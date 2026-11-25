import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  nicknameSchema,
  trackIdSchema,
  stageJoinSchema,
  PLAYLIST_COUNT_LIMIT,
  PLAYLIST_LIMIT,
  type MusicService,
  type Guest,
} from '../shared/contracts.js';
import { catAppearanceSchema } from '../shared/appearance.js';
import {
  EmptyPlaylistImportError,
  NicknameCooldownError,
  Store,
  hashToken,
} from './db.js';
import { Auth, HttpError, COOKIE } from './auth.js';
import { authRoutes, setSession } from './auth-routes.js';
import { smtpMail, type SendMail } from './mail.js';
import { RoomRegistry } from './room-registry.js';
import { EmoteCatalog, EmoteConflictError } from './emote-catalog.js';
import { roomRoutes } from './room-routes.js';
import { createMusicService } from './music.js';
import {
  createNeteaseRequest,
  NeteaseRequestError,
  type NeteaseFetch,
} from './netease-protocol.js';
import {
  NeteaseCredentialStore,
  NeteaseQrLogin,
  validAdminKey,
} from './netease-admin.js';

const ApiError = HttpError;
const nicknameBody = z.object({ nickname: nicknameSchema }).strict();
const playlistSlotSchema = z.number().int().min(1).max(PLAYLIST_COUNT_LIMIT);
const playlistTargetQuery = z
  .object({
    slot: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(playlistSlotSchema)
      .optional(),
  })
  .strict();
class Limiter {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string) {
    const now = Date.now();
    if (this.entries.size >= 10000)
      for (const [id, entry] of this.entries)
        if (entry.until <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 10000) return false;
      entry = { count: 0, until: now + this.windowMs };
      this.entries.set(key, entry);
    }
    return ++entry.count <= this.max;
  }
}
function sameOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host
    );
  } catch {
    return false;
  }
}
function socketToken(header: string | undefined) {
  try {
    return header
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
  } catch {
    return undefined;
  }
}
export async function createServer(
  options: {
    buildId?: string;
    dbPath?: string;
    music?: MusicService;
    disconnectGraceMs?: number;
    resolveTimeoutMs?: number;
    singleRoom?: boolean;
    sendMail?: SendMail;
    authSecret?: string;
    authNow?: () => number;
    adminKey?: string;
    neteaseCookieFile?: string;
    neteaseQrFetch?: NeteaseFetch;
    neteaseMusicFetch?: NeteaseFetch;
    neteaseNow?: () => number;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  const db = new Store(options.dbPath);
  const emoteCatalog = new EmoteCatalog(db);
  const credentials = new NeteaseCredentialStore(options.neteaseCookieFile);
  const music =
    options.music ??
    createMusicService(
      createNeteaseRequest(() => credentials.get(), options.neteaseMusicFetch),
    );
  const qrLogin = new NeteaseQrLogin(
    credentials,
    options.neteaseQrFetch,
    options.neteaseNow,
  );
  const auth = new Auth(db, {
    sendMail: options.sendMail ?? smtpMail(),
    secret: options.authSecret ?? process.env.AUTH_SECRET,
    now: options.authNow,
  });
  const io = new Server(app.server, {
    maxHttpBufferSize: 4096,
    allowRequest: (request, callback) =>
      callback(null, sameOrigin(request.headers.origin, request.headers.host)),
  });
  const registry = new RoomRegistry(db, music, io, {
    ...options,
    emoteCatalog,
  });
  auth.onRevoke = (userId, tokenHash) => registry.revoke(userId, tokenHash);
  await app.register(cookie);
  const guestLimit = new Limiter(20, 60_000),
    neteaseSignupLimit = new Limiter(5, 60_000),
    searchLimit = new Limiter(60, 60_000),
    importLimit = new Limiter(10, 60_000),
    roomLimit = new Limiter(20, 60_000),
    authLimit = new Limiter(100, 60_000),
    adminStatusLimit = new Limiter(60, 60_000),
    adminStartLimit = new Limiter(3, 60_000),
    adminCheckLimit = new Limiter(30, 60_000),
    adminEmoteReadLimit = new Limiter(60, 60_000),
    adminEmoteWriteLimit = new Limiter(20, 60_000);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/admin/'))
      reply.header('Cache-Control', 'no-store');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !sameOrigin(request.headers.origin, request.headers.host)
    )
      throw new ApiError(403, '请求来源无效');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: '请求格式无效' });
    if (error instanceof NicknameCooldownError) {
      const { nicknameChangeAvailableAt } = error;
      const seconds = Math.max(
        1,
        Math.ceil((nicknameChangeAvailableAt - Date.now()) / 1000),
      );
      return reply
        .code(429)
        .header('Retry-After', String(seconds))
        .send({ error: error.message, nicknameChangeAvailableAt });
    }
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    return reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({
        error:
          status && status < 500 && error instanceof Error
            ? error.message
            : '服务器暂时不可用',
      });
  });
  const identity = (request: {
    cookies: Record<string, string | undefined>;
  }) => {
    return auth.identity(request.cookies[COOKIE]);
  };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/version', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { version: options.buildId ?? null };
  });
  const adminGuard =
    (limit: Limiter) =>
    async (
      request: { headers: Record<string, unknown>; ip: string },
      reply: { header: (name: string, value: string) => unknown },
    ) => {
      reply.header('Cache-Control', 'no-store');
      if (!limit.allow(request.ip))
        throw new ApiError(429, '操作太快，请稍后重试');
      if (
        !validAdminKey(
          request.headers['x-loop-admin-key'],
          options.adminKey ?? process.env.LOOP_ADMIN_KEY,
        )
      )
        throw new ApiError(403, '管理员密钥无效');
    };
  const adminBody = (body: unknown) =>
    z
      .object({})
      .strict()
      .parse(body ?? {});
  app.get('/api/emotes', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return emoteCatalog.get();
  });
  app.post(
    '/api/admin/emotes/catalog',
    { preHandler: adminGuard(adminEmoteReadLimit) },
    async (request) => {
      adminBody(request.body);
      return emoteCatalog.get();
    },
  );
  app.put(
    '/api/admin/emotes/catalog',
    { bodyLimit: 256_000, preHandler: adminGuard(adminEmoteWriteLimit) },
    async (request) => {
      try {
        const state = emoteCatalog.save(request.body);
        io.emit('emotes:updated', { revision: state.revision });
        return state;
      } catch (error) {
        if (error instanceof EmoteConflictError)
          throw new ApiError(409, error.message);
        throw error;
      }
    },
  );
  app.post(
    '/api/admin/netease/status',
    { preHandler: adminGuard(adminStatusLimit) },
    async (request) => {
      adminBody(request.body);
      return qrLogin.status();
    },
  );
  app.post(
    '/api/admin/netease/qr/start',
    { preHandler: adminGuard(adminStartLimit) },
    async (request) => {
      adminBody(request.body);
      try {
        return await qrLogin.start();
      } catch {
        throw new ApiError(502, '网易云扫码暂时不可用');
      }
    },
  );
  app.post(
    '/api/admin/netease/qr/check',
    { preHandler: adminGuard(adminCheckLimit) },
    async (request) => {
      adminBody(request.body);
      try {
        return await qrLogin.check();
      } catch {
        throw new ApiError(502, '网易云扫码暂时不可用');
      }
    },
  );
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/auth/') && !authLimit.allow(request.ip))
      throw new ApiError(429, '操作太快，请稍后重试');
  });
  authRoutes(app, auth);
  roomRoutes(app, db, auth, registry, (key) => roomLimit.allow(key));
  const rename = (id: string, nickname: string) => {
    const { guest, changed } = db.rename(id, nickname);
    if (changed) registry.updateNickname(id, guest.nickname);
    return { guest: auth.profile(guest) };
  };
  app.patch('/api/me/nickname', async (request) => {
    const current = identity(request);
    const { nickname } = nicknameBody.parse(request.body);
    return rename(current.id, nickname);
  });
  app.patch('/api/me/appearance', async (request) => {
    const current = identity(request);
    const appearance = catAppearanceSchema.parse(request.body);
    const guest = db.updateAppearance(current.id, appearance);
    registry.updateAppearance(current.id, appearance);
    return { guest: auth.profile(guest) };
  });
  app.post('/api/guest', async (request, reply) => {
    if (!guestLimit.allow(request.ip))
      throw new ApiError(429, '操作太快，请稍后重试');
    const { nickname } = nicknameBody.parse(request.body);
    const existing = db.guest(request.cookies[COOKIE]);
    if (existing) return rename(existing.id, nickname);
    const { guest, token, createdRoom } = db.createUser(nickname);
    setSession(reply, token);
    return { guest: auth.profile(guest), createdRoom };
  });
  app.post('/api/guest/from-netease', async (request, reply) => {
    const { userId, playlistId, playlistOffset, nickname } = z
      .object({
        userId: trackIdSchema,
        playlistId: trackIdSchema,
        playlistOffset: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 20)
          .refine((offset) => offset % 20 === 0),
        nickname: nicknameSchema,
      })
      .strict()
      .parse(request.body);
    if (db.guest(request.cookies[COOKIE]))
      throw new ApiError(409, '当前已有身份，请先退出再创建新身份');
    if (!guestLimit.allow(request.ip) || !neteaseSignupLimit.allow(request.ip))
      throw new ApiError(429, '操作太快，请稍后重试');
    if (!music.userPlaylists || !music.playlist)
      throw new ApiError(503, '网易云歌单导入暂时不可用');
    // Verify the selected playlist against the same user-list page shown by
    // the signup UI. This does not prove ownership of the upstream account.
    let userPage;
    try {
      userPage = await music.userPlaylists(userId, playlistOffset);
    } catch {
      throw new ApiError(502, '网易云用户歌单暂时不可用');
    }
    if (!userPage.playlists.some((item) => item.id === playlistId))
      throw new ApiError(400, '该歌单不在所选网易云用户的当前页中');
    let source;
    try {
      source = await music.playlist(playlistId, 0, PLAYLIST_LIMIT);
    } catch {
      throw new ApiError(502, '网易云歌单资料暂时不可用');
    }
    if (source.playlist.id !== playlistId)
      throw new ApiError(502, '网易云歌单资料无效');
    let created;
    try {
      created = db.createUserFromPlaylist(nickname, source.tracks);
    } catch (error) {
      if (error instanceof EmptyPlaylistImportError)
        throw new ApiError(400, '该网易云歌单没有可导入的歌曲');
      throw error;
    }
    setSession(reply, created.token);
    return {
      guest: auth.profile(created.guest),
      createdRoom: created.createdRoom,
    };
  });
  app.get('/api/playlist', async (request) =>
    db.playlist(identity(request).id),
  );
  function targetPlaylist(userId: string, query: unknown) {
    const { slot } = playlistTargetQuery.parse(query);
    try {
      return db.playlistSlot(userId, slot);
    } catch {
      throw new ApiError(404, '歌单不存在');
    }
  }
  app.put('/api/playlists/active', async (request) => {
    const { id } = identity(request);
    const { slot } = z
      .object({ slot: playlistSlotSchema })
      .strict()
      .parse(request.body);
    const current = db.playlist(id);
    if (slot === current.slot) return current;
    const state = db.selectPlaylist(id, slot);
    registry.publishPlaylist(id, state);
    return state;
  });
  app.post('/api/playlist', async (request) => {
    const guest = identity(request),
      { id } = z.object({ id: trackIdSchema }).strict().parse(request.body);
    const slot = targetPlaylist(guest.id, request.query);
    const tracks = db.tracks(guest.id, slot);
    if (
      tracks.length >= PLAYLIST_LIMIT &&
      !tracks.some((track) => track.id === id)
    )
      throw new ApiError(400, `歌单最多 ${PLAYLIST_LIMIT} 首`);
    let track;
    try {
      track = await music.detail(id);
    } catch {
      throw new ApiError(502, '歌曲资料暂时不可用');
    }
    if (track.id !== id) throw new ApiError(502, '歌曲资料无效');
    try {
      db.add(guest.id, track, slot);
      return db.playlist(guest.id);
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  });
  app.delete('/api/playlist/:id', async (request) => {
    const guest = identity(request),
      { id } = z.object({ id: trackIdSchema }).parse(request.params);
    db.remove(guest.id, id, targetPlaylist(guest.id, request.query));
    return db.playlist(guest.id);
  });
  app.post('/api/playlist/import', async (request) => {
    const guest = identity(request);
    const { playlistId, start, mode } = z
      .object({
        playlistId: trackIdSchema,
        mode: z.enum(['replace', 'append']).default('append'),
        start: z
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER - PLAYLIST_LIMIT)
          .default(1),
      })
      .strict()
      .parse(request.body);
    const slot = targetPlaylist(guest.id, request.query);
    if (mode === 'append' && db.tracks(guest.id, slot).length >= PLAYLIST_LIMIT)
      throw new ApiError(
        400,
        `歌单最多 ${PLAYLIST_LIMIT} 首，请先删除部分歌曲`,
      );
    if (!importLimit.allow(guest.id))
      throw new ApiError(429, '导入太快，请稍后重试');
    if (!music.playlist) throw new ApiError(503, '歌单导入暂时不可用');
    let source;
    try {
      source = await music.playlist(playlistId, start - 1, PLAYLIST_LIMIT);
    } catch {
      throw new ApiError(502, '网易云歌单资料暂时不可用');
    }
    if (start > source.total)
      throw new ApiError(
        400,
        source.total
          ? `起始序号不能超过歌单的 ${source.total} 首歌曲`
          : '该网易云歌单没有歌曲',
      );
    try {
      return db.importTracks(guest.id, source.tracks, start, mode, slot);
    } catch (error) {
      if (error instanceof EmptyPlaylistImportError)
        throw new ApiError(400, error.message);
      throw error;
    }
  });
  app.put('/api/playlist/order', async (request) => {
    const guest = identity(request),
      { ids } = z
        // Retain ordering for historical queues above the new addition limit.
        .object({ ids: z.array(trackIdSchema).max(200) })
        .strict()
        .parse(request.body);
    const slot = targetPlaylist(guest.id, request.query);
    try {
      db.order(guest.id, ids, slot);
      return db.playlist(guest.id);
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  });
  app.put('/api/playlist/move', async (request) => {
    const guest = identity(request);
    const { id, targetId, placement } = z
      .object({
        id: trackIdSchema,
        targetId: trackIdSchema.optional(),
        placement: z.enum(['before', 'after', 'first']),
      })
      .strict()
      .refine((move) => move.placement === 'first' || !!move.targetId, {
        message: '请选择排序目标',
      })
      .parse(request.body);
    const slot = targetPlaylist(guest.id, request.query);
    try {
      // Apply the move inside the current queue's transaction, so concurrent
      // playback rotation/additions cannot be overwritten by a stale ID array.
      db.moveTrack(guest.id, id, targetId, placement, slot);
      return db.playlist(guest.id);
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  });
  app.get('/api/search', async (request) => {
    identity(request);
    if (!searchLimit.allow(request.ip))
      throw new ApiError(429, '搜索太快，请稍后重试');
    const { q } = z
      .object({ q: z.string().trim().min(1).max(100) })
      .strict()
      .parse(request.query);
    try {
      return { tracks: await music.search(q) };
    } catch {
      throw new ApiError(502, '搜索暂时不可用');
    }
  });
  const metadataAccess = (
    request: Parameters<typeof identity>[0] & {
      headers: { origin?: string; host?: string };
      ip: string;
    },
  ) => {
    identity(request);
    if (!sameOrigin(request.headers.origin, request.headers.host))
      throw new ApiError(403, '请求来源无效');
    if (!searchLimit.allow(request.ip))
      throw new ApiError(429, '查询太快，请稍后重试');
  };
  const publicUserMetadataAccess = (
    request: Parameters<typeof metadataAccess>[0],
  ) => {
    if (!sameOrigin(request.headers.origin, request.headers.host))
      throw new ApiError(403, '请求来源无效');
    if (!searchLimit.allow(request.ip))
      throw new ApiError(429, '查询太快，请稍后重试');
  };
  const offsetQuery = z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - PLAYLIST_LIMIT),
    );
  app.get('/api/lyrics/:id', async (request) => {
    metadataAccess(request);
    const { id } = z
      .object({ id: trackIdSchema })
      .strict()
      .parse(request.params);
    z.object({}).strict().parse(request.query);
    if (!music.lyrics) throw new ApiError(503, '歌词暂时不可用');
    try {
      return await music.lyrics(id);
    } catch {
      throw new ApiError(502, '歌词暂时不可用');
    }
  });
  app.get('/api/music/playlists/search', async (request) => {
    metadataAccess(request);
    const { q, offset } = z
      .object({
        q: z.string().trim().min(1).max(100),
        offset: offsetQuery.default(0),
      })
      .strict()
      .parse(request.query);
    if (!music.searchPlaylists) throw new ApiError(503, '歌单搜索暂时不可用');
    try {
      return await music.searchPlaylists(q, offset);
    } catch {
      throw new ApiError(502, '歌单搜索暂时不可用');
    }
  });
  app.get('/api/music/users/search', async (request) => {
    publicUserMetadataAccess(request);
    const { q, offset } = z
      .object({
        q: z.string().trim().min(1).max(100),
        offset: offsetQuery.default(0),
      })
      .strict()
      .parse(request.query);
    if (!music.searchUsers) throw new ApiError(503, '用户搜索暂时不可用');
    try {
      return await music.searchUsers(q, offset);
    } catch {
      throw new ApiError(502, '网易云用户搜索暂时不可用');
    }
  });
  app.get('/api/music/users/:id/playlists', async (request) => {
    publicUserMetadataAccess(request);
    const { id } = z
      .object({ id: trackIdSchema })
      .strict()
      .parse(request.params);
    const { offset } = z
      .object({ offset: offsetQuery.default(0) })
      .strict()
      .parse(request.query);
    if (!music.userPlaylists) throw new ApiError(503, '用户歌单暂时不可用');
    try {
      return await music.userPlaylists(id, offset);
    } catch (error) {
      if (error instanceof NeteaseRequestError && error.code === 301)
        throw new ApiError(502, '网易云用户歌单需要登录');
      throw new ApiError(502, '网易云用户歌单暂时不可用');
    }
  });
  app.get('/api/music/playlists/:id', async (request) => {
    metadataAccess(request);
    const { id } = z
      .object({ id: trackIdSchema })
      .strict()
      .parse(request.params);
    const { offset, limit } = z
      .object({
        offset: offsetQuery.default(0),
        limit: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.number().int().min(1).max(PLAYLIST_LIMIT))
          .default(PLAYLIST_LIMIT),
      })
      .strict()
      .parse(request.query);
    if (!music.playlist) throw new ApiError(503, '歌单浏览暂时不可用');
    try {
      return await music.playlist(id, offset, limit);
    } catch {
      throw new ApiError(502, '网易云歌单资料暂时不可用');
    }
  });
  io.use((socket, next) => {
    const token = socketToken(socket.request.headers.cookie);
    const guest = db.guest(token);
    if (
      !guest ||
      !sameOrigin(
        socket.handshake.headers.origin,
        socket.handshake.headers.host,
      )
    )
      return next(new Error('请先填写昵称，或检查请求来源'));
    const roomId =
      socket.handshake.auth?.roomId ??
      (options.singleRoom ? '__test__' : undefined);
    if (
      typeof roomId !== 'string' ||
      (roomId !== '__test__' && !z.string().uuid().safeParse(roomId).success)
    )
      return next(new Error('请选择有效的房间'));
    try {
      registry.admit(roomId, guest.id);
    } catch (error) {
      return next(new Error((error as Error).message));
    }
    socket.data.guest = guest;
    socket.data.roomId = roomId;
    socket.data.token = token;
    next();
  });
  io.on('connection', (socket) => {
    const guest = socket.data.guest as Guest,
      roomId = socket.data.roomId as string,
      token = socket.data.token as string;
    let room;
    try {
      room = registry.connect(roomId, guest, socket, hashToken(token));
    } catch (error) {
      socket.emit('room:removed', { roomId, reason: (error as Error).message });
      socket.disconnect(true);
      return;
    }
    socket.emit('playlist:updated', db.playlist(guest.id));
    const limit = new Limiter(60, 1000);
    const current = () => {
      if (
        !registry.isCurrent(roomId, guest.id, socket.id) ||
        db.guest(token)?.id !== guest.id
      )
        throw new Error('连接已被替换或会话已结束');
    };
    const bind = (
      event: string,
      action: (payload: unknown) => unknown,
      hasPayload = true,
    ) => {
      socket.on(event, async (...args: unknown[]) => {
        const ack = args[hasPayload ? 1 : 0];
        try {
          current();
          if (!limit.allow(guest.id)) throw new Error('操作太快');
          await action(hasPayload ? args[0] : undefined);
          // Leave intentionally destroys membership. Other asynchronous commands must still belong to this socket.
          if (event !== 'room:leave') current();
          if (typeof ack === 'function') ack({ ok: true });
        } catch (error) {
          if (typeof ack === 'function')
            ack({
              ok: false,
              error:
                error instanceof z.ZodError
                  ? '请求格式无效'
                  : (error as Error).message,
            });
        }
      });
    };
    bind('room:motion', (payload) => room.motion(guest.id, payload));
    bind('room:move', (payload) => room.move(guest.id, payload));
    bind('room:stop', () => room.stop(guest.id), false);
    bind('room:emote', (payload) => room.emote(guest.id, payload));
    bind('stage:join', (payload) => {
      const { from } = stageJoinSchema.parse(payload);
      return room.join(guest.id, socket.id, undefined, from);
    });
    bind('stage:leave', (payload) => room.leave(guest.id, socket.id, payload));
    bind('playback:skip', (payload) =>
      room.skip(
        guest.id,
        payload,
        socket.id,
        roomId !== '__test__' && registry.info(roomId).ownerId === guest.id,
      ),
    );
    bind('playback:failed', (payload) =>
      room.mediaFailed(guest.id, payload, socket.id),
    );
    bind('playback:seek', (payload) => room.seek(guest.id, payload, socket.id));
    const target = (payload: unknown) =>
      z.object({ userId: z.string().uuid() }).strict().parse(payload).userId;
    bind('stage:remove', (payload) =>
      registry.forceLeave(roomId, guest.id, target(payload)),
    );
    bind('member:kick', (payload) =>
      registry.kick(roomId, guest.id, target(payload)),
    );
    bind(
      'room:leave',
      () => registry.leave(roomId, guest.id, socket.id),
      false,
    );
    socket.on('room:sync', (ack) => {
      try {
        current();
        if (limit.allow(guest.id) && typeof ack === 'function')
          ack(registry.snapshot(roomId));
      } catch {
        /* A stale socket cannot read a newer room session. */
      }
    });
    socket.on('disconnect', () =>
      registry.disconnect(roomId, guest.id, socket.id),
    );
  });
  const clientRoot = resolve('dist/client');
  if (existsSync(clientRoot)) {
    const clientEntry = resolve(clientRoot, 'index.html');
    await app.register(fastifyStatic, {
      root: clientRoot,
      setHeaders(reply, filePath) {
        if (filePath === clientEntry) reply.header('Cache-Control', 'no-store');
      },
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') || request.method !== 'GET'
        ? reply.code(404).send({ error: '不存在的接口' })
        : reply.sendFile('index.html'),
    );
  } else
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: '不存在的接口' }),
    );
  app.addHook('preClose', async () => {
    registry.close();
    await new Promise<void>((done) => io.close(() => done()));
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  return {
    app,
    room: registry.singleRoom!,
    db,
    io,
    registry,
    auth,
    emoteCatalog,
  };
}

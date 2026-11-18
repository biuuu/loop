import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_STAGE_CAPACITY,
  roomDirectoryFilterSchema,
  roomNumberSchema,
  stageCapacitySchema,
} from '../shared/contracts.js';
import {
  DEFAULT_ENVIRONMENT,
  environmentIdSchema,
} from '../shared/environments.js';
import type { Store } from './db.js';
import { Auth, COOKIE, HttpError } from './auth.js';
import type { RoomRegistry } from './room-registry.js';
const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  environmentId: environmentIdSchema,
};
const roomId = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
const publicRoomId = z.object({
  id: z.union([
    z.string().uuid(),
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(roomNumberSchema),
  ]),
});
export function roomRoutes(
  app: FastifyInstance,
  db: Store,
  auth: Auth,
  registry: RoomRegistry,
  allow: (key: string) => boolean,
) {
  app.get('/api/rooms', async (request) => {
    const { offset, limit, owner, filter } = z
      .object({
        offset: z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .default(0),
        limit: z.coerce.number().int().min(1).max(100).default(24),
        owner: z.literal('me').optional(),
        filter: roomDirectoryFilterSchema.default('all'),
      })
      .strict()
      .parse(request.query);
    const current =
      owner === 'me' ? auth.identity(request.cookies[COOKIE]) : null;
    const rooms = registry.summaries().filter((room) => {
      if (current && room.ownerId !== current.id) return false;
      switch (filter) {
        case 'playing':
          return room.trackTitle !== undefined;
        case 'occupied':
          return room.online > 0;
        case 'empty':
          return room.online === 0;
        case 'all':
          return true;
      }
    });
    return { rooms: rooms.slice(offset, offset + limit), total: rooms.length };
  });
  app.get('/api/rooms/:id', async (request) => {
    const { id } = publicRoomId.parse(request.params);
    if (typeof id === 'string') return { room: registry.info(id) };
    const room = db.roomByNumber(id);
    if (!room) throw new HttpError(404, '房间不存在或已被删除');
    return { room: registry.info(room.id) };
  });
  app.post('/api/rooms', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]);
    if (!allow(`create:${user.id}:${request.ip}`))
      throw new HttpError(429, '创建房间太快，请稍后重试');
    const { name, environmentId, stageCapacity } = z
      .object({
        ...fields,
        environmentId: fields.environmentId.default(DEFAULT_ENVIRONMENT),
        stageCapacity: stageCapacitySchema.default(DEFAULT_STAGE_CAPACITY),
      })
      .strict()
      .parse(request.body);
    if (db.rooms().some((room) => room.ownerId === user.id))
      throw new HttpError(409, '每个账号最多拥有一个房间');
    try {
      return {
        room: db.createRoom(user.id, name, environmentId, stageCapacity),
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
        throw new HttpError(409, '每个账号最多拥有一个房间');
      throw error;
    }
  });
  app.patch('/api/rooms/:id', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]),
      id = roomId(request.params),
      before = registry.owner(id, user.id);
    const changes = z
      .object({
        name: fields.name.optional(),
        environmentId: fields.environmentId.optional(),
        joinPolicy: z.enum(['open', 'closed']).optional(),
        stageCapacity: stageCapacitySchema.optional(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    if (!allow(`edit:${user.id}`))
      throw new HttpError(429, '操作太快，请稍后重试');
    const stageCapacity = changes.stageCapacity ?? before.stageCapacity;
    // Validation and commit remain synchronous so membership cannot change in between.
    registry.assertStageCapacity(id, stageCapacity);
    if (
      !db.updateRoom(id, changes.expectedRevision, {
        name: changes.name ?? before.name,
        environmentId: changes.environmentId ?? before.environmentId,
        joinPolicy: changes.joinPolicy ?? before.joinPolicy,
        stageCapacity,
      })
    )
      throw new HttpError(409, '房间资料已更新，请刷新后重试');
    const room = registry.info(id);
    registry.updated(room);
    return { room };
  });
  app.get('/api/rooms/:id/bans', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]),
      id = roomId(request.params);
    registry.owner(id, user.id);
    return { bans: db.bans(id) };
  });
  app.post('/api/rooms/:id/bans', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]),
      id = roomId(request.params),
      { userId } = z
        .object({ userId: z.string().uuid() })
        .strict()
        .parse(request.body);
    if (!allow(`ban:${user.id}`))
      throw new HttpError(429, '操作太快，请稍后重试');
    registry.ban(id, user.id, userId);
    return { bans: db.bans(id) };
  });
  app.delete('/api/rooms/:id/bans/:userId', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]),
      { id, userId } = z
        .object({ id: z.string().uuid(), userId: z.string().uuid() })
        .parse(request.params);
    registry.owner(id, user.id);
    db.unban(id, userId);
    return { bans: db.bans(id) };
  });
  app.get('/api/rooms/:id/members', async (request) => {
    const user = auth.identity(request.cookies[COOKIE]),
      id = roomId(request.params);
    return { users: registry.members(id, user.id) };
  });
  for (const action of ['kick', 'leave-stage'] as const)
    app.post(`/api/rooms/:id/members/:userId/${action}`, async (request) => {
      const user = auth.identity(request.cookies[COOKIE]);
      const { id, userId } = z
        .object({ id: z.string().uuid(), userId: z.string().uuid() })
        .strict()
        .parse(request.params);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!allow(`moderate:${user.id}`))
        throw new HttpError(429, '操作太快，请稍后重试');
      if (action === 'kick') registry.kick(id, user.id, userId);
      else await registry.forceLeave(id, user.id, userId);
      return { ok: true };
    });
}

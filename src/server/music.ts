import { z } from 'zod';
import type {
  MusicService,
  NeteasePlaylist,
  NeteaseUser,
  SongLyrics,
  Track,
} from '../shared/contracts.js';
import { trackIdSchema } from '../shared/contracts.js';
import {
  createNeteaseRequest,
  NeteaseRequestError,
  type NeteaseRequest,
} from './netease-protocol.js';
import { MusicPlaybackError } from './music-errors.js';

const songSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  dt: z.number().positive(),
  ar: z.array(z.object({ name: z.string() })).default([]),
  al: z
    .object({ name: z.string().optional(), picUrl: z.string().optional() })
    .optional(),
});

const pageOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 50);
const playlistSchema = z.object({
  id: z.union([z.string(), z.number().int().nonnegative().safe()]),
  name: z.string().trim().min(1),
  coverImgUrl: z.string().optional(),
  trackCount: z.number().int().nonnegative().safe(),
  creator: z.object({ nickname: z.string() }).nullish(),
});
const userSchema = z.object({
  userId: z.union([z.string(), z.number().int().nonnegative().safe()]),
  nickname: z.string().trim().min(1).max(100),
  avatarUrl: z.string().nullish(),
});
function publicCover(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
function normalizePlaylist(raw: unknown): NeteasePlaylist | null {
  const parsed = playlistSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const id = String(item.id);
  if (!trackIdSchema.safeParse(id).success) return null;
  return {
    id,
    name: item.name,
    cover: publicCover(item.coverImgUrl),
    creator: item.creator?.nickname || '未知创建者',
    trackCount: item.trackCount,
  };
}
function normalizeUser(raw: unknown): NeteaseUser | null {
  const parsed = userSchema.safeParse(raw);
  if (!parsed.success) return null;
  const id = String(parsed.data.userId);
  if (!trackIdSchema.safeParse(id).success) return null;
  return {
    id,
    nickname: parsed.data.nickname,
    avatar: publicCover(parsed.data.avatarUrl ?? undefined),
  };
}

function normalizeSong(raw: unknown): Track | null {
  const result = songSchema.safeParse(raw);
  if (!result.success) return null;
  const song = result.data;
  if (!trackIdSchema.safeParse(String(song.id)).success) return null;
  let cover = '';
  if (song.al?.picUrl) {
    try {
      const url = new URL(song.al.picUrl);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol === 'https:') cover = url.href;
    } catch {
      /* Missing/invalid cover does not prevent playback. */
    }
  }
  return {
    id: String(song.id),
    title: song.name,
    artist: song.ar.map((a) => a.name).join(' / ') || '未知歌手',
    album: song.al?.name || '',
    cover,
    durationMs: Math.round(song.dt),
  };
}

export function createMusicService(
  request: NeteaseRequest = createNeteaseRequest(),
): MusicService {
  const details = new Map<string, { track: Track; until: number }>();
  const lyrics = new Map<string, { value: SongLyrics; until: number }>();
  const pendingLyrics = new Map<string, Promise<SongLyrics>>();
  const remember = (track: Track) => {
    if (details.size >= 500) details.delete(details.keys().next().value!);
    details.set(track.id, { track, until: Date.now() + 300_000 });
    return track;
  };
  return {
    async lyrics(id) {
      trackIdSchema.parse(id);
      const cached = lyrics.get(id);
      if (cached && cached.until > Date.now()) return { ...cached.value };
      lyrics.delete(id);
      const pending = pendingLyrics.get(id);
      if (pending) return { ...(await pending) };
      if (pendingLyrics.size >= 100) throw new Error('歌词暂时不可用');
      const loading = (async (): Promise<SongLyrics> => {
        let raw: unknown;
        try {
          raw = await request('/api/song/lyric', {
            id,
            tv: -1,
            lv: -1,
            rv: -1,
            kv: -1,
            _nmclfl: 1,
          });
        } catch {
          throw new Error('歌词暂时不可用');
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('歌词暂时不可用');
        const body = raw as {
          nolyric?: unknown;
          uncollected?: unknown;
          lrc?: { lyric?: unknown } | null;
          tlyric?: { lyric?: unknown } | null;
        };
        // Only the two plain LRC fields are public. Pronunciation, ruby and YRC
        // metadata never leave this service; cap text retained per cached track.
        const text = (value: unknown) =>
          typeof value === 'string' ? value.slice(0, 200_000) : '';
        const empty = body.nolyric === true || body.uncollected === true;
        const value = {
          trackId: id,
          original: empty ? '' : text(body.lrc?.lyric),
          translation: empty ? '' : text(body.tlyric?.lyric),
        };
        if (lyrics.size >= 100) lyrics.delete(lyrics.keys().next().value!);
        lyrics.set(id, { value, until: Date.now() + 300_000 });
        return value;
      })();
      pendingLyrics.set(id, loading);
      try {
        return { ...(await loading) };
      } finally {
        pendingLyrics.delete(id);
      }
    },
    async search(query) {
      const keywords = query.trim();
      if (!keywords || keywords.length > 100)
        throw new Error('搜索词长度应为 1–100 个字符');
      const body = (await request('/api/cloudsearch/pc', {
        s: keywords,
        type: 1,
        limit: 30,
        offset: 0,
        total: true,
      })) as { result?: { songs?: unknown[] } };
      const songs = body.result?.songs;
      if (!songs) return [];
      if (!Array.isArray(songs)) throw new Error('网易云返回了无效的搜索结果');
      return songs
        .map(normalizeSong)
        .filter((track): track is Track => track !== null)
        .map(remember);
    },
    async searchPlaylists(query, offset = 0) {
      const keywords = z.string().trim().min(1).max(100).parse(query);
      pageOffsetSchema.parse(offset);
      const body = (await request('/api/cloudsearch/pc', {
        s: keywords,
        type: 1000,
        limit: 20,
        offset,
        total: true,
      })) as { result?: { playlists?: unknown; playlistCount?: unknown } };
      const raw = body.result?.playlists ?? [];
      if (!Array.isArray(raw))
        throw new Error('网易云返回了无效的歌单搜索结果');
      const total = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(body.result?.playlistCount ?? 0);
      return {
        playlists: raw
          .map(normalizePlaylist)
          .filter((item): item is NeteasePlaylist => item !== null),
        total,
        more: offset + raw.length < total,
      };
    },
    async searchUsers(query, offset = 0) {
      const keywords = z.string().trim().min(1).max(100).parse(query);
      pageOffsetSchema.parse(offset);
      const body = (await request('/api/cloudsearch/pc', {
        s: keywords,
        type: 1002,
        limit: 20,
        offset,
        total: true,
      })) as {
        result?: { userprofiles?: unknown; userprofileCount?: unknown };
      };
      const raw = body.result?.userprofiles ?? [];
      if (!Array.isArray(raw))
        throw new Error('网易云返回了无效的用户搜索结果');
      const total = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(body.result?.userprofileCount ?? 0);
      return {
        users: raw
          .slice(0, 20)
          .map(normalizeUser)
          .filter((item): item is NeteaseUser => item !== null),
        total,
        more: offset + raw.length < total,
      };
    },
    async userPlaylists(id, offset = 0) {
      trackIdSchema.parse(id);
      pageOffsetSchema.parse(offset);
      const body = (await request('/api/user/playlist', {
        uid: id,
        limit: 20,
        offset,
        includeVideo: true,
      })) as { playlist?: unknown; more?: unknown };
      if (!Array.isArray(body.playlist) || typeof body.more !== 'boolean')
        throw new Error('网易云用户歌单资料暂时不可用');
      return {
        playlists: body.playlist
          .slice(0, 20)
          .map(normalizePlaylist)
          .filter((item): item is NeteasePlaylist => item !== null),
        offset,
        more: body.more || body.playlist.length > 20,
      };
    },
    async playlist(id, offset = 0, limit = 50) {
      trackIdSchema.parse(id);
      pageOffsetSchema.parse(offset);
      z.number().int().min(1).max(50).parse(limit);
      const body = (await request('/api/v6/playlist/detail', {
        id,
        n: 100000,
        s: 8,
      })) as { playlist?: { trackIds?: unknown } };
      const playlist = normalizePlaylist(body.playlist);
      if (
        !playlist ||
        playlist.id !== id ||
        !Array.isArray(body.playlist?.trackIds)
      )
        throw new Error('网易云歌单资料暂时不可用');
      // trackIds is the complete source order; playlist.tracks may contain only a preview.
      // Slice before validation/deduplication to retain unavailable source positions.
      const source = body.playlist.trackIds;
      const selected = source
        .slice(offset, offset + limit)
        .map((raw: unknown, index: number) => {
          const value =
            raw && typeof raw === 'object'
              ? (raw as { id?: unknown }).id
              : undefined;
          const candidate =
            typeof value === 'string' ||
            (typeof value === 'number' && Number.isSafeInteger(value))
              ? String(value)
              : '';
          return {
            position: offset + index + 1,
            id: trackIdSchema.safeParse(candidate).success ? candidate : '',
          };
        });
      const ids = [
        ...new Set(selected.map((entry) => entry.id).filter(Boolean)),
      ];
      const byId = new Map<string, Track>();
      if (ids.length) {
        const detail = (await request('/api/v3/song/detail', {
          c: JSON.stringify(ids.map((id) => ({ id }))),
        })) as { songs?: unknown };
        if (!Array.isArray(detail.songs))
          throw new Error('网易云歌曲资料暂时不可用');
        const wanted = new Set(ids);
        for (const raw of detail.songs) {
          const track = normalizeSong(raw);
          if (track && wanted.has(track.id))
            byId.set(track.id, remember(track));
        }
      }
      return {
        playlist,
        total: source.length,
        offset,
        tracks: selected.map((entry) => ({
          ...entry,
          track: byId.get(entry.id) ?? null,
        })),
      };
    },
    async detail(id) {
      trackIdSchema.parse(id);
      const cached = details.get(id);
      if (cached && cached.until > Date.now()) return { ...cached.track };
      const body = (await request('/api/v3/song/detail', {
        c: JSON.stringify([{ id }]),
      })) as { songs?: unknown[] };
      const track = normalizeSong(body.songs?.[0]);
      if (!track || track.id !== id) throw new Error('没有找到这首歌');
      return remember(track);
    },
    async resolve(track) {
      trackIdSchema.parse(track.id);
      let body: {
        data?: Array<{
          url?: string | null;
          time?: number;
          freeTrialInfo?: unknown;
          code?: number;
        }>;
      };
      try {
        body = (await request('/api/song/enhance/player/url/v1', {
          ids: `[${track.id}]`,
          level: 'standard',
          encodeType: 'mp3',
        })) as typeof body;
      } catch (error) {
        if (error instanceof NeteaseRequestError) {
          const timedOut =
            error.kind === 'network' &&
            ['TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(
              String(error.code),
            );
          throw new MusicPlaybackError(timedOut ? 'timeout' : 'upstream');
        }
        throw new Error('歌曲播放地址解析失败');
      }
      const resource = body.data?.[0];
      if (!resource?.url || (resource.code != null && resource.code !== 200))
        throw new MusicPlaybackError('unavailable');
      let url: URL;
      try {
        url = new URL(resource.url);
      } catch {
        throw new MusicPlaybackError('unavailable');
      }
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new MusicPlaybackError('unavailable');
      const resourceDuration =
        typeof resource.time === 'number' &&
        Number.isFinite(resource.time) &&
        resource.time > 0
          ? resource.time
          : undefined;
      if (resource.freeTrialInfo != null) {
        const trial = z
          .object({
            start: z.number().finite().nonnegative(),
            end: z.number().finite().nonnegative(),
          })
          .safeParse(resource.freeTrialInfo);
        const interval =
          trial.success && trial.data.end > trial.data.start
            ? (trial.data.end - trial.data.start) * 1000
            : undefined;
        const previewDuration =
          interval && Number.isFinite(interval)
            ? Math.min(interval, resourceDuration ?? Infinity)
            : resourceDuration && resourceDuration <= 30_000
              ? resourceDuration
              : undefined;
        if (!previewDuration) throw new MusicPlaybackError('unavailable');
        return {
          url: url.href,
          durationMs: Math.max(1, Math.round(previewDuration)),
          isTrial: true,
          lyricOffsetMs:
            interval &&
            Number.isFinite(interval) &&
            trial.success &&
            Number.isFinite(trial.data.start * 1000)
              ? trial.data.start * 1000
              : null,
        };
      }
      return {
        url: url.href,
        durationMs: resourceDuration
          ? Math.round(resourceDuration)
          : track.durationMs,
      };
    },
  };
}

export const neteaseMusic = createMusicService();

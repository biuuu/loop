import { z } from 'zod';
import type { CatAppearance } from './appearance';

export type EmoteId = string;
export interface EmoteItem {
  id: EmoteId;
  url: string;
}
export interface EmoteGroup {
  id: string;
  label: string;
  items: EmoteItem[];
}
export interface EmoteCatalog {
  enabled: boolean;
  revision: number;
  groups: EmoteGroup[];
}
export const EMOTE_DURATION_MS = 3000;
export const EMOTE_COOLDOWN_MS = 2000;
export const NICKNAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
export const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[\p{L}\p{N}_\- ]+$/u, '昵称使用文字、数字、空格、下划线或短横线');
export const trackIdSchema = z.string().regex(/^\d{1,20}$/);
export const PLAYLIST_LIMIT = 100;
export const PLAYLIST_COUNT_LIMIT = 3;
export const moveSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
export const SCENE = {
  width: 1240,
  height: 620,
  walk: { left: 75, right: 1165, top: 350, bottom: 555 },
  stageY: 255,
  seatXs: [340, 452, 564, 676, 788, 900],
  speed: 180,
} as const;
// Local presentation may run ahead of coalesced network updates. Both ends of
// the reported segment remain constrained to the walkable audience floor.
export const motionSchema = z
  .object({
    x: z.number().finite().min(SCENE.walk.left).max(SCENE.walk.right),
    y: z.number().finite().min(SCENE.walk.top).max(SCENE.walk.bottom),
    targetX: z.number().finite().min(SCENE.walk.left).max(SCENE.walk.right),
    targetY: z.number().finite().min(SCENE.walk.top).max(SCENE.walk.bottom),
    facingRight: z.boolean(),
    clientMoveId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ClientMotion = z.infer<typeof motionSchema>;
export const ROOM_CAPACITY = 30;
export const STAGE_CAPACITY = 6;
export const DEFAULT_STAGE_CAPACITY = 5;
export const stageCapacitySchema = z.number().int().min(1).max(STAGE_CAPACITY);
export function stageSeatXs(capacity = DEFAULT_STAGE_CAPACITY): number[] {
  const count = stageCapacitySchema.parse(capacity);
  return Array.from(
    { length: count },
    (_, index) => SCENE.width / 2 + (index - (count - 1) / 2) * 112,
  );
}
export const stageSeatSchema = z
  .number()
  .int()
  .min(0)
  .max(STAGE_CAPACITY - 1);
const stageFloorPointSchema = z
  .object({
    x: z.number().finite().min(SCENE.walk.left).max(SCENE.walk.right),
    y: z.number().finite().min(SCENE.walk.top).max(SCENE.walk.bottom),
  })
  .strict();
// Older clients still send a seat number. The server places every join at the tail.
export const stageJoinSchema = z
  .object({
    seat: stageSeatSchema.optional(),
    from: stageFloorPointSchema.optional(),
  })
  .strict();
export type StageJoin = z.infer<typeof stageJoinSchema>;
// Accept the old point payload while the server uses the saved pre-stage point.
export const stageLeaveSchema = z.union([
  z.object({}).strict(),
  stageFloorPointSchema,
]);
export type StageLeave = z.infer<typeof stageLeaveSchema>;
export interface Guest {
  registered?: boolean;
  email?: string;
  id: string;
  nickname: string;
  // Older snapshots without an appearance render with the default orange coat.
  appearance?: CatAppearance;
}
export interface AccountProfile extends Guest {
  nicknameChangeAvailableAt?: number;
}
export const roomNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export interface RoomInfo {
  number: number;
  stageCapacity: number;
  id: string;
  ownerId: string;
  ownerNickname: string;
  name: string;
  environmentId: import('./environments.js').EnvironmentId;
  joinPolicy: 'open' | 'closed';
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface RoomSummary extends RoomInfo {
  online: number;
  capacity: number;
  full: boolean;
  trackTitle?: string;
  trackCover?: string;
}
export const ROOM_DIRECTORY_PAGE_SIZE = 9;
export const roomDirectoryFilterSchema = z.enum([
  'all',
  'playing',
  'occupied',
  'empty',
]);
export type RoomDirectoryFilter = z.infer<typeof roomDirectoryFilterSchema>;
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  durationMs: number;
}
export interface SongLyrics {
  trackId: string;
  original: string;
  translation: string;
}
export interface NeteasePlaylist {
  id: string;
  name: string;
  cover: string;
  creator: string;
  trackCount: number;
}
export interface NeteasePlaylistSearch {
  playlists: NeteasePlaylist[];
  total: number;
  more: boolean;
}
export interface NeteaseUser {
  id: string;
  nickname: string;
  avatar: string;
}
export interface NeteaseUserSearch {
  users: NeteaseUser[];
  total: number;
  more: boolean;
}
export interface NeteaseUserPlaylistPage {
  playlists: NeteasePlaylist[];
  offset: number;
  more: boolean;
}
export interface NeteasePlaylistEntry {
  position: number;
  id: string;
  track: Track | null;
}
export interface NeteasePlaylistPage {
  playlist: NeteasePlaylist;
  tracks: NeteasePlaylistEntry[];
  total: number;
  offset: number;
}
export interface Participant extends Guest {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  movingSince: number;
  durationMs: number;
  seat: number | null;
  // Optional for compatibility with older snapshots; stop preserves this facing.
  facingRight?: boolean;
  clientMoveId?: number;
  connected: boolean;
}
// Authoritative movement for one existing audience member; shares room revision.
export interface RoomMotion {
  roomId?: string;
  revision: number;
  serverTime: number;
  userId: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  movingSince: number;
  durationMs: number;
  facingRight: boolean;
  // Omitted by legacy move/stop commands; clients must clear the prior marker.
  clientMoveId?: number;
}
// Transient notification only. Clients own display timing; snapshots omit emotes.
export interface RoomEmote {
  roomId?: string;
  userId: string;
  id: EmoteId;
}
export interface Playback {
  roundId: string;
  track: Track;
  djId: string;
  url: string;
  // Timeline origin in server time. Seeking rebases it within the same round.
  startedAt: number;
  durationMs: number;
  isTrial?: true;
  // Full-song lyric time differs from preview-relative audio time. Null means
  // the playable preview's full-song offset is unknown.
  lyricOffsetMs?: number | null;
}
// Shares the room revision sequence. Stage order can change without membership changing.
export interface PlaybackState {
  roomId?: string;
  revision: number;
  serverTime: number;
  playback: Playback | null;
  resolving: boolean;
  notice: string | null;
  stage?: string[];
}
export interface RoomSnapshot extends PlaybackState {
  room?: RoomInfo;
  users: Participant[];
  stage: string[];
  capacity: number;
  stageCapacity: number;
}
export interface Ack {
  ok: boolean;
  error?: string;
}
export interface MusicService {
  search(query: string): Promise<Track[]>;
  lyrics?(id: string): Promise<SongLyrics>;
  searchPlaylists?(
    query: string,
    offset?: number,
  ): Promise<NeteasePlaylistSearch>;
  searchUsers?(query: string, offset?: number): Promise<NeteaseUserSearch>;
  userPlaylists?(id: string, offset?: number): Promise<NeteaseUserPlaylistPage>;
  playlist?(
    id: string,
    offset?: number,
    limit?: number,
  ): Promise<NeteasePlaylistPage>;
  detail(id: string): Promise<Track>;
  resolve(track: Track): Promise<{
    url: string;
    durationMs: number;
    isTrial?: true;
    lyricOffsetMs?: number | null;
  }>;
}
export interface ClientEvents {
  'room:leave': (ack: (result: Ack) => void) => void;
  'stage:remove': (
    payload: { userId: string },
    ack: (result: Ack) => void,
  ) => void;
  'member:kick': (
    payload: { userId: string },
    ack: (result: Ack) => void,
  ) => void;
  'room:motion': (payload: ClientMotion, ack: (result: Ack) => void) => void;
  'room:stop': (ack: (result: Ack) => void) => void;
  'room:move': (
    payload: { x: number; y: number },
    ack: (result: Ack) => void,
  ) => void;
  'room:emote': (payload: { id: EmoteId }, ack: (result: Ack) => void) => void;
  'stage:join': (payload: StageJoin, ack: (result: Ack) => void) => void;
  'stage:leave': (payload: StageLeave, ack: (result: Ack) => void) => void;
  'playback:skip': (
    payload: { roundId: string },
    ack: (result: Ack) => void,
  ) => void;
  'playback:seek': (
    payload: { roundId: string; positionMs: number },
    ack: (result: Ack) => void,
  ) => void;
  'room:sync': (ack: (snapshot: RoomSnapshot) => void) => void;
}
export interface ServerEvents {
  'room:updated': (room: RoomInfo) => void;
  'room:removed': (event: { roomId: string; reason: string }) => void;
  'playlist:updated': (state: PlaylistState) => void;
  'playlist:reordered': (state: PlaylistOrder) => void;
  'room:snapshot': (snapshot: RoomSnapshot) => void;
  'room:motion': (state: RoomMotion) => void;
  'playback:updated': (state: PlaybackState) => void;
  'room:emote': (event: RoomEmote) => void;
  'emotes:updated': (event: { revision: number }) => void;
  'room:replaced': () => void;
}

export interface PlaylistState {
  tracks: Track[];
  revision: number;
  slot: number;
  count: number;
}
export interface PlaylistOrder {
  ids: string[];
  revision: number;
  slot: number;
}
export interface PlaylistImportResult extends PlaylistState {
  imported: number;
  duplicates: number;
  unavailable: number;
  overflow: number;
  scanned: number;
  start: number;
  end: number;
}

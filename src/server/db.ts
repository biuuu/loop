import Database from 'better-sqlite3';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_STAGE_CAPACITY,
  NICKNAME_CHANGE_COOLDOWN_MS,
  PLAYLIST_COUNT_LIMIT,
  PLAYLIST_LIMIT,
  type Guest,
  type RoomInfo,
  type NeteasePlaylistEntry,
  type PlaylistImportResult,
  type PlaylistOrder,
  type PlaylistState,
  type Track,
} from '../shared/contracts.js';
import {
  CAT_COATS,
  CAT_PATTERNS,
  catAppearanceSchema,
  type CatAppearance,
} from '../shared/appearance.js';
import { ENVIRONMENTS } from '../shared/environments.js';

const BASELINE_VERSION = 11;
const ROOM_COLUMNS = `r.id,n.number,r.owner_user_id AS ownerId,g.nickname AS ownerNickname,
  r.name,r.environment_id AS environmentId,r.join_policy AS joinPolicy,r.stage_capacity AS stageCapacity,r.revision,
  r.created_at AS createdAt,r.updated_at AS updatedAt`;
const ROOM_TABLES = `FROM rooms r JOIN guests g ON g.id=r.owner_user_id
  JOIN room_numbers n ON n.room_id=r.id`;

type GuestRow = {
  id: string;
  nickname: string;
  coat: CatAppearance['coat'];
  pattern: CatAppearance['pattern'];
};
type PlaylistSettings = Pick<PlaylistState, 'slot' | 'count' | 'revision'>;
const readGuest = ({ id, nickname, coat, pattern }: GuestRow): Guest => ({
  id,
  nickname,
  appearance: { coat, pattern },
});

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export class EmptyPlaylistImportError extends Error {
  constructor() {
    super('所选歌曲均不可导入，原歌单已保留');
  }
}
export class NicknameCooldownError extends Error {
  constructor(readonly nicknameChangeAvailableAt: number) {
    super('两次昵称修改需间隔 7 天');
  }
}
export class Store {
  readonly sql: Database.Database;
  constructor(
    path = process.env.DATABASE_PATH || 'data/loop.sqlite',
    migrationsPath = resolve('migrations'),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new Database(path);
    try {
      this.sql.pragma('foreign_keys = ON');
      const migrations = readdirSync(migrationsPath)
        .flatMap((name) => {
          const match = /^(\d+)-[^/]+\.sql$/.exec(name);
          return match ? [{ name, version: Number(match[1]) }] : [];
        })
        .sort((a, b) => a.version - b.version);
      if (migrations[0]?.name !== '011-baseline.sql')
        throw new Error('Missing migration 011-baseline.sql');
      for (const [index, migration] of migrations.entries()) {
        const expected = BASELINE_VERSION + index;
        if (migration.version !== expected)
          throw new Error(`Missing migration ${expected}`);
      }
      const latest = migrations.at(-1)!.version;
      this.sql
        .transaction(() => {
          const version = Number(
            this.sql.pragma('user_version', { simple: true }),
          );
          if (version === 0) {
            const existing = this.sql
              .prepare(
                "SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
              )
              .get();
            if (existing) throw new Error('Unversioned database is not empty');
          } else if (version < BASELINE_VERSION) {
            throw new Error(
              `Unsupported database version ${version}; first supported version is ${BASELINE_VERSION}`,
            );
          } else if (version > latest) {
            throw new Error(
              `Database version ${version} is newer than supported version ${latest}`,
            );
          }
          for (const migration of migrations) {
            if (migration.version <= version) continue;
            this.sql.exec(
              readFileSync(join(migrationsPath, migration.name), 'utf8'),
            );
            this.sql.pragma(`user_version = ${migration.version}`);
          }
        })
        .immediate();
      this.sql.pragma('journal_mode = WAL');
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  createGuest(nickname: string): { guest: Guest; token: string } {
    const token = randomBytes(32).toString('base64url');
    const guest = {
      id: randomUUID(),
      nickname,
      appearance: {
        coat: CAT_COATS[randomInt(CAT_COATS.length)]!.id,
        pattern: CAT_PATTERNS[randomInt(CAT_PATTERNS.length)]!.id,
      },
    };
    this.sql.transaction(() => {
      this.sql
        .prepare(
          'INSERT INTO guests (id,nickname,token_hash,coat,pattern) VALUES (?,?,?,?,?)',
        )
        .run(
          guest.id,
          nickname,
          hashToken(randomBytes(32).toString('hex')),
          guest.appearance.coat,
          guest.appearance.pattern,
        );
      const now = Date.now();
      this.sql
        .prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
        .run(
          hashToken(token),
          guest.id,
          'temporary',
          now,
          now + 365 * 24 * 3600_000,
        );
    })();
    return { guest, token };
  }
  createUser(nickname: string): {
    guest: Guest;
    token: string;
    createdRoom: RoomInfo;
  } {
    return this.sql.transaction(() => {
      const created = this.createGuest(nickname);
      const createdRoom = this.createRoom(
        created.guest.id,
        `${nickname}的房间`,
        ENVIRONMENTS[randomInt(ENVIRONMENTS.length)]!.id,
      );
      return { ...created, createdRoom };
    })();
  }
  createUserFromPlaylist(
    nickname: string,
    entries: NeteasePlaylistEntry[],
  ): {
    guest: Guest;
    token: string;
    createdRoom: RoomInfo;
  } {
    return this.sql.transaction(() => {
      const created = this.createUser(nickname);
      this.importTracks(
        created.guest.id,
        entries.slice(0, PLAYLIST_LIMIT),
        1,
        'replace',
      );
      return created;
    })();
  }
  guest(token?: string): Guest | null {
    if (!token) return null;
    const hashed = hashToken(token);
    const row = this.sql
      .prepare(
        `SELECT g.id,g.nickname,g.coat,g.pattern FROM guests g
      JOIN sessions s ON s.user_id=g.id WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(hashed, Date.now()) as GuestRow | undefined;
    if (row) return readGuest(row);
    // Migrated, pre-session cookies remain usable until logout or first binding.
    const legacy = this.sql
      .prepare('SELECT id,nickname,coat,pattern FROM guests WHERE token_hash=?')
      .get(hashed) as GuestRow | undefined;
    return legacy ? readGuest(legacy) : null;
  }
  rename(
    id: string,
    nickname: string,
    now = Date.now(),
  ): { guest: Guest; changed: boolean } {
    return this.sql
      .transaction(() => {
        const guest = this.guestById(id);
        if (guest.nickname === nickname) return { guest, changed: false };
        const availableAt = this.nicknameChangeAvailableAt(id);
        if (availableAt !== undefined && now < availableAt)
          throw new NicknameCooldownError(availableAt);
        this.sql
          .prepare(
            'UPDATE guests SET nickname=?,nickname_changed_at=? WHERE id=?',
          )
          .run(nickname, now, id);
        return { guest: { ...guest, nickname }, changed: true };
      })
      .immediate();
  }
  nicknameChangeAvailableAt(id: string): number | undefined {
    const row = this.sql
      .prepare('SELECT nickname_changed_at FROM guests WHERE id=?')
      .get(id) as { nickname_changed_at: number | null } | undefined;
    const changedAt = row?.nickname_changed_at;
    return changedAt == null
      ? undefined
      : changedAt + NICKNAME_CHANGE_COOLDOWN_MS;
  }
  guestById(id: string): Guest {
    const row = this.sql
      .prepare('SELECT id,nickname,coat,pattern FROM guests WHERE id=?')
      .get(id) as GuestRow | undefined;
    if (!row) throw new Error('游客不存在');
    return readGuest(row);
  }
  updateAppearance(id: string, input: CatAppearance): Guest {
    const appearance = catAppearanceSchema.parse(input);
    this.sql
      .prepare('UPDATE guests SET coat=?,pattern=? WHERE id=?')
      .run(appearance.coat, appearance.pattern, id);
    return this.guestById(id);
  }
  tracks(id: string, slot?: number): Track[] {
    return this.tracksAt(
      id,
      slot === undefined
        ? (this.playlistSettings(id)?.slot ?? 1)
        : this.playlistSlot(id, slot),
    );
  }
  private tracksAt(id: string, slot: number): Track[] {
    return (
      this.sql
        .prepare(
          'SELECT track_json FROM playlist WHERE guest_id=? AND slot=? ORDER BY position',
        )
        .all(id, slot) as { track_json: string }[]
    ).map((row) => JSON.parse(row.track_json));
  }
  playlist(id: string): PlaylistState {
    return this.sql.transaction(() => {
      const settings = this.guestPlaylistSettings(id);
      return { ...settings, tracks: this.tracksAt(id, settings.slot) };
    })();
  }
  playlistOrder(id: string): PlaylistOrder {
    return this.sql.transaction(() => {
      const { slot, revision } = this.guestPlaylistSettings(id);
      const rows = this.sql
        .prepare(
          'SELECT track_id FROM playlist WHERE guest_id=? AND slot=? ORDER BY position',
        )
        .all(id, slot) as { track_id: string }[];
      return { slot, revision, ids: rows.map((row) => row.track_id) };
    })();
  }
  playlistSlot(id: string, slot?: number): number {
    const settings = this.guestPlaylistSettings(id);
    if (slot === undefined) return settings.slot;
    if (!Number.isInteger(slot) || slot < 1 || slot > settings.count)
      throw new Error('歌单不存在');
    return slot;
  }
  createPlaylist(id: string): PlaylistState {
    return this.sql
      .transaction(() => {
        const { count } = this.guestPlaylistSettings(id);
        if (count >= PLAYLIST_COUNT_LIMIT)
          throw new Error(`最多创建 ${PLAYLIST_COUNT_LIMIT} 个歌单`);
        this.sql
          .prepare(
            `UPDATE guests
             SET playlist_count=playlist_count+1,playlist_slot=playlist_count+1,
                 playlist_revision=playlist_revision+1
             WHERE id=?`,
          )
          .run(id);
        return this.playlist(id);
      })
      .immediate();
  }
  selectPlaylist(id: string, slot: number): PlaylistState {
    return this.sql
      .transaction(() => {
        this.playlistSlot(id, slot);
        this.sql
          .prepare(
            `UPDATE guests SET playlist_slot=?,playlist_revision=playlist_revision+1
             WHERE id=? AND playlist_slot<>?`,
          )
          .run(slot, id, slot);
        return this.playlist(id);
      })
      .immediate();
  }
  private playlistSettings(id: string): PlaylistSettings | undefined {
    return this.sql
      .prepare(
        `SELECT playlist_slot AS slot,playlist_count AS count,playlist_revision AS revision
         FROM guests WHERE id=?`,
      )
      .get(id) as PlaylistSettings | undefined;
  }
  private guestPlaylistSettings(id: string): PlaylistSettings {
    const row = this.playlistSettings(id);
    if (!row) throw new Error('游客不存在');
    return row;
  }
  private editTracks(
    id: string,
    slot: number | undefined,
    edit: (tracks: Track[]) => Track[],
  ): Track[] {
    return this.sql
      .transaction(() => {
        const target = this.playlistSlot(id, slot);
        const before = this.tracksAt(id, target);
        const after = edit(before);
        if (
          before.length === after.length &&
          before.every((track, index) => track.id === after[index]!.id)
        )
          return before;
        const remove = this.sql.prepare(
          'DELETE FROM playlist WHERE guest_id=? AND slot=? AND track_id=?',
        );
        for (const track of before)
          if (!after.some((item) => item.id === track.id))
            remove.run(id, target, track.id);
        const insert = this.sql.prepare(
          'INSERT OR IGNORE INTO playlist (guest_id,slot,track_id,position,track_json) VALUES (?,?,?,?,?)',
        );
        const position = this.sql.prepare(
          'UPDATE playlist SET position=? WHERE guest_id=? AND slot=? AND track_id=?',
        );
        after.forEach((track, index) => {
          insert.run(id, target, track.id, index, JSON.stringify(track));
          position.run(index, id, target, track.id);
        });
        this.sql
          .prepare(
            'UPDATE guests SET playlist_revision=playlist_revision+1 WHERE id=?',
          )
          .run(id);
        return after;
      })
      .immediate();
  }
  add(id: string, track: Track, slot?: number): Track[] {
    return this.editTracks(id, slot, (tracks) => {
      if (tracks.some((item) => item.id === track.id)) return tracks;
      if (tracks.length >= PLAYLIST_LIMIT)
        throw new Error(`歌单最多 ${PLAYLIST_LIMIT} 首`);
      return [...tracks, track];
    });
  }
  importTracks(
    id: string,
    entries: NeteasePlaylistEntry[],
    start: number,
    mode: 'replace' | 'append' = 'append',
    slot?: number,
  ): PlaylistImportResult {
    const summary = { imported: 0, duplicates: 0, unavailable: 0, overflow: 0 };
    // Read the latest queue after upstream metadata arrives. Append incorporates
    // concurrent edits; replace atomically replaces that latest queue.
    this.editTracks(id, slot, (tracks) => {
      const after = mode === 'replace' ? [] : [...tracks];
      const seen = new Set(after.map((track) => track.id));
      for (const entry of entries) {
        if (!entry.track) {
          summary.unavailable++;
          continue;
        }
        if (seen.has(entry.track.id)) {
          summary.duplicates++;
          continue;
        }
        seen.add(entry.track.id);
        if (after.length >= PLAYLIST_LIMIT) {
          summary.overflow++;
          continue;
        }
        after.push(entry.track);
        summary.imported++;
      }
      if (mode === 'replace' && after.length === 0)
        throw new EmptyPlaylistImportError();
      return after;
    });
    return {
      ...this.playlist(id),
      ...summary,
      scanned: entries.length,
      start,
      end: entries.length ? entries[entries.length - 1]!.position : start - 1,
    };
  }
  remove(id: string, trackId: string, slot?: number): Track[] {
    return this.editTracks(id, slot, (tracks) =>
      tracks.filter((track) => track.id !== trackId),
    );
  }
  order(id: string, ids: string[], slot?: number): Track[] {
    return this.editTracks(id, slot, (tracks) => {
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== tracks.length ||
        ids.some((key) => !tracks.some((track) => track.id === key))
      )
        throw new Error('必须提供完整且无重复的歌单顺序');
      return ids.map((key) => tracks.find((track) => track.id === key)!);
    });
  }
  moveTrack(
    id: string,
    trackId: string,
    targetId: string | undefined,
    placement: 'before' | 'after' | 'first',
    slot?: number,
  ): Track[] {
    return this.editTracks(id, slot, (tracks) => {
      const track = tracks.find((item) => item.id === trackId);
      if (
        !track ||
        (placement !== 'first' && !tracks.some((item) => item.id === targetId))
      )
        throw new Error('歌曲已不在歌单中，请重新排序');
      if (placement !== 'first' && trackId === targetId) return tracks;
      const next = tracks.filter((item) => item.id !== trackId);
      if (placement === 'first') return [track, ...next];
      const index = next.findIndex((item) => item.id === targetId);
      next.splice(index + (placement === 'after' ? 1 : 0), 0, track);
      return next;
    });
  }
  firstTrack(id: string, slot?: number): Track | null {
    return this.tracks(id, slot)[0] ?? null;
  }
  rotateTrack(
    id: string,
    trackId: string,
    playback?: { roomId: string; startedAt: number },
    slot?: number,
  ): Track[] {
    return this.editTracks(id, slot, (tracks) => {
      if (playback)
        this.sql
          .prepare('UPDATE rooms SET last_played_at=? WHERE id=?')
          .run(playback.startedAt, playback.roomId);
      const played = tracks.find((track) => track.id === trackId);
      return played
        ? [...tracks.filter((track) => track.id !== trackId), played]
        : tracks;
    });
  }
  room(id: string): RoomInfo | null {
    const row = this.sql
      .prepare(`SELECT ${ROOM_COLUMNS} ${ROOM_TABLES} WHERE r.id=?`)
      .get(id);
    return (row as RoomInfo | undefined) ?? null;
  }
  roomByNumber(number: number): RoomInfo | null {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const row = this.sql
      .prepare(`SELECT ${ROOM_COLUMNS} ${ROOM_TABLES} WHERE n.number=?`)
      .get(number);
    return (row as RoomInfo | undefined) ?? null;
  }
  roomByOwner(userId: string): RoomInfo | null {
    const row = this.sql
      .prepare(`SELECT ${ROOM_COLUMNS} ${ROOM_TABLES} WHERE r.owner_user_id=?`)
      .get(userId);
    return (row as RoomInfo | undefined) ?? null;
  }
  rooms(): RoomInfo[] {
    return this.sql
      .prepare(
        `SELECT ${ROOM_COLUMNS} ${ROOM_TABLES} ORDER BY r.created_at,r.id`,
      )
      .all() as RoomInfo[];
  }
  roomsForDirectory(): Array<RoomInfo & { lastPlayedAt: number | null }> {
    return this.sql
      .prepare(
        `SELECT ${ROOM_COLUMNS},r.last_played_at AS lastPlayedAt ${ROOM_TABLES} ORDER BY r.created_at,r.id`,
      )
      .all() as Array<RoomInfo & { lastPlayedAt: number | null }>;
  }
  createRoom(
    ownerId: string,
    name: string,
    environmentId: string,
    stageCapacity = DEFAULT_STAGE_CAPACITY,
  ): RoomInfo {
    const id = randomUUID(),
      now = Date.now();
    return this.sql.transaction(() => {
      this.sql
        .prepare(
          'INSERT INTO rooms (id,owner_user_id,name,environment_id,stage_capacity,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, ownerId, name, environmentId, stageCapacity, now, now);
      this.sql.prepare('INSERT INTO room_numbers (room_id) VALUES (?)').run(id);
      return this.room(id)!;
    })();
  }
  updateRoom(
    id: string,
    revision: number,
    changes: Pick<RoomInfo, 'name' | 'environmentId' | 'joinPolicy'> &
      Partial<Pick<RoomInfo, 'stageCapacity'>>,
  ): boolean {
    return Boolean(
      this.sql
        .prepare(
          `UPDATE rooms SET name=?,environment_id=?,join_policy=?,stage_capacity=COALESCE(?,stage_capacity),revision=revision+1,
      updated_at=? WHERE id=? AND revision=?`,
        )
        .run(
          changes.name,
          changes.environmentId,
          changes.joinPolicy,
          changes.stageCapacity ?? null,
          Date.now(),
          id,
          revision,
        ).changes,
    );
  }
  deleteRoom(id: string) {
    this.sql.prepare('DELETE FROM rooms WHERE id=?').run(id);
  }
  banned(roomId: string, userId: string): boolean {
    return Boolean(
      this.sql
        .prepare('SELECT 1 FROM room_bans WHERE room_id=? AND user_id=?')
        .get(roomId, userId),
    );
  }
  bans(roomId: string) {
    return this.sql
      .prepare(
        `SELECT b.user_id AS userId,g.nickname,b.created_at AS createdAt FROM room_bans b
      JOIN guests g ON g.id=b.user_id WHERE b.room_id=? ORDER BY b.created_at,b.user_id`,
      )
      .all(roomId);
  }
  ban(roomId: string, userId: string) {
    this.sql
      .prepare('INSERT OR IGNORE INTO room_bans VALUES (?,?,?)')
      .run(roomId, userId, Date.now());
  }
  unban(roomId: string, userId: string) {
    this.sql
      .prepare('DELETE FROM room_bans WHERE room_id=? AND user_id=?')
      .run(roomId, userId);
  }
  close() {
    this.sql.close();
  }
}

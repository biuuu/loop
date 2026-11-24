import type { Server, Socket } from 'socket.io';
import type { CatAppearance } from '../shared/appearance.js';
import {
  ROOM_CAPACITY,
  type Guest,
  type MusicService,
  type PlaylistState,
  type RoomDetails,
  type RoomSnapshot,
  type RoomSummary,
} from '../shared/contracts.js';
import { HttpError, publicGuest } from './auth.js';
import type { Store } from './db.js';
import { Room } from './room.js';
import type { EmoteCatalog } from './emote-catalog.js';

type Active = { roomId: string; socket: Socket; tokenHash: string };
const channel = (id: string) => `room:${id}`;
export class RoomRegistry {
  private live = new Map<string, Room>();
  private active = new Map<string, Active>();
  readonly singleRoom?: Room;
  constructor(
    private db: Store,
    private music: MusicService,
    private io: Server,
    private options: {
      disconnectGraceMs?: number;
      resolveTimeoutMs?: number;
      singleRoom?: boolean;
      emoteCatalog?: EmoteCatalog;
    } = {},
  ) {
    if (options.singleRoom) this.singleRoom = this.runtime('__test__');
  }
  private runtime(id: string) {
    let room = this.live.get(id);
    if (room) return room;
    room = new Room(
      this.db,
      this.music,
      {
        ...this.options,
        roomId: id === '__test__' ? undefined : id,
        stageCapacity: id === '__test__' ? 6 : this.info(id).stageCapacity,
      },
      this.options.emoteCatalog,
    );
    this.live.set(id, room);
    room.onChange = (snapshot) => {
      if (this.live.get(id) !== room) return;
      const members = new Set(snapshot.users.map((user) => user.id));
      for (const [userId, current] of this.active)
        if (current.roomId === id && !members.has(userId))
          this.active.delete(userId);
      this.io
        .to(channel(id))
        .emit('room:snapshot', this.decorate(id, snapshot));
    };
    room.onPlaybackChange = (state) =>
      this.io.to(channel(id)).emit('playback:updated', this.scoped(id, state));
    room.onMotion = (state) =>
      this.io.to(channel(id)).emit('room:motion', this.scoped(id, state));
    room.onEmote = (state) =>
      this.io.to(channel(id)).emit('room:emote', this.scoped(id, state));
    room.onPlaylistChange = (userId, state) => {
      const current = this.active.get(userId);
      if (current?.roomId === id && room!.isCurrent(userId, current.socket.id))
        current.socket.emit('playlist:reordered', state);
    };
    room.onEmpty = () => {
      if (
        this.singleRoom === room ||
        (this.options.singleRoom && id === '__test__')
      )
        return;
      if (this.live.get(id) !== room) return;
      this.live.delete(id);
      for (const [userId, current] of this.active)
        if (current.roomId === id) this.active.delete(userId);
      room!.close();
    };
    return room;
  }
  private scoped<T extends object>(
    id: string,
    value: T,
  ): T & { roomId?: string } {
    return id === '__test__' ? value : { ...value, roomId: id };
  }
  private decorate(id: string, snapshot: RoomSnapshot): RoomSnapshot {
    return id === '__test__'
      ? snapshot
      : { ...snapshot, roomId: id, room: this.db.roomDetails(id) ?? undefined };
  }
  info(id: string) {
    const info = this.db.room(id);
    if (!info) throw new HttpError(404, '房间不存在或已被删除');
    return info;
  }
  details(id: string) {
    const details = this.db.roomDetails(id);
    if (!details) throw new HttpError(404, '房间不存在或已被删除');
    return details;
  }
  owner(id: string, userId: string) {
    const info = this.info(id);
    if (info.ownerId !== userId)
      throw new HttpError(403, '只有房主可以执行此操作');
    return info;
  }
  summaries(): RoomSummary[] {
    return this.db
      .roomsForDirectory()
      .map((info) => {
        const snapshot = this.live.get(info.id)?.snapshot();
        return {
          ...info,
          online: snapshot?.users.filter((user) => user.connected).length ?? 0,
          capacity: ROOM_CAPACITY,
          full: (snapshot?.users.length ?? 0) >= ROOM_CAPACITY,
          ...(snapshot?.playback
            ? {
                trackTitle: snapshot.playback.track.title,
                ...(snapshot.playback.track.cover
                  ? { trackCover: snapshot.playback.track.cover }
                  : {}),
              }
            : {}),
        };
      })
      .sort((a, b) => {
        if (a.lastPlayedAt !== b.lastPlayedAt)
          return (b.lastPlayedAt ?? -Infinity) - (a.lastPlayedAt ?? -Infinity);
        return (
          b.online - a.online ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id)
        );
      })
      .map(({ lastPlayedAt, ...summary }) => summary);
  }
  admit(id: string, userId: string) {
    if (id !== '__test__' || !this.options.singleRoom) {
      const info = this.info(id);
      if (this.db.banned(id, userId))
        throw new HttpError(403, '你已被禁止进入此房间');
      const existing = this.live
        .get(id)
        ?.snapshot()
        .users.some((user) => user.id === userId);
      if (info.joinPolicy === 'closed' && info.ownerId !== userId && !existing)
        throw new HttpError(403, '房主已暂停新成员进入');
    }
    if (this.live.get(id)?.canConnect(userId) === false)
      throw new HttpError(409, '房间已满');
  }
  connect(id: string, guest: Guest, socket: Socket, tokenHash: string) {
    // No await between admission and commit. A failed admission preserves the previous room.
    this.admit(id, guest.id);
    const next = this.runtime(id),
      previous = this.active.get(guest.id);
    if (previous && previous.roomId !== id) {
      this.active.delete(guest.id);
      void this.live
        .get(previous.roomId)
        ?.removeMember(guest.id, previous.socket.id);
      previous.socket.emit('room:replaced');
      previous.socket.disconnect(true);
    }
    this.active.set(guest.id, { roomId: id, socket, tokenHash });
    socket.join(channel(id));
    next.connect(publicGuest(guest), {
      id: socket.id,
      replaced: () => {
        socket.emit('room:replaced');
        socket.disconnect(true);
      },
    });
    return next;
  }
  isCurrent(id: string, userId: string, socketId: string) {
    const entry = this.active.get(userId);
    return (
      entry?.roomId === id &&
      entry.socket.id === socketId &&
      Boolean(this.live.get(id)?.isCurrent(userId, socketId))
    );
  }
  snapshot(id: string) {
    const room = this.live.get(id);
    if (!room) throw new HttpError(404, '房间会话已结束');
    return this.decorate(id, room.snapshot());
  }
  disconnect(id: string, userId: string, socketId: string) {
    if (this.isCurrent(id, userId, socketId))
      this.live.get(id)!.disconnect(userId, socketId);
  }
  leave(id: string, userId: string, socketId: string) {
    if (!this.isCurrent(id, userId, socketId))
      throw new HttpError(409, '连接已被替换');
    const active = this.active.get(userId)!;
    this.active.delete(userId);
    void this.live.get(id)?.removeMember(userId, socketId);
    active.socket.leave(channel(id));
    // Allow the command acknowledgement to reach the client before closing the transport.
    setImmediate(() => active.socket.disconnect(true));
  }
  private remove(id: string, userId: string, reason: string) {
    const active = this.active.get(userId);
    if (active?.roomId === id) {
      this.active.delete(userId);
      active.socket.emit('room:removed', { roomId: id, reason });
      active.socket.leave(channel(id));
      active.socket.disconnect(true);
    }
    void this.live.get(id)?.removeMember(userId);
  }
  kick(id: string, ownerId: string, targetId: string) {
    this.owner(id, ownerId);
    if (targetId === ownerId) throw new HttpError(400, '不能移出房主自己');
    if (
      !this.live
        .get(id)
        ?.snapshot()
        .users.some((user) => user.id === targetId)
    )
      throw new HttpError(404, '成员已离开房间');
    this.remove(id, targetId, '你已被房主移出房间');
  }
  forceLeave(id: string, ownerId: string, targetId: string) {
    this.owner(id, ownerId);
    if (targetId === ownerId) throw new HttpError(400, '请使用自己的下台操作');
    const room = this.live.get(id);
    if (!room?.snapshot().users.some((user) => user.id === targetId))
      throw new HttpError(404, '成员已离开房间');
    return room.forceLeave(targetId);
  }
  ban(id: string, ownerId: string, targetId: string) {
    this.owner(id, ownerId);
    if (targetId === ownerId) throw new HttpError(400, '不能封禁房主自己');
    try {
      this.db.guestById(targetId);
    } catch {
      throw new HttpError(404, '用户不存在');
    }
    this.db.ban(id, targetId);
    this.remove(id, targetId, '你已被房主禁止进入此房间');
  }
  updated(info: RoomDetails) {
    this.live.get(info.id)?.configureStage(info.stageCapacity);
    this.io.to(channel(info.id)).emit('room:updated', info);
  }
  assertStageCapacity(id: string, capacity: number) {
    try {
      this.live.get(id)?.assertStageCapacity(capacity);
    } catch {
      throw new HttpError(409, '请先让多余的成员下台，再减少舞台席位');
    }
  }
  revoke(userId: string, tokenHash?: string) {
    const current = this.active.get(userId);
    if (current && (!tokenHash || current.tokenHash === tokenHash))
      this.remove(current.roomId, userId, '账号会话已结束，请重新登录');
  }
  updateAppearance(userId: string, appearance: CatAppearance) {
    const current = this.active.get(userId);
    if (current)
      this.live.get(current.roomId)?.updateAppearance(userId, appearance);
  }
  publishPlaylist(userId: string, state: PlaylistState) {
    const current = this.active.get(userId);
    if (current && this.isCurrent(current.roomId, userId, current.socket.id))
      current.socket.emit('playlist:updated', state);
  }
  updateNickname(userId: string, nickname: string) {
    const current = this.active.get(userId);
    if (current)
      this.live.get(current.roomId)?.updateNickname(userId, nickname);
    const owned = this.db.roomByOwner(userId);
    if (owned && owned.id !== current?.roomId && this.live.has(owned.id))
      this.updated(this.details(owned.id));
  }
  members(id: string, ownerId: string) {
    this.owner(id, ownerId);
    return this.live.get(id)?.snapshot().users ?? [];
  }
  runtimeCount() {
    return this.live.size;
  }
  close() {
    for (const room of this.live.values()) room.close();
    this.live.clear();
    this.active.clear();
  }
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EMOTE_COOLDOWN_MS,
  moveSchema,
  motionSchema,
  stageLeaveSchema,
  SCENE,
  ROOM_CAPACITY,
  STAGE_CAPACITY,
  DEFAULT_STAGE_CAPACITY,
  stageCapacitySchema,
  DEFAULT_STAGE_TIME_LIMIT_MINUTES,
  stageTimeLimitMinutesSchema,
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  trackTimeLimitMinutesSchema,
  stageSeatXs,
  type Guest,
  type MusicService,
  type Participant,
  type PlaylistOrder,
  type Playback,
  type PlaybackState,
  type RoomSnapshot,
  type RoomEmote,
  type RoomMotion,
  type StageJoin,
} from '../shared/contracts.js';
import { catSleepDelay } from '../shared/cat-activity.js';
import type { Store } from './db.js';
import { EmoteCatalog } from './emote-catalog.js';
import {
  catAppearanceSchema,
  type CatAppearance,
} from '../shared/appearance.js';
import {
  MusicPlaybackError,
  type MusicPlaybackFailure,
} from './music-errors.js';
import type { RoomCheckpoint } from './room-checkpoint.js';

type Connection = { id: string; replaced(): void };
type FailedAttempt = { kind: MusicPlaybackFailure | 'unknown'; title: string };
type DjPlaybackInterval = { userId: string; from: number; to: number };
function playbackFailureNotice(failures: FailedAttempt[]) {
  const title =
    failures.length === 1
      ? failures[0]!.title
          .replace(/[\p{Cc}\p{Cf}]/gu, '')
          .trim()
          .slice(0, 60)
      : '';
  const target =
    failures.length === 1
      ? title
        ? `的《${title}》`
        : '的歌曲'
      : `的 ${failures.length} 首歌曲`;
  const kinds = new Set(failures.map((failure) => failure.kind));
  const reasons: string[] = [];
  if (kinds.has('unavailable'))
    reasons.push(
      `${failures.length === 1 ? '' : '有歌曲'}暂无可播放地址（可能暂不可用，或需要网易云登录或相应权限）`,
    );
  if (kinds.has('upstream')) reasons.push('网易云暂时无法访问');
  if (kinds.has('timeout')) reasons.push('播放地址解析超时');
  if (kinds.has('unknown')) reasons.push('播放地址解析失败');
  const retry = kinds.has('unavailable')
    ? kinds.size > 1
      ? '请换歌或调整歌单，稍后下台重新上台重试。'
      : '请换歌或调整歌单后下台重新上台重试。'
    : '请稍后下台重新上台重试。';
  return `本轮尝试${target}未能播放：${reasons.join('；')}。${retry}`;
}
const spawnSeatXs = stageSeatXs(STAGE_CAPACITY);
const SPAWN_ATTEMPTS = 24;
const SPAWN_SEPARATION = 32;
const playbackRoundSchema = z.object({ roundId: z.string().uuid() }).strict();
const seekSchema = z
  .object({ roundId: z.string().uuid(), positionMs: z.number().nonnegative() })
  .strict();
export class Room {
  private users = new Map<string, Participant>();
  private connections = new Map<string, Connection>();
  private grace = new Map<
    string,
    { until: number; timer: ReturnType<typeof setTimeout> }
  >();
  private emoteTimes = new Map<string, number>();
  private emoteCatalog: EmoteCatalog;
  private stage: string[] = [];
  private stageEntries = new Map<
    string,
    { returnPosition: { x: number; y: number }; joinedAt: number }
  >();
  private stageCapacity: number;
  private stageTimeLimitMinutes: number;
  private trackTimeLimitMinutes: number;
  private stageDirty = false;
  private publishedStage: string[] = [];
  private playback: Playback | null = null;
  private djPlaybackFrom?: number;
  private unsettledDjPlayback: DjPlaybackInterval[] = [];
  private failedMedia = new Map<string, Set<string>>();
  private resolving = false;
  private notice: string | null = null;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private resolutionGeneration = 0;
  private pendingDj: string | null = null;
  private cancelResolution?: () => void;
  private waitingForReconnect = false;
  private lastCheckpoint?: string;
  onEmpty: () => void = () => {};
  onChange: (snapshot: RoomSnapshot) => void = () => {};
  onPlaybackChange: (state: PlaybackState) => void = () => {};
  onEmote: (event: RoomEmote) => void = () => {};
  onMotion: (event: RoomMotion) => void = () => {};
  onPlaylistChange: (guestId: string, state: PlaylistOrder) => void = () => {};
  onPointsAwarded: (guestId: string, awarded: number) => void = () => {};
  hasMember(id: string) {
    return this.users.has(id);
  }
  canConnect(id: string) {
    return this.hasMember(id) || this.users.size < ROOM_CAPACITY;
  }
  isCurrent(id: string, connectionId: string) {
    return this.connections.get(id)?.id === connectionId;
  }
  constructor(
    private db: Store,
    private music: MusicService,
    private options: {
      roomId?: string;
      disconnectGraceMs?: number;
      resolveTimeoutMs?: number;
      stageCapacity?: number;
      stageTimeLimitMinutes?: number;
      trackTimeLimitMinutes?: number;
    } = {},
    emoteCatalog?: EmoteCatalog,
  ) {
    this.emoteCatalog = emoteCatalog ?? new EmoteCatalog(db);
    this.stageCapacity = stageCapacitySchema.parse(
      options.stageCapacity ?? DEFAULT_STAGE_CAPACITY,
    );
    this.stageTimeLimitMinutes = stageTimeLimitMinutesSchema.parse(
      options.stageTimeLimitMinutes ?? DEFAULT_STAGE_TIME_LIMIT_MINUTES,
    );
    this.trackTimeLimitMinutes = trackTimeLimitMinutesSchema.parse(
      options.trackTimeLimitMinutes ?? DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    );
  }
  assertStageCapacity(capacity: number) {
    stageCapacitySchema.parse(capacity);
    if (this.stage.length > capacity)
      throw new Error('请先让多余的成员下台，再减少舞台席位');
  }
  configureStage(capacity: number) {
    this.assertStageCapacity(capacity);
    if (this.stageCapacity === capacity) return;
    this.stageCapacity = capacity;
    this.positionStage();
    this.publish();
  }
  configureStageTimeLimit(minutes: number): void {
    this.stageTimeLimitMinutes = stageTimeLimitMinutesSchema.parse(minutes);
  }
  configureTrackTimeLimit(minutes: number): void {
    this.trackTimeLimitMinutes = trackTimeLimitMinutesSchema.parse(minutes);
  }
  private captureCheckpoint(
    savedAt: number,
    playback = this.playback,
  ): RoomCheckpoint | null {
    if (!this.users.size) return null;
    return {
      savedAt,
      members: [...this.users.values()].map((user) => {
        const entry = this.stageEntries.get(user.id);
        const position = entry?.returnPosition ?? this.position(user, savedAt);
        const grace = this.grace.get(user.id);
        return {
          id: user.id,
          ...position,
          facingRight: user.facingRight ?? false,
          ...(user.sleepAt === undefined ? {} : { sleepAt: user.sleepAt }),
          ...(grace ? { reconnectUntil: grace.until } : {}),
          ...(entry ? { stageJoinedAt: entry.joinedAt } : {}),
        };
      }),
      stage: [...this.stage],
      playback,
    };
  }
  private recordDjPlayback(interval: DjPlaybackInterval): boolean {
    const { userId, from, to } = interval;
    let awarded: number;
    try {
      awarded = this.db.recordDjPlayback(userId, from, to);
    } catch (error) {
      console.error(
        'Failed to record DJ playback time',
        this.options.roomId,
        error,
      );
      return false;
    }
    if (awarded) this.onPointsAwarded(userId, awarded);
    return true;
  }
  private settleDjPlayback(at = Date.now(), stopping = false): void {
    // Retired rounds are retried in order if an earlier SQLite write failed.
    const pending = this.unsettledDjPlayback;
    while (pending[0] && this.recordDjPlayback(pending[0])) pending.shift();
    const from = this.djPlaybackFrom;
    const playback = this.playback;
    if (from !== undefined && playback) {
      const to = Math.floor(
        Math.min(at, playback.startedAt + playback.durationMs),
      );
      if (to > from) {
        const interval = { userId: playback.djId, from, to };
        if (!pending.length && this.recordDjPlayback(interval))
          this.djPlaybackFrom = to;
        else if (stopping) pending.push(interval);
      }
    }
    if (stopping) this.djPlaybackFrom = undefined;
  }
  checkpoint(): void {
    if (this.closed) return;
    const now = Date.now();
    this.settleDjPlayback(now);
    if (!this.options.roomId) return;
    const checkpoint = this.captureCheckpoint(now);
    const serialized = JSON.stringify(checkpoint);
    if (serialized === this.lastCheckpoint) return;
    try {
      this.db.saveRoomCheckpoint(this.options.roomId, checkpoint);
      this.lastCheckpoint = serialized;
    } catch (error) {
      console.error(
        'Failed to save room checkpoint',
        this.options.roomId,
        error,
      );
    }
  }
  restoreCheckpoint(checkpoint: RoomCheckpoint): void {
    const roomId = this.options.roomId;
    if (this.closed || !roomId) return;
    const now = Date.now();
    const members = new Map(
      checkpoint.members.map((member) => [member.id, member]),
    );
    for (const member of members.values()) {
      const { id, x, y, facingRight } = member;
      const until = member.reconnectUntil ?? now + this.disconnectGraceMs;
      if (until <= now || this.db.banned(roomId, id)) continue;
      let guest: Guest;
      try {
        guest = this.db.guestById(id);
      } catch (error) {
        if (error instanceof Error && error.message === '游客不存在') continue;
        throw error;
      }
      this.users.set(id, {
        ...guest,
        x,
        y,
        targetX: x,
        targetY: y,
        movingSince: now,
        durationMs: 0,
        facingRight,
        seat: null,
        connected: false,
        sleepAt: member.sleepAt ?? now + catSleepDelay(id),
      });
      this.reserveMember(id, until, now);
    }
    if (!this.users.size) {
      this.checkpoint();
      this.onEmpty();
      return;
    }
    // A retained round can finish during grace. The next round needs a listener.
    this.waitingForReconnect = true;
    this.stage = checkpoint.stage
      .filter((id) => this.users.has(id))
      .slice(0, this.stageCapacity);
    for (const id of this.stage) {
      const user = this.users.get(id)!;
      this.stageEntries.set(id, {
        returnPosition: { x: user.x, y: user.y },
        joinedAt: members.get(id)!.stageJoinedAt ?? checkpoint.savedAt,
      });
      user.y = user.targetY = SCENE.stageY;
    }
    this.positionStage();
    const playback = checkpoint.playback;
    if (playback && this.stage[0] === playback.djId) {
      const elapsedMs = now - playback.startedAt;
      if (elapsedMs >= playback.durationMs)
        this.finishPlayback(playback, playback.startedAt + playback.durationMs);
      else if (elapsedMs >= 0) {
        this.playback = playback;
        this.schedulePlaybackEnd(playback, playback.durationMs - elapsedMs);
      }
    }
    this.publishedStage = [...this.stage];
    this.checkpoint();
  }
  snapshot(): RoomSnapshot {
    return structuredClone({
      revision: this.revision,
      serverTime: Date.now(),
      users: [...this.users.values()],
      stage: this.stage,
      playback: this.playback,
      resolving: this.resolving,
      notice: this.notice,
      capacity: ROOM_CAPACITY,
      stageCapacity: this.stageCapacity,
    });
  }
  private publish() {
    if (!this.closed) {
      this.revision++;
      this.stageDirty = false;
      this.publishedStage = [...this.stage];
      this.onChange(this.snapshot());
    }
  }
  private publishPlayback() {
    if (this.closed) return;
    if (this.stageDirty) {
      this.publish();
      return;
    }
    const stageChanged =
      this.stage.length !== this.publishedStage.length ||
      this.stage.some((id, index) => id !== this.publishedStage[index]);
    if (stageChanged) this.publishedStage = [...this.stage];
    this.revision++;
    this.onPlaybackChange(
      structuredClone({
        revision: this.revision,
        serverTime: Date.now(),
        playback: this.playback,
        resolving: this.resolving,
        notice: this.notice,
        ...(stageChanged ? { stage: this.publishedStage } : {}),
      }),
    );
  }
  private publishMotion(user: Participant) {
    if (this.closed) return;
    const sleepAt = user.movingSince + user.durationMs + catSleepDelay(user.id);
    user.sleepAt = sleepAt;
    this.revision++;
    this.onMotion({
      revision: this.revision,
      serverTime: Date.now(),
      userId: user.id,
      x: user.x,
      y: user.y,
      targetX: user.targetX,
      targetY: user.targetY,
      movingSince: user.movingSince,
      durationMs: user.durationMs,
      facingRight: user.facingRight ?? false,
      sleepAt,
      ...(user.clientMoveId === undefined
        ? {}
        : { clientMoveId: user.clientMoveId }),
    });
  }
  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    // Serialize state entry, never hold admission/removal behind upstream I/O.
    const started = this.chain.then(() => {
      if (this.closed) throw new Error('房间已关闭');
      return { result: action() };
    });
    this.chain = started.then(
      () => {},
      () => {},
    );
    return started.then(({ result }) => result);
  }
  private invalidateResolution() {
    this.resolutionGeneration++;
    this.cancelResolution?.();
    this.cancelResolution = undefined;
    this.pendingDj = null;
  }
  removeMember(id: string, connectionId?: string): Promise<void> {
    if (this.closed || (connectionId && !this.isCurrent(id, connectionId)))
      return Promise.resolve();
    const current = this.playback?.djId === id || this.pendingDj === id;
    if (this.playback?.djId === id) this.settleDjPlayback(Date.now(), true);
    clearTimeout(this.grace.get(id)?.timer);
    this.grace.delete(id);
    this.connections.delete(id);
    this.removeStage(id);
    this.users.delete(id);
    this.emoteTimes.delete(id);
    if (!this.users.size) {
      this.invalidateResolution();
      clearTimeout(this.timer);
      this.playback = null;
      this.resolving = false;
      this.notice = null;
      this.checkpoint();
      this.publish();
      this.onEmpty();
    } else if (current) void this.advance().catch(() => {});
    else {
      this.checkpoint();
      this.publish();
    }
    return Promise.resolve();
  }
  forceLeave(id: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('房间已关闭'));
    const current = this.playback?.djId === id || this.pendingDj === id;
    this.removeStage(id);
    if (current) void this.advance().catch(() => {});
    else {
      this.checkpoint();
      this.publish();
    }
    return Promise.resolve();
  }
  private spawnPosition() {
    const now = Date.now();
    const audience = [...this.users.values()]
      .filter((user) => user.seat === null)
      .map((user) => this.position(user, now));
    const left = spawnSeatXs[0]!;
    const right = spawnSeatXs.at(-1)!;
    const { top, bottom } = SCENE.walk;
    let best: { point: { x: number; y: number }; distance: number } | undefined;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const point = {
        x: left + Math.random() * (right - left),
        y: top + Math.random() * (bottom - top),
      };
      const distance = Math.min(
        ...audience.map((user) =>
          Math.hypot(user.x - point.x, user.y - point.y),
        ),
      );
      if (distance >= SPAWN_SEPARATION) return point;
      if (!best || distance > best.distance) best = { point, distance };
    }
    return best!.point;
  }
  connect(guest: Guest, connection: Connection) {
    if (this.closed) throw new Error('房间已关闭');
    if (!this.users.has(guest.id) && this.users.size >= ROOM_CAPACITY)
      throw new Error('房间已满');
    const previous = this.connections.get(guest.id);
    this.connections.set(guest.id, connection);
    if (previous && previous.id !== connection.id) previous.replaced();
    clearTimeout(this.grace.get(guest.id)?.timer);
    this.grace.delete(guest.id);
    const existing = this.users.get(guest.id);
    if (existing) Object.assign(existing, guest, { connected: true });
    else {
      const { x, y } = this.spawnPosition();
      const now = Date.now();
      this.users.set(guest.id, {
        ...guest,
        x,
        y,
        targetX: x,
        targetY: y,
        movingSince: now,
        durationMs: 0,
        facingRight: false,
        seat: null,
        connected: true,
        sleepAt: now + catSleepDelay(guest.id),
      });
    }
    const resume =
      this.waitingForReconnect && !this.playback && this.stage.length;
    this.waitingForReconnect = false;
    if (this.playback?.djId === guest.id) this.djPlaybackFrom ??= Date.now();
    this.checkpoint();
    this.publish();
    if (resume) void this.advance().catch(() => {});
  }
  updateAppearance(id: string, appearance: CatAppearance) {
    const user = this.users.get(id);
    if (this.closed || !user) return;
    user.appearance = catAppearanceSchema.parse(appearance);
    this.publish();
  }
  updateNickname(id: string, nickname: string) {
    const user = this.users.get(id);
    if (this.closed || !user || user.nickname === nickname) return;
    user.nickname = nickname;
    this.publish();
  }
  disconnect(id: string, connectionId: string) {
    if (this.closed) return;
    if (this.connections.get(id)?.id !== connectionId) return;
    const now = Date.now();
    if (this.playback?.djId === id) this.settleDjPlayback(now, true);
    this.connections.delete(id);
    const user = this.users.get(id);
    if (!user) return;
    user.connected = false;
    this.reserveMember(id, now + this.disconnectGraceMs, now);
    this.checkpoint();
    this.publish();
  }
  private get disconnectGraceMs() {
    return this.options.disconnectGraceMs ?? 30_000;
  }
  private reserveMember(id: string, until: number, now: number) {
    const timer = setTimeout(() => {
      this.grace.delete(id);
      if (!this.connections.has(id)) void this.removeMember(id);
    }, until - now);
    this.grace.set(id, { until, timer });
  }
  private user(id: string, connectionId?: string) {
    const user = this.users.get(id);
    if (
      this.closed ||
      !user?.connected ||
      (connectionId && !this.isCurrent(id, connectionId))
    )
      throw new Error('请重新连接房间');
    return user;
  }
  private position(user: Participant, now: number) {
    const progress = user.durationMs
      ? Math.max(0, Math.min(1, (now - user.movingSince) / user.durationMs))
      : 1;
    return {
      x: user.x + (user.targetX - user.x) * progress,
      y: user.y + (user.targetY - user.y) * progress,
    };
  }
  motion(id: string, input: unknown) {
    const motion = motionSchema.parse(input),
      user = this.user(id);
    if (user.seat !== null) throw new Error('请先离开舞台');
    Object.assign(user, motion, {
      movingSince: Date.now(),
      durationMs:
        (Math.hypot(motion.targetX - motion.x, motion.targetY - motion.y) /
          SCENE.speed) *
        1000,
    });
    this.publishMotion(user);
  }
  move(id: string, input: unknown) {
    const point = moveSchema.parse(input),
      user = this.user(id);
    if (user.seat !== null) throw new Error('请先离开舞台');
    if (
      point.x < SCENE.walk.left ||
      point.x > SCENE.walk.right ||
      point.y < SCENE.walk.top ||
      point.y > SCENE.walk.bottom
    )
      throw new Error('不能走到这里');
    const now = Date.now();
    delete user.clientMoveId;
    Object.assign(user, this.position(user, now));
    if (point.x !== user.x) user.facingRight = point.x > user.x;
    user.targetX = point.x;
    user.targetY = point.y;
    user.movingSince = now;
    user.durationMs =
      (Math.hypot(point.x - user.x, point.y - user.y) / SCENE.speed) * 1000;
    this.publishMotion(user);
  }
  stop(id: string) {
    const user = this.user(id);
    if (user.seat !== null) throw new Error('请先离开舞台');
    const now = Date.now(),
      { x, y } = this.position(user, now);
    delete user.clientMoveId;
    Object.assign(user, {
      x,
      y,
      targetX: x,
      targetY: y,
      durationMs: 0,
      movingSince: now,
    });
    this.publishMotion(user);
  }
  emote(id: string, input: unknown) {
    const emote = z
      .object({ id: z.string().min(1).max(80) })
      .strict()
      .parse(input);
    const user = this.user(id);
    if (!this.emoteCatalog.allows(emote.id)) throw new Error('表情不可用');
    const now = Date.now();
    if (now - (this.emoteTimes.get(id) ?? -Infinity) < EMOTE_COOLDOWN_MS)
      throw new Error('表情发送太快');
    this.emoteTimes.set(id, now);
    const event: RoomEmote = { userId: id, id: emote.id };
    if (user.seat === null) {
      const arrival = user.movingSince + user.durationMs;
      const sleepAt = Math.max(now, arrival) + catSleepDelay(id);
      user.sleepAt = sleepAt;
      event.activity = { sleepAt, revision: ++this.revision };
    }
    this.onEmote(event);
  }
  join(
    id: string,
    connectionId?: string,
    _requestedSeat?: number,
    from?: StageJoin['from'],
  ) {
    return this.enqueue(async () => {
      const user = this.user(id, connectionId);
      if (this.stage.includes(id)) return;
      if (this.stage.length >= this.stageCapacity) throw new Error('舞台已满');
      if (!this.db.tracks(id).length) throw new Error('先添加歌曲到歌单');
      const now = Date.now();
      this.stageEntries.set(id, {
        returnPosition: from ? { ...from } : this.position(user, now),
        joinedAt: now,
      });
      delete user.clientMoveId;
      Object.assign(user, {
        y: SCENE.stageY,
        targetY: SCENE.stageY,
        durationMs: 0,
        movingSince: now,
      });
      this.stage.push(id);
      this.positionStage();
      this.stageDirty = true;
      if (!this.playback && !this.resolving) {
        this.failedMedia.clear();
        await this.advance();
      } else {
        this.checkpoint();
        this.publish();
      }
    });
  }
  leave(id: string, connectionId?: string, payload: unknown = {}) {
    return this.enqueue(async () => {
      this.user(id, connectionId);
      stageLeaveSchema.parse(payload);
      if (!this.stage.includes(id)) throw new Error('你已经在台下了');
      const current = this.playback?.djId === id || this.pendingDj === id;
      this.removeStage(id);
      if (current) await this.advance();
      else {
        this.checkpoint();
        this.publish();
      }
    });
  }
  private positionStage() {
    const positions = stageSeatXs(this.stageCapacity);
    this.stage.forEach((id, seat) => {
      const user = this.users.get(id)!;
      const x = positions[seat]!;
      delete user.sleepAt;
      Object.assign(user, { seat, x, targetX: x });
    });
  }
  private rotateStage() {
    if (this.stage.length < 2) return;
    this.stage.push(this.stage.shift()!);
    this.positionStage();
  }
  private removeStage(id: string) {
    const index = this.stage.indexOf(id);
    if (index < 0) return;
    this.stage.splice(index, 1);
    this.failedMedia.delete(id);
    this.positionStage();
    this.stageDirty = true;
    const { returnPosition } = this.stageEntries.get(id)!;
    this.stageEntries.delete(id);
    const user = this.users.get(id);
    if (user) {
      const { x, y } = returnPosition;
      const now = Date.now();
      delete user.clientMoveId;
      Object.assign(user, {
        seat: null,
        x,
        y,
        targetX: x,
        targetY: y,
        durationMs: 0,
        movingSince: now,
        sleepAt: now + catSleepDelay(id),
      });
    }
  }
  skip(id: string, input: unknown, connectionId?: string, moderator = false) {
    return this.enqueue(async () => {
      this.user(id, connectionId);
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).length !== 1 ||
        !('roundId' in input) ||
        typeof input.roundId !== 'string'
      )
        throw new Error('无效轮次');
      if (
        !this.playback ||
        (!moderator && this.playback.djId !== id) ||
        this.playback.roundId !== input.roundId
      )
        throw new Error('只能跳过自己当前的歌曲');
      await this.advance(Date.now());
    });
  }
  mediaFailed(id: string, input: unknown, connectionId?: string) {
    return this.enqueue(async () => {
      this.user(id, connectionId);
      const { roundId } = playbackRoundSchema.parse(input);
      const playback = this.playback;
      if (playback?.roundId !== roundId) return;
      if (playback.djId !== id) throw new Error('只能报告自己当前的歌曲');
      const failed = this.failedMedia.get(id) ?? new Set<string>();
      failed.add(playback.track.id);
      this.failedMedia.set(id, failed);
      this.rotateStage();
      await this.advance(undefined, '当前歌曲无法播放，已跳过。');
    });
  }
  seek(id: string, input: unknown, connectionId?: string) {
    return this.enqueue(() => {
      this.user(id, connectionId);
      const { roundId, positionMs } = seekSchema.parse(input);
      const playback = this.playback;
      if (playback?.djId !== id || playback.roundId !== roundId)
        throw new Error('只能调整自己当前歌曲的播放进度');
      if (positionMs > playback.durationMs) throw new Error('播放进度超出范围');
      const target =
        positionMs === playback.durationMs
          ? Math.max(0, playback.durationMs - 1)
          : positionMs;
      const now = Date.now();
      if (target <= Math.max(0, now - playback.startedAt)) return;
      this.settleDjPlayback(now);
      this.playback = { ...playback, startedAt: now - target };
      this.schedulePlaybackEnd(this.playback, playback.durationMs - target);
      this.checkpoint();
      this.publishPlayback();
    });
  }
  private schedulePlaybackEnd(playback: Playback, remainingMs: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.enqueue(async () => {
          if (this.playback === playback)
            await this.advance(playback.startedAt + playback.durationMs);
        }).catch(() => {});
      },
      Math.min(Math.ceil(remainingMs), 2_147_483_647),
    );
  }
  private finishPlayback(playback: Playback, endedAt: number) {
    const id = playback.djId;
    if (this.stage[0] !== id) return;
    const { joinedAt } = this.stageEntries.get(id)!;
    if (
      this.stageTimeLimitMinutes === 0 ||
      endedAt - joinedAt >= this.stageTimeLimitMinutes * 60_000
    )
      this.removeStage(id);
    else this.rotateStage();
  }
  private async advance(endedAt?: number, notice: string | null = null) {
    this.invalidateResolution();
    const generation = this.resolutionGeneration;
    clearTimeout(this.timer);
    this.settleDjPlayback(endedAt ?? Date.now(), true);
    if (this.playback && endedAt !== undefined) {
      this.failedMedia.clear();
      this.finishPlayback(this.playback, endedAt);
    }
    this.playback = null;
    this.resolving = !this.waitingForReconnect;
    this.notice = notice;
    // Preserve the next DJ and retire the old round before resolving the URL.
    this.checkpoint();
    if (this.waitingForReconnect) {
      this.publishPlayback();
      return;
    }
    // Cached resolutions finish before the next turn; only announce a loading
    // state when resolution actually remains pending.
    const pendingNotification = setTimeout(() => {
      this.pendingTimers.delete(pendingNotification);
      if (!this.closed && generation === this.resolutionGeneration)
        this.publishPlayback();
    }, 0);
    this.pendingTimers.add(pendingNotification);
    try {
      const visited = new Set<string>();
      const failures: FailedAttempt[] = [];
      while (this.stage.length && visited.size < STAGE_CAPACITY) {
        const id = this.stage[0]!;
        if (visited.has(id)) break;
        visited.add(id);
        const slot = this.db.playlistSlot(id);
        const tracks = this.db.tracks(id, slot);
        if (!tracks.length) {
          this.removeStage(id);
          this.checkpoint();
          continue;
        }
        const failed = this.failedMedia.get(id);
        const track = tracks.find((item) => !failed?.has(item.id));
        if (!track) {
          this.rotateStage();
          continue;
        }
        let beforeRevision: number;
        try {
          this.pendingDj = id;
          const result = await this.resolve(track);
          if (this.closed || generation !== this.resolutionGeneration) return;
          this.pendingDj = null;
          if (this.stage[0] !== id || !this.users.has(id)) return;
          const url = new URL(result.url);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            !Number.isFinite(result.durationMs) ||
            result.durationMs <= 0
          )
            throw new Error('无效播放地址');
          beforeRevision = this.db.playlistOrder(id).revision;
          const startedAt = Date.now();
          const playback: Playback = {
            roundId: randomUUID(),
            track,
            djId: id,
            url: result.url,
            startedAt,
            durationMs: this.trackTimeLimitMinutes
              ? Math.min(result.durationMs, this.trackTimeLimitMinutes * 60_000)
              : result.durationMs,
            ...(result.isTrial ? { isTrial: true as const } : {}),
            ...(result.lyricOffsetMs !== undefined
              ? {
                  lyricOffsetMs:
                    typeof result.lyricOffsetMs === 'number' &&
                    Number.isFinite(result.lyricOffsetMs) &&
                    result.lyricOffsetMs >= 0
                      ? result.lyricOffsetMs
                      : null,
                }
              : {}),
          };
          const roomId = this.options.roomId;
          const checkpoint = roomId
            ? this.captureCheckpoint(startedAt, playback)!
            : undefined;
          this.db.rotateTrack(
            id,
            track.id,
            roomId ? { roomId, startedAt, checkpoint } : undefined,
            slot,
          );
          if (checkpoint) this.lastCheckpoint = JSON.stringify(checkpoint);
          this.playback = playback;
          if (this.connections.has(id)) this.djPlaybackFrom = startedAt;
        } catch (error) {
          if (this.closed || generation !== this.resolutionGeneration) return;
          this.pendingDj = null;
          failures.push({
            kind: error instanceof MusicPlaybackError ? error.kind : 'unknown',
            title: track.title,
          });
          this.rotateStage();
          this.checkpoint();
          continue;
        }
        this.resolving = false;
        this.schedulePlaybackEnd(this.playback, this.playback.durationMs);
        const order = this.db.playlistOrder(id);
        if (order.slot === slot && order.revision !== beforeRevision)
          this.onPlaylistChange(id, order);
        this.publishPlayback();
        return;
      }
      this.resolving = false;
      if (this.stage.length && this.failedMedia.size)
        this.notice = '暂时没有可播放的歌曲，请调整歌单后下台重新上台。';
      else if (this.stage.length && failures.length)
        this.notice = playbackFailureNotice(failures);
      this.publishPlayback();
    } finally {
      clearTimeout(pendingNotification);
      this.pendingTimers.delete(pendingNotification);
    }
  }
  private async resolve(track: Parameters<MusicService['resolve']>[0]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('解析已取消'));
    });
    this.cancelResolution = cancel;
    try {
      return await Promise.race([
        this.music.resolve(track),
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new MusicPlaybackError('timeout')),
            this.options.resolveTimeoutMs ?? 10_000,
          );
          this.pendingTimers.add(timer);
        }),
      ]);
    } finally {
      if (this.cancelResolution === cancel) this.cancelResolution = undefined;
      if (timer) {
        clearTimeout(timer);
        this.pendingTimers.delete(timer);
      }
    }
  }
  close() {
    if (this.closed) return;
    this.settleDjPlayback(Date.now(), true);
    this.closed = true;
    this.invalidateResolution();
    clearTimeout(this.timer);
    this.emoteTimes.clear();
    this.stageEntries.clear();
    for (const { timer } of this.grace.values()) clearTimeout(timer);
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.grace.clear();
    this.pendingTimers.clear();
  }
}

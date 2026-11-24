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

type Connection = { id: string; replaced(): void };
type FailedAttempt = { kind: MusicPlaybackFailure | 'unknown'; title: string };
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
const seekSchema = z
  .object({ roundId: z.string().uuid(), positionMs: z.number().nonnegative() })
  .strict();
export class Room {
  private users = new Map<string, Participant>();
  private connections = new Map<string, Connection>();
  private grace = new Map<string, ReturnType<typeof setTimeout>>();
  private emoteTimes = new Map<string, number>();
  private emoteCatalog: EmoteCatalog;
  private stage: string[] = [];
  private stageReturnPositions = new Map<string, { x: number; y: number }>();
  private stageCapacity: number;
  private stageDirty = false;
  private publishedStage: string[] = [];
  private playback: Playback | null = null;
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
  onEmpty: () => void = () => {};
  onChange: (snapshot: RoomSnapshot) => void = () => {};
  onPlaybackChange: (state: PlaybackState) => void = () => {};
  onEmote: (event: RoomEmote) => void = () => {};
  onMotion: (event: RoomMotion) => void = () => {};
  onPlaylistChange: (guestId: string, state: PlaylistOrder) => void = () => {};
  canConnect(id: string) {
    return this.users.has(id) || this.users.size < ROOM_CAPACITY;
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
    } = {},
    emoteCatalog?: EmoteCatalog,
  ) {
    this.emoteCatalog = emoteCatalog ?? new EmoteCatalog(db);
    this.stageCapacity = stageCapacitySchema.parse(
      options.stageCapacity ?? DEFAULT_STAGE_CAPACITY,
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
    clearTimeout(this.grace.get(id));
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
      this.publish();
      this.onEmpty();
    } else if (current) void this.advance().catch(() => {});
    else this.publish();
    return Promise.resolve();
  }
  forceLeave(id: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('房间已关闭'));
    const current = this.playback?.djId === id || this.pendingDj === id;
    this.removeStage(id);
    if (current) void this.advance().catch(() => {});
    else this.publish();
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
    clearTimeout(this.grace.get(guest.id));
    this.grace.delete(guest.id);
    const existing = this.users.get(guest.id);
    if (existing) Object.assign(existing, guest, { connected: true });
    else {
      const { x, y } = this.spawnPosition();
      this.users.set(guest.id, {
        ...guest,
        x,
        y,
        targetX: x,
        targetY: y,
        movingSince: Date.now(),
        durationMs: 0,
        facingRight: false,
        seat: null,
        connected: true,
      });
    }
    this.publish();
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
    this.connections.delete(id);
    const user = this.users.get(id);
    if (!user) return;
    user.connected = false;
    this.publish();
    const timer = setTimeout(() => {
      this.grace.delete(id);
      if (!this.connections.has(id)) void this.removeMember(id);
    }, this.options.disconnectGraceMs ?? 30_000);
    this.grace.set(id, timer);
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
    this.user(id);
    if (!this.emoteCatalog.allows(emote.id)) throw new Error('表情不可用');
    const now = Date.now();
    if (now - (this.emoteTimes.get(id) ?? -Infinity) < EMOTE_COOLDOWN_MS)
      throw new Error('表情发送太快');
    this.emoteTimes.set(id, now);
    this.onEmote({ userId: id, id: emote.id });
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
      this.stageReturnPositions.set(
        id,
        from ? { ...from } : this.position(user, now),
      );
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
      if (!this.playback && !this.resolving) await this.advance();
      else this.publish();
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
      else this.publish();
    });
  }
  private positionStage() {
    const positions = stageSeatXs(this.stageCapacity);
    this.stage.forEach((id, seat) => {
      const user = this.users.get(id)!;
      const x = positions[seat]!;
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
    this.positionStage();
    this.stageDirty = true;
    const point = this.stageReturnPositions.get(id)!;
    this.stageReturnPositions.delete(id);
    const user = this.users.get(id);
    if (user) {
      const { x, y } = point;
      delete user.clientMoveId;
      Object.assign(user, {
        seat: null,
        x,
        y,
        targetX: x,
        targetY: y,
        durationMs: 0,
        movingSince: Date.now(),
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
      await this.advance();
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
      this.playback = { ...playback, startedAt: now - target };
      this.schedulePlaybackEnd(this.playback, playback.durationMs - target);
      this.publishPlayback();
    });
  }
  private schedulePlaybackEnd(playback: Playback, remainingMs: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.enqueue(async () => {
          if (this.playback === playback) await this.advance();
        }).catch(() => {});
      },
      Math.min(Math.ceil(remainingMs), 2_147_483_647),
    );
  }
  private async advance() {
    this.invalidateResolution();
    const generation = this.resolutionGeneration;
    clearTimeout(this.timer);
    if (this.playback && this.stage[0] === this.playback.djId)
      this.rotateStage();
    this.playback = null;
    this.resolving = true;
    this.notice = null;
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
        const track = this.db.firstTrack(id, slot);
        if (!track) {
          this.removeStage(id);
          continue;
        }
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
          const beforeRevision = this.db.playlistOrder(id).revision;
          const startedAt = Date.now();
          this.db.rotateTrack(
            id,
            track.id,
            this.options.roomId
              ? { roomId: this.options.roomId, startedAt }
              : undefined,
            slot,
          );
          const order = this.db.playlistOrder(id);
          if (order.slot === slot && order.revision !== beforeRevision)
            this.onPlaylistChange(id, order);
          this.playback = {
            roundId: randomUUID(),
            track,
            djId: id,
            url: result.url,
            startedAt,
            durationMs: result.durationMs,
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
          this.resolving = false;
          this.schedulePlaybackEnd(this.playback, result.durationMs);
        } catch (error) {
          if (this.closed || generation !== this.resolutionGeneration) return;
          this.pendingDj = null;
          failures.push({
            kind: error instanceof MusicPlaybackError ? error.kind : 'unknown',
            title: track.title,
          });
          this.rotateStage();
          continue;
        }
        this.publishPlayback();
        return;
      }
      this.resolving = false;
      this.notice =
        this.stage.length && failures.length
          ? playbackFailureNotice(failures)
          : null;
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
    this.closed = true;
    this.invalidateResolution();
    clearTimeout(this.timer);
    this.emoteTimes.clear();
    this.stageReturnPositions.clear();
    for (const timer of [...this.grace.values(), ...this.pendingTimers])
      clearTimeout(timer);
    this.grace.clear();
    this.pendingTimers.clear();
  }
}

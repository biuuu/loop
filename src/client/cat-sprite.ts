import type { Participant } from '../shared/contracts';

export const CAT_CELL_SIZE = 64;
export const CAT_SHEET_COLUMNS = 16;
export const CAT_SHEET_ROWS = 14;
export const CAT_FRAME_MS = 200;
export const CAT_SCALE = 3;
export const CAT_IDLE_UP_COLUMN = 0;
export const CAT_SLEEP_AFTER_MS = 120_000;
const CAT_SLEEP_SPREAD_MS = 30_000;
// Sleep opens with six quiet frames. Columns 6–11 build Z, ZZ, ZZZ;
// columns 12–15 remove the last two letters again.
const SLEEP_LOOP_FIRST_COLUMN = 6;
const SLEEP_LOOP_FRAMES = 6;
// Rows and timing come from the supplied Cat.aseprite animation tags.
export const CAT_ANIMATIONS = {
  idle: { row: 6, frames: 12, footY: 48 },
  side: { row: 13, frames: 6, footY: 48 },
  // The source Up tag includes a front-facing fifth cell. Loop only its four
  // rear-facing walking cells so an upward walk never briefly turns around.
  up: { row: 11, frames: 4, footY: 53 },
  down: { row: 12, frames: 3, footY: 46 },
  sleep: { row: 0, frames: 16, footY: 48 },
} as const;
export type CatAnimation = keyof typeof CAT_ANIMATIONS;
type Movement = Pick<
  Participant,
  'id' | 'x' | 'y' | 'targetX' | 'targetY' | 'movingSince' | 'durationMs'
> &
  Partial<Pick<Participant, 'seat' | 'facingRight'>>;

export interface CatActivity {
  inactiveSince: number;
  movement: string;
  emoteReceivedAt: number | undefined;
  seat: Participant['seat'];
}

/** Scene-local activity, independent of unrelated room snapshot revisions. */
export function catActivity(
  previous: CatActivity | undefined,
  user: Movement & Pick<Participant, 'seat'>,
  now: number,
  snapshotTime = now,
  emoteReceivedAt?: number,
): CatActivity {
  const movement = [
    user.x,
    user.y,
    user.targetX,
    user.targetY,
    user.movingSince,
    user.durationMs,
  ].join(':');
  let inactiveSince = previous?.inactiveSince ?? now;
  if (previous && previous.movement !== movement)
    inactiveSince = Math.max(inactiveSince, user.movingSince + user.durationMs);
  if (previous && previous.seat !== user.seat)
    inactiveSince = Math.max(inactiveSince, snapshotTime);
  if (
    emoteReceivedAt !== undefined &&
    emoteReceivedAt !== previous?.emoteReceivedAt
  )
    inactiveSince = Math.max(inactiveSince, now);
  // A newly observed walk must finish before its inactivity countdown starts.
  inactiveSince = Math.max(inactiveSince, user.movingSince + user.durationMs);
  return {
    inactiveSince,
    movement,
    emoteReceivedAt: emoteReceivedAt ?? previous?.emoteReceivedAt,
    seat: user.seat,
  };
}

// Stable per-cat phases avoid lockstep animations without timers or random frame state.
function identityHash(id: string, salt: string) {
  let hash = 2166136261;
  for (const character of `${salt}:${id}`)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function catSleepDelay(id: string) {
  return (
    CAT_SLEEP_AFTER_MS + (identityHash(id, 'sleep') % (CAT_SLEEP_SPREAD_MS + 1))
  );
}

/** Play the untouched source loop, then wait on its raised-tail first frame. */
export function idleColumn(id: string, elapsed: number, reducedMotion = false) {
  if (reducedMotion) return CAT_IDLE_UP_COLUMN;
  const pauseMs = 8000 + (identityHash(id, 'idle') % 4001);
  const loopMs = CAT_ANIMATIONS.idle.frames * CAT_FRAME_MS;
  const phase = Math.max(0, elapsed) % (pauseMs + loopMs);
  return phase < pauseMs
    ? CAT_IDLE_UP_COLUMN
    : Math.floor((phase - pauseMs) / CAT_FRAME_MS);
}

/** Select presentation only; server movement and interpolated position stay authoritative. */
export function catFrame(
  user: Movement,
  now: number,
  reducedMotion = false,
  lastFacingRight = false,
  inactiveSince?: number,
  walkStartedAt?: number,
) {
  const dx = user.targetX - user.x;
  const dy = user.targetY - user.y;
  const moving =
    user.durationMs > 0 &&
    now >= user.movingSince &&
    now < user.movingSince + user.durationMs &&
    (dx !== 0 || dy !== 0);
  const sleepElapsed =
    !moving && user.seat == null && inactiveSince !== undefined
      ? now - inactiveSince - catSleepDelay(user.id)
      : -1;
  let animation: CatAnimation = 'idle';
  if (moving) {
    if (Math.abs(dx) >= Math.abs(dy)) animation = 'side';
    else animation = dy < 0 ? 'up' : 'down';
  } else if (sleepElapsed >= 0) {
    animation = 'sleep';
  }
  const sequence = CAT_ANIMATIONS[animation];
  let column: number;
  if (moving) {
    column = reducedMotion
      ? 0
      : Math.floor((now - (walkStartedAt ?? user.movingSince)) / CAT_FRAME_MS) %
        sequence.frames;
  } else if (animation === 'sleep') {
    const frame = reducedMotion ? 0 : Math.floor(sleepElapsed / CAT_FRAME_MS);
    column =
      frame < SLEEP_LOOP_FIRST_COLUMN
        ? frame
        : SLEEP_LOOP_FIRST_COLUMN +
          ((frame - SLEEP_LOOP_FIRST_COLUMN) % SLEEP_LOOP_FRAMES);
  } else {
    const arrivedAt = user.movingSince + user.durationMs;
    column = idleColumn(user.id, now - arrivedAt, reducedMotion);
  }
  return {
    animation,
    column,
    row: sequence.row,
    // The supplied idle and side frames face left. Keep the last horizontal
    // facing through arrival and vertical walks.
    flipX:
      animation === 'idle' || animation === 'sleep'
        ? (user.facingRight ??
          (user.durationMs > 0 && dx !== 0 ? dx > 0 : lastFacingRight))
        : animation === 'side' && dx > 0,
    footY: sequence.footY,
  };
}

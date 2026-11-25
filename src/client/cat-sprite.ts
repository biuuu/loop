import type { Participant } from '../shared/contracts';
import { identityHash } from '../shared/cat-activity';

export const CAT_CELL_SIZE = 64;
export const CAT_SHEET_COLUMNS = 16;
export const CAT_SHEET_ROWS = 14;
export const CAT_FRAME_MS = 200;
export const CAT_SCALE = 3;
export const CAT_IDLE_UP_COLUMN = 0;
// Loop the quiet frames and the growing Zs, skipping the source fade-out.
const SLEEP_LOOP_FRAMES = 12;
const TAIL_LOOPS_BEFORE_GROOM = 2;
const GROOM_REPEATS = 2;
// Rows and timing come from the supplied Cat.aseprite animation tags.
export const CAT_ANIMATIONS = {
  idle: { row: 6, frames: 12, footY: 48 },
  side: { row: 13, frames: 6, footY: 48 },
  // The source Up tag includes a front-facing fifth cell. Loop only its four
  // rear-facing walking cells so an upward walk never briefly turns around.
  up: { row: 11, frames: 4, footY: 53 },
  down: { row: 12, frames: 3, footY: 46 },
  sleep: { row: 0, frames: 16, footY: 48 },
  groom: { row: 3, frames: 4, footY: 48 },
} as const;
export type CatAnimation = keyof typeof CAT_ANIMATIONS;
type Movement = Pick<
  Participant,
  'id' | 'x' | 'y' | 'targetX' | 'targetY' | 'movingSince' | 'durationMs'
> &
  Partial<Pick<Participant, 'seat' | 'facingRight' | 'sleepAt'>>;

const sitting = { animation: 'idle', column: CAT_IDLE_UP_COLUMN } as const;

/** Rest before each source action, occasionally choosing a paw lick. */
export function idleFrame(
  id: string,
  elapsed: number,
  reducedMotion = false,
): { animation: 'idle' | 'groom'; column: number } {
  if (reducedMotion) return sitting;
  const pauseMs = 8000 + (identityHash(id, 'idle') % 4001);
  const tailCycleMs = pauseMs + CAT_ANIMATIONS.idle.frames * CAT_FRAME_MS;
  const tailSpanMs = tailCycleMs * TAIL_LOOPS_BEFORE_GROOM;
  const groomMs = CAT_ANIMATIONS.groom.frames * CAT_FRAME_MS * GROOM_REPEATS;
  const phase = Math.max(0, elapsed) % (tailSpanMs + pauseMs + groomMs);
  const animation = phase < tailSpanMs ? 'idle' : 'groom';
  const actionTime =
    (animation === 'idle' ? phase % tailCycleMs : phase - tailSpanMs) - pauseMs;
  if (actionTime < 0) return sitting;
  const column =
    Math.floor(actionTime / CAT_FRAME_MS) % CAT_ANIMATIONS[animation].frames;
  return { animation, column };
}

/** Select presentation only; server movement and interpolated position stay authoritative. */
export function catFrame(
  user: Movement,
  now: number,
  reducedMotion = false,
  lastFacingRight = false,
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
    user.seat == null && user.sleepAt !== undefined ? now - user.sleepAt : -1;
  let animation: CatAnimation;
  let column: number;
  if (moving) {
    animation = Math.abs(dx) >= Math.abs(dy) ? 'side' : dy < 0 ? 'up' : 'down';
    column = reducedMotion
      ? 0
      : Math.floor((now - (walkStartedAt ?? user.movingSince)) / CAT_FRAME_MS) %
        CAT_ANIMATIONS[animation].frames;
  } else if (sleepElapsed >= 0) {
    animation = 'sleep';
    column = reducedMotion
      ? 0
      : Math.floor(sleepElapsed / CAT_FRAME_MS) % SLEEP_LOOP_FRAMES;
  } else {
    const arrivedAt = user.movingSince + user.durationMs;
    ({ animation, column } = idleFrame(
      user.id,
      now - arrivedAt,
      reducedMotion,
    ));
  }
  const sequence = CAT_ANIMATIONS[animation];
  return {
    animation,
    column,
    row: sequence.row,
    // The supplied idle and side frames face left. Keep the last horizontal
    // facing through arrival and vertical walks.
    flipX: moving
      ? animation === 'side' && dx > 0
      : (user.facingRight ??
        (user.durationMs > 0 && dx !== 0 ? dx > 0 : lastFacingRight)),
    footY: sequence.footY,
  };
}

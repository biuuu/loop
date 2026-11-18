import { SCENE, type Participant } from '../shared/contracts';

export const REMOTE_CORRECTION_MS = 120;
const REMOTE_MOTION_SAMPLE_MS = 16;
const REMOTE_MOTION_EPSILON = 0.05;
type Movement = Pick<
  Participant,
  | 'x'
  | 'y'
  | 'targetX'
  | 'targetY'
  | 'movingSince'
  | 'durationMs'
  | 'seat'
  | 'clientMoveId'
>;

function position(user: Movement, now: number) {
  const progress =
    user.durationMs > 0
      ? Math.max(0, Math.min(1, (now - user.movingSince) / user.durationMs))
      : 1;
  return {
    x: user.x + (user.targetX - user.x) * progress,
    y: user.y + (user.targetY - user.y) * progress,
  };
}

function walking(user: Movement, now: number) {
  return (
    user.durationMs > 0 &&
    now >= user.movingSince &&
    now < user.movingSince + user.durationMs &&
    (user.x !== user.targetX || user.y !== user.targetY)
  );
}

function geometry(user: Movement) {
  return [
    user.x,
    user.y,
    user.targetX,
    user.targetY,
    user.movingSince,
    user.durationMs,
    user.seat,
  ].join(':');
}

/** One remote cat's presentation; no timers or changes to authoritative data. */
export function createRemoteMovement() {
  let latest: Movement | undefined;
  let signature: string | undefined;
  let correction = { x: 0, y: 0, since: 0, durationMs: 0 };
  let walkStartedAt: number | undefined;

  function displayed(now: number) {
    const authoritative = position(latest!, now);
    const remaining = Math.max(
      0,
      correction.durationMs > 0
        ? Math.min(1, 1 - (now - correction.since) / correction.durationMs)
        : 0,
    );
    return {
      x: authoritative.x + correction.x * remaining,
      y: authoritative.y + correction.y * remaining,
    };
  }

  return {
    view(user: Movement, now: number) {
      const nextSignature = geometry(user);
      if (signature !== nextSignature) {
        const stageChanged = latest !== undefined && latest.seat !== user.seat;
        const previous = latest && !stageChanged ? displayed(now) : undefined;
        const authoritative = position(user, now);
        const travelX = latest ? latest.targetX - latest.x : 0;
        const travelY = latest ? latest.targetY - latest.y : 0;
        const travel = Math.hypot(travelX, travelY);
        const overshoot = previous
          ? {
              x: previous.x - authoritative.x,
              y: previous.y - authoritative.y,
            }
          : { x: 0, y: 0 };
        const overshootDistance = Math.hypot(overshoot.x, overshoot.y);
        // A stop directly after the last reported walk can arrive after the
        // observer has predicted a little too far. Align that small overshoot
        // without showing a false turn. A skipped move ID means there was an
        // unseen retarget, so its reverse movement must still be replayed.
        const predictedPastStop =
          latest !== undefined &&
          latest.durationMs > 0 &&
          user.durationMs === 0 &&
          latest.clientMoveId !== undefined &&
          user.clientMoveId === latest.clientMoveId + 1 &&
          overshootDistance > 0 &&
          overshootDistance <= SCENE.speed * 0.2 &&
          travel > 0 &&
          overshoot.x * travelX + overshoot.y * travelY >
            overshootDistance * travel * 0.7;
        const dx = predictedPastStop ? 0 : overshoot.x;
        const dy = predictedPastStop ? 0 : overshoot.y;
        const distance = Math.hypot(dx, dy);
        // Moving reports may correct a prediction at most half a walk speed;
        // stopped reports replay missed short taps at the normal walk speed.
        const correctionSpeed = walking(user, now)
          ? SCENE.speed / 2
          : SCENE.speed;
        correction = {
          x: dx,
          y: dy,
          since: now,
          durationMs: distance
            ? Math.max(
                REMOTE_CORRECTION_MS,
                (distance / correctionSpeed) * 1000,
              )
            : 0,
        };
        // Snapshot objects may be replaced or mutated outside this helper.
        latest = {
          x: user.x,
          y: user.y,
          targetX: user.targetX,
          targetY: user.targetY,
          movingSince: user.movingSince,
          durationMs: user.durationMs,
          seat: user.seat,
          clientMoveId: user.clientMoveId,
        };
        signature = nextSignature;
        if (stageChanged) walkStartedAt = undefined;
      } else if (latest) latest.clientMoveId = user.clientMoveId;
      const current = displayed(now);
      const next = displayed(now + REMOTE_MOTION_SAMPLE_MS);
      const visualDx = next.x - current.x;
      const visualDy = next.y - current.y;
      const visuallyMoving =
        Math.hypot(visualDx, visualDy) > REMOTE_MOTION_EPSILON;
      if (!visuallyMoving) walkStartedAt = undefined;
      else walkStartedAt ??= walking(user, now) ? user.movingSince : now;
      return { ...current, visualDx, visualDy, walkStartedAt };
    },
  };
}

/** Match the sprite's gait and facing to its smoothed feet, including missed taps. */
export function remoteFrameUser<T extends Participant>(
  user: T,
  view: ReturnType<ReturnType<typeof createRemoteMovement>['view']>,
  now: number,
): T {
  if (Math.hypot(view.visualDx, view.visualDy) <= REMOTE_MOTION_EPSILON)
    return user;
  return {
    ...user,
    x: view.x,
    y: view.y,
    targetX: view.x + view.visualDx,
    targetY: view.y + view.visualDy,
    movingSince: now,
    durationMs: REMOTE_MOTION_SAMPLE_MS,
    facingRight:
      Math.abs(view.visualDx) > REMOTE_MOTION_EPSILON
        ? view.visualDx > 0
        : user.facingRight,
  };
}

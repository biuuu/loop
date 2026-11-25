import {
  SCENE,
  type ClientMotion,
  type Participant,
} from '../shared/contracts';
import { movementPosition, type Direction } from './keyboard-movement';

type Point = { x: number; y: number };
type LocalSegment = Pick<
  Participant,
  'x' | 'y' | 'targetX' | 'targetY' | 'movingSince' | 'durationMs'
> & { facingRight: boolean; clientMoveId: number };
const clamp = ({ x, y }: Point): Point => ({
  x: Math.max(SCENE.walk.left, Math.min(SCENE.walk.right, x)),
  y: Math.max(SCENE.walk.top, Math.min(SCENE.walk.bottom, y)),
});
const samePoint = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < 0.000001 && Math.abs(a.y - b.y) < 0.000001;

/** One local segment, independent of network cadence and echoed snapshots. */
export function createLocalMovement() {
  let latest: LocalSegment | undefined;
  let overriding = false;
  let revision = 0;
  function view(authoritative: Participant, now: number): Participant {
    if (!latest) return authoritative;
    const localPoint = movementPosition(latest, now);
    const remotePoint = movementPosition(authoritative, now);
    if (
      overriding &&
      authoritative.clientMoveId === latest.clientMoveId &&
      now >= latest.movingSince + latest.durationMs &&
      now >= authoritative.movingSince + authoritative.durationMs &&
      samePoint(localPoint, remotePoint) &&
      samePoint(
        { x: latest.targetX, y: latest.targetY },
        { x: authoritative.targetX, y: authoritative.targetY },
      ) &&
      authoritative.facingRight === latest.facingRight
    )
      overriding = false;
    // Keep the settled segment as a fence against older echoes after catch-up.
    return overriding ||
      (authoritative.clientMoveId ?? -1) < latest.clientMoveId
      ? {
          ...authoritative,
          ...latest,
          // Wake locally even for a quick stop before the server echo arrives.
          sleepAt:
            authoritative.clientMoveId === latest.clientMoveId
              ? authoritative.sleepAt
              : undefined,
        }
      : authoritative;
  }
  function set(authoritative: Participant, point: Point, now: number) {
    const current = view(authoritative, now);
    const start = clamp(movementPosition(current, now));
    const target = clamp(point);
    revision = Math.max(revision, authoritative.clientMoveId ?? 0) + 1;
    latest = {
      ...start,
      targetX: target.x,
      targetY: target.y,
      movingSince: now,
      durationMs:
        (Math.hypot(target.x - start.x, target.y - start.y) / SCENE.speed) *
        1000,
      facingRight:
        target.x === start.x
          ? (current.facingRight ??
            (current.targetX !== current.x
              ? current.targetX > current.x
              : false))
          : target.x > start.x,
      clientMoveId: revision,
    };
    overriding = true;
  }
  return {
    view,
    move(authoritative: Participant, point: Point, now: number) {
      set(authoritative, point, now);
    },
    direction(authoritative: Participant, direction: Direction, now: number) {
      const point = movementPosition(view(authoritative, now), now);
      if (direction === 'left') point.x = SCENE.walk.left;
      if (direction === 'right') point.x = SCENE.walk.right;
      if (direction === 'up') point.y = SCENE.walk.top;
      if (direction === 'down') point.y = SCENE.walk.bottom;
      set(authoritative, point, now);
    },
    stop(authoritative: Participant, now: number) {
      set(authoritative, movementPosition(view(authoritative, now), now), now);
    },
    report(now: number): ClientMotion | undefined {
      if (!latest) return undefined;
      return {
        ...clamp(movementPosition(latest, now)),
        targetX: latest.targetX,
        targetY: latest.targetY,
        facingRight: latest.facingRight,
        clientMoveId: latest.clientMoveId,
      };
    },
    reject(clientMoveId: number) {
      if (latest?.clientMoveId !== clientMoveId) return false;
      latest = undefined;
      overriding = false;
      return true;
    },
    reset() {
      latest = undefined;
      overriding = false;
    },
  };
}

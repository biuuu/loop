import type { Participant } from '../shared/contracts';

export type Movement = Pick<
  Participant,
  'x' | 'y' | 'targetX' | 'targetY' | 'movingSince' | 'durationMs'
>;
type Point = { x: number; y: number };
export type Direction = 'left' | 'right' | 'up' | 'down';
type MovementKey = { code?: string; key: string; repeat?: boolean };
const codes: Record<string, Direction> = {
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'up',
  KeyS: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};
const keys: Record<string, Direction> = {
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function movementKey(event: MovementKey) {
  const physical = event.code && event.code !== 'Unidentified';
  const id = physical
    ? event.code!
    : event.key.length === 1
      ? event.key.toLowerCase()
      : event.key;
  const direction = (physical ? codes : keys)[id];
  return direction ? { id, direction } : undefined;
}

export function movementPosition(movement: Movement, now: number): Point {
  const progress =
    movement.durationMs > 0
      ? Math.max(
          0,
          Math.min(1, (now - movement.movingSince) / movement.durationMs),
        )
      : 1;
  return {
    x: movement.x + (movement.targetX - movement.x) * progress,
    y: movement.y + (movement.targetY - movement.y) * progress,
  };
}

/** Key state only. App owns whether room/focus state allows keyboard input. */
export function createKeyboardMovement(options: {
  sendDirection: (direction: Direction) => void;
  stop: () => void;
}) {
  const held = new Map<string, Direction>();
  const direction = () => [...held.values()].at(-1);
  function move(next: Direction | undefined) {
    if (next) options.sendDirection(next);
    else options.stop();
  }
  return {
    press(event: MovementKey) {
      const key = movementKey(event);
      if (!key) return false;
      if (held.has(key.id)) return true;
      // A reset/focus change relinquishes held movement until a fresh press.
      if (event.repeat) return true;
      const previous = direction();
      held.set(key.id, key.direction);
      if (direction() !== previous) move(direction());
      return true;
    },
    release(event: MovementKey) {
      const key = movementKey(event);
      if (!key || !held.has(key.id)) return false;
      const previous = direction();
      held.delete(key.id);
      if (direction() !== previous) move(direction());
      return true;
    },
    reset(stop = true) {
      const active = held.size > 0;
      held.clear();
      if (active && stop) move(undefined);
    },
  };
}

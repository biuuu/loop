import type { MaskPatch } from './cat-patterns';
import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

const forehead: MaskPatch = {
  part: 'forehead',
  x: 27,
  y: 33,
  rows: ['#.....#', '##.#.##', '.#.#.#.'],
};
const chin: MaskPatch = {
  part: 'bib',
  x: 29,
  y: 40,
  rows: ['###'],
  marking: 2,
};
const idleFlank: MaskPatch = {
  part: 'flank',
  x: 32,
  y: 42,
  rows: ['#.#.', '#..#', '.#.#'],
};
const sideFlank: MaskPatch = {
  part: 'flank',
  x: 33,
  y: 41,
  rows: ['..#..', '#..#.', '.#..#', '.#..#'],
};
const sleepFlank: MaskPatch = {
  part: 'flank',
  x: 34,
  y: 44,
  rows: ['#..#', '#..#'],
};

const sitting = [forehead, chin, idleFlank];
const walking = [forehead, chin, sideFlank];
const walkingHigh = walking.map((patch) => ({ ...patch, y: patch.y - 1 }));
const frontLow = [{ ...forehead, y: 34 }];
const sleeping = [{ ...forehead, y: 37 }, sleepFlank];
const sleepingLow = [{ ...forehead, y: 38 }, sleepFlank];

// Existing back stripes and socks supply the rear-facing view. Extra details
// are attached to the bobbing head or to the torso, depending on the patch.
export const CAT_TABBY_WHITE_DETAILS: Readonly<
  Partial<Record<CatAnimation, readonly (readonly MaskPatch[])[]>>
> = {
  idle: Array.from({ length: CAT_ANIMATIONS.idle.frames }, () => sitting),
  side: [walking, walkingHigh, walking, walking, walkingHigh, walking],
  down: [frontLow, [forehead], frontLow],
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, (_, frame) =>
    frame % 4 < 2 ? sleeping : sleepingLow,
  ),
};

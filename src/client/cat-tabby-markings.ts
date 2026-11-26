import type { MaskPatch } from './cat-patterns';
import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

type FramePatches = Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
>;

function shiftY(patches: readonly MaskPatch[], dy: number) {
  return patches.map((patch) => ({ ...patch, y: patch.y + dy }));
}

// The centre forehead stripe and the paired cheek dashes leave the eyes clear.
const HEAD: readonly MaskPatch[] = [
  { part: 'forehead', x: 27, y: 33, rows: ['#.....#', '#..#..#', '...#...'] },
  {
    part: 'face',
    x: 25,
    y: 36,
    rows: ['#.........#', '...........', '##.......##'],
  },
];
const IDLE_STRIPES: readonly MaskPatch[] = [
  ...HEAD,
  { part: 'flank', x: 32, y: 42, rows: ['..#.', '#.#.', '#..#', '...#'] },
];
const SIDE_STRIPES: readonly MaskPatch[] = [
  ...HEAD,
  { part: 'flank', x: 33, y: 41, rows: ['..#.', '#.##', '#..#', '...#'] },
];
const SIDE_STRIPES_HIGH = shiftY(SIDE_STRIPES, -1);
const SLEEP_FLANK: MaskPatch = {
  part: 'flank',
  x: 34,
  y: 44,
  rows: ['#.#.', '..##'],
};
const SLEEP_STRIPES = [...shiftY(HEAD, 4), SLEEP_FLANK];
const SLEEP_STRIPES_LOW = [...shiftY(HEAD, 5), SLEEP_FLANK];

export const CAT_TABBY_STRIPES: Omit<FramePatches, 'up'> = {
  idle: Array.from({ length: CAT_ANIMATIONS.idle.frames }, () => IDLE_STRIPES),
  side: [
    SIDE_STRIPES,
    SIDE_STRIPES_HIGH,
    SIDE_STRIPES,
    SIDE_STRIPES,
    SIDE_STRIPES_HIGH,
    SIDE_STRIPES,
  ],
  down: [shiftY(HEAD, 1), HEAD, shiftY(HEAD, 1)],
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, (_, frame) =>
    frame % 4 < 2 ? SLEEP_STRIPES : SLEEP_STRIPES_LOW,
  ),
};

// Connect the white muzzle and chest in one patch, using only the visible
// muzzle when the front-facing pose hides the chest behind the head.
const MUZZLE: MaskPatch = {
  part: 'face',
  marking: 2,
  x: 27,
  y: 39,
  rows: ['..###..', '.#####.'],
};
const IDLE_BIB: MaskPatch = {
  part: 'bib',
  marking: 2,
  x: 27,
  y: 41,
  rows: ['#######', '######.', '#####..', '.####..'],
};
const SIDE_BIB: MaskPatch = {
  ...IDLE_BIB,
  rows: ['#######', '#######', '.#####.', '.####..'],
};
const SLEEP_BIB: MaskPatch = {
  part: 'bib',
  marking: 2,
  x: 26,
  y: 44,
  rows: ['########', '########', '.######.'],
};
const SIDE_WHITE = [MUZZLE, SIDE_BIB];
const SIDE_WHITE_HIGH = shiftY(SIDE_WHITE, -1);
const FRONT_WHITE_LOW = shiftY([MUZZLE], 1);
const SLEEP_WHITE = [...shiftY([MUZZLE], 3), SLEEP_BIB];
const SLEEP_WHITE_LOW = [...shiftY([MUZZLE], 4), SLEEP_BIB];

export const CAT_TABBY_WHITE_BIBS: FramePatches = {
  idle: Array.from({ length: CAT_ANIMATIONS.idle.frames }, () => [
    MUZZLE,
    IDLE_BIB,
  ]),
  side: [
    SIDE_WHITE,
    SIDE_WHITE_HIGH,
    SIDE_WHITE,
    SIDE_WHITE,
    SIDE_WHITE_HIGH,
    SIDE_WHITE,
  ],
  up: Array.from({ length: CAT_ANIMATIONS.up.frames }, () => []),
  down: [FRONT_WHITE_LOW, [MUZZLE], FRONT_WHITE_LOW],
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, (_, frame) =>
    frame % 4 < 2 ? SLEEP_WHITE : SLEEP_WHITE_LOW,
  ),
};

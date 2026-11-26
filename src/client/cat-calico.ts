import type { MaskPatch } from './cat-patterns';
import { CAT_STRIPED_TAIL_PATCHES, CAT_TAIL_BANDS } from './cat-striped-tail';
import type { CatAnimation } from './cat-sprite';

export const CAT_CALICO_MARKINGS = {
  orange: CAT_TAIL_BANDS.light,
  dark: CAT_TAIL_BANDS.dark,
} as const;
const { orange, dark } = CAT_CALICO_MARKINGS;

function patch(
  part: MaskPatch['part'],
  marking: typeof orange | typeof dark,
  x: number,
  y: number,
  rows: readonly string[],
): MaskPatch {
  return { part, marking, x, y, rows };
}

function shiftY(patches: readonly MaskPatch[], dy: number) {
  return patches.map((region) => ({ ...region, y: region.y + dy }));
}

// Both colors wrap from the ears into the cheeks, leaving a widening white blaze.
const CROWN = [
  patch('face', dark, 25, 32, ['.##..', '.###.', '.####', '####.', '####.']),
  patch('face', orange, 30, 32, [
    '...##.',
    '..###.',
    '#####.',
    '.#####',
    '..####',
  ]),
];
const FACE = [
  ...CROWN,
  patch('face', dark, 25, 37, ['###', '#..', '##.', '.#.']),
  patch('face', orange, 26, 38, ['##.', '.##', '.#.']),
  patch('face', orange, 33, 37, ['###', '###', '###', '##.']),
];
const SLEEP_FACE = [
  ...shiftY(CROWN, 4),
  patch('face', dark, 25, 41, ['##.', '#..']),
  patch('face', orange, 26, 42, ['##']),
  patch('face', orange, 33, 41, ['###', '.##']),
];
const REAR_CROWN = [
  patch('ear', orange, 25, 33, ['.##..', '.###.', '.####', '####.', '###..']),
  patch('ear', dark, 31, 33, ['..##.', '.###.', '.###.', '..###', '...##']),
];

const IDLE_BODY = [
  patch('flank', dark, 32, 42, [
    '..#....',
    '.###...',
    '.####..',
    '..#####',
    '...###.',
  ]),
];
const SIDE = [
  ...FACE,
  patch('flank', dark, 32, 41, [
    '...#....',
    '.#####..',
    '.#######',
    '..#####.',
    '...###..',
  ]),
];
const REAR_BODY = [
  patch('back', orange, 27, 41, ['#..', '##.', '##.', '##.', '#..', '.##']),
  patch('back', dark, 30, 41, [
    '...#',
    '..##',
    '..##',
    '..##',
    '..##',
    '..##',
    '..##',
  ]),
];
const SLEEP_BODY = [
  patch('flank', dark, 33, 43, ['....##', '...###', '..####', '...##.']),
];

const SIDE_HIGH = shiftY(SIDE, -1);
const REAR_CROWN_HIGH = shiftY(REAR_CROWN, -1);
const FACE_LOW = shiftY(FACE, 1);
const SLEEP_FACE_LOW = shiftY(SLEEP_FACE, 1);

export const CAT_CALICO_PATCHES: Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
> = {
  idle: CAT_STRIPED_TAIL_PATCHES.idle.map((tail) => [
    ...FACE,
    ...IDLE_BODY,
    ...tail,
  ]),
  side: CAT_STRIPED_TAIL_PATCHES.side.map((tail, frame) => [
    ...(frame === 1 || frame === 4 ? SIDE_HIGH : SIDE),
    ...tail,
  ]),
  up: CAT_STRIPED_TAIL_PATCHES.up.map((tail, frame) => [
    ...(frame % 2 === 0 ? REAR_CROWN : REAR_CROWN_HIGH),
    ...REAR_BODY,
    ...tail,
  ]),
  down: CAT_STRIPED_TAIL_PATCHES.down.map((tail, frame) => [
    ...(frame === 1 ? FACE : FACE_LOW),
    ...tail,
  ]),
  sleep: CAT_STRIPED_TAIL_PATCHES.sleep.map((tail, frame) => [
    ...(frame % 4 < 2 ? SLEEP_FACE : SLEEP_FACE_LOW),
    ...SLEEP_BODY,
    ...tail,
  ]),
};

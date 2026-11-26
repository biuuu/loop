import type { MaskPatch } from './cat-patterns';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

export const CAT_CALICO_MARKINGS = { orange: 1, dark: 2 } as const;
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
  patch('face', dark, 25, 32, ['.##..', '.###.', '.###.', '####.', '###..']),
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
  patch('face', dark, 25, 37, ['##.', '#..', '##.', '.#.']),
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
  patch('flank', orange, 27, 41, ['##..', '####', '###.', '##..']),
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
  patch('flank', orange, 27, 41, ['##..', '####', '.###', '.##.']),
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
  patch('flank', orange, 26, 44, ['##.', '###', '##.']),
  patch('flank', dark, 33, 43, ['....##', '...###', '..####', '...##.']),
];

type TailStripe = (column: number, row: number) => boolean;

// Partition the existing tail pixels into stripes. The bands follow each pose's
// tail shape, including the horizontal flick and the curl on the floor.
function stripedTail(patches: readonly MaskPatch[], isOrange: TailStripe) {
  return patches
    .filter(({ part }) => part === 'tail')
    .flatMap((tail) =>
      [dark, orange].flatMap((marking) => {
        const rows = tail.rows.map((row, y) =>
          row.replace(/#/g, (_, x: number) =>
            isOrange(tail.x + x, tail.y + y) === (marking === orange)
              ? '#'
              : '.',
          ),
        );
        return rows.some((row) => row.includes('#'))
          ? [{ ...tail, marking, rows }]
          : [];
      }),
    );
}

const raisedStripe: TailStripe = (_, y) => y === 40 || y === 41 || y === 43;
const angledStripe: TailStripe = (_, y) => y === 41 || y === 42 || y === 44;
const lowStripe: TailStripe = (x, y) => y === 43 || (y === 45 && x >= 40);
const flatStripe: TailStripe = (x) =>
  (x >= 41 && x <= 42) || (x >= 45 && x <= 46);
const IDLE_STRIPES = [
  raisedStripe,
  angledStripe,
  lowStripe,
  flatStripe,
  lowStripe,
  angledStripe,
];
const SLEEP_TAIL = stripedTail(
  CAT_SEAL_POINT_PATCHES.sleepHigh,
  (_, y) => y === 45 || y === 47 || y === 48,
);
const SIDE_HIGH = shiftY(SIDE, -1);
const REAR_CROWN_HIGH = shiftY(REAR_CROWN, -1);
const FACE_LOW = shiftY(FACE, 1);
const SLEEP_FACE_LOW = shiftY(SLEEP_FACE, 1);

export const CAT_CALICO_PATCHES: Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
> = {
  idle: CAT_SEAL_POINT_PATCHES.idle.map((regions, frame) => [
    ...FACE,
    ...IDLE_BODY,
    ...stripedTail(regions, IDLE_STRIPES[frame % IDLE_STRIPES.length]!),
  ]),
  side: CAT_SEAL_POINT_PATCHES.side.map((regions, frame) => {
    const high = frame === 1 || frame === 4;
    const dy = high ? -1 : 0;
    return [
      ...(high ? SIDE_HIGH : SIDE),
      ...stripedTail(regions, (_, y) => y === 42 + dy || y === 44 + dy),
    ];
  }),
  up: CAT_SEAL_POINT_PATCHES.up.map((regions, frame) => [
    ...(frame % 2 === 0 ? REAR_CROWN : REAR_CROWN_HIGH),
    ...REAR_BODY,
    ...stripedTail(regions, (_, y) => y === 40 || y === 41 || y === 44),
  ]),
  down: CAT_SEAL_POINT_PATCHES.down.map((regions, frame) => {
    const high = frame === 1;
    const dy = high ? -1 : 0;
    return [
      ...(high ? FACE : FACE_LOW),
      ...stripedTail(regions, (_, y) => [27, 28, 30, 31].includes(y - dy)),
    ];
  }),
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, (_, frame) => [
    ...(frame % 4 < 2 ? SLEEP_FACE : SLEEP_FACE_LOW),
    ...SLEEP_BODY,
    ...SLEEP_TAIL,
  ]),
};

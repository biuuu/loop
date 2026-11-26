import type { MaskPatch } from './cat-patterns';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

function patch(
  part: MaskPatch['part'],
  marking: NonNullable<MaskPatch['marking']>,
  x: number,
  y: number,
  rows: readonly string[],
): MaskPatch {
  return { part, marking, x, y, rows };
}

function shiftRows(patches: readonly MaskPatch[], dy: number) {
  return patches.map((region) => ({ ...region, y: region.y + dy }));
}

function tail(patches: readonly MaskPatch[]) {
  return patches.filter(({ part }) => part === 'tail');
}

function whitePaws(patches: readonly MaskPatch[]) {
  return patches
    .filter(({ part }) => part === 'frontPaw' || part === 'rearPaw')
    .map((region) => ({ ...region, marking: 4 as const }));
}

// The pale forehead opening widens toward the eyes and covers the muzzle.
const FACE = patch('face', 1, 25, 32, [
  '.#.......#.',
  '.#.#...#.#.',
  '.####.####.',
  '#####.#####',
  '####...####',
  '###.....###',
  '.##.....##.',
  '.###...###.',
]);
const WHITE_FACE = patch('face', 4, 25, 34, [
  '.....#.....',
  '.....#.....',
  '....###....',
  '....###....',
  '#...###...#',
  '#...###...#',
  '.#########.',
]);
const INNER_EARS = patch('ear', 5, 27, 32, ['#.....#', '#.....#']);
const EYE_ROW = '#...#';
const EYES = patch('eye', 6, 28, 37, [EYE_ROW, EYE_ROW]);
const AWAKE_HEAD = [FACE, WHITE_FACE, INNER_EARS, EYES];
const BLINK_HEAD = [
  {
    ...FACE,
    // During the blink the upper eye pixels become cheek fur.
    rows: FACE.rows.map((row, index) => (index === 5 ? '####...####' : row)),
  },
  WHITE_FACE,
  INNER_EARS,
  patch('eye', 6, 28, 38, [EYE_ROW]),
];

const IDLE_BODY = [
  patch('bib', 4, 27, 41, ['#######', '######.', '#####..', '#####..']),
  patch('frontPaw', 4, 27, 45, ['#.###', '#.##.']),
  patch('rearPaw', 4, 35, 46, ['##']),
  patch('flank', 3, 32, 42, ['.##..', '####.', '.####']),
];

const SIDE_BODY = [
  ...AWAKE_HEAD,
  patch('bib', 4, 27, 41, ['#######', '######.', '.#####.', '.####..']),
  patch('flank', 3, 33, 41, ['..#...', '.####.', '######', '.#####']),
];
const SIDE_BODY_HIGH = shiftRows(SIDE_BODY, -1);
// The native light soles already use white. Only mark the surrounding fur.
const SIDE_PAWS = [
  [
    patch('frontPaw', 4, 28, 46, ['##.', '..#']),
    patch('rearPaw', 4, 36, 46, ['.##', '#..']),
  ],
  [
    patch('frontPaw', 4, 27, 45, ['#....', '....#', '....#']),
    patch('rearPaw', 4, 33, 45, ['....##', '.#...#', '#.....']),
  ],
  [patch('frontPaw', 4, 28, 46, ['##']), patch('rearPaw', 4, 35, 46, ['##'])],
  [patch('frontPaw', 4, 28, 46, ['##']), patch('rearPaw', 4, 36, 46, ['##'])],
  [
    patch('frontPaw', 4, 27, 45, ['###', '#.#']),
    patch('rearPaw', 4, 35, 45, ['##', '.#', '.#']),
  ],
  [patch('frontPaw', 4, 29, 46, ['##']), patch('rearPaw', 4, 35, 46, ['###'])],
] as const;

// The back view shows the outer ears and the saddle on either side of the tail.
const REAR_EARS = patch('ear', 1, 26, 33, [
  '##.....##',
  '###...###',
  '###...###',
]);
const REAR_EARS_HIGH = { ...REAR_EARS, y: 32 };
const REAR_SADDLE = patch('back', 3, 28, 41, [
  '#...#',
  '#...#',
  '#...#',
  '#...#',
  '#...#',
  '#####',
  '##.##',
]);
const FRONT_HEAD_LOW = shiftRows(AWAKE_HEAD, 1);

// The sleeping pose draws the eyelids horizontally. The head moves by a pixel
// while the chest, flank, paws and tail stay planted.
const SLEEP_HEAD = [
  patch('face', 1, 25, 36, [
    '.#.......#.',
    '.#.#...#.#.',
    '.####.####.',
    '#####.#####',
    '####...####',
    '##......###',
    '.###...###.',
    '.###...###.',
  ]),
  patch('face', 4, 25, 38, [
    '.....#.....',
    '.....#.....',
    '....###....',
    '....##.....',
    '#...###...#',
    '....###...#',
  ]),
  ...shiftRows([INNER_EARS], 4),
];
const SLEEP_BODY = [
  patch('flank', 3, 35, 43, ['..##', '.###', '####']),
  ...tail(CAT_SEAL_POINT_PATCHES.sleepHigh),
  ...whitePaws(CAT_SEAL_POINT_PATCHES.sleepHigh),
];
const SLEEP_HIGH = [
  ...SLEEP_HEAD,
  patch('face', 4, 25, 43, ['#']),
  patch('bib', 4, 26, 44, ['#########', '..######.', '..#####..']),
  ...SLEEP_BODY,
];
const SLEEP_LOW = [
  ...shiftRows(SLEEP_HEAD, 1),
  patch('bib', 4, 26, 45, ['#########', '..#####..']),
  ...SLEEP_BODY,
];

export const CAT_RAGDOLL_PATCHES: Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
> = {
  idle: CAT_SEAL_POINT_PATCHES.idle.map((regions, frame) => [
    ...(frame === 3 ? BLINK_HEAD : AWAKE_HEAD),
    ...IDLE_BODY,
    ...tail(regions),
  ]),
  side: CAT_SEAL_POINT_PATCHES.side.map((regions, frame) => [
    ...(frame === 1 || frame === 4 ? SIDE_BODY_HIGH : SIDE_BODY),
    ...SIDE_PAWS[frame]!,
    ...tail(regions),
  ]),
  up: CAT_SEAL_POINT_PATCHES.up.map((regions, frame) => [
    frame % 2 === 0 ? REAR_EARS : REAR_EARS_HIGH,
    REAR_SADDLE,
    ...tail(regions),
    ...whitePaws(regions),
  ]),
  down: CAT_SEAL_POINT_PATCHES.down.map((regions, frame) => [
    ...(frame === 1 ? AWAKE_HEAD : FRONT_HEAD_LOW),
    ...tail(regions),
    ...whitePaws(regions),
  ]),
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, (_, frame) =>
    frame % 4 < 2 ? SLEEP_HIGH : SLEEP_LOW,
  ),
};

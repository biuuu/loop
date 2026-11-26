import type { MaskPatch } from './cat-patterns';

function point(
  part: MaskPatch['part'],
  x: number,
  y: number,
  rows: readonly string[],
): MaskPatch {
  return { part, x, y, rows, marking: part === 'face' ? 1 : 2 };
}

function shiftY(patch: MaskPatch, dy: number): MaskPatch {
  return { ...patch, y: patch.y + dy };
}

const ears = point('ear', 26, 32, ['##.....##', '##.....##', '.#.....#.']);
const face = point('face', 27, 36, [
  '.#####.',
  '#.###.#',
  '#.###.#',
  '#######',
  '.#####.',
]);
// The blinking frame replaces the upper halves of both eyes with fur.
const blink = point('face', 27, 36, [
  '.#####.',
  '#######',
  '#.###.#',
  '#######',
  '.#####.',
]);

const idlePaws = [
  point('frontPaw', 27, 45, ['#..##', '#.##.']),
  point('rearPaw', 34, 45, ['##.', '###']),
];
const raisedTail = point('tail', 39, 38, [
  '..#.',
  '..#.',
  '...#',
  '...#',
  '..#.',
  '.##.',
  '##..',
  '#...',
]);
const angledTail = point('tail', 39, 39, [
  '.....#',
  '....##',
  '....#.',
  '...##.',
  '..##..',
  '###...',
  '#.....',
]);
const lowTail = point('tail', 39, 42, [
  '.......##',
  '.....##..',
  '...##....',
  '###......',
]);
const extendedTail = point('tail', 39, 45, ['##########']);
const idleRaised = [ears, face, raisedTail, ...idlePaws];
const idleAngled = [ears, face, angledTail, ...idlePaws];
const idleLow = [ears, face, lowTail, ...idlePaws];
const idleExtended = [ears, face, extendedTail, ...idlePaws];
const idleBlink = [ears, blink, extendedTail, ...idlePaws];

const sideTail = point('tail', 40, 40, [
  '......#',
  '......#',
  '....##.',
  '..##...',
  '##.....',
]);
const sideHead = [ears, face, sideTail];
const sideHeadHigh = sideHead.map((patch) => shiftY(patch, -1));

// From behind, the raised tail crosses the back and its tip flicks sideways.
const upEars = shiftY(ears, 1);
const upEarsHigh = ears;
const upTailStem = point('tail', 30, 39, ['#', '#', '#', '#', '#', '#', '#']);
const upTailLeft = point('tail', 28, 38, ['###']);
const upTailRight = point('tail', 30, 38, ['###']);
const upTailRightHigh = point('tail', 30, 37, ['###', '#..']);
const upStandingPaws = point('rearPaw', 28, 50, ['#...#', '#...#']);

const downHead = [shiftY(ears, 1), shiftY(face, 1)];
const downTail = point('tail', 28, 25, [
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '.###.',
  '#####',
  '.###.',
]);
const downTailHigh = point('tail', 28, 24, [
  '##...',
  '.##..',
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '.###.',
  '#####',
  '.###.',
]);

const sleepFace = point('face', 27, 40, [
  '.#####..',
  '..##..##',
  '########',
  '#######.',
  '..###...',
]);
const sleepBody = [
  point('tail', 40, 44, [
    '##....',
    '..###.',
    '.....#',
    '.....#',
    '.....#',
    '...##.',
  ]),
  point('frontPaw', 26, 46, ['##']),
  point('rearPaw', 35, 46, ['##']),
];

export const CAT_SEAL_POINT_PATCHES = {
  idle: [
    idleRaised,
    idleAngled,
    idleLow,
    idleBlink,
    idleLow,
    idleAngled,
    idleRaised,
    idleAngled,
    idleLow,
    idleExtended,
    idleLow,
    idleAngled,
  ],
  side: [
    [
      ...sideHead,
      point('frontPaw', 28, 46, ['##.', '#.#']),
      point('rearPaw', 36, 46, ['.##', '#.#']),
    ],
    [
      ...sideHeadHigh,
      point('frontPaw', 27, 45, ['#....', '#...#', '....#']),
      point('rearPaw', 33, 45, ['....##', '.#...#', '#....#']),
    ],
    [
      ...sideHead,
      point('frontPaw', 28, 46, ['##', '#.']),
      point('rearPaw', 35, 46, ['##', '.#']),
    ],
    [
      ...sideHead,
      point('frontPaw', 28, 46, ['##', '.#']),
      point('rearPaw', 36, 46, ['##', '.#']),
    ],
    [
      ...sideHeadHigh,
      point('frontPaw', 27, 45, ['#..', '#.#', '..#']),
      point('rearPaw', 34, 45, ['.#.', '#.#', '..#']),
    ],
    [
      ...sideHead,
      point('frontPaw', 29, 46, ['##', '.#']),
      point('rearPaw', 35, 46, ['###', '.#.']),
    ],
  ],
  up: [
    [upEars, upTailLeft, upTailStem, upStandingPaws],
    [
      upEarsHigh,
      upTailLeft,
      upTailStem,
      point('rearPaw', 28, 48, ['.#....', '##...#', '....##']),
    ],
    [upEars, upTailRight, upTailStem, upStandingPaws],
    [
      upEarsHigh,
      upTailRightHigh,
      upTailStem,
      point('rearPaw', 27, 48, ['....#.', '.#..##', '##....']),
    ],
  ],
  down: [
    [...downHead, downTail, point('frontPaw', 28, 43, ['#', '#'])],
    [ears, face, downTailHigh, point('frontPaw', 28, 43, ['#...#', '#...#'])],
    [...downHead, downTail, point('frontPaw', 32, 43, ['#', '#'])],
  ],
  sleepHigh: [shiftY(ears, 4), sleepFace, ...sleepBody],
  sleepLow: [shiftY(ears, 5), shiftY(sleepFace, 1), ...sleepBody],
} as const;

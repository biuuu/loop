import type { MaskPatch } from './cat-patterns';
import type { CatAnimation } from './cat-sprite';

function patch(
  part: MaskPatch['part'],
  x: number,
  y: number,
  rows: readonly string[],
): MaskPatch {
  return { part, x, y, rows };
}

function shiftY(mask: MaskPatch, dy: number): MaskPatch {
  return { ...mask, y: mask.y + dy };
}

// The ears meet across the crown, with a soft center that stops above the eyes.
const crown = patch('forehead', 26, 32, [
  '##.....#.',
  '###...###',
  '.#######.',
  '...###...',
]);
// The lighter cheek fur bridges the crown and the pale muzzle.
const cheeks: MaskPatch = {
  ...patch('face', 26, 35, [
    '###...###',
    '##.....##',
    '#.......#',
    '#.......#',
  ]),
  marking: 2,
};

const idleBack = patch('back', 33, 42, [
  '##....',
  '.##...',
  '.###..',
  '..####',
]);
const idleRaised = [
  crown,
  cheeks,
  idleBack,
  patch('tail', 39, 38, [
    '..#.',
    '..#.',
    '...#',
    '...#',
    '..#.',
    '.##.',
    '##..',
    '#...',
  ]),
];
const idleAngled = [
  crown,
  cheeks,
  idleBack,
  patch('tail', 39, 39, [
    '.....#',
    '.....#',
    '....#.',
    '....#.',
    '...#..',
    '.##...',
    '#.....',
  ]),
];
const idleLow = [
  crown,
  cheeks,
  idleBack,
  patch('tail', 39, 42, ['.......##', '.....##..', '...##....', '###......']),
];
const idleExtended = [
  crown,
  cheeks,
  idleBack,
  patch('tail', 39, 45, ['##########']),
];

const side = [
  crown,
  cheeks,
  patch('back', 34, 41, ['.#....', '####..', '..####', '....#.']),
  patch('tail', 40, 40, [
    '......#',
    '......#',
    '....##.',
    '..##...',
    '##.....',
  ]),
];
const sideHigh = side.map((mask) => shiftY(mask, -1));

// From behind the raised tail crosses the back. Follow both sides of its ink
// outline, then taper the shading before the hind legs.
const rearCrown = shiftY(crown, 1);
const rearLeftNape = patch('back', 26, 36, [
  '.##...##',
  '##...###',
  '#.....##',
  '##....#.',
]);
const rearRightNape = patch('back', 27, 36, [
  '##...##.',
  '###...##',
  '##.....#',
  '.#....##',
]);
const rearLeftNapeHigh = patch('back', 26, 35, [
  '.##...##',
  '##...###',
  '#.....##',
  '#.....#.',
  '.#....#.',
]);
const rearRightNapeHigh = {
  ...shiftY(rearRightNape, -1),
  rows: [...rearRightNape.rows, '.#....#.'],
};
const rearBack = patch('back', 27, 40, ['##...##', '.#...#.', '.#...#.']);
const rearLeftTip = patch('tail', 28, 38, ['###']);
const rearRightTip = patch('tail', 30, 38, ['###']);
const rearRightTipHigh = patch('tail', 30, 37, ['###', '#..']);
const rearTail = patch('tail', 30, 39, ['#', '#', '#', '#', '#', '#', '#']);

const frontTailBase = [
  '..#..',
  '..#..',
  '..#..',
  '..#..',
  '.###.',
  '.###.',
  '..#..',
];
const front = [
  shiftY(crown, 1),
  shiftY(cheeks, 1),
  patch('tail', 28, 25, ['..#..', '..#..', ...frontTailBase]),
];
const frontHigh = [
  crown,
  cheeks,
  patch('tail', 28, 24, ['##...', '.##..', ...frontTailBase]),
];

// The sleeping head bobs, while the back and the wrapped tail stay in place.
const sleepBody = [
  patch('back', 36, 43, ['.##', '###', '.##']),
  patch('tail', 40, 44, [
    '##....',
    '..###.',
    '.....#',
    '.....#',
    '.....#',
    '...##.',
  ]),
];
const sleepHigh = [shiftY(crown, 4), shiftY(cheeks, 4), ...sleepBody];
const sleepLow = [shiftY(crown, 5), shiftY(cheeks, 5), ...sleepBody];

export const CAT_SILVER_SHADED_PATCHES: Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
> = {
  idle: [
    idleRaised,
    idleAngled,
    idleLow,
    idleExtended,
    idleLow,
    idleAngled,
    idleRaised,
    idleAngled,
    idleLow,
    idleExtended,
    idleLow,
    idleAngled,
  ],
  side: [side, sideHigh, side, side, sideHigh, side],
  up: [
    [rearCrown, rearLeftNape, rearBack, rearLeftTip, rearTail],
    [crown, rearLeftNapeHigh, rearBack, rearLeftTip, rearTail],
    [rearCrown, rearRightNape, rearBack, rearRightTip, rearTail],
    [crown, rearRightNapeHigh, rearBack, rearRightTipHigh, rearTail],
  ],
  down: [front, frontHigh, front],
  sleep: [
    sleepHigh,
    sleepHigh,
    sleepLow,
    sleepLow,
    sleepHigh,
    sleepHigh,
    sleepLow,
    sleepLow,
    sleepHigh,
    sleepHigh,
    sleepLow,
    sleepLow,
    sleepHigh,
    sleepHigh,
    sleepLow,
    sleepLow,
  ],
};

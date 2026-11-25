import type { MaskPatch } from './cat-patterns';

export type PresetFramePatterns = Readonly<
  Record<'cow' | 'orange_white' | 'tortoiseshell', readonly MaskPatch[]>
>;

const COW_CAP: MaskPatch = {
  part: 'forehead',
  marking: 2,
  x: 28,
  y: 32,
  rows: [
    '.....##.',
    '....###.',
    '..#####.',
    '.#######',
    '..#####.',
    '.....##.',
  ],
};
const ORANGE_CAP: MaskPatch = {
  part: 'forehead',
  x: 25,
  y: 32,
  rows: [
    '.##.....##.',
    '.###...###.',
    '.####.####.',
    '#####.#####',
    '####...####',
    '##.......##',
  ],
};
const TORTIE_FACE: readonly MaskPatch[] = [
  { part: 'ear', x: 25, y: 32, rows: ['.#.', '.##', '..#'] },
  { part: 'ear', marking: 2, x: 32, y: 32, rows: ['.##', '..#'] },
  {
    part: 'forehead',
    marking: 2,
    x: 29,
    y: 34,
    rows: ['##.', '.##', '.#.'],
  },
  { part: 'temple', x: 32, y: 34, rows: ['.#..', '..##', '..#.'] },
  {
    part: 'temple',
    marking: 2,
    x: 26,
    y: 38,
    rows: ['#.', '##', '.#'],
  },
];

const SIDE_COW_SADDLE: MaskPatch = {
  part: 'back',
  marking: 2,
  x: 31,
  y: 41,
  rows: ['....#...', '..#####.', '.#######', '..#####.', '....##..'],
};
const SIDE_ORANGE_SADDLE: MaskPatch = {
  part: 'back',
  x: 31,
  y: 41,
  rows: ['.##.#...', '#######.', '########', '.######.', '...###..'],
};
const SIDE_TORTIE_BODY: readonly MaskPatch[] = [
  { part: 'back', x: 31, y: 41, rows: ['.#.', '###', '..#'] },
  {
    part: 'flank',
    marking: 2,
    x: 29,
    y: 43,
    rows: ['.#.', '##.', '.##'],
  },
  { part: 'flank', x: 35, y: 43, rows: ['..#.', '.###', '##..'] },
];

const REAR_COW_CAP: MaskPatch = {
  part: 'back',
  marking: 2,
  x: 25,
  y: 33,
  rows: ['.##....', '.###...', '.#####.', '#######', '.##....'],
};
const REAR_COW_SADDLE: MaskPatch = {
  part: 'back',
  marking: 2,
  x: 27,
  y: 41,
  rows: [
    '.#.....',
    '##.....',
    '##.....',
    '##.....',
    '.#.....',
    '#####..',
    '.##....',
  ],
};
const REAR_ORANGE_CAP: MaskPatch = {
  part: 'back',
  x: 25,
  y: 33,
  rows: ['.##.....##.', '.###...###.', '.#########.', '###########'],
};
const REAR_ORANGE_SADDLE: MaskPatch = {
  part: 'back',
  x: 27,
  y: 40,
  rows: [
    '.#...##',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '#######',
    '##...##',
  ],
};
const REAR_TORTIE_HEAD: readonly MaskPatch[] = [
  { part: 'ear', x: 32, y: 33, rows: ['..#', '.##', '.#.'] },
  { part: 'ear', marking: 2, x: 26, y: 33, rows: ['##.', '#..'] },
  { part: 'back', x: 27, y: 35, rows: ['.##', '##.'] },
  { part: 'back', marking: 2, x: 31, y: 35, rows: ['##.', '.##'] },
];
const REAR_TORTIE_BODY: readonly MaskPatch[] = [
  { part: 'back', marking: 2, x: 32, y: 40, rows: ['#.', '##', '.#'] },
  { part: 'flank', x: 27, y: 42, rows: ['.#', '##', '#.'] },
  { part: 'flank', x: 31, y: 45, rows: ['.#.', '###', '..#'] },
  { part: 'flank', marking: 2, x: 28, y: 46, rows: ['.#', '##'] },
];

const SLEEP_COW_SADDLE: MaskPatch = {
  part: 'back',
  marking: 2,
  x: 32,
  y: 43,
  rows: ['.....#.', '..#####', '.#####.', '..#....'],
};
const SLEEP_ORANGE_SADDLE: MaskPatch = {
  part: 'back',
  x: 31,
  y: 43,
  rows: ['.####.##', '.#######', '..#####.'],
};
const SLEEP_TORTIE_BODY: readonly MaskPatch[] = [
  { part: 'flank', x: 32, y: 43, rows: ['#..', '##.', '.##'] },
  { part: 'back', marking: 2, x: 36, y: 43, rows: ['.#.', '###'] },
  { part: 'flank', x: 36, y: 45, rows: ['..#', '##.'] },
  { part: 'flank', marking: 2, x: 28, y: 44, rows: ['.##', '.#.'] },
];

function shiftRows(patches: readonly MaskPatch[], dy: number) {
  return patches.map((patch) => ({ ...patch, y: patch.y + dy }));
}

// The head shifts with the walk cycle and sleep breathing. The sleeping body
// and the rear saddle share fixed landmarks outside those moving regions.
export const CAT_COAT_PATCHES = {
  idle: {
    cow: [
      COW_CAP,
      {
        part: 'back',
        marking: 2,
        x: 31,
        y: 42,
        rows: ['..##....', '..###...', '.#####..', '...#####', '....##..'],
      },
    ],
    orange_white: [
      ORANGE_CAP,
      {
        part: 'back',
        x: 31,
        y: 41,
        rows: ['.##.....', '####....', '#####...', '.#####..', '...####.'],
      },
    ],
    tortoiseshell: [
      ...TORTIE_FACE,
      { part: 'back', x: 31, y: 41, rows: ['.#.', '###', '..#'] },
      { part: 'flank', marking: 2, x: 28, y: 43, rows: ['.#.', '###', '..#'] },
      { part: 'flank', x: 34, y: 44, rows: ['.##.', '..##', '..#.'] },
    ],
  },
  side: {
    cow: [COW_CAP, SIDE_COW_SADDLE],
    orange_white: [ORANGE_CAP, SIDE_ORANGE_SADDLE],
    tortoiseshell: [...TORTIE_FACE, ...SIDE_TORTIE_BODY],
  },
  sideHigh: {
    cow: shiftRows([COW_CAP, SIDE_COW_SADDLE], -1),
    orange_white: shiftRows([ORANGE_CAP, SIDE_ORANGE_SADDLE], -1),
    tortoiseshell: shiftRows([...TORTIE_FACE, ...SIDE_TORTIE_BODY], -1),
  },
  rear: {
    cow: [REAR_COW_CAP, REAR_COW_SADDLE],
    orange_white: [REAR_ORANGE_CAP, REAR_ORANGE_SADDLE],
    tortoiseshell: [...REAR_TORTIE_HEAD, ...REAR_TORTIE_BODY],
  },
  rearHigh: {
    cow: [...shiftRows([REAR_COW_CAP], -1), REAR_COW_SADDLE],
    orange_white: [...shiftRows([REAR_ORANGE_CAP], -1), REAR_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows(REAR_TORTIE_HEAD, -1), ...REAR_TORTIE_BODY],
  },
  front: {
    cow: shiftRows([COW_CAP], 1),
    orange_white: [
      ...shiftRows([ORANGE_CAP], 1),
      { part: 'back', x: 28, y: 32, rows: ['##.##', '.#.#.'] },
    ],
    tortoiseshell: shiftRows(TORTIE_FACE, 1),
  },
  frontHigh: {
    cow: [COW_CAP],
    orange_white: [
      ORANGE_CAP,
      { part: 'back', x: 28, y: 31, rows: ['##.##', '.#.#.'] },
    ],
    tortoiseshell: TORTIE_FACE,
  },
  sleep: {
    cow: [...shiftRows([COW_CAP], 4), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 4), SLEEP_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows(TORTIE_FACE, 4), ...SLEEP_TORTIE_BODY],
  },
  sleepLow: {
    cow: [...shiftRows([COW_CAP], 5), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 5), SLEEP_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows(TORTIE_FACE, 5), ...SLEEP_TORTIE_BODY],
  },
} satisfies Record<string, PresetFramePatterns>;

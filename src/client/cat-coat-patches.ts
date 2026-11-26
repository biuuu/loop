import type { MaskPatch } from './cat-patterns';

export type PresetFramePatterns = Readonly<
  Record<'cow' | 'orange_white', readonly MaskPatch[]>
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
    '.#########.',
    '###########',
    '####...####',
    '##.......##',
    '##.......##',
  ],
};

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
  },
  side: {
    cow: [COW_CAP, SIDE_COW_SADDLE],
    orange_white: [ORANGE_CAP, SIDE_ORANGE_SADDLE],
  },
  sideHigh: {
    cow: shiftRows([COW_CAP, SIDE_COW_SADDLE], -1),
    orange_white: shiftRows([ORANGE_CAP, SIDE_ORANGE_SADDLE], -1),
  },
  rear: {
    cow: [REAR_COW_CAP, REAR_COW_SADDLE],
    orange_white: [REAR_ORANGE_CAP, REAR_ORANGE_SADDLE],
  },
  rearHigh: {
    cow: [...shiftRows([REAR_COW_CAP], -1), REAR_COW_SADDLE],
    orange_white: [...shiftRows([REAR_ORANGE_CAP], -1), REAR_ORANGE_SADDLE],
  },
  front: {
    cow: shiftRows([COW_CAP], 1),
    orange_white: shiftRows([ORANGE_CAP], 1),
  },
  frontHigh: {
    cow: [COW_CAP],
    orange_white: [ORANGE_CAP],
  },
  sleep: {
    cow: [...shiftRows([COW_CAP], 4), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 4), SLEEP_ORANGE_SADDLE],
  },
  sleepLow: {
    cow: [...shiftRows([COW_CAP], 5), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 5), SLEEP_ORANGE_SADDLE],
  },
} satisfies Record<string, PresetFramePatterns>;

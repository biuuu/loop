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
    '.#########.',
    '###########',
    '####...####',
    '##.......##',
    '##.......##',
  ],
};
// Keep the warm fur connected from one ear into the upper forehead.
const TORTIE_CAP: MaskPatch = {
  part: 'forehead',
  x: 25,
  y: 32,
  rows: ['.##...', '.###..', '.####.', '######', '####..'],
};
const IDLE_TORTIE_SADDLE: MaskPatch = {
  part: 'back',
  x: 31,
  y: 42,
  rows: ['..#.....', '..###...', '..####..', '...####.', '.....#..'],
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
const SIDE_TORTIE_SADDLE: MaskPatch = {
  part: 'back',
  x: 31,
  y: 41,
  rows: ['....#...', '...####.', '..######', '....###.', '.....#..'],
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
const REAR_TORTIE_CAP: MaskPatch = {
  part: 'ear',
  x: 30,
  y: 33,
  rows: ['...##.', '..###.', '.####.', '#####.'],
};
const REAR_TORTIE_SADDLE: MaskPatch = {
  part: 'back',
  x: 29,
  y: 41,
  rows: ['...#.', '...##', '...##', '...##', '...#.', '.####', '...##'],
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
const SLEEP_TORTIE_SADDLE: MaskPatch = {
  part: 'back',
  x: 32,
  y: 43,
  rows: ['.....#.', '...####', '..####.', '..#....'],
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
    tortoiseshell: [TORTIE_CAP, IDLE_TORTIE_SADDLE],
  },
  side: {
    cow: [COW_CAP, SIDE_COW_SADDLE],
    orange_white: [ORANGE_CAP, SIDE_ORANGE_SADDLE],
    tortoiseshell: [TORTIE_CAP, SIDE_TORTIE_SADDLE],
  },
  sideHigh: {
    cow: shiftRows([COW_CAP, SIDE_COW_SADDLE], -1),
    orange_white: shiftRows([ORANGE_CAP, SIDE_ORANGE_SADDLE], -1),
    tortoiseshell: shiftRows([TORTIE_CAP, SIDE_TORTIE_SADDLE], -1),
  },
  rear: {
    cow: [REAR_COW_CAP, REAR_COW_SADDLE],
    orange_white: [REAR_ORANGE_CAP, REAR_ORANGE_SADDLE],
    tortoiseshell: [REAR_TORTIE_CAP, REAR_TORTIE_SADDLE],
  },
  rearHigh: {
    cow: [...shiftRows([REAR_COW_CAP], -1), REAR_COW_SADDLE],
    orange_white: [...shiftRows([REAR_ORANGE_CAP], -1), REAR_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows([REAR_TORTIE_CAP], -1), REAR_TORTIE_SADDLE],
  },
  front: {
    cow: shiftRows([COW_CAP], 1),
    orange_white: shiftRows([ORANGE_CAP], 1),
    tortoiseshell: shiftRows([TORTIE_CAP], 1),
  },
  frontHigh: {
    cow: [COW_CAP],
    orange_white: [ORANGE_CAP],
    tortoiseshell: [TORTIE_CAP],
  },
  sleep: {
    cow: [...shiftRows([COW_CAP], 4), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 4), SLEEP_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows([TORTIE_CAP], 4), SLEEP_TORTIE_SADDLE],
  },
  sleepLow: {
    cow: [...shiftRows([COW_CAP], 5), SLEEP_COW_SADDLE],
    orange_white: [...shiftRows([ORANGE_CAP], 5), SLEEP_ORANGE_SADDLE],
    tortoiseshell: [...shiftRows([TORTIE_CAP], 5), SLEEP_TORTIE_SADDLE],
  },
} satisfies Record<string, PresetFramePatterns>;

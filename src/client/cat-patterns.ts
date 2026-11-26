import { CAT_CALICO_PATCHES } from './cat-calico';
import { CAT_ANIMATIONS, CAT_CELL_SIZE, type CatAnimation } from './cat-sprite';
import { CAT_COAT_PATCHES, type PresetFramePatterns } from './cat-coat-patches';
import { CAT_RAGDOLL_PATCHES } from './cat-ragdoll';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import { CAT_TABBY_WHITE_DETAILS } from './cat-tabby-white';

export const RAGDOLL_EYE_MARKING = 6;

export type CatPattern = keyof FramePatterns;
export interface MaskPatch {
  readonly part:
    | 'bib'
    | 'frontPaw'
    | 'rearPaw'
    | 'forehead'
    | 'flank'
    | 'back'
    | 'ear'
    | 'temple'
    | 'face'
    | 'tail'
    | 'eye';
  readonly x: number;
  readonly y: number;
  readonly rows: readonly string[];
  readonly marking?: 1 | 2 | 3 | 4 | 5 | 6;
}
interface BaseFramePatterns extends PresetFramePatterns {
  readonly socks: readonly MaskPatch[];
  readonly tabby: readonly MaskPatch[];
  readonly seal_point: readonly MaskPatch[];
}
interface FramePatterns extends BaseFramePatterns {
  readonly calico: readonly MaskPatch[];
  readonly tabby_white: readonly MaskPatch[];
  readonly ragdoll: readonly MaskPatch[];
}

// Coordinates are frame-local source pixels. Only the regions named here were
// compared for reuse: blinking eyes, tail swings and sleep Zs lie outside them.
const IDLE: Omit<BaseFramePatterns, 'seal_point'> = {
  socks: [
    { part: 'bib', x: 28, y: 41, rows: ['.#..', '####', '.##.', '..#.'] },
    { part: 'frontPaw', x: 27, y: 45, rows: ['#..#', '#.##'] },
    { part: 'rearPaw', x: 35, y: 45, rows: ['.#', '##'] },
  ],
  tabby: [
    { part: 'forehead', x: 28, y: 34, rows: ['#.....#', '#.....#'] },
    { part: 'flank', x: 34, y: 43, rows: ['#..', '#.#', '..#'] },
  ],
  ...CAT_COAT_PATCHES.idle,
};

const SIDE_BIB: MaskPatch = {
  part: 'bib',
  x: 27,
  y: 41,
  rows: ['.#.', '###', '.##', '.#.'],
};
const SIDE_BIB_HIGH: MaskPatch = { ...SIDE_BIB, y: 40 };
const SIDE_TABBY: readonly MaskPatch[] = [
  { part: 'forehead', x: 28, y: 34, rows: ['#.....#', '#.....#'] },
  { part: 'flank', x: 35, y: 42, rows: ['#...', '#..#', '...#'] },
];
const SIDE_TABBY_HIGH: readonly MaskPatch[] = [
  { part: 'forehead', x: 28, y: 33, rows: ['#.....#', '#.....#'] },
  { part: 'flank', x: 35, y: 41, rows: ['#...', '#..#', '...#'] },
];

// Rear views hide the chest and forehead. The raised tail splits the upper back
// stripe; the lower stripe changes shape when a hind leg is lifted.
const REAR_NAPE: MaskPatch = {
  part: 'back',
  x: 28,
  y: 35,
  rows: ['#...#', '#...#'],
};
const REAR_NAPE_HIGH: MaskPatch = { ...REAR_NAPE, y: 34 };
const REAR_BACK: MaskPatch = {
  part: 'back',
  x: 27,
  y: 44,
  rows: ['##.#.##'],
};
const REAR_RUMP: MaskPatch = {
  part: 'back',
  x: 27,
  y: 47,
  rows: ['#######'],
};
const REAR_RUMP_STEP: MaskPatch = { ...REAR_RUMP, rows: ['###.###'] };

const FRONT_TABBY: readonly MaskPatch[] = [
  { part: 'forehead', x: 28, y: 35, rows: ['#.....#', '#.....#'] },
  { part: 'back', x: 29, y: 31, rows: ['###'] },
];
const FRONT_TABBY_HIGH: readonly MaskPatch[] = [
  { part: 'forehead', x: 28, y: 34, rows: ['#.....#', '#.....#'] },
  { part: 'back', x: 29, y: 30, rows: ['###'] },
];
// Front views show paw tips only; a bib here reads as a white mouth on the head.
const FRONT_STANDING: BaseFramePatterns = {
  socks: [{ part: 'frontPaw', x: 28, y: 43, rows: ['#...#', '#...#'] }],
  tabby: FRONT_TABBY_HIGH,
  seal_point: CAT_SEAL_POINT_PATCHES.down[1],
  ...CAT_COAT_PATCHES.frontHigh,
};

const SLEEP_PAWS: readonly MaskPatch[] = [
  { part: 'frontPaw', x: 26, y: 46, rows: ['##'] },
  { part: 'rearPaw', x: 35, y: 46, rows: ['##'] },
];
const SLEEP_FLANK: MaskPatch = {
  part: 'flank',
  x: 36,
  y: 44,
  rows: ['#.#', '#.#'],
};
// Omit the upper throat pixel so breathing never makes it blink in and out.
const SLEEP_BIB: MaskPatch = {
  part: 'bib',
  x: 29,
  y: 44,
  rows: ['###', '.#.'],
};
const SLEEP_HIGH: BaseFramePatterns = {
  socks: [SLEEP_BIB, ...SLEEP_PAWS],
  tabby: [
    { part: 'forehead', x: 28, y: 38, rows: ['#.....#', '#.....#'] },
    SLEEP_FLANK,
  ],

  seal_point: CAT_SEAL_POINT_PATCHES.sleepHigh,
  ...CAT_COAT_PATCHES.sleep,
};
const SLEEP_LOW: BaseFramePatterns = {
  socks: [SLEEP_BIB, ...SLEEP_PAWS],
  tabby: [
    { part: 'forehead', x: 28, y: 39, rows: ['#.....#', '#.....#'] },
    SLEEP_FLANK,
  ],

  seal_point: CAT_SEAL_POINT_PATCHES.sleepLow,
  ...CAT_COAT_PATCHES.sleepLow,
};

const BASE_PATTERN_PATCHES: Readonly<
  Record<CatAnimation, readonly BaseFramePatterns[]>
> = {
  idle: CAT_SEAL_POINT_PATCHES.idle.map((seal_point) => ({
    ...IDLE,
    seal_point,
  })),
  side: [
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 45, rows: ['#..', '##.', '..#'] },
        { part: 'rearPaw', x: 36, y: 46, rows: ['.##', '#..'] },
      ],
      tabby: SIDE_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.side[0],
      ...CAT_COAT_PATCHES.side,
    },
    {
      socks: [
        SIDE_BIB_HIGH,
        { part: 'frontPaw', x: 27, y: 45, rows: ['#....', '....#', '....#'] },
        { part: 'rearPaw', x: 33, y: 45, rows: ['.....#', '.....#', '#.....'] },
      ],
      tabby: SIDE_TABBY_HIGH,
      seal_point: CAT_SEAL_POINT_PATCHES.side[1],
      ...CAT_COAT_PATCHES.sideHigh,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 45, rows: ['#.', '##'] },
        { part: 'rearPaw', x: 35, y: 46, rows: ['##'] },
      ],
      tabby: SIDE_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.side[2],
      ...CAT_COAT_PATCHES.side,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 46, rows: ['##'] },
        { part: 'rearPaw', x: 36, y: 45, rows: ['.#', '##'] },
      ],
      tabby: SIDE_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.side[3],
      ...CAT_COAT_PATCHES.side,
    },
    {
      socks: [
        SIDE_BIB_HIGH,
        { part: 'frontPaw', x: 27, y: 45, rows: ['#..', '#.#'] },
        { part: 'rearPaw', x: 35, y: 45, rows: ['#.', '.#', '.#'] },
      ],
      tabby: SIDE_TABBY_HIGH,
      seal_point: CAT_SEAL_POINT_PATCHES.side[4],
      ...CAT_COAT_PATCHES.sideHigh,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 29, y: 45, rows: ['#.', '##'] },
        { part: 'rearPaw', x: 35, y: 46, rows: ['###'] },
      ],
      tabby: SIDE_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.side[5],
      ...CAT_COAT_PATCHES.side,
    },
  ],
  up: [
    {
      socks: [{ part: 'rearPaw', x: 28, y: 50, rows: ['#...#', '#...#'] }],
      tabby: [REAR_NAPE, REAR_BACK, REAR_RUMP],
      seal_point: CAT_SEAL_POINT_PATCHES.up[0],
      ...CAT_COAT_PATCHES.rear,
    },
    {
      socks: [
        { part: 'rearPaw', x: 28, y: 48, rows: ['.#....', '##...#', '....##'] },
      ],
      tabby: [REAR_NAPE_HIGH, REAR_BACK, REAR_RUMP_STEP],
      seal_point: CAT_SEAL_POINT_PATCHES.up[1],
      ...CAT_COAT_PATCHES.rearHigh,
    },
    {
      socks: [{ part: 'rearPaw', x: 28, y: 50, rows: ['#...#', '#...#'] }],
      tabby: [REAR_NAPE, REAR_BACK, REAR_RUMP],
      seal_point: CAT_SEAL_POINT_PATCHES.up[2],
      ...CAT_COAT_PATCHES.rear,
    },
    {
      socks: [
        { part: 'rearPaw', x: 27, y: 48, rows: ['....#.', '.#..##', '##....'] },
      ],
      tabby: [REAR_NAPE_HIGH, REAR_BACK, REAR_RUMP_STEP],
      seal_point: CAT_SEAL_POINT_PATCHES.up[3],
      ...CAT_COAT_PATCHES.rearHigh,
    },
  ],
  down: [
    {
      socks: [{ part: 'frontPaw', x: 28, y: 43, rows: ['#', '#'] }],
      tabby: FRONT_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.down[0],
      ...CAT_COAT_PATCHES.front,
    },
    FRONT_STANDING,
    {
      socks: [{ part: 'frontPaw', x: 32, y: 43, rows: ['#', '#'] }],
      tabby: FRONT_TABBY,
      seal_point: CAT_SEAL_POINT_PATCHES.down[2],
      ...CAT_COAT_PATCHES.front,
    },
  ],
  sleep: [
    SLEEP_HIGH,
    SLEEP_HIGH,
    SLEEP_LOW,
    SLEEP_LOW,
    SLEEP_HIGH,
    SLEEP_HIGH,
    SLEEP_LOW,
    SLEEP_LOW,
    SLEEP_HIGH,
    SLEEP_HIGH,
    SLEEP_LOW,
    SLEEP_LOW,
    SLEEP_HIGH,
    SLEEP_HIGH,
    SLEEP_LOW,
    SLEEP_LOW,
  ],
};

function addCoatPresets(animation: CatAnimation): readonly FramePatterns[] {
  return BASE_PATTERN_PATCHES[animation].map((patches, frame) => ({
    ...patches,
    calico: CAT_CALICO_PATCHES[animation][frame]!,
    ragdoll: CAT_RAGDOLL_PATCHES[animation][frame]!,
    tabby_white: [
      ...(CAT_TABBY_WHITE_DETAILS[animation]?.[frame] ?? []),
      ...patches.tabby.filter((patch) => patch.part === 'back'),
      ...patches.socks.map((patch) => ({ ...patch, marking: 2 as const })),
    ],
  }));
}

export const CAT_PATTERN_PATCHES = {
  idle: addCoatPresets('idle'),
  side: addCoatPresets('side'),
  up: addCoatPresets('up'),
  down: addCoatPresets('down'),
  sleep: addCoatPresets('sleep'),
} as const satisfies Record<CatAnimation, readonly FramePatterns[]>;

const PARTS = new Set<MaskPatch['part']>([
  'bib',
  'frontPaw',
  'rearPaw',
  'forehead',
  'flank',
  'back',
  'ear',
  'temple',
  'face',
  'tail',
  'eye',
]);
const masks = new Map<string, Uint8Array>();

/** Lazily rasterize authored regions once per pattern and source frame. */
export function getPatternMask(
  pattern: CatPattern,
  animation: CatAnimation,
  frame: number,
): Uint8Array {
  if (!Object.hasOwn(CAT_PATTERN_PATCHES.idle[0]!, pattern))
    throw new Error('Unknown cat pattern');
  if (!Object.hasOwn(CAT_ANIMATIONS, animation))
    throw new Error('Unknown cat animation');
  const frames = CAT_PATTERN_PATCHES[animation];
  if (frames.length !== CAT_ANIMATIONS[animation].frames)
    throw new Error('Incomplete cat pattern frames');
  if (!Number.isInteger(frame) || frame < 0 || frame >= frames.length)
    throw new Error('Invalid cat pattern frame');
  const key = `${pattern}:${animation}:${frame}`;
  const cached = masks.get(key);
  if (cached) return cached;
  const mask = new Uint8Array(CAT_CELL_SIZE * CAT_CELL_SIZE);
  const patches = frames[frame]![pattern];
  const maxMarking = pattern === 'ragdoll' ? RAGDOLL_EYE_MARKING : 2;
  if (!Array.isArray(patches as unknown))
    throw new Error('Missing cat pattern patches');
  for (const patch of patches) {
    const width = patch.rows[0]?.length ?? 0;
    const marking = patch.marking ?? 1;
    if (
      !PARTS.has(patch.part) ||
      !Number.isInteger(patch.x) ||
      !Number.isInteger(patch.y) ||
      patch.x < 0 ||
      patch.y < 0 ||
      !Number.isInteger(marking) ||
      marking < 1 ||
      marking > maxMarking ||
      (patch.part === 'eye') !== (marking === RAGDOLL_EYE_MARKING) ||
      width === 0 ||
      patch.rows.length === 0 ||
      patch.x + width > CAT_CELL_SIZE ||
      patch.y + patch.rows.length > CAT_CELL_SIZE ||
      !patch.rows.some((row) => row.includes('#')) ||
      patch.rows.some((row) => row.length !== width || !/^[#.]+$/.test(row))
    ) {
      throw new Error('Invalid cat pattern patch');
    }
    for (let y = 0; y < patch.rows.length; y++) {
      for (let x = 0; x < width; x++) {
        if (patch.rows[y]![x] === '#')
          mask[(patch.y + y) * CAT_CELL_SIZE + patch.x + x] = marking;
      }
    }
  }
  masks.set(key, mask);
  return mask;
}

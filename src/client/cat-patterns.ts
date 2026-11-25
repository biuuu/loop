import { CAT_ANIMATIONS, CAT_CELL_SIZE, type CatAnimation } from './cat-sprite';

export type CatPattern = 'socks' | 'tabby';
export interface MaskPatch {
  readonly part: 'bib' | 'frontPaw' | 'rearPaw' | 'forehead' | 'flank' | 'back';
  readonly x: number;
  readonly y: number;
  readonly rows: readonly string[];
}
export interface FramePatterns {
  readonly socks: readonly MaskPatch[];
  readonly tabby: readonly MaskPatch[];
}

// Coordinates are frame-local source pixels. Only the regions named here were
// compared for reuse: blinking eyes, tail swings and sleep Zs lie outside them.
const IDLE: FramePatterns = {
  socks: [
    { part: 'bib', x: 28, y: 41, rows: ['.#..', '####', '.##.', '..#.'] },
    { part: 'frontPaw', x: 27, y: 45, rows: ['#..#', '#.##'] },
    { part: 'rearPaw', x: 35, y: 45, rows: ['.#', '##'] },
  ],
  tabby: [
    { part: 'forehead', x: 28, y: 34, rows: ['#.....#', '#.....#'] },
    { part: 'flank', x: 34, y: 43, rows: ['#..', '#.#', '..#'] },
  ],
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
const FRONT_STANDING: FramePatterns = {
  socks: [{ part: 'frontPaw', x: 28, y: 43, rows: ['#...#', '#...#'] }],
  tabby: FRONT_TABBY_HIGH,
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
const SLEEP_HIGH: FramePatterns = {
  socks: [SLEEP_BIB, ...SLEEP_PAWS],
  tabby: [
    { part: 'forehead', x: 28, y: 38, rows: ['#.....#', '#.....#'] },
    SLEEP_FLANK,
  ],
};
const SLEEP_LOW: FramePatterns = {
  socks: [SLEEP_BIB, ...SLEEP_PAWS],
  tabby: [
    { part: 'forehead', x: 28, y: 39, rows: ['#.....#', '#.....#'] },
    SLEEP_FLANK,
  ],
};

// The grooming body and raised paw stay in place while the head lifts.
const GROOM_SOCKS: readonly MaskPatch[] = [
  { part: 'bib', x: 30, y: 41, rows: ['.##', '###', '..#'] },
  { part: 'frontPaw', x: 27, y: 41, rows: ['###', '#..'] },
  { part: 'frontPaw', x: 29, y: 46, rows: ['##'] },
  { part: 'rearPaw', x: 36, y: 45, rows: ['.#', '##'] },
];
const GROOM_FLANK: MaskPatch = {
  part: 'flank',
  x: 34,
  y: 43,
  rows: ['#..', '#.#', '..#'],
};
const GROOM_LOW: FramePatterns = {
  socks: GROOM_SOCKS,
  tabby: [
    { part: 'forehead', x: 28, y: 34, rows: ['#.....#', '#.....#'] },
    GROOM_FLANK,
  ],
};
const GROOM_HIGH: FramePatterns = {
  socks: GROOM_SOCKS,
  tabby: [
    { part: 'forehead', x: 28, y: 33, rows: ['#.....#', '#.....#'] },
    GROOM_FLANK,
  ],
};

export const CAT_PATTERN_PATCHES: Readonly<
  Record<CatAnimation, readonly FramePatterns[]>
> = {
  idle: [
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
    IDLE,
  ],
  side: [
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 45, rows: ['#..', '##.', '..#'] },
        { part: 'rearPaw', x: 36, y: 46, rows: ['.##', '#..'] },
      ],
      tabby: SIDE_TABBY,
    },
    {
      socks: [
        SIDE_BIB_HIGH,
        { part: 'frontPaw', x: 27, y: 45, rows: ['#....', '....#', '....#'] },
        { part: 'rearPaw', x: 33, y: 45, rows: ['.....#', '.....#', '#.....'] },
      ],
      tabby: SIDE_TABBY_HIGH,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 45, rows: ['#.', '##'] },
        { part: 'rearPaw', x: 35, y: 46, rows: ['##'] },
      ],
      tabby: SIDE_TABBY,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 28, y: 46, rows: ['##'] },
        { part: 'rearPaw', x: 36, y: 45, rows: ['.#', '##'] },
      ],
      tabby: SIDE_TABBY,
    },
    {
      socks: [
        SIDE_BIB_HIGH,
        { part: 'frontPaw', x: 27, y: 45, rows: ['#..', '#.#'] },
        { part: 'rearPaw', x: 35, y: 45, rows: ['#.', '.#', '.#'] },
      ],
      tabby: SIDE_TABBY_HIGH,
    },
    {
      socks: [
        SIDE_BIB,
        { part: 'frontPaw', x: 29, y: 45, rows: ['#.', '##'] },
        { part: 'rearPaw', x: 35, y: 46, rows: ['###'] },
      ],
      tabby: SIDE_TABBY,
    },
  ],
  up: [
    {
      socks: [{ part: 'rearPaw', x: 28, y: 50, rows: ['#...#', '#...#'] }],
      tabby: [REAR_NAPE, REAR_BACK, REAR_RUMP],
    },
    {
      socks: [
        { part: 'rearPaw', x: 28, y: 48, rows: ['.#....', '##...#', '....##'] },
      ],
      tabby: [REAR_NAPE_HIGH, REAR_BACK, REAR_RUMP_STEP],
    },
    {
      socks: [{ part: 'rearPaw', x: 28, y: 50, rows: ['#...#', '#...#'] }],
      tabby: [REAR_NAPE, REAR_BACK, REAR_RUMP],
    },
    {
      socks: [
        { part: 'rearPaw', x: 27, y: 48, rows: ['....#.', '.#..##', '##....'] },
      ],
      tabby: [REAR_NAPE_HIGH, REAR_BACK, REAR_RUMP_STEP],
    },
  ],
  down: [
    {
      socks: [{ part: 'frontPaw', x: 28, y: 43, rows: ['#', '#'] }],
      tabby: FRONT_TABBY,
    },
    FRONT_STANDING,
    {
      socks: [{ part: 'frontPaw', x: 32, y: 43, rows: ['#', '#'] }],
      tabby: FRONT_TABBY,
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
  groom: [GROOM_LOW, GROOM_LOW, GROOM_HIGH, GROOM_HIGH],
};

const PARTS = new Set<MaskPatch['part']>([
  'bib',
  'frontPaw',
  'rearPaw',
  'forehead',
  'flank',
  'back',
]);
const masks = new Map<string, Uint8Array>();

/** Lazily rasterize authored regions once per pattern and source frame. */
export function getPatternMask(
  pattern: CatPattern,
  animation: CatAnimation,
  frame: number,
): Uint8Array {
  if (pattern !== 'socks' && pattern !== 'tabby')
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
  if (!Array.isArray(patches as unknown))
    throw new Error('Missing cat pattern patches');
  for (const patch of patches) {
    const width = patch.rows[0]?.length ?? 0;
    if (
      !PARTS.has(patch.part) ||
      !Number.isInteger(patch.x) ||
      !Number.isInteger(patch.y) ||
      patch.x < 0 ||
      patch.y < 0 ||
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
          mask[(patch.y + y) * CAT_CELL_SIZE + patch.x + x] = 1;
      }
    }
  }
  masks.set(key, mask);
  return mask;
}

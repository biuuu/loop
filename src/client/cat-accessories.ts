import type {
  CatAccessoryChoice,
  CatAccessoryColor,
  CatAccessoryId,
} from '../shared/accessories';
import { CAT_ANIMATIONS, CAT_CELL_SIZE, type CatAnimation } from './cat-sprite';
import {
  CAT_APPEARANCE_HEIGHT,
  CAT_APPEARANCE_WIDTH,
  CAT_PACKED_ROWS,
} from './cat-appearance';

type Paint = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>;
type TailKnot = readonly [x: number, y: number, sideways?: true];

// D = outline, L = light, M = wool, S = shadow.
const beretColors = {
  D: '#354a3e',
  L: '#a3b795',
  M: '#7b9878',
  S: '#5e7b61',
};
const beretFront = [
  '...DD.....',
  '....D.....',
  '..DDDDD...',
  '.DLLMMMDD.',
  'DLMMMMMMSD',
  '.DSSSSSDD.',
  '..DDDDD...',
];
const beretBack = [
  '.....DD...',
  '.....D....',
  '...DDDDD..',
  '.DDMMLMMD.',
  'DSMMMMMLMD',
  '.DDSSSSSD.',
  '...DDDDD..',
];

const daisyColors = { D: '#a4876d', W: '#fff2d7', G: '#dc9f45' };
const daisy = ['..D..', '.DWD.', 'DWGWD', '.DWD.', '..D..'];
const sproutColors = { D: '#4c6846', M: '#84ad60', L: '#c1d98c' };
const sprout = ['DL...LD.', 'DML.LMMD', '.DMLMDD.', '...MD...', '...DD...'];
const sproutLying = [
  '......D.',
  '.LD..LMD',
  'DMLDMMDD',
  '.DDMD...',
  '...DD...',
];
const headphoneColors = {
  D: '#3f4659',
  S: '#665e74',
  M: '#7b7693',
  L: '#d4b4d7',
};
const headphones = [
  '....DDDDDDD....',
  '...DMMMMMMMD...',
  '..DD.......DD..',
  '.DD.........DD.',
  'DLD.........DLD',
  'DMDD.......DDMD',
  'DMD.........DMD',
  '.DD.........DD.',
];
const headphonesBack = [
  '....DDDDDDD....',
  '...DMMMMMMMD...',
  '..DD.......DD..',
  '.DS.........SD.',
  'DMD.........DMD',
  'DSDD.......DDSD',
  '.DD.........DD.',
];
const headphonesLying = [
  '...DDDDDD......',
  '..DMMMMMMDD....',
  '.DD.......DD...',
  'DLD.........DLD',
  'DMDD.......DDMD',
  '.DD.........DD.',
];

// Y is the height of the head in each original 64px cell, above the eyes.
// Downward walking has a raised tail behind this layer. Sleep Zs start farther right.
const headY = {
  idle: [31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31],
  side: [31, 30, 31, 31, 30, 31],
  up: [32, 31, 32, 31],
  down: [32, 31, 32],
  sleep: [35, 35, 36, 36, 35, 35, 36, 36, 35, 35, 36, 36, 35, 35, 36, 36],
} satisfies Record<CatAnimation, readonly number[]>;

const chestSamples = {
  bell: {
    colors: { D: '#684833', L: '#ffe5a3', M: '#e3ab59', S: '#b47542' },
    upright: { x: 27, rows: ['.DLD.', 'DMMMD', '.DSD.'] },
    down: { x: 29, rows: ['DLD', '.S.'] },
    sleep: { x: 26, rows: ['.DL', 'DMD'] },
  },
  bow: {
    colors: {
      D: '#304a63',
      M: '#517f9f',
      L: '#a7d4e8',
      K: '#ffe0a4',
      J: '#d9af72',
    },
    upright: { x: 25, rows: ['DMM..MMD', 'DLLKJLLD', '.DD..DD.'] },
    down: { x: 27, rows: ['DL...LD', 'DLDKDLD'] },
    sleep: { x: 26, rows: ['.DMMD', 'DLDKD'] },
  },
  scarf: {
    colors: { D: '#794d42', M: '#ba7560', L: '#f2ad8d' },
    upright: { x: 26, rows: ['DDLLMDD', '.DLMD.', '..DMD.', '...D..'] },
    down: { x: 28, rows: ['DLMLD', '.DMD.', '..D..'] },
    sleep: { x: 26, rows: ['.DLMD', 'DMD..'] },
  },
  'star-pin': {
    colors: { D: '#4d3e61', M: '#b894c7', L: '#ffe098' },
    upright: { x: 26, rows: ['...D...', 'DMLLLMD', '.DMLMD.', '..D.D..'] },
    down: { x: 28, rows: ['..D..', 'DMLMD', '.D.D.'] },
    sleep: { x: 26, rows: ['.LD', 'DMD'] },
  },
};
const chestColorVariants: Partial<
  Record<
    CatAccessoryId,
    Partial<Record<CatAccessoryColor, Record<string, string>>>
  >
> = {
  bow: {
    rose: {
      D: '#714457',
      M: '#b46d84',
      L: '#f1b5c1',
      K: '#ffe0a4',
      J: '#d9af72',
    },
    sage: {
      D: '#405947',
      M: '#67865f',
      L: '#b5ce9f',
      K: '#ffe0a4',
      J: '#d9af72',
    },
  },
  scarf: {
    blue: { D: '#3e6278', M: '#5d8da6', L: '#afd4e6' },
    sage: { D: '#52694a', M: '#7b966a', L: '#c0d6a2' },
  },
};
const ribbonColors = { D: '#8b4c60', L: '#ffd0c2', M: '#d88291' };
const ribbon = ['D...D', 'DMLMD', '.DLD.', '.D.D.'];
const ribbonFlat = ['..DD', '.DM.', '..LL', '.DM.', '..DD'];
const streamerColors = { D: '#48736e', L: '#b5e2cf', M: '#77b6ab' };
const streamer = ['LD...', '.LMD.', '..DMD'];
const streamerFlat = ['..LD.', '.DMD.', 'DMD..'];
const tailRingColors = {
  D: '#64504f',
  M: '#b18469',
  L: '#e3be93',
  K: '#bda4dc',
};
const tailRing = ['.DLD.', 'DMMKD', '.DDD.'];
const tailRingFlat = ['.DD..', '.DL..', '.DMD.', '.DKD.', '..D..'];
const tailFlowerColors = { D: '#885d78', L: '#e7aaca', M: '#ffe0a4' };
const tailFlower = ['..L..', '.DLD.', 'DLMLD', '.DLD.'];
// Pixel coordinates locate the knot on the tail rather than relative to the
// body. The sitting tail flicks between four shapes; the sleeping curl is fixed.
const raised = [42, 40] as const;
const angled = [43, 42] as const;
const low = [45, 43, true] as const;
const flat = [46, 45, true] as const;
const sleepTail = [45, 47] as const;
const tailKnots = {
  idle: [
    raised,
    angled,
    low,
    flat,
    low,
    angled,
    raised,
    angled,
    low,
    flat,
    low,
    angled,
  ],
  side: [
    [46, 41],
    [46, 40],
    [46, 41],
    [46, 41],
    [46, 40],
    [46, 41],
  ],
  up: [
    [29, 38],
    [29, 38],
    [31, 38],
    [31, 37],
  ],
  down: [
    [30, 25],
    [29, 24],
    [30, 25],
  ],
  sleep: Array<TailKnot>(CAT_ANIMATIONS.sleep.frames).fill(sleepTail),
} satisfies Record<CatAnimation, readonly TailKnot[]>;
// The flower sits one small step farther along the tip than a tied ribbon.
const raisedTip = [41, 38] as const;
const angledTip = [44, 39] as const;
const lowTip = [47, 42] as const;
const flatTip = [48, 45] as const;
const tailTips = {
  idle: [
    raisedTip,
    angledTip,
    lowTip,
    flatTip,
    lowTip,
    angledTip,
    raisedTip,
    angledTip,
    lowTip,
    flatTip,
    lowTip,
    angledTip,
  ],
  side: [
    [46, 40],
    [46, 39],
    [46, 40],
    [46, 40],
    [46, 39],
    [46, 40],
  ],
  up: [
    [28, 38],
    [28, 38],
    [32, 38],
    [32, 37],
  ],
  down: tailKnots.down,
  sleep: Array<TailKnot>(CAT_ANIMATIONS.sleep.frames).fill([44, 49]),
} satisfies Record<CatAnimation, readonly TailKnot[]>;

export function drawCatAccessory(
  context: Paint,
  sample: CatAccessoryId,
  animation: CatAnimation,
  column: number,
  color: CatAccessoryColor = 'default',
) {
  const head = headY[animation][column]!;
  if (sample === 'beret') {
    const behind = animation === 'up';
    drawPixels(
      context,
      behind ? beretBack : beretFront,
      beretColors,
      behind ? 27 : 24,
      head - 4,
    );
    return;
  }
  if (sample === 'daisy') {
    drawPixels(
      context,
      daisy,
      daisyColors,
      animation === 'up' ? 32 : 24,
      head - 2,
    );
    return;
  }
  if (sample === 'sprout') {
    drawPixels(
      context,
      animation === 'sleep' ? sproutLying : sprout,
      sproutColors,
      26,
      head - 2,
    );
    return;
  }
  if (sample === 'headphones') {
    const rows =
      animation === 'sleep'
        ? headphonesLying
        : animation === 'up'
          ? headphonesBack
          : headphones;
    drawPixels(context, rows, headphoneColors, 23, head - 3);
    return;
  }
  if (
    sample === 'bell' ||
    sample === 'bow' ||
    sample === 'scarf' ||
    sample === 'star-pin'
  ) {
    // The back hides chest accessories. The lowered head partly covers them in
    // sleep, and there's less room under the chin in the front-facing walk.
    if (animation === 'up') return;
    const { colors, upright, down, sleep } = chestSamples[sample];
    const pose =
      animation === 'sleep' ? sleep : animation === 'down' ? down : upright;
    drawPixels(
      context,
      pose.rows,
      chestColorVariants[sample]?.[color] ?? colors,
      pose.x,
      head + (pose === upright ? 11 : 10),
    );
    return;
  }
  if (sample === 'tail-flower') {
    const [x, y] = tailTips[animation][column]!;
    drawPixels(context, tailFlower, tailFlowerColors, x - 2, y - 2);
    return;
  }
  const [x, y, sideways] = tailKnots[animation][column]!;
  if (sample === 'tail-ring') {
    drawPixels(
      context,
      sideways ? tailRingFlat : tailRing,
      tailRingColors,
      x - 2,
      y - (sideways ? 2 : 1),
    );
    return;
  }
  if (sample === 'streamer') {
    drawPixels(
      context,
      sideways ? streamerFlat : streamer,
      streamerColors,
      x - (sideways ? 2 : 0),
      y,
    );
    return;
  }
  drawPixels(
    context,
    sideways ? ribbonFlat : ribbon,
    ribbonColors,
    x - 2,
    y - (sideways ? 2 : 1),
  );
}

/** Use the same frame coordinates as the coat atlas. Each item is cached on its own. */
export function createAccessorySheet(choice: CatAccessoryChoice) {
  const canvas = document.createElement('canvas');
  canvas.width = CAT_APPEARANCE_WIDTH;
  canvas.height = CAT_APPEARANCE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cat accessory canvas is unavailable');
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    const y = CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE;
    for (let column = 0; column < CAT_ANIMATIONS[animation].frames; column++) {
      context.setTransform(1, 0, 0, 1, column * CAT_CELL_SIZE, y);
      drawCatAccessory(context, choice.id, animation, column, choice.color);
    }
  }
  return canvas;
}

function drawPixels(
  context: Paint,
  rows: readonly string[],
  colors: Readonly<Record<string, string>>,
  x: number,
  y: number,
) {
  for (const [row, line] of rows.entries()) {
    for (let pixel = 0; pixel < line.length; pixel++) {
      const color = colors[line[pixel]!];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x + pixel, y + row, 1, 1);
    }
  }
}

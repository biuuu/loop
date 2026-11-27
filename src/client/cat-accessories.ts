import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

export const CAT_ACCESSORY_SAMPLES = [
  { id: 'beret', label: '小贝雷帽', slot: 'head' },
  { id: 'daisy', label: '小雏菊', slot: 'head' },
  { id: 'sprout', label: '双叶芽', slot: 'head' },
  { id: 'knit-cap', label: '针织帽', slot: 'head' },
  { id: 'headphones', label: '迷你耳机', slot: 'head' },
  { id: 'bell', label: '胸前铃铛', slot: 'chest' },
  { id: 'bow', label: '短蝴蝶结', slot: 'chest' },
  { id: 'scarf', label: '小领巾', slot: 'chest' },
  { id: 'star-pin', label: '星形胸针', slot: 'chest' },
  { id: 'ribbon', label: '尾巴丝带', slot: 'tail' },
  { id: 'streamer', label: '短飘带', slot: 'tail' },
  { id: 'tail-ring', label: '珠扣尾环', slot: 'tail' },
  { id: 'tail-flower', label: '尾尖花结', slot: 'tail' },
] as const;
export type CatAccessorySample = (typeof CAT_ACCESSORY_SAMPLES)[number]['id'];
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
const knitColors = { D: '#714b40', S: '#aa6a58', M: '#ca8870', L: '#efb395' };
const knit = [
  '....DDDD.....',
  '...DMLMMD....',
  '..DMLMLMMD...',
  '.DMMMMMMMMD..',
  'DLMLMLMLMLMDD',
  '.DDDDDDDDDDD.',
];
const knitLying = [
  '...DDDDD.....',
  '..DMSMMMDD...',
  '.DMMMMMMMMDD.',
  'DLMLMLMLMMMDD',
  '.DDDDDDDDDDD.',
];
const headphoneColors = {
  D: '#3f4659',
  S: '#665e74',
  M: '#7b7693',
  L: '#d4b4d7',
};
const headphones = [
  '....DDDDD....',
  '...DMMMMMD...',
  '..DD.....DD..',
  '.DD.......DD.',
  'DLD.......DLD',
  'DMDD.....DDMD',
  'DMD.......DMD',
  '.DD.......DD.',
];
const headphonesBack = [
  '....DDDDD....',
  '...DMMMMMD...',
  '..DD.....DD..',
  '.DS.......SD.',
  'DMD.......DMD',
  'DSDD.....DDSD',
  '.DD.......DD.',
];
const headphonesLying = [
  '...DDDDD.....',
  '..DMMMMMD....',
  '.DD.....DD...',
  'DLD......DLDD',
  'DMDD.....DMD.',
  '.DD.......DD.',
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
    colors: { D: '#936248', M: '#e3ae60', L: '#fff0ad' },
    upright: { x: 27, rows: ['..L..', 'DMLMD', '.DLD.', '.D.D.'] },
    down: { x: 29, rows: ['.L.', 'DMD', '.D.'] },
    sleep: { x: 26, rows: ['.DL', 'DMD'] },
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
  sample: CatAccessorySample,
  animation: CatAnimation,
  column: number,
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
  if (sample === 'knit-cap') {
    const rows = animation === 'sleep' ? knitLying : knit;
    drawPixels(context, rows, knitColors, 23, head + 3 - rows.length);
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
      colors,
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

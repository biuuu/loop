import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

export const CAT_ACCESSORY_SAMPLES = [
  { id: 'beret', label: '小贝雷帽', slot: 'head' },
  { id: 'wizard-hat', label: '巫师帽', slot: 'head' },
  { id: 'bell', label: '胸前铃铛', slot: 'chest' },
  { id: 'ribbon', label: '尾巴丝带', slot: 'tail' },
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

// G = gold band, A = light on the band.
const wizardHatColors = {
  D: '#43334c',
  L: '#a391ab',
  M: '#7c6686',
  S: '#5d496c',
  G: '#bd8e54',
  A: '#f1ca83',
};
const wizardHatFront = [
  '.DDDD.......',
  '...LDD......',
  '...DLD......',
  '....DLMD....',
  '....DLMMD...',
  '...DLMMSD...',
  '...DGGAGD...',
  '..DDGAGMDDD.',
  '.DSMMMMMMMMD',
  '..DDDDDDDDD.',
];
const wizardHatBack = [
  '.......DDDD.',
  '......DMSD..',
  '......DLMD..',
  '....DLMMD...',
  '...DLMMMD...',
  '...DSMMMSD..',
  '...DAAGGD...',
  '.DDDMMGGDDD.',
  'DSMMMMMMMMMD',
  '.DDDDDDDDDD.',
];
const wizardHatLying = [
  'DDDD.......',
  '.LMMDD.....',
  '..DLMMD....',
  '..DLMMSD...',
  '...DGGAGD..',
  '..DDGGMDDD.',
  '.DSMMMMMMMD',
  '..DDDDDDDD.',
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

const bellColors = { D: '#684833', L: '#ffe5a3', M: '#e3ab59', S: '#b47542' };
const bell = ['.DLD.', 'DMMMD', '.DSD.'];
const bellFront = ['DLD', '.S.'];
const bellLying = ['.DL', 'DMD'];
const ribbonColors = { D: '#8b4c60', L: '#ffd0c2', M: '#d88291' };
const ribbon = ['D...D', 'DMLMD', '.DLD.', '.D.D.'];
const ribbonFlat = ['..DD', '.DM.', '..LL', '.DM.', '..DD'];
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
  if (sample === 'wizard-hat') {
    if (animation === 'up')
      drawPixels(context, wizardHatBack, wizardHatColors, 27, head - 7);
    else if (animation === 'sleep')
      drawPixels(context, wizardHatLying, wizardHatColors, 23, head - 5);
    else drawPixels(context, wizardHatFront, wizardHatColors, 22, head - 7);
    return;
  }
  if (sample === 'bell') {
    // Viewed from behind the neck hides the bell; on the floor it peeks out
    // beside the forepaws. The front walk has less room under the chin.
    if (animation === 'up') return;
    if (animation === 'sleep')
      drawPixels(context, bellLying, bellColors, 26, head + 10);
    else if (animation === 'down')
      drawPixels(context, bellFront, bellColors, 29, head + 10);
    else drawPixels(context, bell, bellColors, 27, head + 11);
    return;
  }
  const [x, y, sideways] = tailKnots[animation][column]!;
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

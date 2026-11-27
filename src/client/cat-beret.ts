import type { CatAnimation } from './cat-sprite';

// D = outline, L = light, M = wool, S = shadow.
const colors = {
  D: '#354a3e',
  L: '#a3b795',
  M: '#7b9878',
  S: '#5e7b61',
};
const front = [
  '...DD.....',
  '....D.....',
  '..DDDDD...',
  '.DLLMMMDD.',
  'DLMMMMMMSD',
  '.DSSSSSDD.',
  '..DDDDD...',
];
const back = [
  '.....DD...',
  '.....D....',
  '...DDDDD..',
  '.DDMMLMMD.',
  'DSMMMMMLMD',
  '.DDSSSSSD.',
  '...DDDDD..',
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

export function drawCatBeret(
  context: Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>,
  animation: CatAnimation,
  column: number,
) {
  const fromBehind = animation === 'up';
  const rows = fromBehind ? back : front;
  const x = fromBehind ? 27 : 24;
  const y = headY[animation][column]! - 4;
  for (const [row, line] of rows.entries()) {
    for (let pixel = 0; pixel < line.length; pixel++) {
      const color = colors[line[pixel] as keyof typeof colors];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x + pixel, y + row, 1, 1);
    }
  }
}

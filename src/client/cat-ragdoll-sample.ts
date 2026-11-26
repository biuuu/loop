import { ORIGINAL_CAT_PALETTE } from './cat-appearance';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  CAT_IDLE_UP_COLUMN,
} from './cat-sprite';

export const RAGDOLL_SAMPLE_SWATCH =
  'linear-gradient(125deg, #948887 26%, #b7a7a0 46%, #faf8f3 46%)';

// The white opening widens down from the forehead into the muzzle.
const FACE = {
  x: 25,
  y: 32,
  rows: [
    '.##.....##.',
    '.###...###.',
    '.####.####.',
    '#####.#####',
    '####...####',
    '####...####',
    '.###...###.',
    '.###...###.',
  ],
};
const CHEST = {
  x: 27,
  y: 41,
  rows: [
    '#######...',
    '######....',
    '######....',
    '#####.....',
    '#.###.....',
    '#.##....##',
  ],
};
const INNER_EARS = { x: 27, y: 32, rows: ['#.....#', '#.....#'] };
const PINK = { main: 0xd7a6aa, shadow: 0xc1969c };
const SADDLE = { x: 32, y: 42, rows: ['.##..', '####.', '.####'] };
const TAIL = CAT_SEAL_POINT_PATCHES.idle[0].find(
  ({ part }) => part === 'tail',
)!;
const POINTS = { main: 0xb7a7a0, shadow: 0x9a8a88 };
const BACK = { main: 0xd6c8bf, shadow: 0xb7aaa3 };
const BODY = { main: 0xeee6dd, shadow: 0xd7c9bf };
const WHITE = { main: 0xfaf8f3, shadow: 0xeee7e0 };
const TAIL_COLORS = { main: 0x948887, shadow: 0x7e7377 };

function hasMark(
  patch: { x: number; y: number; rows: readonly string[] },
  x: number,
  y: number,
) {
  return patch.rows[y - patch.y]?.[x - patch.x] === '#';
}

/** Color the source idle pose in place before preview cropping or scaling. */
export function recolorRagdollSample(pixels: Uint8ClampedArray) {
  const source = ORIGINAL_CAT_PALETTE;
  for (let y = 0; y < CAT_CELL_SIZE; y++) {
    for (let x = 0; x < CAT_CELL_SIZE; x++) {
      const index = (y * CAT_CELL_SIZE + x) * 4;
      if (!pixels[index + 3]) continue;
      const color =
        (pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!;
      let replacement: number;
      if (color === source.main || color === source.shadow) {
        let fur = BODY;
        if (hasMark(INNER_EARS, x, y)) fur = PINK;
        else if (hasMark(FACE, x, y)) fur = POINTS;
        else if (hasMark(TAIL, x, y)) fur = TAIL_COLORS;
        else if (hasMark(SADDLE, x, y)) fur = BACK;
        else if (y <= 40 || hasMark(CHEST, x, y)) fur = WHITE;
        replacement = color === source.main ? fur.main : fur.shadow;
      } else if (color === source.ink) {
        const eye = (x === 28 || x === 32) && (y === 37 || y === 38);
        replacement = eye ? 0x3e668d : 0x413a40;
      } else if (color === source.light) {
        replacement = WHITE.main;
      } else continue;
      pixels[index] = replacement >>> 16;
      pixels[index + 1] = (replacement >>> 8) & 255;
      pixels[index + 2] = replacement & 255;
    }
  }
}

export function createRagdollSampleFrame(image: CanvasImageSource) {
  const frame = document.createElement('canvas');
  frame.width = frame.height = CAT_CELL_SIZE;
  const context = frame.getContext('2d');
  if (!context) throw new Error('Cat sample canvas is unavailable');
  context.drawImage(
    image,
    CAT_IDLE_UP_COLUMN * CAT_CELL_SIZE,
    CAT_ANIMATIONS.idle.row * CAT_CELL_SIZE,
    CAT_CELL_SIZE,
    CAT_CELL_SIZE,
    0,
    0,
    CAT_CELL_SIZE,
    CAT_CELL_SIZE,
  );
  const pixels = context.getImageData(0, 0, CAT_CELL_SIZE, CAT_CELL_SIZE);
  recolorRagdollSample(pixels.data);
  context.putImageData(pixels, 0, 0);
  return frame;
}

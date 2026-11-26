import { ORIGINAL_CAT_PALETTE } from './cat-appearance';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  CAT_IDLE_UP_COLUMN,
} from './cat-sprite';

export const RAGDOLL_SAMPLE_SWATCH =
  'linear-gradient(125deg, #788ba4 31%, #b1b9c9 51%, #f6f0e9 51%)';

// The white opening widens down from the forehead into the muzzle.
const FACE = {
  x: 25,
  y: 32,
  rows: [
    '.##.....##.',
    '.###...###.',
    '.####.####.',
    '####...####',
    '###.....###',
    '##.......##',
    '#.........#',
  ],
};
const SADDLE = { x: 32, y: 42, rows: ['.##..', '####.', '.####'] };
const TAIL = CAT_SEAL_POINT_PATCHES.idle[0].find(
  ({ part }) => part === 'tail',
)!;
const POINTS = { main: 0x788ba4, shadow: 0x566881 };
const BACK = { main: 0xb1b9c9, shadow: 0x96a1b1 };
const BODY = { main: 0xf6f0e9, shadow: 0xe4dad5 };

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
        const fur =
          hasMark(FACE, x, y) || hasMark(TAIL, x, y)
            ? POINTS
            : hasMark(SADDLE, x, y)
              ? BACK
              : BODY;
        replacement = color === source.main ? fur.main : fur.shadow;
      } else if (color === source.ink) {
        const eye = (x === 28 || x === 32) && (y === 37 || y === 38);
        replacement = eye ? (y === 37 ? 0x4579b2 : 0x2d506f) : 0x384251;
      } else if (color === source.light) {
        replacement = 0xfffbf6;
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

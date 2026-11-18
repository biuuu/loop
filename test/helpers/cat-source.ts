import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  CAT_APPEARANCE_WIDTH,
  CAT_APPEARANCE_HEIGHT,
  CAT_PACKED_ROWS,
} from '../../src/client/cat-appearance';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  type CatAnimation,
} from '../../src/client/cat-sprite';

// Decode the repository's 8-bit RGBA PNG for pixel-level checks without a browser
// or a canvas dependency. Handle all five standard PNG scanline filters.
export function sourcePixels() {
  const png = readFileSync(
    new URL('../../public/Cat/Cat.png', import.meta.url),
  );
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 896);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  assert.equal(png[28], 0);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = 1024 * 4;
  const decoded = new Uint8ClampedArray(stride * 896);
  for (let y = 0; y < 896; y++) {
    const filter = raw[y * (stride + 1)]!;
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? decoded[index - 4]! : 0;
      const above = y > 0 ? decoded[index - stride]! : 0;
      const diagonal = y > 0 && x >= 4 ? decoded[index - stride - 4]! : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = above;
      if (filter === 3) prediction = Math.floor((left + above) / 2);
      if (filter === 4) {
        const paeth = left + above - diagonal;
        const distances = [
          Math.abs(paeth - left),
          Math.abs(paeth - above),
          Math.abs(paeth - diagonal),
        ];
        prediction =
          distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
            ? left
            : distances[1]! <= distances[2]!
              ? above
              : diagonal;
      }
      decoded[index] = (raw[y * (stride + 1) + x + 1]! + prediction) & 255;
    }
  }
  const packed = new Uint8ClampedArray(
    CAT_APPEARANCE_WIDTH * CAT_APPEARANCE_HEIGHT * 4,
  );
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    const sequence = CAT_ANIMATIONS[animation];
    for (let y = 0; y < CAT_CELL_SIZE; y++) {
      const start = (sequence.row * CAT_CELL_SIZE + y) * 1024 * 4;
      packed.set(
        decoded.subarray(start, start + sequence.frames * CAT_CELL_SIZE * 4),
        (CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE + y) *
          CAT_APPEARANCE_WIDTH *
          4,
      );
    }
  }
  return packed;
}

export const rgb = (pixels: Uint8ClampedArray, index: number) =>
  (pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!;

export function frameIndex(
  animation: CatAnimation,
  frame: number,
  x: number,
  y: number,
) {
  return (
    ((CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE + y) * CAT_APPEARANCE_WIDTH +
      frame * CAT_CELL_SIZE +
      x) *
    4
  );
}

export function frameRgb(
  pixels: Uint8ClampedArray,
  animation: CatAnimation,
  frame: number,
  x: number,
  y: number,
) {
  return rgb(pixels, frameIndex(animation, frame, x, y));
}

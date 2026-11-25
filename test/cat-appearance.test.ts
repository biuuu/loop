import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAT_APPEARANCE_HEIGHT,
  CAT_APPEARANCE_WIDTH,
  CAT_PACKED_ROWS,
  recolorCatPixels,
} from '../src/client/cat-appearance';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  type CatAnimation,
} from '../src/client/cat-sprite';
import {
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
  CAT_PATTERNS,
  DEFAULT_CAT_APPEARANCE,
  type CatPresetPattern,
} from '../src/shared/appearance';

import { getPatternMask } from '../src/client/cat-patterns';
import { frameIndex, sourcePixels, rgb } from './helpers/cat-source';

const original = sourcePixels();
const isCoat = (color: number) => color === 0xfb8c00 || color === 0xef6c00;

test('packed appearance sheet includes all sixteen sleep frames from the original first row', () => {
  assert.equal(CAT_APPEARANCE_WIDTH, 1024);
  assert.equal(CAT_APPEARANCE_HEIGHT, 320);
  assert.equal(CAT_ANIMATIONS.sleep.row, 0);
  assert.equal(CAT_ANIMATIONS.sleep.frames, 16);
  assert.equal(CAT_PACKED_ROWS.sleep, 4);
  for (let column = 0; column < 16; column++) {
    const index = ((4 * 64 + 46) * 1024 + column * 64 + 30) * 4;
    assert.equal(original[index + 3], 255);
    assert.ok(isCoat(rgb(original, index)));
  }
});

test('orange solid preserves every supplied pixel and never mutates the source buffer', () => {
  const before = new Uint8ClampedArray(original);
  const recolored = recolorCatPixels(original, DEFAULT_CAT_APPEARANCE);
  assert.notEqual(recolored, original);
  assert.deepEqual(recolored, before);
  assert.deepEqual(original, before);
  assert.throws(
    () => recolorCatPixels(new Uint8ClampedArray(4), DEFAULT_CAT_APPEARANCE),
    /size/,
  );
});

test('coat palettes replace body colors while preserving alpha and eye/outline locations', () => {
  for (const coat of CAT_COATS) {
    const result = recolorCatPixels(original, {
      coat: coat.id,
      pattern: 'solid',
    });
    let mainPixels = 0;
    let shadowPixels = 0;
    for (let index = 0; index < original.length; index += 4) {
      assert.equal(result[index + 3], original[index + 3]);
      const color = rgb(original, index);
      if (original[index + 3] === 0)
        assert.deepEqual(
          result.subarray(index, index + 4),
          original.subarray(index, index + 4),
        );
      if (original[index + 3] && color === 0x482a00) {
        if (coat.id === 'pure_black')
          assert.ok([0x030303, 0x242424].includes(rgb(result, index)));
        else
          assert.equal(
            rgb(result, index),
            coat.id === 'pure_white' ? 0x5b5b5b : color,
          );
      }
      if (original[index + 3] && color === 0xfb8c00) {
        assert.equal(
          rgb(result, index),
          Number.parseInt(coat.color.slice(1), 16),
        );
        mainPixels++;
      }
      if (original[index + 3] && color === 0xef6c00) {
        assert.notEqual(
          rgb(result, index),
          Number.parseInt(coat.color.slice(1), 16),
        );
        shadowPixels++;
      }
    }
    assert.ok(mainPixels > 0 && shadowPixels > 0);
  }
});

test('every pattern affects real coat pixels in every used animation frame and preserves all other pixels', () => {
  for (const coat of CAT_COATS) {
    const solid = recolorCatPixels(original, {
      coat: coat.id,
      pattern: 'solid',
    });
    const socks = recolorCatPixels(original, {
      coat: coat.id,
      pattern: 'socks',
    });
    const tabby = recolorCatPixels(original, {
      coat: coat.id,
      pattern: 'tabby',
    });
    assert.notDeepEqual(socks, tabby);
    for (const pattern of CAT_PATTERNS.filter(
      (pattern) => pattern.id !== 'solid',
    )) {
      const result = pattern.id === 'socks' ? socks : tabby;
      for (let index = 0; index < original.length; index += 4) {
        assert.equal(result[index + 3], original[index + 3]);
        if (!isCoat(rgb(original, index)) || original[index + 3] === 0)
          assert.deepEqual(
            result.subarray(index, index + 4),
            solid.subarray(index, index + 4),
          );
      }
      for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
        for (
          let column = 0;
          column < CAT_ANIMATIONS[animation].frames;
          column++
        ) {
          let changes = 0;
          for (let y = 0; y < CAT_CELL_SIZE; y++) {
            for (let x = 0; x < CAT_CELL_SIZE; x++) {
              const index =
                ((CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE + y) *
                  CAT_APPEARANCE_WIDTH +
                  column * CAT_CELL_SIZE +
                  x) *
                4;
              if (rgb(result, index) !== rgb(solid, index)) changes++;
            }
          }
          assert.ok(
            changes > 0,
            `${coat.id}/${pattern.id}/${animation}/${column} has a visible coat mask`,
          );
        }
      }
    }
  }
});

test('each preset keeps its base and shades its spots across all poses while preserving source details', () => {
  const palettes: Record<
    CatPresetPattern,
    Partial<Record<number, readonly [number, number]>>
  > = {
    calico: { 1: [0xd98947, 0xb96b36], 2: [0x554b4e, 0x41383c] },
    cow: { 2: [0x38353b, 0x29262c] },
    orange_white: { 1: [0xeda251, 0xd57836] },
    tortoiseshell: { 1: [0xc7794a, 0xa7613a], 2: [0x905a40, 0x72432f] },
  };
  for (const { appearance } of CAT_APPEARANCE_PRESETS) {
    const base = recolorCatPixels(original, {
      coat: appearance.coat,
      pattern: 'solid',
    });
    const result = recolorCatPixels(original, appearance);
    const palette = palettes[appearance.pattern];
    for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
      for (let frame = 0; frame < CAT_ANIMATIONS[animation].frames; frame++) {
        const mask = getPatternMask(appearance.pattern, animation, frame);
        const painted = new Set<number>();
        for (let y = 0; y < CAT_CELL_SIZE; y++) {
          for (let x = 0; x < CAT_CELL_SIZE; x++) {
            const index = frameIndex(animation, frame, x, y);
            const color = rgb(original, index);
            const mark = mask[y * CAT_CELL_SIZE + x] ?? 0;
            assert.equal(result[index + 3], original[index + 3]);
            if (!original[index + 3] || !isCoat(color)) {
              assert.equal(rgb(result, index), rgb(base, index));
              continue;
            }
            painted.add(mark);
            const tones = palette[mark];
            if (mark) assert.ok(tones);
            assert.equal(
              rgb(result, index),
              tones ? tones[color === 0xef6c00 ? 1 : 0] : rgb(base, index),
            );
          }
        }
        assert.deepEqual(
          [...painted].sort(),
          [0, ...Object.keys(palette).map(Number)],
          `${appearance.pattern}/${animation}/${frame}`,
        );
      }
    }
  }
});

test('pure black blends the connected outer contour while retaining open and blinking eyes', () => {
  const result = recolorCatPixels(original, {
    coat: 'pure_black',
    pattern: 'solid',
  });
  const pixel = (column: number, x: number, y: number) =>
    ((CAT_PACKED_ROWS.idle * CAT_CELL_SIZE + y) * CAT_APPEARANCE_WIDTH +
      column * CAT_CELL_SIZE +
      x) *
    4;
  for (const column of [0, 3]) {
    // Ear and foot outline remain in exactly the supplied locations.
    for (const [x, y] of [
      [26, 31],
      [28, 47],
    ]) {
      const index = pixel(column, x!, y!);
      assert.equal(rgb(original, index), 0x482a00);
      assert.equal(rgb(result, index), 0x030303);
      assert.equal(result[index + 3], original[index + 3]);
    }
    for (const x of [28, 32]) {
      const lowerEye = pixel(column, x, 38);
      assert.equal(rgb(original, lowerEye), 0x482a00);
      assert.equal(rgb(result, lowerEye), 0x242424);
      const upperEye = pixel(column, x, 37);
      assert.equal(rgb(original, upperEye), column === 3 ? 0xfb8c00 : 0x482a00);
      assert.equal(rgb(result, upperEye), column === 3 ? 0x000000 : 0x242424);
    }
  }
});

test('original dark and ivory coats retain their distinct palettes and original ink', () => {
  for (const [coat, main, shadow, light] of [
    ['black', 0x50515a, 0x393a45, 0xa3a2a6],
    ['white', 0xf1eee5, 0xd3cfc3, 0xfffaf2],
  ] as const) {
    const result = recolorCatPixels(original, { coat, pattern: 'solid' });
    const expected = new Map([
      [0xfb8c00, main],
      [0xef6c00, shadow],
      [0xffdeb1, light],
      [0x482a00, 0x482a00],
    ]);
    for (let index = 0; index < original.length; index += 4) {
      if (original[index + 3] === 0) continue;
      assert.equal(rgb(result, index), expected.get(rgb(original, index)));
    }
  }
});

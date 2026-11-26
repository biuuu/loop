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
  CAT_IDLE_UP_COLUMN,
  type CatAnimation,
} from '../src/client/cat-sprite';
import { recolorRagdollSample } from '../src/client/cat-ragdoll-sample';
import {
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
  CAT_PATTERNS,
  DEFAULT_CAT_APPEARANCE,
  SEAL_POINT_APPEARANCE,
  catAppearancePreset,
  catAppearanceSchema,
  type CatPresetPattern,
} from '../src/shared/appearance';

import { getPatternMask } from '../src/client/cat-patterns';
import { frameIndex, frameRgb, sourcePixels, rgb } from './helpers/cat-source';

const original = sourcePixels();
const isCoat = (color: number) => color === 0xfb8c00 || color === 0xef6c00;

test('the bicolor ragdoll sample keeps the cat silhouette and the Siamese rename keeps its ID', () => {
  const frame = new Uint8ClampedArray(CAT_CELL_SIZE ** 2 * 4);
  for (let y = 0; y < CAT_CELL_SIZE; y++) {
    const start = frameIndex('idle', CAT_IDLE_UP_COLUMN, 0, y);
    frame.set(
      original.subarray(start, start + CAT_CELL_SIZE * 4),
      y * CAT_CELL_SIZE * 4,
    );
  }
  const source = frame.slice();
  recolorRagdollSample(frame);
  for (let index = 3; index < frame.length; index += 4)
    assert.equal(frame[index], source[index]);
  const colorAt = (x: number, y: number) =>
    rgb(frame, (y * CAT_CELL_SIZE + x) * 4);
  assert.equal(colorAt(26, 32), 0xb7a7a0); // Ear and its pink interior
  assert.equal(colorAt(27, 32), 0xc1969c);
  assert.equal(colorAt(29, 34), 0xb7a7a0);
  assert.equal(colorAt(30, 34), 0xeee7e0); // Upper tip of the white V
  assert.equal(colorAt(27, 39), 0xb7a7a0); // Warm gray cheek below the eye
  assert.equal(colorAt(29, 39), 0xfaf8f3);
  assert.equal(colorAt(30, 39), 0xc18b93); // Nose
  assert.equal(colorAt(28, 36), 0x304359);
  assert.equal(colorAt(28, 37), 0xb5dbf2);
  assert.equal(colorAt(27, 38), 0x537fa8);
  assert.equal(colorAt(32, 38), 0x537fa8);
  assert.equal(colorAt(29, 42), 0xfaf8f3); // Ruffles around the chest
  assert.equal(colorAt(34, 43), 0xd6c8bf);
  assert.equal(colorAt(41, 38), 0x948887);
  assert.equal(colorAt(27, 46), 0xfaf8f3); // Paw
  assert.equal(
    catAppearanceSchema.safeParse({ coat: 'white', pattern: 'ragdoll-sample' })
      .success,
    false,
  );
  assert.equal(catAppearancePreset('seal_point')?.label, '暹罗');
  assert.deepEqual(catAppearanceSchema.parse(SEAL_POINT_APPEARANCE), {
    coat: 'cream',
    pattern: 'seal_point',
  });
});

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
    Partial<Record<number, readonly [number, number, number?]>>
  > = {
    calico: { 1: [0xd98947, 0xb96b36], 2: [0x554b4e, 0x41383c] },
    cow: { 2: [0x38353b, 0x29262c] },
    orange_white: { 1: [0xeda251, 0xd57836] },
    tortoiseshell: { 1: [0xa97a54, 0x8e6144] },
    seal_point: { 1: [0xad8361, 0x946a50], 2: [0x785644, 0x654637, 0x9b7055] },
    tabby_white: { 1: [0x665142, 0x543e32], 2: [0xfff6e8, 0xe9decf] },
  };
  const presetBodyColors: Partial<
    Record<CatPresetPattern, readonly [number, number]>
  > = {
    seal_point: [0xf2e2c9, 0xdcc3a6],
    tabby_white: [0xaa9983, 0x907b64],
  };
  for (const { appearance } of CAT_APPEARANCE_PRESETS) {
    const base = recolorCatPixels(original, {
      coat: appearance.coat,
      pattern: 'solid',
    });
    const result = recolorCatPixels(original, appearance);
    const palette = palettes[appearance.pattern];
    const bodyColors = presetBodyColors[appearance.pattern];
    const hasFaceMask = appearance.pattern === 'seal_point';
    for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
      const expectedMarks = Object.keys(palette)
        .map(Number)
        .filter((mark) => !(hasFaceMask && animation === 'up' && mark === 1));
      for (let frame = 0; frame < CAT_ANIMATIONS[animation].frames; frame++) {
        const mask = getPatternMask(appearance.pattern, animation, frame);
        const painted = new Set<number>();
        for (let y = 0; y < CAT_CELL_SIZE; y++) {
          for (let x = 0; x < CAT_CELL_SIZE; x++) {
            const index = frameIndex(animation, frame, x, y);
            const color = rgb(original, index);
            const mark = mask[y * CAT_CELL_SIZE + x] ?? 0;
            assert.equal(result[index + 3], original[index + 3]);
            if (
              !original[index + 3] ||
              (!isCoat(color) && color !== 0xffdeb1)
            ) {
              assert.equal(rgb(result, index), rgb(base, index));
              continue;
            }
            if (isCoat(color)) painted.add(mark);
            const tones = palette[mark];
            if (mark) assert.ok(tones);
            const shade = color === 0xfb8c00 ? 0 : color === 0xef6c00 ? 1 : 2;
            const baseColor =
              (shade === 2 ? undefined : bodyColors?.[shade]) ??
              rgb(base, index);
            assert.equal(rgb(result, index), tones?.[shade] ?? baseColor);
          }
        }
        assert.deepEqual(
          [...painted].sort(),
          [0, ...expectedMarks],
          `${appearance.pattern}/${animation}/${frame}`,
        );
      }
    }
  }
});

test('seal point keeps the reviewed palette while following the tail, blinking, breath and steps', () => {
  const result = recolorCatPixels(original, SEAL_POINT_APPEARANCE);
  const face = 0xad8361;
  const point = 0x785644;
  const ink = 0x482a00;
  const cream = 0xf2e2c9;
  const landmarks = [
    ['idle', 0, 26, 32, point],
    ['idle', 0, 29, 37, face],
    ['idle', 0, 28, 37, ink],
    ['idle', 0, 41, 38, point],
    ['idle', 0, 27, 46, point],
    ['idle', 0, 33, 43, cream],
    ['idle', 1, 44, 39, point],
    ['idle', 2, 47, 42, point],
    ['idle', 3, 28, 37, face],
    ['idle', 3, 28, 38, ink],
    ['idle', 3, 48, 45, point],
    ['side', 0, 28, 47, 0x9b7055], // Source paw highlight
    ['side', 1, 29, 36, face],
    ['side', 1, 46, 39, point],
    ['side', 1, 31, 47, point],
    ['side', 1, 32, 44, cream],
    ['up', 0, 28, 38, point],
    ['up', 2, 32, 38, point],
    ['up', 3, 27, 50, point],
    ['down', 0, 30, 25, point],
    ['down', 1, 28, 24, point],
    ['down', 2, 32, 44, point],
    ['sleep', 0, 26, 36, point],
    ['sleep', 0, 29, 41, face],
    ['sleep', 0, 28, 41, ink],
    ['sleep', 2, 28, 42, ink],
    ['sleep', 2, 29, 42, face],
    ['sleep', 0, 45, 47, point],
    ['sleep', 2, 45, 47, point],
    ['sleep', 0, 26, 46, point],
    ['sleep', 2, 26, 46, point],
    ['sleep', 0, 33, 45, cream],
  ] as const;
  for (const [animation, column, x, y, color] of landmarks)
    assert.equal(
      frameRgb(result, animation, column, x, y),
      color,
      `${animation}/${column}/${x},${y}`,
    );
});

test('tabby white leaves the mouth area clear and retains the chest and paw markings', () => {
  const tabbyWhite = recolorCatPixels(original, {
    coat: 'gray',
    pattern: 'tabby_white',
  });
  const body = 0xaa9983;
  const white = 0xfff6e8;
  for (let frame = 0; frame < CAT_ANIMATIONS.idle.frames; frame++) {
    for (const x of [29, 30, 31])
      assert.equal(frameRgb(tabbyWhite, 'idle', frame, x, 40), body);
    assert.equal(frameRgb(tabbyWhite, 'idle', frame, 29, 41), white);
  }
  for (const [frame, mouthY] of [40, 39, 40, 40, 39, 40].entries()) {
    for (const x of [29, 30, 31])
      assert.equal(frameRgb(tabbyWhite, 'side', frame, x, mouthY), body);
    assert.equal(frameRgb(tabbyWhite, 'side', frame, 28, mouthY + 1), white);
  }
  assert.equal(frameRgb(tabbyWhite, 'idle', 0, 27, 33), 0x665142);
  assert.equal(frameRgb(tabbyWhite, 'idle', 0, 27, 46), white);
  assert.equal(frameRgb(tabbyWhite, 'side', 1, 31, 47), white);
  assert.equal(frameRgb(tabbyWhite, 'down', 1, 29, 40), body);
  assert.equal(frameRgb(tabbyWhite, 'sleep', 2, 30, 44), white);
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

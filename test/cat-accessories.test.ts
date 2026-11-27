import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAT_ACCESSORY_SAMPLES,
  drawCatAccessory,
  type CatAccessorySample,
} from '../src/client/cat-accessories';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  type CatAnimation,
} from '../src/client/cat-sprite';
import { CAT_EYE_MARKING, getPatternMask } from '../src/client/cat-patterns';
import { CAT_STRIPED_TAIL_PATCHES } from '../src/client/cat-striped-tail';
import { frameIndex, rgb, sourcePixels } from './helpers/cat-source';

const source = sourcePixels();
const frames = (Object.keys(CAT_ANIMATIONS) as CatAnimation[]).flatMap(
  (animation) =>
    Array.from({ length: CAT_ANIMATIONS[animation].frames }, (_, column) => ({
      animation,
      column,
      label: `${animation}:${column}`,
    })),
);

function pixelsFor(
  sample: CatAccessorySample,
  animation: CatAnimation,
  column: number,
) {
  const pixels: { x: number; y: number }[] = [];
  drawCatAccessory(
    {
      fillStyle: '',
      fillRect(x, y, width, height) {
        assert.equal(width, 1);
        assert.equal(height, 1);
        assert.ok(x >= 0 && x < CAT_CELL_SIZE && y >= 0 && y < CAT_CELL_SIZE);
        pixels.push({ x, y });
      },
    },
    sample,
    animation,
    column,
  );
  return pixels;
}

function firstEarRow(animation: CatAnimation, column: number) {
  // The tips of the right ear appear together, clear of the tail and Zs.
  for (let y = 0; y < CAT_CELL_SIZE; y++) {
    if (
      source[frameIndex(animation, column, 33, y) + 3] &&
      source[frameIndex(animation, column, 34, y) + 3]
    )
      return y;
  }
  assert.fail(`Missing ear pixels in ${animation}:${column}`);
}

test('the wardrobe offers the expected samples in each slot', () => {
  const ids = (slot: (typeof CAT_ACCESSORY_SAMPLES)[number]['slot']) =>
    CAT_ACCESSORY_SAMPLES.filter((sample) => sample.slot === slot)
      .map(({ id }) => id)
      .sort();
  assert.deepEqual(ids('head'), [
    'beret',
    'daisy',
    'headphones',
    'knit-cap',
    'sprout',
  ]);
  assert.deepEqual(ids('chest'), ['bell', 'bow', 'scarf', 'star-pin']);
  assert.deepEqual(ids('tail'), [
    'ribbon',
    'streamer',
    'tail-flower',
    'tail-ring',
  ]);
});

for (const { id, slot } of CAT_ACCESSORY_SAMPLES) {
  if (slot !== 'head') continue;
  test(`${id} follows the head and preserves eyes and sleep Zs across the source frames`, () => {
    for (const { animation, column, label } of frames) {
      const isOpaque = (x: number, y: number) =>
        source[frameIndex(animation, column, x, y) + 3] !== 0;
      const earY = firstEarRow(animation, column);
      const eyes = getPatternMask('ragdoll', animation, column);
      const overlay = pixelsFor(id, animation, column);
      for (const { x, y } of overlay) {
        assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, label);
        if (animation === 'sleep' && y < earY)
          assert.equal(isOpaque(x, y), false, label);
      }
      assert.ok(
        overlay.some(
          ({ x, y }) =>
            x >= 24 && x <= 36 && y >= earY && y <= earY + 5 && isOpaque(x, y),
        ),
        label,
      );

      const top = Math.min(...overlay.map(({ y }) => y));
      if (id === 'beret') assert.equal(top, earY - 4, label);
      if (id === 'daisy') {
        assert.equal(top, earY - 2, label);
        const nearEar = animation === 'up' ? 34 : 26;
        const farEar = animation === 'up' ? 26 : 34;
        assert.ok(isOpaque(nearEar, earY), label);
        assert.ok(
          overlay.some(({ x, y }) => x === nearEar && y === earY),
          label,
        );
        assert.ok(
          overlay.every(({ x }) => x !== farEar),
          label,
        );
      }
    }
  });
}

for (const { id, slot } of CAT_ACCESSORY_SAMPLES) {
  if (slot !== 'chest') continue;
  test(`${id} follows the chest, is shortened while sleeping or walking forward, and is hidden from behind`, () => {
    const upright = pixelsFor(id, 'idle', 0);
    const uprightRows = new Set(upright.map(({ y }) => y)).size;
    for (const { animation, column, label } of frames) {
      const overlay = pixelsFor(id, animation, column);
      if (animation === 'up') {
        assert.equal(overlay.length, 0, label);
        continue;
      }
      const earY = firstEarRow(animation, column);
      assert.ok(
        overlay.some(
          ({ x, y }) =>
            x >= 24 &&
            x <= 36 &&
            y >= earY + 9 &&
            y <= earY + 14 &&
            source[frameIndex(animation, column, x, y) + 3],
        ),
        label,
      );
      const compact = animation === 'sleep' || animation === 'down';
      const height = new Set(overlay.map(({ y }) => y)).size;
      if (compact) {
        assert.ok(height < uprightRows, label);
        assert.ok(overlay.length < upright.length, label);
      } else {
        assert.equal(height, uprightRows, label);
        assert.equal(overlay.length, upright.length, label);
      }
      if (id === 'bell' || id === 'bow')
        assert.equal(height, compact ? 2 : 3, label);
      if (id === 'bow') {
        const xs = overlay.map(({ x }) => x);
        const width = Math.max(...xs) - Math.min(...xs) + 1;
        assert.equal(
          width,
          animation === 'sleep' ? 5 : animation === 'down' ? 7 : 8,
          label,
        );
      }
      const eyes = getPatternMask('ragdoll', animation, column);
      for (const { x, y } of overlay)
        assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, label);
    }
  });
}

for (const { id, slot } of CAT_ACCESSORY_SAMPLES) {
  if (slot !== 'tail') continue;
  test(`${id} attaches to tail fur across the source frames`, () => {
    for (const { animation, column, label } of frames) {
      const overlay = pixelsFor(id, animation, column);
      const tail = CAT_STRIPED_TAIL_PATCHES[animation][column]!;
      assert.ok(
        overlay.some(({ x, y }) => {
          const index = frameIndex(animation, column, x, y);
          return (
            source[index + 3] &&
            rgb(source, index) === 0xfb8c00 &&
            tail.some(
              ({ x: left, y: top, rows }) => rows[y - top]?.[x - left] === '#',
            )
          );
        }),
        label,
      );
    }
    assert.notDeepEqual(pixelsFor(id, 'idle', 0), pixelsFor(id, 'idle', 3));
    assert.deepEqual(pixelsFor(id, 'sleep', 0), pixelsFor(id, 'sleep', 2));
  });
}

test('the ribbon and streamer share a knot', () => {
  for (const { animation, column, label } of frames) {
    const ribbon = pixelsFor('ribbon', animation, column);
    const streamer = pixelsFor('streamer', animation, column);
    const xs = ribbon.map(({ x }) => x);
    const ys = ribbon.map(({ y }) => y);
    const knotX = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
    const knotY = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
    const index = frameIndex(animation, column, knotX, knotY);
    assert.ok(source[index + 3] && rgb(source, index) === 0xfb8c00, label);
    for (const overlay of [ribbon, streamer]) {
      assert.ok(
        overlay.some(({ x, y }) => x === knotX && y === knotY),
        label,
      );
    }
  }
});

test('any one accessory from each slot can be layered across the source frames', () => {
  for (const { animation, column, label } of frames) {
    const overlays = CAT_ACCESSORY_SAMPLES.map(({ id, slot }) => ({
      id,
      slot,
      pixels: new Set(
        pixelsFor(id, animation, column).map(
          ({ x, y }) => y * CAT_CELL_SIZE + x,
        ),
      ),
    }));
    for (const [i, first] of overlays.entries()) {
      for (const second of overlays.slice(i + 1)) {
        if (first.slot === second.slot) continue;
        assert.ok(
          [...first.pixels].every((pixel) => !second.pixels.has(pixel)),
          `${label} ${first.id} overlaps ${second.id}`,
        );
      }
    }
  }
});

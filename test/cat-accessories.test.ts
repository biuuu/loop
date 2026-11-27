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
import { frameIndex, rgb, sourcePixels } from './helpers/cat-source';

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

for (const sample of ['beret', 'wizard-hat', 'daisy'] as const) {
  test(`${sample} follows the head and preserves eyes and sleep Zs across the source frames`, () => {
    const source = sourcePixels();
    for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
      for (
        let column = 0;
        column < CAT_ANIMATIONS[animation].frames;
        column++
      ) {
        const frame = `${animation}:${column}`;
        const isOpaque = (x: number, y: number) =>
          source[frameIndex(animation, column, x, y) + 3] !== 0;
        // The tips of the right ear appear together, clear of the tail and Zs.
        let earY = 0;
        while (
          earY < CAT_CELL_SIZE &&
          !(isOpaque(33, earY) && isOpaque(34, earY))
        )
          earY++;
        assert.ok(earY < CAT_CELL_SIZE, frame);
        const eyes = getPatternMask('ragdoll', animation, column);
        const overlay = pixelsFor(sample, animation, column);
        for (const { x, y } of overlay) {
          assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, frame);
          if (animation === 'sleep' && y < earY)
            assert.equal(isOpaque(x, y), false, frame);
        }
        const top = Math.min(...overlay.map(({ y }) => y));
        if (sample === 'beret') assert.equal(top, earY - 4, frame);
        assert.ok(
          overlay.some(({ x, y }) => y === earY + 2 && isOpaque(x, y)),
          frame,
        );
        if (sample === 'daisy') {
          assert.equal(top, earY - 2, frame);
          const nearEar = animation === 'up' ? 34 : 26;
          const farEar = animation === 'up' ? 26 : 34;
          assert.ok(isOpaque(nearEar, earY), frame);
          assert.ok(
            overlay.some(({ x, y }) => x === nearEar && y === earY),
            frame,
          );
          assert.ok(
            overlay.every(({ x }) => x !== farEar),
            frame,
          );
        }
        if (sample === 'wizard-hat') {
          assert.ok(top <= earY - 4, frame);
          for (const earX of [26, 27, 33, 34]) {
            assert.ok(isOpaque(earX, earY), frame);
            assert.ok(
              overlay.some(({ x, y }) => x === earX && y === earY),
              frame,
            );
          }
          const brim = overlay.filter(({ y }) => y === earY + 1);
          assert.ok(
            brim.some(({ x }) => x < 24),
            frame,
          );
          assert.ok(
            brim.some(({ x }) => x > 36),
            frame,
          );
        }
      }
    }
  });
}

for (const sample of ['bell', 'bow'] as const) {
  test(`${sample} stays on the chest, peeks out while sleeping, and is hidden from behind`, () => {
    const source = sourcePixels();
    const fullSize = pixelsFor(sample, 'idle', 0).length;
    for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
      for (
        let column = 0;
        column < CAT_ANIMATIONS[animation].frames;
        column++
      ) {
        const frame = `${animation}:${column}`;
        const overlay = pixelsFor(sample, animation, column);
        if (animation === 'up') {
          assert.equal(overlay.length, 0, frame);
          continue;
        }
        assert.ok(
          overlay.some(
            ({ x, y }) => source[frameIndex(animation, column, x, y) + 3],
          ),
          frame,
        );
        const ys = overlay.map(({ y }) => y);
        const height = Math.max(...ys) - Math.min(...ys) + 1;
        if (animation === 'sleep' || animation === 'down') {
          assert.equal(height, 2, frame);
          assert.ok(overlay.length < fullSize, frame);
        } else {
          assert.equal(height, 3, frame);
          assert.equal(overlay.length, fullSize, frame);
        }
        const eyes = getPatternMask('ragdoll', animation, column);
        for (const { x, y } of overlay)
          assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, frame);
      }
    }
  });
}

test('both tail accessories attach at the tail knot and avoid the chest and head pieces', () => {
  const source = sourcePixels();
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    for (let column = 0; column < CAT_ANIMATIONS[animation].frames; column++) {
      const frame = `${animation}:${column}`;
      const ribbon = pixelsFor('ribbon', animation, column);
      const streamer = pixelsFor('streamer', animation, column);
      const xs = ribbon.map(({ x }) => x);
      const ys = ribbon.map(({ y }) => y);
      const knotX = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
      const knotY = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
      const index = frameIndex(animation, column, knotX, knotY);
      assert.ok(source[index + 3] && rgb(source, index) === 0xfb8c00, frame);
      const others = new Set(
        CAT_ACCESSORY_SAMPLES.filter(({ slot }) => slot !== 'tail')
          .flatMap(({ id }) => pixelsFor(id, animation, column))
          .map(({ x, y }) => y * CAT_CELL_SIZE + x),
      );
      for (const overlay of [ribbon, streamer]) {
        assert.ok(
          overlay.some(({ x, y }) => x === knotX && y === knotY),
          frame,
        );
        assert.ok(
          overlay.every(({ x, y }) => !others.has(y * CAT_CELL_SIZE + x)),
          frame,
        );
      }
    }
  }
  assert.notDeepEqual(
    pixelsFor('ribbon', 'idle', 0),
    pixelsFor('ribbon', 'idle', 3),
  );
  assert.deepEqual(
    pixelsFor('ribbon', 'sleep', 0),
    pixelsFor('ribbon', 'sleep', 2),
  );
  assert.notDeepEqual(
    pixelsFor('streamer', 'idle', 0),
    pixelsFor('streamer', 'idle', 3),
  );
  assert.deepEqual(
    pixelsFor('streamer', 'sleep', 0),
    pixelsFor('streamer', 'sleep', 2),
  );
});

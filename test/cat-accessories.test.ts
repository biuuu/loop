import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

for (const hat of ['beret', 'wizard-hat'] as const) {
  test(`${hat} follows the head and preserves eyes and sleep Zs across the source frames`, () => {
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
        const overlay = pixelsFor(hat, animation, column);
        for (const { x, y } of overlay) {
          assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, frame);
          if (animation === 'sleep' && y < earY)
            assert.equal(isOpaque(x, y), false, frame);
        }
        const top = hat === 'beret' ? 4 : animation === 'sleep' ? 5 : 7;
        assert.equal(Math.min(...overlay.map(({ y }) => y)), earY - top, frame);
        assert.ok(
          overlay.some(({ x, y }) => y === earY + 2 && isOpaque(x, y)),
          frame,
        );
        if (hat === 'wizard-hat') {
          const otherEar = animation === 'up' ? 26 : 34;
          assert.ok(isOpaque(otherEar, earY), frame);
          assert.ok(
            overlay.every(({ x, y }) => x !== otherEar || y !== earY),
            frame,
          );
        }
      }
    }
  });
}

test('the bell stays on the chest, peeks out while sleeping, and is hidden from behind', () => {
  const source = sourcePixels();
  const fullSize = pixelsFor('bell', 'idle', 0).length;
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    for (let column = 0; column < CAT_ANIMATIONS[animation].frames; column++) {
      const frame = `${animation}:${column}`;
      const bell = pixelsFor('bell', animation, column);
      if (animation === 'up') {
        assert.equal(bell.length, 0, frame);
        continue;
      }
      assert.ok(
        bell.some(
          ({ x, y }) => source[frameIndex(animation, column, x, y) + 3],
        ),
        frame,
      );
      const ys = bell.map(({ y }) => y);
      const height = Math.max(...ys) - Math.min(...ys) + 1;
      if (animation === 'sleep' || animation === 'down') {
        assert.equal(height, 2, frame);
        assert.ok(bell.length < fullSize, frame);
      } else {
        assert.equal(height, 3, frame);
        assert.equal(bell.length, fullSize, frame);
      }
      const eyes = getPatternMask('ragdoll', animation, column);
      for (const { x, y } of bell)
        assert.notEqual(eyes[y * CAT_CELL_SIZE + x], CAT_EYE_MARKING, frame);
    }
  }
});

test('the ribbon knot touches tail fur in every frame without overlapping the other samples', () => {
  const source = sourcePixels();
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    for (let column = 0; column < CAT_ANIMATIONS[animation].frames; column++) {
      const frame = `${animation}:${column}`;
      const ribbon = pixelsFor('ribbon', animation, column);
      const xs = ribbon.map(({ x }) => x);
      const ys = ribbon.map(({ y }) => y);
      const knotX = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
      const knotY = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
      assert.ok(
        ribbon.some(({ x, y }) => x === knotX && y === knotY),
        frame,
      );
      const index = frameIndex(animation, column, knotX, knotY);
      assert.ok(source[index + 3] && rgb(source, index) === 0xfb8c00, frame);
      const others = new Set(
        [
          ...pixelsFor('beret', animation, column),
          ...pixelsFor('wizard-hat', animation, column),
          ...pixelsFor('bell', animation, column),
        ].map(({ x, y }) => y * CAT_CELL_SIZE + x),
      );
      assert.ok(
        ribbon.every(({ x, y }) => !others.has(y * CAT_CELL_SIZE + x)),
        frame,
      );
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
});

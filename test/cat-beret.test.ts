import assert from 'node:assert/strict';
import test from 'node:test';
import { drawCatBeret } from '../src/client/cat-beret';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  type CatAnimation,
} from '../src/client/cat-sprite';
import { CAT_EYE_MARKING, getPatternMask } from '../src/client/cat-patterns';
import { frameIndex, sourcePixels } from './helpers/cat-source';

test('beret pixels follow the head and preserve eyes and sleep Zs across the source frames', () => {
  const source = sourcePixels();
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    for (let column = 0; column < CAT_ANIMATIONS[animation].frames; column++) {
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
      const overlay: { x: number; y: number }[] = [];
      drawCatBeret(
        {
          fillStyle: '',
          fillRect(x, y, width, height) {
            assert.equal(width, 1, frame);
            assert.equal(height, 1, frame);
            assert.ok(
              x >= 0 && x < CAT_CELL_SIZE && y >= 0 && y < CAT_CELL_SIZE,
              frame,
            );
            assert.notEqual(
              eyes[y * CAT_CELL_SIZE + x],
              CAT_EYE_MARKING,
              frame,
            );
            if (animation === 'sleep' && y < earY)
              assert.equal(isOpaque(x, y), false, frame);
            overlay.push({ x, y });
          },
        },
        animation,
        column,
      );
      assert.equal(Math.min(...overlay.map(({ y }) => y)), earY - 4, frame);
      assert.ok(
        overlay.some(({ x, y }) => y === earY + 2 && isOpaque(x, y)),
        frame,
      );
    }
  }
});

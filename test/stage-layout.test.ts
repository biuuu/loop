import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE,
  stageCapacitySchema,
  stageSeatXs,
} from '../src/shared/contracts';
import { stageSeatAt } from '../src/client/scene-camera';

test('one through six stage positions remain centered, distinct and evenly spaced', () => {
  assert.equal(SCENE.width / SCENE.height, 2);
  for (let capacity = 1; capacity <= 6; capacity++) {
    const xs = stageSeatXs(capacity);
    assert.equal(xs.length, capacity);
    assert.equal(new Set(xs).size, capacity);
    assert.equal((xs[0]! + xs.at(-1)!) / 2, SCENE.width / 2);
    assert.equal(xs.reduce((sum, x) => sum + x, 0) / capacity, SCENE.width / 2);
    for (let seat = 1; seat < capacity; seat++)
      assert.equal(xs[seat]! - xs[seat - 1]!, 112);
    const left = xs[0]! - 81;
    const right = xs.at(-1)! + 81;
    assert.equal(right - left, (capacity - 1) * 112 + 162);
    assert.ok(left >= 0 && right <= SCENE.width);
  }
  assert.deepEqual(stageSeatXs(1), [SCENE.width / 2]);
  assert.deepEqual(stageSeatXs(), stageSeatXs(5));
  assert.deepEqual(stageSeatXs(6), SCENE.seatXs);
});

test('capacity validation accepts only integral counts from one through six', () => {
  for (const capacity of [1, 2, 3, 4, 5, 6])
    assert.equal(stageCapacitySchema.parse(capacity), capacity);
  for (const capacity of [0, 7, -1, 2.5, NaN, Infinity, '3', null])
    assert.equal(stageCapacitySchema.safeParse(capacity).success, false);
});

test('stage picking covers exactly the current bench and preserves seat ordering', () => {
  for (let capacity = 1; capacity <= 6; capacity++) {
    const xs = stageSeatXs(capacity);
    const left = xs[0]! - 81;
    const right = xs.at(-1)! + 81;
    for (const y of [200, 255, 321]) {
      assert.equal(stageSeatAt({ x: left, y }, capacity), 0);
      assert.equal(stageSeatAt({ x: right, y }, capacity), capacity - 1);
      assert.equal(stageSeatAt({ x: left - 0.01, y }, capacity), null);
      assert.equal(stageSeatAt({ x: right + 0.01, y }, capacity), null);
      xs.forEach((x, seat) => {
        assert.equal(stageSeatAt({ x, y }, capacity), seat);
      });
    }
    for (const y of [199.99, 321.01])
      for (const x of [left, SCENE.width / 2, right])
        assert.equal(stageSeatAt({ x, y }, capacity), null);
    for (let seat = 1; seat < capacity; seat++) {
      const midpoint = (xs[seat - 1]! + xs[seat]!) / 2;
      assert.equal(stageSeatAt({ x: midpoint, y: 255 }, capacity), seat - 1);
      assert.equal(stageSeatAt({ x: midpoint + 0.01, y: 255 }, capacity), seat);
    }
  }
});

test('capacity changes immediately change picking and remove obsolete positions', () => {
  for (const capacity of [6, 1, 4, 2, 5, 3, 6]) {
    const xs = stageSeatXs(capacity);
    for (let x = 0; x <= SCENE.width; x++) {
      const seat = stageSeatAt({ x, y: 255 }, capacity);
      if (x < xs[0]! - 81 || x > xs.at(-1)! + 81) assert.equal(seat, null);
      else assert.ok(seat !== null && seat >= 0 && seat < capacity);
    }
  }
  assert.equal(stageSeatAt({ x: SCENE.seatXs[0]!, y: 255 }, 6), 0);
  assert.equal(stageSeatAt({ x: SCENE.seatXs[0]!, y: 255 }, 1), null);
  assert.equal(stageSeatAt({ x: SCENE.seatXs[5]!, y: 255 }, 6), 5);
  assert.equal(stageSeatAt({ x: SCENE.seatXs[5]!, y: 255 }, 1), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  CAT_FRAME_MS,
  CAT_IDLE_UP_COLUMN,
  CAT_SHEET_COLUMNS,
  CAT_SHEET_ROWS,
  catFrame,
  idleColumn,
} from '../src/client/cat-sprite';

const movement = {
  id: 'cat-one',
  x: 500,
  y: 400,
  targetX: 600,
  targetY: 400,
  movingSince: 1000,
  durationMs: 2000,
};

test('walk starts on the server timeline and returns to sitting exactly at arrival', () => {
  assert.equal(catFrame(movement, 999).animation, 'idle');
  assert.equal(catFrame(movement, 1000).animation, 'side');
  assert.equal(catFrame(movement, 2999).animation, 'side');
  assert.equal(catFrame(movement, 3000).animation, 'idle');
  assert.equal(
    catFrame({ ...movement, durationMs: 0 }, 1000).animation,
    'idle',
  );
  assert.equal(
    catFrame({ ...movement, targetX: movement.x }, 1000).animation,
    'idle',
  );
});

test('dominant movement axis picks the supplied direction and mirrors only rightward walking', () => {
  assert.equal(catFrame(movement, 1000).flipX, true);
  assert.equal(catFrame({ ...movement, targetX: 400 }, 1000).flipX, false);
  const up = catFrame({ ...movement, targetY: 200 }, 1000);
  assert.equal(up.animation, 'up');
  assert.equal(up.row, 11);
  assert.equal(up.footY, 53);
  assert.equal(up.flipX, false);
  const down = catFrame({ ...movement, targetY: 550 }, 1000);
  assert.equal(down.animation, 'down');
  assert.equal(down.row, 12);
  assert.equal(down.footY, 46);
  assert.equal(down.flipX, false);
  assert.equal(catFrame({ ...movement, targetY: 500 }, 1000).animation, 'side');
});

test('idle keeps the last horizontal facing after arrival and vertical movement', () => {
  assert.equal(catFrame(movement, 3000).flipX, true);
  assert.equal(catFrame({ ...movement, targetX: 400 }, 3000).flipX, false);
  const vertical = { ...movement, targetX: movement.x, targetY: 200 };
  assert.equal(catFrame(vertical, 3000, false, true).flipX, true);
  assert.equal(catFrame(vertical, 3000, false, false).flipX, false);
  assert.equal(
    catFrame({ ...vertical, durationMs: 0 }, 3000, true, true).flipX,
    true,
  );
});

test('server stop retains authoritative facing even with no remaining movement', () => {
  const stopped = { ...movement, targetX: movement.x, durationMs: 0 };
  assert.equal(catFrame({ ...stopped, facingRight: true }, 4000).flipX, true);
  assert.equal(
    catFrame({ ...stopped, facingRight: false }, 4000, false, true).flipX,
    false,
  );
  assert.equal(
    catFrame({ ...stopped, facingRight: true, seat: null, sleepAt: 4000 }, 4000)
      .flipX,
    true,
  );
});

test('walking animations follow 200ms cells and wrap within their own row', () => {
  const cases = [
    { ...movement, durationMs: 10000 },
    { ...movement, durationMs: 10000, targetY: 200 },
    { ...movement, durationMs: 10000, targetY: 600 },
  ];
  for (const user of cases) {
    const initial = catFrame(user, 1000);
    const sequence = CAT_ANIMATIONS[initial.animation];
    const start = 1000;
    assert.equal(catFrame(user, start + CAT_FRAME_MS - 1).column, 0);
    assert.equal(catFrame(user, start + CAT_FRAME_MS).column, 1);
    assert.equal(
      catFrame(user, start + sequence.frames * CAT_FRAME_MS).column,
      0,
    );
  }
});

test('upward floor traversal never plays the source front-facing fifth cell', () => {
  const user = {
    ...movement,
    x: 500,
    targetX: 500,
    y: 555,
    targetY: 350,
    durationMs: (205 / 180) * 1000,
  };
  assert.equal(CAT_ANIMATIONS.up.frames, 4);
  for (let elapsed = 0; elapsed < user.durationMs; elapsed += 10) {
    for (const walkStartedAt of [undefined, 0]) {
      const frame = catFrame(
        user,
        user.movingSince + elapsed,
        false,
        false,
        walkStartedAt,
      );
      assert.equal(frame.animation, 'up');
      assert.ok(frame.column >= 0 && frame.column < 4);
    }
  }
  assert.equal(catFrame(user, user.movingSince + 800).column, 0);
});

test('reduced motion freezes animation frames while preserving direction selection', () => {
  for (const now of [1000, 1200, 1800, 2500]) {
    const frame = catFrame(movement, now, true);
    assert.equal(frame.column, 0);
    assert.equal(frame.animation, 'side');
    assert.equal(frame.flipX, true);
  }
  assert.equal(catFrame(movement, 3000, true).animation, 'idle');
  assert.equal(catFrame(movement, 3000, true).column, 0);
});

test('an optional remote gait clock only changes walking columns, leaving motion and idle timing intact', () => {
  const report = { ...movement, movingSince: 1800, durationMs: 2000 };
  assert.equal(catFrame(report, 1800).column, 0);
  const remote = catFrame(report, 1800, false, false, 1000);
  assert.equal(remote.column, 4);
  assert.equal(remote.animation, 'side');
  assert.equal(remote.flipX, true);
  assert.equal(catFrame(report, 1800, true, false, 1000).column, 0);
  for (const now of [1799, 3800, 5000, 16000])
    assert.deepEqual(
      catFrame(report, now, false, false, 1000),
      catFrame(report, now),
    );
});

test('selected animation cells fit the unchanged supplied PNG sheet', () => {
  const png = readFileSync(new URL('../public/Cat/Cat.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), CAT_CELL_SIZE * CAT_SHEET_COLUMNS);
  assert.equal(png.readUInt32BE(20), CAT_CELL_SIZE * CAT_SHEET_ROWS);
  for (const sequence of Object.values(CAT_ANIMATIONS)) {
    assert.ok(sequence.row >= 0 && sequence.row < CAT_SHEET_ROWS);
    assert.ok(sequence.frames > 1 && sequence.frames <= CAT_SHEET_COLUMNS);
    assert.ok(sequence.footY > 0 && sequence.footY <= CAT_CELL_SIZE);
  }
});

test('idle preserves all original frames and pauses 8–12 seconds between loops', () => {
  for (const id of ['cat-one', 'cat-two', 'cat-three']) {
    const changes: { time: number; column: number }[] = [];
    let previous = 0;
    for (let time = 0; time < 40000; time++) {
      const column = idleColumn(id, time);
      if (column !== previous) changes.push({ time, column });
      previous = column;
    }
    assert.deepEqual(
      changes.slice(0, 12).map((change) => change.column),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0],
    );
    const pause = changes[0]!.time - CAT_FRAME_MS;
    assert.ok(pause >= 8000 && pause <= 12000);
    for (let index = 1; index < 12; index++)
      assert.equal(
        changes[index]!.time - changes[index - 1]!.time,
        CAT_FRAME_MS,
      );
    assert.equal(changes[12]!.time - changes[11]!.time, pause + CAT_FRAME_MS);
  }
});

test('idle timing is deterministic, differs by cat, and reduced motion stays upright', () => {
  const times = Array.from({ length: 600 }, (_, index) => index * 100);
  const first = times.map((time) => idleColumn('cat-one', time));
  assert.deepEqual(
    first,
    times.map((time) => idleColumn('cat-one', time)),
  );
  assert.notDeepEqual(
    first,
    times.map((time) => idleColumn('cat-two', time)),
  );
  for (const time of times)
    assert.equal(idleColumn('cat-one', time, true), CAT_IDLE_UP_COLUMN);
});

test('movement arrival, spawn and stage placement begin with a full raised-tail pause', () => {
  for (const user of [movement, { ...movement, durationMs: 0 }]) {
    const arrival = user.movingSince + user.durationMs;
    for (let elapsed = 0; elapsed < 8000; elapsed += 100) {
      const frame = catFrame(user, arrival + elapsed);
      assert.equal(frame.animation, 'idle');
      assert.equal(frame.column, CAT_IDLE_UP_COLUMN);
    }
  }
});

test('sleep loops from the full Zs directly back to the quiet frames', () => {
  const start = 123_000;
  const user = { ...movement, durationMs: 0, seat: null, sleepAt: start };
  assert.equal(catFrame(user, start - 1).animation, 'idle');
  for (let frame = 0; frame < 25; frame++) {
    const now = start + frame * CAT_FRAME_MS;
    const result = catFrame(user, now, false, true);
    assert.equal(result.animation, 'sleep');
    assert.equal(result.row, 0);
    assert.equal(result.column, frame % 12);
    assert.equal(result.flipX, true);
    assert.equal(catFrame(user, now, true, true).column, 0);
  }
  assert.equal(catFrame({ ...user, seat: 0 }, start).animation, 'idle');
});

test('a late observer renders the current sleep phase from the server deadline', () => {
  const sleeping = { ...movement, durationMs: 0, seat: null, sleepAt: 130_000 };
  const observedAt = 131_700;
  assert.equal(catFrame(sleeping, observedAt).animation, 'sleep');
  assert.equal(catFrame(sleeping, observedAt).column, 8);
  const { sleepAt, ...legacy } = sleeping;
  assert.equal(catFrame(legacy, observedAt).animation, 'idle');
  const waking = { ...sleeping, sleepAt: 251_700 };
  assert.equal(catFrame(waking, observedAt).animation, 'idle');
});

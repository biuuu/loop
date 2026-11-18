import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMovementScheduler,
  type MovementClock,
} from '../src/client/movement-scheduler';
function fakeClock() {
  let now = 1000;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: MovementClock = {
    set(callback, delay) {
      const token = ++id;
      timers.set(token, { at: now + delay, callback });
      return token;
    },
    clear(token) {
      timers.delete(token as number);
    },
  };
  return {
    clock,
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

function fixture() {
  const time = fakeClock();
  let context: string | undefined = 'socket-one:guest-one';
  const sent: { value: number; at: number }[] = [];
  const scheduler = createMovementScheduler<number>({
    context: () => context,
    now: () => time.now,
    clock: time.clock,
    send: (value) => sent.push({ value, at: time.now }),
  });
  return {
    time,
    scheduler,
    sent,
    set context(value: string | undefined) {
      context = value;
    },
  };
}

test('first report sends immediately and singleton has no trailing duplicate or heartbeat', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  assert.deepEqual(f.sent, [{ value: 1, at: 1000 }]);
  assert.equal(f.time.pending, 0);
  f.time.advance(4000);
  assert.equal(f.sent.length, 1);
});

test('rapid updates replace the pending factory without postponing its 150 ms deadline', () => {
  const f = fixture();
  let value = 1;
  f.scheduler.schedule(() => value);
  for (let i = 0; i < 7; i++) {
    f.time.advance(20);
    value = i + 2;
    f.scheduler.schedule(() => value);
  }
  assert.equal(f.sent.length, 1);
  assert.equal(f.time.pending, 1);
  f.time.advance(9);
  value = 99;
  f.time.advance(1);
  assert.deepEqual(f.sent, [
    { value: 1, at: 1000 },
    { value: 99, at: 1150 },
  ]);
  assert.equal(f.time.pending, 0);
});

test('continuous input is bounded to roughly seven reports per second and final delivery within 150 ms', () => {
  const f = fixture();
  for (let i = 0; i <= 100; i++) {
    f.scheduler.schedule(() => i);
    f.time.advance(10);
  }
  assert.deepEqual(
    f.sent.map((report) => report.at),
    [1000, 1150, 1300, 1450, 1600, 1750, 1900],
  );
  assert.equal(f.sent.filter((report) => report.at < 2000).length, 7);
  f.time.advance(40);
  assert.deepEqual(f.sent.at(-1), { value: 100, at: 2050 });
  assert.equal(f.time.pending, 0);
});

test('a report after the interval sends immediately', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(150);
  f.scheduler.schedule(() => 2);
  assert.deepEqual(f.sent.at(-1), { value: 2, at: 1150 });
  assert.equal(f.time.pending, 0);
});

test('final stop flushes immediately, clears pending restart and never duplicates its leading report', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  f.scheduler.schedule(() => 2);
  f.time.advance(50);
  f.scheduler.schedule(() => 0);
  f.scheduler.flush();
  assert.deepEqual(f.sent, [
    { value: 1, at: 1000 },
    { value: 0, at: 1100 },
  ]);
  assert.equal(f.time.pending, 0);
  f.scheduler.flush();
  f.time.advance(4000);
  assert.equal(f.sent.length, 2);
  f.scheduler.schedule(() => 0);
  f.scheduler.flush();
  assert.equal(f.sent.length, 3);
});

test('flush preserves last-send time so rapid fresh start still waits for the interval', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  f.scheduler.schedule(() => 0);
  f.scheduler.flush();
  f.time.advance(10);
  f.scheduler.schedule(() => 2);
  assert.equal(f.sent.length, 2);
  f.time.advance(139);
  assert.equal(f.sent.length, 2);
  f.time.advance(1);
  assert.deepEqual(f.sent.at(-1), { value: 2, at: 1200 });
});

test('cancel drops pending reports and interval state; a new session report sends immediately', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  f.scheduler.schedule(() => 2);
  assert.equal(f.time.pending, 1);
  f.scheduler.cancel();
  assert.equal(f.time.pending, 0);
  f.scheduler.schedule(() => 3);
  assert.deepEqual(f.sent.at(-1), { value: 3, at: 1050 });
  f.time.advance(4000);
  assert.equal(f.sent.length, 2);
});

test('dispatch rejects reports from invalid socket or identity context', () => {
  for (const context of [
    undefined,
    'socket-two:guest-one',
    'socket-one:guest-two',
  ]) {
    const f = fixture();
    f.scheduler.schedule(() => 1);
    f.time.advance(50);
    f.scheduler.schedule(() => 2);
    f.context = context;
    f.time.advance(4000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.time.pending, 0);
    f.context = 'new-session';
    f.scheduler.schedule(() => 3);
    assert.deepEqual(f.sent.at(-1), { value: 3, at: 5050 });
  }
});

test('a final report is preserved even when its coordinates equal the first report', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  f.scheduler.schedule(() => 2);
  f.time.advance(50);
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  assert.deepEqual(f.sent, [
    { value: 1, at: 1000 },
    { value: 1, at: 1150 },
  ]);
});

test('an empty sample sends nothing and does not advance the report interval', () => {
  const f = fixture();
  f.scheduler.schedule(() => 1);
  f.time.advance(50);
  f.scheduler.schedule(() => undefined);
  f.time.advance(100);
  assert.equal(f.sent.length, 1);
  f.scheduler.schedule(() => 2);
  assert.deepEqual(f.sent.at(-1), { value: 2, at: 1150 });
});

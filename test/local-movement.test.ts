import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMovement } from '../src/client/local-movement';
import {
  createMovementScheduler,
  type MovementClock,
} from '../src/client/movement-scheduler';
import {
  createKeyboardMovement,
  movementPosition,
  type Direction,
} from '../src/client/keyboard-movement';
import { catFrame } from '../src/client/cat-sprite';
import {
  SCENE,
  type ClientMotion,
  type Participant,
} from '../src/shared/contracts';

const initial = (): Participant => ({
  id: 'local-cat',
  nickname: 'Cat',
  x: 500,
  y: 450,
  targetX: 500,
  targetY: 450,
  movingSince: 0,
  durationMs: 0,
  seat: null,
  connected: true,
  facingRight: false,
});
const point = (user: Participant, now: number) => movementPosition(user, now);
function fixture() {
  let now = 1000;
  let token = 0;
  let context: string | undefined = 'socket:guest';
  let authoritative = initial();
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: MovementClock = {
    set(run, delay) {
      const id = ++token;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clear(id) {
      timers.delete(id as number);
    },
  };
  const local = createLocalMovement();
  const sent: (ClientMotion & { at: number })[] = [];
  const scheduler = createMovementScheduler<ClientMotion>({
    context: () => context,
    now: () => now,
    clock,
    send: (report) => sent.push({ ...report, at: now }),
  });
  const schedule = () => scheduler.schedule(() => local.report(now));
  const move = (x: number, y: number) => {
    local.move(authoritative, { x, y }, now);
    schedule();
  };
  const direction = (direction: Direction) => {
    local.direction(authoritative, direction, now);
    schedule();
  };
  const stop = () => {
    local.stop(authoritative, now);
    schedule();
    scheduler.flush();
  };
  const keyboard = createKeyboardMovement({ sendDirection: direction, stop });
  return {
    local,
    scheduler,
    keyboard,
    sent,
    move,
    direction,
    stop,
    view: () => local.view(authoritative, now),
    get now() {
      return now;
    },
    set authoritative(value: Participant) {
      authoritative = value;
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
        next[1].run();
      }
      now = end;
    },
    disconnect() {
      context = undefined;
      scheduler.cancel();
      local.reset();
    },
  };
}

test('every rapid direction and stop rebases immediately from current local interpolation', () => {
  const f = fixture();
  f.direction('right');
  f.advance(100);
  assert.deepEqual(point(f.view(), f.now), { x: 518, y: 450 });
  f.direction('up');
  assert.equal(f.view().targetX, 518);
  assert.equal(catFrame(f.view(), f.now).animation, 'up');
  f.advance(100);
  f.direction('left');
  assert.deepEqual(point(f.view(), f.now), { x: 518, y: 432 });
  assert.equal(f.view().targetX, SCENE.walk.left);
  assert.equal(catFrame(f.view(), f.now).flipX, false);
  f.advance(50);
  f.stop();
  assert.deepEqual(point(f.view(), f.now), { x: 509, y: 432 });
  assert.equal(f.view().durationMs, 0);
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent.at(-1), {
    x: 509,
    y: 432,
    targetX: 509,
    targetY: 432,
    facingRight: false,
    clientMoveId: 4,
    at: 1250,
  });
});

test('rapid clicks change local target and animation immediately while reports are throttled', () => {
  const f = fixture();
  f.move(800, 450);
  f.advance(100);
  f.move(518, 350);
  assert.deepEqual(point(f.view(), f.now), { x: 518, y: 450 });
  assert.equal(catFrame(f.view(), f.now).animation, 'up');
  f.advance(100);
  f.move(100, 432);
  assert.deepEqual(point(f.view(), f.now), { x: 518, y: 432 });
  assert.equal(catFrame(f.view(), f.now).animation, 'side');
  assert.equal(f.sent.length, 2);
  f.advance(100);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2]?.x, 500);
  assert.equal(f.sent[2]?.targetX, 100);
  assert.deepEqual(
    f.sent.map((report) => report.at),
    [1000, 1150, 1300],
  );
});

test('rapid press/release taps move locally and publish exact stops immediately', () => {
  const f = fixture();
  const right = { code: 'KeyD', key: 'd' };
  const left = { code: 'KeyA', key: 'a' };
  f.keyboard.press(right);
  f.advance(100);
  f.keyboard.release(right);
  assert.equal(f.view().targetX, 518);
  assert.deepEqual(f.sent.at(-1), {
    x: 518,
    y: 450,
    targetX: 518,
    targetY: 450,
    facingRight: true,
    clientMoveId: 2,
    at: 1100,
  });
  f.advance(100);
  f.keyboard.press(left);
  assert.equal(f.view().targetX, SCENE.walk.left);
  assert.equal(f.sent.length, 2); // The next start respects the last stop's interval.
  f.advance(50);
  f.keyboard.release(left);
  assert.equal(f.view().targetX, 509);
  assert.deepEqual(f.sent.at(-1), {
    x: 509,
    y: 450,
    targetX: 509,
    targetY: 450,
    facingRight: false,
    clientMoveId: 4,
    at: 1250,
  });
  const count = f.sent.length;
  f.advance(4000);
  assert.equal(f.sent.length, count); // No delayed start survives the final stop.
});

test('held aliases/repeats do not restart local animation or enqueue reports', () => {
  const f = fixture();
  const right = { code: 'KeyD', key: 'd' };
  f.keyboard.press(right);
  f.keyboard.press({ code: 'ArrowRight', key: 'ArrowRight' });
  const columns: number[] = [];
  for (let i = 0; i < 14; i++) {
    f.keyboard.press({ ...right, repeat: true });
    columns.push(catFrame(f.view(), f.now).column);
    f.advance(100);
  }
  assert.deepEqual([...new Set(columns)], [0, 1, 2, 3, 4, 5]);
  assert.equal(f.view().movingSince, 1000);
  assert.equal(f.sent.length, 1);
  f.keyboard.release(right);
  assert.equal(f.view().durationMs > 0, true);
  f.keyboard.release({ code: 'ArrowRight', key: 'ArrowRight' });
  assert.equal(f.view().durationMs, 0);
});

test('stale and matching in-flight snapshots do not pull local motion backwards; metadata still refreshes', () => {
  const local = createLocalMovement();
  const user = initial();
  local.move(user, { x: 800, y: 450 }, 1000);
  const old = {
    ...user,
    nickname: 'Renamed',
    appearance: { coat: 'pure_black' as const, pattern: 'tabby' as const },
  };
  const shown = local.view(old, 1500);
  assert.deepEqual(point(shown, 1500), { x: 590, y: 450 });
  assert.equal(shown.nickname, 'Renamed');
  assert.deepEqual(shown.appearance, old.appearance);
  const echo = {
    ...user,
    targetX: 800,
    movingSince: 1200,
    durationMs: (300 / SCENE.speed) * 1000,
    clientMoveId: 1,
    facingRight: true,
  };
  assert.deepEqual(point(local.view(echo, 1500), 1500), { x: 590, y: 450 });
  assert.deepEqual(point(local.view(echo, 2800), 2800), { x: 800, y: 450 });
  assert.deepEqual(local.view(echo, 3000), echo); // Both segments have arrived.
  assert.equal(local.view(user, 3100).targetX, 800); // An older echo stays fenced out.
});

test('same-id mismatched target or facing cannot retire local override', () => {
  const local = createLocalMovement();
  const user = initial();
  local.move(user, { x: 600, y: 450 }, 1000);
  const echo = {
    ...user,
    x: 600,
    targetX: 600,
    clientMoveId: 1,
    facingRight: false,
  };
  assert.equal(local.view(echo, 3000).facingRight, true);
  assert.equal(
    local.view({ ...echo, x: 550, targetX: 550, facingRight: true }, 3000)
      .targetX,
    600,
  );
});

test('vertical turns and stop preserve local horizontal facing and all inputs clamp', () => {
  const local = createLocalMovement();
  const user = initial();
  local.direction(user, 'right', 1000);
  local.direction(user, 'up', 1100);
  local.stop(user, 1200);
  assert.equal(local.view(user, 1200).facingRight, true);
  local.move(user, { x: -100, y: 900 }, 1200);
  const view = local.view(user, 1200);
  assert.equal(view.targetX, SCENE.walk.left);
  assert.equal(view.targetY, SCENE.walk.bottom);
  assert.equal(view.facingRight, false);
});

test('only rejection of the latest input rolls back local override; reset preserves monotonic ids', () => {
  const local = createLocalMovement();
  const user = initial();
  local.direction(user, 'right', 1000);
  local.direction(user, 'left', 1100);
  assert.equal(local.reject(1), false);
  assert.equal(local.view(user, 1100).targetX, SCENE.walk.left);
  assert.equal(local.reject(2), true);
  assert.equal(local.view(user, 1100), user);
  local.direction(user, 'right', 1200);
  assert.equal(local.report(1200)?.clientMoveId, 3);
  local.reset();
  assert.equal(local.report(1300), undefined);
  assert.equal(local.view(user, 1300), user);
  local.direction({ ...user, clientMoveId: 40 }, 'up', 1400);
  assert.equal(local.report(1400)?.clientMoveId, 41);
});

test('lifecycle flush preserves pending pointer target; stage stop flushes exact final position', () => {
  const f = fixture();
  f.move(800, 450);
  f.advance(50);
  f.move(700, 500);
  f.advance(50);
  const before = f.local.report(f.now)!;
  f.scheduler.flush(); // Panel/blur with no owned keyboard leaves pointer motion intact.
  assert.deepEqual(f.sent.at(-1), { ...before, at: 1100 });
  assert.equal(f.view().targetX, 700);
  f.advance(50);
  f.stop(); // Stage action stops and publishes locally before changing seat.
  const count = f.sent.length;
  f.scheduler.flush(); // Already-flushed stop is never duplicated.
  assert.equal(f.sent.length, count);
  const final = f.sent.at(-1)!;
  assert.equal(final.x, final.targetX);
  assert.equal(final.y, final.targetY);
  assert.equal(final.at, 1150);
  assert.equal(f.view().durationMs, 0);
  f.disconnect();
  assert.equal(f.view().clientMoveId, undefined);
  f.advance(4000);
  assert.equal(f.sent.length, count);
});

test('disconnect drops override and unsent reports rather than publishing stale motion', () => {
  const f = fixture();
  f.move(800, 450);
  f.advance(100);
  f.move(100, 450);
  assert.equal(f.view().targetX, 100);
  f.disconnect();
  assert.equal(f.view().targetX, 500);
  f.advance(4000);
  assert.equal(f.sent.length, 1);
});

test('return to first coordinates still publishes the latest final revision', () => {
  const f = fixture();
  f.move(500, 450);
  f.advance(25);
  f.move(600, 450);
  f.advance(25);
  f.move(500, 450);
  f.advance(100);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]?.x, 500);
  assert.equal(f.sent[1]?.x, 500);
  assert.equal(f.sent[1]?.targetX, 500);
  assert.equal(f.sent[1]?.clientMoveId, 3);
});

test('one target needs no arrival report; remote and local finish at the same target', () => {
  const f = fixture();
  f.move(600, 450);
  f.advance(3000);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(point(f.view(), f.now), { x: 600, y: 450 });
  const report = f.sent[0]!;
  const remote = {
    ...initial(),
    ...report,
    movingSince: report.at + 200,
    durationMs:
      (Math.hypot(report.targetX - report.x, report.targetY - report.y) /
        SCENE.speed) *
      1000,
  };
  assert.deepEqual(point(remote, f.now), { x: 600, y: 450 });
});

test('continuous local changes stay immediate while reports throttle and final stop flushes immediately', () => {
  const f = fixture();
  for (let i = 0; i <= 100; i++) {
    f.move(600 + i, 450);
    assert.equal(f.view().targetX, 600 + i);
    f.advance(10);
  }
  assert.deepEqual(
    f.sent.map((report) => report.at),
    [1000, 1150, 1300, 1450, 1600, 1750, 1900],
  );
  f.stop();
  const final = f.local.report(f.now)!;
  assert.deepEqual(f.sent.at(-1), { ...final, at: 2010 });
  const count = f.sent.length;
  f.advance(1000);
  assert.equal(f.sent.length, count);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { catFrame } from '../src/client/cat-sprite';
import { movementPosition } from '../src/client/keyboard-movement';
import {
  createRemoteMovement,
  REMOTE_CORRECTION_MS,
  remoteFrameUser,
} from '../src/client/remote-movement';
import { SCENE, type Participant } from '../src/shared/contracts';

const initial = (): Participant => ({
  id: 'remote-cat',
  nickname: 'Cat',
  x: 100,
  y: 450,
  targetX: 100,
  targetY: 450,
  movingSince: 1000,
  durationMs: 0,
  seat: null,
  connected: true,
});
function segment(x: number, targetX: number, since: number): Participant {
  return {
    ...initial(),
    x,
    targetX,
    movingSince: since,
    durationMs: (Math.abs(targetX - x) / SCENE.speed) * 1000,
  };
}
function closePoint(
  actual: { x: number; y: number },
  expected: {
    x: number;
    y: number;
  },
) {
  assert.ok(
    Math.abs(actual.x - expected.x) < 1e-9,
    `${actual.x} != ${expected.x}`,
  );
  assert.ok(
    Math.abs(actual.y - expected.y) < 1e-9,
    `${actual.y} != ${expected.y}`,
  );
}
function frame(user: Participant, now: number, walkStartedAt?: number) {
  return catFrame(user, now, false, false, walkStartedAt);
}
function displayedFrame(
  user: Participant,
  view: ReturnType<ReturnType<typeof createRemoteMovement>['view']>,
  now: number,
) {
  return frame(remoteFrameUser(user, view, now), now, view.walkStartedAt);
}

test('first sight snaps to the current server trajectory and ordinary movement arrives exactly', () => {
  const remote = createRemoteMovement();
  const user = segment(100, 460, 1000);
  for (const now of [1500, 1600, 2999, 3000, 4000]) {
    const view = remote.view(user, now);
    closePoint(view, movementPosition(user, now));
    assert.equal(
      frame(user, now, view.walkStartedAt).animation,
      now < 3000 ? 'side' : 'idle',
    );
  }
  assert.equal(remote.view(user, 4000).walkStartedAt, undefined);
});

test('two observers keep positions continuous and advance all walk cells through 150ms reports', () => {
  const observers = [createRemoteMovement(), createRemoteMovement()];
  const columns = observers.map(() => new Set<number>());
  let user = segment(100, 900, 1000);
  for (const observer of observers) observer.view(user, 1000);
  for (let now = 1010; now <= 2500; now += 10) {
    if ((now - 1000) % 150 === 0) {
      // A small reporting error must not jump either observer. Their previous
      // rendered frames differ, so continuity must sample the old path at now.
      const expected = movementPosition(user, now);
      const x =
        100 + ((now - 1000) / 1000) * SCENE.speed + (now % 300 ? 3 : -2);
      user = segment(x, 900, now);
      for (const observer of observers) {
        const view = observer.view(user, now);
        closePoint(view, expected);
        assert.equal(view.walkStartedAt, 1000);
      }
    }
    for (const [index, observer] of observers.entries()) {
      if (index === 1 && now % 30 !== 0) continue;
      const view = observer.view(user, now);
      const pose = frame(user, now, view.walkStartedAt);
      assert.equal(pose.animation, 'side');
      columns[index]!.add(pose.column);
      if (now - user.movingSince >= REMOTE_CORRECTION_MS)
        closePoint(view, movementPosition(user, now));
    }
  }
  for (const observed of columns)
    assert.deepEqual([...observed], [0, 1, 2, 3, 4, 5]);
});

test('a final stop is continuous, walks while correcting, and settles within 120ms', () => {
  for (const remote of [createRemoteMovement(), createRemoteMovement()]) {
    const walking = segment(100, 900, 1000);
    remote.view(walking, 1000);
    remote.view(walking, 1400); // Last frame is deliberately older than receipt.
    const stopped = { ...initial(), x: 172, targetX: 172, movingSince: 1500 };
    const receipt = remote.view(stopped, 1500);
    closePoint(receipt, { x: 190, y: 450 });
    assert.equal(receipt.walkStartedAt, 1000);
    assert.equal(displayedFrame(stopped, receipt, 1500).animation, 'side');
    closePoint(remote.view(stopped, 1560), { x: 181, y: 450 });
    for (const now of [1620, 2000, 10000]) {
      const view = remote.view(stopped, now);
      closePoint(view, { x: 172, y: 450 });
      assert.equal(displayedFrame(stopped, view, now).animation, 'idle');
    }
  }
});

test('a direct stop drops short prediction overshoot without walking backward', () => {
  const remote = createRemoteMovement();
  const walking = { ...segment(100, 900, 1000), clientMoveId: 1 };
  remote.view(walking, 1000);
  closePoint(remote.view(walking, 1500), { x: 190, y: 450 });
  const stopped = {
    ...initial(),
    x: 172,
    targetX: 172,
    movingSince: 1500,
    clientMoveId: 2,
  };
  const receipt = remote.view(stopped, 1500);
  closePoint(receipt, { x: 172, y: 450 });
  assert.equal(receipt.walkStartedAt, undefined);
  assert.equal(displayedFrame(stopped, receipt, 1500).animation, 'idle');
  for (const now of [1516, 1560, 2000])
    closePoint(remote.view(stopped, now), { x: 172, y: 450 });
});

test('a missed retarget before stopping still shows a genuine reversal', () => {
  const remote = createRemoteMovement();
  const walking = { ...segment(100, 900, 1000), clientMoveId: 1 };
  remote.view(walking, 1000);
  closePoint(remote.view(walking, 1500), { x: 190, y: 450 });
  const stopped = {
    ...initial(),
    x: 172,
    targetX: 172,
    movingSince: 1500,
    clientMoveId: 3,
    facingRight: false,
  };
  const receipt = remote.view(stopped, 1500);
  closePoint(receipt, { x: 190, y: 450 });
  assert.equal(displayedFrame(stopped, receipt, 1500).animation, 'side');
  assert.equal(displayedFrame(stopped, receipt, 1500).flipX, false);
  closePoint(remote.view(stopped, 1620), { x: 172, y: 450 });
});

test('nickname, appearance, facing and snapshot metadata do not restart correction or gait', () => {
  const baseline = createRemoteMovement();
  const remote = createRemoteMovement();
  const walking = segment(100, 900, 1000);
  for (const observer of [baseline, remote]) observer.view(walking, 1000);
  const report = segment(150, 900, 1150);
  for (const observer of [baseline, remote]) observer.view(report, 1150);
  for (const now of [1180, 1210, 1240, 1270, 1400]) {
    const metadata = {
      ...report,
      nickname: `Cat ${now}`,
      appearance: { coat: 'pure_black' as const, pattern: 'tabby' as const },
      facingRight: false,
      connected: false,
      revision: now,
    };
    assert.deepEqual(remote.view(metadata, now), baseline.view(report, now));
    assert.equal(remote.view(metadata, now).walkStartedAt, 1000);
  }
  closePoint(remote.view(report, 1420), movementPosition(report, 1420));
});

test('a report arriving during correction rebases the currently displayed path without drift', () => {
  const remote = createRemoteMovement();
  remote.view(segment(100, 900, 1000), 1000);
  const first = segment(150, 900, 1100);
  closePoint(remote.view(first, 1100), { x: 118, y: 450 });
  const before = remote.view(first, 1160);
  closePoint(before, { x: 134.2, y: 450 });
  const turn = segment(130, 75, 1160);
  const after = remote.view(turn, 1160);
  closePoint(after, before);
  assert.equal(after.walkStartedAt, 1000);
  closePoint(remote.view(turn, 1220), { x: 121.3, y: 450 });
  closePoint(remote.view(turn, 1280), movementPosition(turn, 1280));
  closePoint(remote.view(turn, 2000), { x: 75, y: 450 });
  const newWalk = segment(75, 900, 2100);
  assert.equal(remote.view(newWalk, 2100).walkStartedAt, 2100);
});

test('rapid taps whose start reports were coalesced still walk between stop positions', () => {
  const remote = createRemoteMovement();
  let user = initial();
  remote.view(user, 1000);
  let previous = { x: 100, y: 450 };
  let previousTime = 1000;
  for (const [at, x] of [
    [1080, 114.4],
    [1160, 128.8],
    [1240, 143.2],
    [1320, 128.8],
  ]) {
    for (let time = previousTime + 10; time <= at!; time += 10) {
      const view = remote.view(user, time);
      const travel = Math.hypot(view.x - previous.x, view.y - previous.y);
      assert.ok(travel <= (SCENE.speed * 10) / 1000 + 0.001);
      previous = view;
    }
    const before = remote.view(user, at!);
    user = {
      ...user,
      x: x!,
      targetX: x!,
      movingSince: at!,
      durationMs: 0,
      facingRight: x! > previous.x,
    };
    const receipt = remote.view(user, at!);
    closePoint(receipt, before);
    const pose = displayedFrame(user, receipt, at!);
    assert.equal(pose.animation, 'side');
    assert.equal(pose.flipX, x! > before.x);
    previousTime = at!;
  }
  const settled = remote.view(user, 1500);
  closePoint(settled, { x: 128.8, y: 450 });
  assert.equal(displayedFrame(user, settled, 1500).animation, 'idle');
});

test('a delayed reversal corrects at bounded speed and faces its displayed path', () => {
  const remote = createRemoteMovement();
  const right = segment(100, 900, 1000);
  remote.view(right, 1000);
  const before = remote.view(right, 1250);
  const left = segment(127, 75, 1250);
  const receipt = remote.view(left, 1250);
  closePoint(receipt, before);
  assert.equal(displayedFrame(left, receipt, 1250).animation, 'side');
  assert.equal(displayedFrame(left, receipt, 1250).flipX, false);
  let previous = receipt;
  for (let now = 1260; now <= 1450; now += 10) {
    const view = remote.view(left, now);
    const distance = Math.hypot(view.x - previous.x, view.y - previous.y);
    assert.ok(distance <= (SCENE.speed * 1.5 * 10) / 1000 + 0.001);
    previous = view;
  }
  closePoint(previous, movementPosition(left, 1450));
});

test('joining, changing seats and leaving stage snap immediately and reset correction and gait', () => {
  const remote = createRemoteMovement();
  remote.view(segment(100, 900, 1000), 1000);
  remote.view(segment(150, 900, 1100), 1100);
  const seated = {
    ...initial(),
    x: SCENE.seatXs[0],
    y: SCENE.stageY,
    targetX: SCENE.seatXs[0],
    targetY: SCENE.stageY,
    movingSince: 1120,
    seat: 0,
  };
  closePoint(remote.view(seated, 1120), { x: seated.x, y: seated.y });
  assert.equal(remote.view(seated, 1120).walkStartedAt, undefined);
  const nextSeat = {
    ...seated,
    x: SCENE.seatXs[2],
    targetX: SCENE.seatXs[2],
    seat: 2,
  };
  closePoint(remote.view(nextSeat, 1140), { x: nextSeat.x, y: nextSeat.y });
  const floor = { ...initial(), x: 600, targetX: 600, movingSince: 1160 };
  closePoint(remote.view(floor, 1160), { x: 600, y: 450 });
  closePoint(remote.view(floor, 1300), { x: 600, y: 450 });
  const walking = segment(600, 900, 1400);
  assert.equal(remote.view(walking, 1400).walkStartedAt, 1400);
});

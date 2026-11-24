import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Room } from '../src/server/room.js';
import { MusicPlaybackError } from '../src/server/music-errors.js';
import {
  EMOTE_DURATION_MS,
  EMOTE_COOLDOWN_MS,
  ROOM_CAPACITY,
  SCENE,
  STAGE_CAPACITY,
  stageSeatXs,
  type MusicService,
  type RoomEmote,
  type RoomMotion,
  type RoomSnapshot,
  type PlaybackState,
  type PlaylistOrder,
  type Track,
} from '../src/shared/contracts.js';

const track = (id: string): Track => ({
  id,
  title: id,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const music: MusicService = {
  search: async () => [],
  detail: async (id) => track(id),
  resolve: async (item) => ({
    url: `https://example.com/${item.id}.mp3`,
    durationMs: 60_000,
  }),
};
function setup(
  service = music,
  options = { disconnectGraceMs: 15, resolveTimeoutMs: 20 },
) {
  const db = new Store(':memory:'),
    room = new Room(db, service, options);
  const guests = ['A', 'B', 'C'].map(
    (nickname) => db.createGuest(nickname).guest,
  );
  guests.forEach((guest, index) => {
    db.add(guest.id, track(String(index + 1)));
    room.connect(guest, { id: guest.id, replaced() {} });
  });
  return {
    db,
    room,
    guests,
    close: () => {
      room.close();
      db.close();
    },
  };
}
function collectSnapshots(room: Room) {
  const snapshots: RoomSnapshot[] = [];
  room.onChange = (snapshot) => snapshots.push(snapshot);
  return snapshots;
}
function collectPlayback(room: Room) {
  const states: PlaybackState[] = [];
  room.onPlaybackChange = (state) => {
    assert.deepEqual(
      Object.keys(state)
        .filter((key) => key !== 'stage')
        .sort(),
      ['notice', 'playback', 'resolving', 'revision', 'serverTime'],
    );
    states.push(state);
  };
  return states;
}
function collectMotion(room: Room) {
  const events: RoomMotion[] = [];
  room.onMotion = (event) => events.push(event);
  return events;
}
function assertStageConsistent(snapshot: RoomSnapshot) {
  const positions = stageSeatXs(snapshot.stageCapacity);
  for (const user of snapshot.users) {
    const seat = snapshot.stage.indexOf(user.id);
    assert.equal(user.seat, seat < 0 ? null : seat);
    if (user.seat !== null) {
      assert.equal(user.x, positions[user.seat]);
      assert.equal(user.targetX, user.x);
      assert.equal(user.y, SCENE.stageY);
      assert.equal(user.targetY, user.y);
      assert.equal(user.durationMs, 0);
      assert.equal(user.clientMoveId, undefined);
    }
  }
  if (snapshot.playback)
    assert.equal(snapshot.playback.djId, snapshot.stage[0]);
}
function assertFloorPosition(
  user: RoomSnapshot['users'][number] | undefined,
  { x, y }: { x: number; y: number },
) {
  assert.ok(user);
  assert.equal(user.seat, null);
  assert.equal(user.x, x);
  assert.equal(user.y, y);
  assert.equal(user.targetX, x);
  assert.equal(user.targetY, y);
  assert.equal(user.durationMs, 0);
}
test('first stage join with an immediate resolver publishes one complete playing state', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const revision = room.snapshot().revision;
    await room.join(a!.id, a!.id, 4);
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.revision, revision + 1);
    assert.equal(snapshots[0]!.playback!.djId, a!.id);
    assert.equal(snapshots[0]!.resolving, false);
    assertStageConsistent(snapshots[0]!);
    assert.equal(playback.length, 0);
  } finally {
    close();
  }
});
test('last DJ leaving publishes one consistent idle state at the previous floor position', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    const floor = room.snapshot().users[0]!;
    await room.join(a!.id);
    const snapshots = collectSnapshots(room);
    const revision = room.snapshot().revision;
    await room.leave(a!.id, a!.id, {});
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    const state = snapshots[0]!;
    assert.equal(state.revision, revision + 1);
    assert.deepEqual(state.stage, []);
    assert.equal(state.playback, null);
    assert.equal(state.resolving, false);
    assert.equal(state.notice, null);
    assertFloorPosition(
      state.users.find((user) => user.id === a!.id),
      floor,
    );
    assertStageConsistent(state);
  } finally {
    close();
  }
});
test('single-song successful playback emits no queue order when its revision is unchanged', async () => {
  const {
    room,
    db,
    guests: [a],
    close,
  } = setup();
  try {
    const before = db.playlist(a!.id);
    const updates: PlaylistOrder[] = [];
    room.onPlaylistChange = (_id, order) => updates.push(order);
    await room.join(a!.id);
    const playback = collectPlayback(room);
    await room.skip(a!.id, { roundId: room.snapshot().playback!.roundId });
    assert.equal(updates.length, 0);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.stage, undefined);
    assert.deepEqual(db.playlist(a!.id), before);
    assert.equal(room.snapshot().playback!.track.id, '1');
  } finally {
    close();
  }
});
test('noncurrent DJ leaving publishes once and preserves current playback and both queues', async () => {
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    await room.join(a!.id);
    await room.join(b!.id);
    await room.join(c!.id);
    const playing = room.snapshot().playback;
    const queues = [db.playlist(a!.id), db.playlist(b!.id)];
    const snapshots = collectSnapshots(room);
    await room.leave(b!.id);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]!.playback, playing);
    assert.deepEqual(snapshots[0]!.stage, [a!.id, c!.id]);
    assert.equal(snapshots[0]!.resolving, false);
    assertStageConsistent(snapshots[0]!);
    assert.deepEqual([db.playlist(a!.id), db.playlist(b!.id)], queues);
  } finally {
    close();
  }
});
test('immediate DJ handoff publishes only the new round and rotates the next queue exactly once', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    db.add(b!.id, track('5'));
    await room.join(a!.id);
    await room.join(b!.id);
    await room.join(c!.id);
    const snapshots = collectSnapshots(room);
    const updates: string[] = [];
    room.onPlaylistChange = (id) => updates.push(id);
    await room.leave(a!.id);
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.playback!.djId, b!.id);
    assert.deepEqual(snapshots[0]!.stage, [b!.id, c!.id]);
    assert.equal(snapshots[0]!.playback!.track.id, '2');
    assert.equal(snapshots[0]!.resolving, false);
    assertStageConsistent(snapshots[0]!);
    assert.deepEqual(
      db.tracks(b!.id).map((item) => item.id),
      ['5', '2'],
    );
    assert.deepEqual(updates, [b!.id]);
  } finally {
    close();
  }
});
test('pure skip sends cloned stage order and preserves staged movement timestamps and shared revisions', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    db.add(b!.id, track('5'));
    await room.join(a!.id);
    await room.join(b!.id);
    const before = room.snapshot();
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const updates: string[] = [];
    room.onPlaylistChange = (id) => updates.push(id);
    context.mock.timers.tick(250);
    await room.skip(a!.id, { roundId: before.playback!.roundId });
    assert.equal(snapshots.length, 0);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.revision, before.revision + 1);
    assert.equal(playback[0]!.playback!.djId, b!.id);
    assert.deepEqual(playback[0]!.stage, [b!.id, a!.id]);
    const after = room.snapshot();
    assert.deepEqual(after.stage, playback[0]!.stage);
    assertStageConsistent(after);
    assert.deepEqual(
      after.users.map((user) => user.movingSince),
      before.users.map((user) => user.movingSince),
    );
    assert.deepEqual(after.users[2], before.users[2]);
    assert.deepEqual(updates, [b!.id]);
    assert.deepEqual(
      db.tracks(b!.id).map((item) => item.id),
      ['5', '2'],
    );
    playback[0]!.playback!.track.title = 'changed by callback';
    playback[0]!.stage!.reverse();
    assert.equal(room.snapshot().playback!.track.title, '2');
    assert.deepEqual(room.snapshot().stage, [b!.id, a!.id]);
    const motions = collectMotion(room);
    room.move(c!.id, { x: 450, y: 450 });
    assert.equal(snapshots.length, 0);
    assert.equal(motions[0]!.revision, before.revision + 2);
    assert.equal(room.snapshot().revision, motions[0]!.revision);
  } finally {
    close();
  }
});
test('scheduled rotation publishes one playback-only final state and advances the queue once', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const {
    room,
    db,
    guests: [a, b],
    close,
  } = setup();
  try {
    db.add(b!.id, track('5'));
    await room.join(a!.id);
    await room.join(b!.id);
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const revision = room.snapshot().revision;
    const updates: string[] = [];
    room.onPlaylistChange = (id) => updates.push(id);
    context.mock.timers.tick(60000);
    // Queue behind the scheduled transition without changing the stage.
    await room.join(b!.id);
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 0);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.revision, revision + 1);
    assert.equal(playback[0]!.playback!.djId, b!.id);
    assert.deepEqual(playback[0]!.stage, [b!.id, a!.id]);
    assert.equal(playback[0]!.resolving, false);
    assertStageConsistent(room.snapshot());
    assert.deepEqual(
      db.tracks(b!.id).map((item) => item.id),
      ['5', '2'],
    );
    assert.deepEqual(updates, [b!.id]);
  } finally {
    close();
  }
});
test('pending DJ handoff publishes an updated loading state next turn then one final state', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let pending = false;
  let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    room,
    guests: [a, b],
    close,
  } = setup({
    ...music,
    resolve: (item) => {
      if (!pending) return music.resolve(item);
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const floor = room.snapshot().users[0]!;
    await room.join(a!.id);
    await room.join(b!.id);
    pending = true;
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const revision = room.snapshot().revision;
    const leaving = room.leave(a!.id, a!.id, { x: 420, y: 450 });
    await resolving;
    assert.equal(room.snapshot().resolving, true);
    assert.equal(room.snapshot().playback, null);
    assert.equal(snapshots.length, 0);
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.resolving, true);
    assert.equal(snapshots[0]!.playback, null);
    assertFloorPosition(
      snapshots[0]!.users.find((user) => user.id === a!.id),
      floor,
    );
    assert.deepEqual(snapshots[0]!.stage, [b!.id]);
    assertStageConsistent(snapshots[0]!);
    finish({ url: 'https://example.com/2.mp3', durationMs: 60000 });
    await leaving;
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.playback!.djId, b!.id);
    assert.equal(playback[0]!.resolving, false);
    assert.equal(playback[0]!.stage, undefined);
    assert.deepEqual(
      [...snapshots, ...playback].map((state) => state.revision),
      [revision + 1, revision + 2],
    );
  } finally {
    close();
  }
});
test('motion during pending stage resolution preserves the pending full seat publication', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    room,
    guests: [a, b],
    close,
  } = setup({
    ...music,
    resolve: () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const motions = collectMotion(room);
    const revision = room.snapshot().revision;
    const joining = room.join(a!.id);
    await resolving;
    room.move(b!.id, { x: 450, y: 450 });
    assert.equal(motions.length, 1);
    assert.equal(motions[0]!.revision, revision + 1);
    assert.equal(snapshots.length, 0);
    assert.equal(playback.length, 0);
    // A sync read also must not acknowledge the still-unbroadcast seat change.
    assert.deepEqual(room.snapshot().stage, [a!.id]);
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.revision, revision + 2);
    assert.equal(snapshots[0]!.resolving, true);
    assert.deepEqual(snapshots[0]!.stage, [a!.id]);
    assertStageConsistent(snapshots[0]!);
    assert.equal(playback.length, 0);
    finish({ url: 'https://example.com/1.mp3', durationMs: 60000 });
    await joining;
    assert.equal(snapshots.length, 1);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.revision, revision + 3);
    assert.equal(playback[0]!.resolving, false);
    assert.equal(playback[0]!.playback!.djId, a!.id);
  } finally {
    close();
  }
});
for (const action of ['appearance', 'connect'] as const) {
  test(`full ${action} publication during resolution conveys stage changes and leaves completion playback-only`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const {
      room,
      guests: [a, b],
      close,
    } = setup({
      ...music,
      resolve: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const snapshots = collectSnapshots(room);
      const playback = collectPlayback(room);
      const revision = room.snapshot().revision;
      const joining = room.join(a!.id);
      await resolving;
      // Sync reads may observe the seat but cannot acknowledge its broadcast.
      assert.deepEqual(room.snapshot().stage, [a!.id]);
      assert.equal(snapshots.length, 0);
      if (action === 'appearance')
        room.updateAppearance(b!.id, { coat: 'cream', pattern: 'socks' });
      else room.connect(b!, { id: 'replacement', replaced() {} });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]!.resolving, true);
      assertStageConsistent(snapshots[0]!);
      assert.deepEqual(snapshots[0]!.stage, [a!.id]);
      context.mock.timers.tick(0);
      assert.equal(snapshots.length, 1);
      assert.equal(playback.length, 1);
      assert.equal(playback[0]!.resolving, true);
      finish({ url: 'https://example.com/1.mp3', durationMs: 60000 });
      await joining;
      assert.equal(snapshots.length, 1);
      assert.equal(playback.length, 2);
      assert.equal(playback[1]!.resolving, false);
      assert.equal(playback[1]!.playback!.djId, a!.id);
      assert.deepEqual(
        [...snapshots, ...playback].map((state) => state.revision),
        [revision + 1, revision + 2, revision + 3],
      );
    } finally {
      close();
    }
  });
}
test('removing an empty DJ after a playback loading event escalates the final event to a full snapshot', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let pending = false;
  let reject!: (error: Error) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup({
    ...music,
    resolve: (item) => {
      if (!pending || item.id !== '2') return music.resolve(item);
      started();
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
  });
  try {
    await room.join(a!.id);
    await room.join(b!.id);
    await room.join(c!.id);
    pending = true;
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const revision = room.snapshot().revision;
    const skipping = room.skip(a!.id, {
      roundId: room.snapshot().playback!.roundId,
    });
    await resolving;
    context.mock.timers.tick(0);
    assert.equal(playback.length, 1);
    assert.equal(playback[0]!.resolving, true);
    assert.deepEqual(playback[0]!.stage, [b!.id, c!.id, a!.id]);
    assert.equal(snapshots.length, 0);
    db.remove(c!.id, '3');
    reject(new MusicPlaybackError('upstream'));
    await skipping;
    assert.equal(playback.length, 1);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]!.stage, [a!.id, b!.id]);
    assert.equal(snapshots[0]!.playback!.djId, a!.id);
    assertStageConsistent(snapshots[0]!);
    assert.deepEqual(
      [playback[0]!.revision, snapshots[0]!.revision],
      [revision + 1, revision + 2],
    );
    pending = false;
    await room.skip(a!.id, { roundId: snapshots[0]!.playback!.roundId });
    assert.equal(snapshots.length, 1);
    assert.equal(playback.length, 2);
    assert.deepEqual(playback[1]!.stage, [b!.id, a!.id]);
  } finally {
    close();
  }
});
for (const failure of ['reject', 'timeout'] as const) {
  test(`pending ${failure} traversal publishes one loading and one terminal state`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let failing = false;
    const calls: string[] = [];
    const rejectors: ((error: Error) => void)[] = [];
    let started!: () => void;
    let nextStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const {
      room,
      db,
      guests: [a, b],
      close,
    } = setup({
      ...music,
      resolve: (item) => {
        if (!failing) return music.resolve(item);
        calls.push(item.id);
        started();
        return new Promise((_, reject) => {
          rejectors.push(reject);
        });
      },
    });
    try {
      await room.join(a!.id);
      await room.join(b!.id);
      failing = true;
      const before = [db.playlist(a!.id), db.playlist(b!.id)];
      const full = collectSnapshots(room);
      const snapshots = collectPlayback(room);
      const revision = room.snapshot().revision;
      const skipping = room.skip(a!.id, {
        roundId: room.snapshot().playback!.roundId,
      });
      await nextStarted;
      context.mock.timers.tick(0);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]!.resolving, true);
      assert.equal(snapshots[0]!.playback, null);
      assert.deepEqual(snapshots[0]!.stage, [b!.id, a!.id]);
      nextStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      if (failure === 'reject')
        rejectors[0]!(new MusicPlaybackError('upstream'));
      else context.mock.timers.tick(20);
      await nextStarted;
      assert.deepEqual(room.snapshot().stage, [a!.id, b!.id]);
      context.mock.timers.tick(0);
      assert.equal(snapshots.length, 1);
      if (failure === 'reject')
        rejectors[1]!(new MusicPlaybackError('upstream'));
      else context.mock.timers.tick(20);
      await skipping;
      context.mock.timers.tick(0);
      assert.deepEqual(calls, ['2', '1']);
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[1]!.resolving, false);
      assert.equal(snapshots[1]!.playback, null);
      assert.equal(snapshots[1]!.stage, undefined);
      assert.match(
        snapshots[1]!.notice!,
        failure === 'timeout' ? /超时/ : /网易云暂时无法访问/,
      );
      assert.equal(full.length, 0);
      assert.deepEqual(
        snapshots.map((state) => state.revision),
        [revision + 1, revision + 2],
      );
      assertStageConsistent(room.snapshot());
      assert.deepEqual([db.playlist(a!.id), db.playlist(b!.id)], before);
    } finally {
      close();
    }
  });
}
test('client motion broadcasts the bounded local segment and exact final stop position', (context) => {
  let now = 1000000;
  context.mock.method(Date, 'now', () => now);
  const {
    db,
    room,
    guests: [a, b],
    close,
  } = setup();
  const me = () => room.snapshot().users.find((user) => user.id === a!.id)!;
  try {
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const events = collectMotion(room);
    const other = room.snapshot().users.find((user) => user.id === b!.id)!;
    const motion = {
      x: 200.25,
      y: 400.5,
      targetX: 380.25,
      targetY: 400.5,
      facingRight: true,
      clientMoveId: 1,
    };
    const revision = room.snapshot().revision;
    room.motion(a!.id, motion);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      ...motion,
      userId: a!.id,
      revision: revision + 1,
      serverTime: now,
      movingSince: now,
      durationMs: 1000,
    });
    assert.equal(room.snapshot().revision, revision + 1);
    assert.deepEqual(me(), {
      ...me(),
      ...motion,
      movingSince: now,
      durationMs: 1000,
    });
    assert.deepEqual(
      room.snapshot().users.find((user) => user.id === b!.id),
      other,
    );
    now += 100;
    const final = {
      x: 715.125,
      y: 510.75,
      targetX: 715.125,
      targetY: 510.75,
      facingRight: false,
      clientMoveId: 2,
    };
    room.motion(a!.id, final);
    assert.deepEqual(me(), {
      ...me(),
      ...final,
      movingSince: now,
      durationMs: 0,
    });
    now += 10000;
    room.stop(a!.id);
    assert.equal(me().x, final.x);
    assert.equal(me().y, final.y);
    assert.equal(me().facingRight, final.facingRight);
    assert.equal(me().clientMoveId, undefined);
    assert.equal(events.length, 3);
    assert.equal(events[2]!.revision, revision + 3);
    assert.equal('clientMoveId' in events[2]!, false);
    assert.equal(snapshots.length, 0);
    assert.equal(playback.length, 0);
    assert.deepEqual(Object.keys(events[2]!).sort(), [
      'durationMs',
      'facingRight',
      'movingSince',
      'revision',
      'serverTime',
      'targetX',
      'targetY',
      'userId',
      'x',
      'y',
    ]);
    assert.equal(
      events[0]!.x,
      motion.x,
      'later commands do not mutate earlier deltas',
    );
    events[2]!.x = -1;
    assert.equal(
      me().x,
      final.x,
      'callback cannot mutate authoritative motion',
    );
  } finally {
    close();
  }
});
test('client motion rejects invalid segments, sequences and extra fields without changing room state', () => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  const motion = {
    x: 200,
    y: 400,
    targetX: 300,
    targetY: 450,
    facingRight: true,
    clientMoveId: 1,
  };
  try {
    const before = room.snapshot();
    const events = collectMotion(room);
    const snapshots = collectSnapshots(room);
    const invalid: unknown[] = [
      undefined,
      {},
      { ...motion, id: a!.id },
      { ...motion, clientTime: Date.now() },
      { ...motion, facingRight: 1 },
    ];
    for (const key of ['x', 'y', 'targetX', 'targetY']) {
      for (const value of [NaN, Infinity, -Infinity, '400', null])
        invalid.push({ ...motion, [key]: value });
      const horizontal = key === 'x' || key === 'targetX';
      invalid.push({
        ...motion,
        [key]: (horizontal ? SCENE.walk.left : SCENE.walk.top) - 0.01,
      });
      invalid.push({
        ...motion,
        [key]: (horizontal ? SCENE.walk.right : SCENE.walk.bottom) + 0.01,
      });
    }
    for (const clientMoveId of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      '1',
      null,
    ])
      invalid.push({ ...motion, clientMoveId });
    for (const input of invalid) {
      assert.throws(() => room.motion(a!.id, input));
      const after = room.snapshot();
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.users, before.users);
    }
    assert.equal(events.length, 0);
    assert.equal(snapshots.length, 0);
    for (const point of [
      { x: SCENE.walk.left, y: SCENE.walk.top },
      { x: SCENE.walk.right, y: SCENE.walk.bottom },
    ])
      room.motion(a!.id, {
        ...point,
        targetX: point.x,
        targetY: point.y,
        facingRight: false,
        clientMoveId: Number.MAX_SAFE_INTEGER,
      });
  } finally {
    close();
  }
});
test('client motion requires connected audience identity and legacy moves or stage transitions clear its marker', async () => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  const motion = {
    x: 200,
    y: 400,
    targetX: 300,
    targetY: 450,
    facingRight: true,
    clientMoveId: 1,
  };
  const me = () => room.snapshot().users.find((user) => user.id === a!.id)!;
  try {
    const events = collectMotion(room);
    assert.throws(() => room.motion('missing', motion), /重新连接/);
    room.disconnect(a!.id, a!.id);
    assert.throws(() => room.motion(a!.id, motion), /重新连接/);
    assert.equal(events.length, 0);
    room.connect(a!, { id: 'reconnected', replaced() {} });
    room.motion(a!.id, motion);
    room.move(a!.id, { x: 400, y: 400 });
    assert.equal(me().clientMoveId, undefined);
    room.motion(a!.id, { ...motion, clientMoveId: 2 });
    await room.join(a!.id, 'reconnected', 2);
    assert.equal(me().clientMoveId, undefined);
    const stage = me();
    assert.throws(() => room.motion(a!.id, motion), /离开舞台/);
    assert.throws(() => room.move(a!.id, { x: 400, y: 400 }), /离开舞台/);
    assert.throws(() => room.stop(a!.id), /离开舞台/);
    assert.equal(events.length, 3);
    assert.deepEqual(me(), stage);
    await room.leave(a!.id, 'reconnected', { x: 400, y: 400 });
    assert.equal(me().clientMoveId, undefined);
  } finally {
    close();
  }
});
test('stopping freezes server progress in both directions and preserves horizontal facing', (context) => {
  let now = 1000000;
  context.mock.method(Date, 'now', () => now);
  const {
    room,
    guests: [a],
    close,
  } = setup();
  const me = () => room.snapshot().users.find((user) => user.id === a!.id)!;
  try {
    const events = collectMotion(room);
    const snapshots = collectSnapshots(room);
    const revision = room.snapshot().revision;
    assert.equal(me().facingRight, false);
    for (const [targetX, facingRight] of [
      [SCENE.walk.right, true],
      [SCENE.walk.left, false],
    ] as const) {
      const start = me();
      room.move(a!.id, { x: targetX, y: start.y });
      const moving = me();
      assert.equal(moving.facingRight, facingRight);
      now += moving.durationMs / 4;
      const expectedX = start.x + (targetX - start.x) / 4;
      room.stop(a!.id);
      const stopped = me();
      assert.ok(Math.abs(stopped.x - expectedX) < 1e-8);
      assert.equal(stopped.targetX, stopped.x);
      assert.equal(stopped.targetY, stopped.y);
      assert.equal(stopped.durationMs, 0);
      assert.equal(stopped.movingSince, now);
      assert.equal(stopped.facingRight, facingRight);
      now += 10000;
      room.stop(a!.id);
      assert.equal(me().x, stopped.x);
      assert.equal(me().y, stopped.y);
      assert.equal(me().facingRight, facingRight);
      room.move(a!.id, { x: stopped.x, y: 550 });
      assert.equal(me().facingRight, facingRight);
      now += me().durationMs / 2;
      room.stop(a!.id);
      assert.equal(me().facingRight, facingRight);
    }
    assert.equal(events.length, 10);
    assert.equal(snapshots.length, 0);
    assert.deepEqual(
      events.map((event) => event.revision),
      Array.from({ length: 10 }, (_, index) => revision + index + 1),
    );
    assert.ok(events.every((event) => !('clientMoveId' in event)));
  } finally {
    close();
  }
});
test('server movement interpolation clamps elapsed time before starting and after arrival', (context) => {
  let now = 1000000;
  context.mock.method(Date, 'now', () => now);
  const {
    room,
    guests: [a],
    close,
  } = setup();
  const me = () => room.snapshot().users.find((user) => user.id === a!.id)!;
  try {
    const start = me();
    room.move(a!.id, { x: 850, y: 500 });
    now -= 100;
    room.stop(a!.id);
    assert.equal(me().x, start.x);
    assert.equal(me().y, start.y);
    room.move(a!.id, { x: 850, y: 500 });
    now += me().durationMs + 100;
    room.stop(a!.id);
    assert.equal(me().x, 850);
    assert.equal(me().y, 500);
    room.move(a!.id, { x: 150, y: 500 });
    now += me().durationMs / 4;
    room.move(a!.id, { x: 750, y: 500 });
    assert.ok(Math.abs(me().x - 675) < 1e-8);
    assert.equal(me().facingRight, true);
    room.move(a!.id, { x: me().x, y: 550 });
    assert.equal(me().facingRight, true);
  } finally {
    close();
  }
});
test('the widened floor accepts movement into both side extensions and rejects outside points', () => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    room.move(a!.id, { x: SCENE.walk.right, y: 440 });
    assert.equal(room.snapshot().users[0]!.targetX, SCENE.walk.right);
    room.move(a!.id, { x: SCENE.walk.left, y: 440 });
    assert.equal(room.snapshot().users[0]!.targetX, SCENE.walk.left);
    assert.throws(() => room.move(a!.id, { x: SCENE.width + 1, y: 440 }));
  } finally {
    close();
  }
});
test('stop requires a connected audience cat and facing survives reconnect, appearance and stage transitions', async () => {
  const {
    db,
    room,
    guests: [a],
    close,
  } = setup();
  const me = () => room.snapshot().users.find((user) => user.id === a!.id)!;
  try {
    assert.throws(() => room.stop('missing'), /重新连接/);
    room.move(a!.id, { x: SCENE.walk.right, y: 500 });
    room.stop(a!.id);
    assert.equal(me().facingRight, true);
    room.disconnect(a!.id, a!.id);
    assert.throws(() => room.stop(a!.id), /重新连接/);
    const guest = db.updateAppearance(a!.id, {
      coat: 'cream',
      pattern: 'socks',
    });
    room.connect(guest, { id: 'reconnected', replaced() {} });
    assert.equal(me().facingRight, true);
    room.updateAppearance(a!.id, { coat: 'white', pattern: 'tabby' });
    assert.equal(me().facingRight, true);
    await room.join(a!.id, 'reconnected', 2);
    const before = room.snapshot();
    assert.throws(() => room.stop(a!.id), /离开舞台/);
    assert.deepEqual(room.snapshot().users, before.users);
    assert.equal(me().facingRight, true);
    await room.leave(a!.id, 'reconnected');
    assert.equal(me().facingRight, true);
  } finally {
    close();
  }
});
test('appearance updates preserve movement, seats and playback, including reconnect', async () => {
  const {
    db,
    room,
    guests: [a, b],
    close,
  } = setup();
  try {
    await room.join(a!.id, a!.id, 2);
    room.move(b!.id, { x: 800, y: 500 });
    const before = room.snapshot();
    const appearance = { coat: 'white', pattern: 'tabby' } as const;
    const updates: number[] = [];
    room.onChange = (snapshot) => updates.push(snapshot.revision);
    for (const guest of [a!, b!]) {
      const updated = db.updateAppearance(guest.id, appearance);
      room.updateAppearance(guest.id, appearance);
      const state = room.snapshot();
      const original = before.users.find((user) => user.id === guest.id)!;
      assert.deepEqual(
        state.users.find((user) => user.id === guest.id),
        { ...original, appearance },
      );
      assert.deepEqual(state.playback, before.playback);
      assert.deepEqual(state.stage, before.stage);
      room.disconnect(guest.id, guest.id);
      room.connect(updated, { id: 'reconnected', replaced() {} });
      assert.deepEqual(
        room.snapshot().users.find((user) => user.id === guest.id),
        { ...original, appearance },
      );
    }
    assert.ok(
      updates.every(
        (revision, index) => revision === before.revision + index + 1,
      ),
    );
    const revision = room.snapshot().revision;
    room.updateAppearance('absent', appearance);
    assert.equal(room.snapshot().revision, revision);
  } finally {
    close();
  }
});
test('concurrent joins append regardless of requested seat and respect stage capacity', async () => {
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    const extra = db.createGuest('Extra').guest;
    db.add(extra.id, track('4'));
    room.connect(extra, { id: extra.id, replaced() {} });
    room.configureStage(3);
    await room.join(a!.id, a!.id, 20);
    await Promise.all([room.join(b!.id, b!.id, 1), room.join(c!.id, c!.id, 1)]);
    await assert.rejects(room.join(extra.id), /舞台已满/);
    assert.deepEqual(room.snapshot().stage, [a!.id, b!.id, c!.id]);
    assertStageConsistent(room.snapshot());
  } finally {
    close();
  }
});
test('late joins go behind the previous DJ and retain their turn when the stage is resized', async () => {
  const {
    room,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    await room.join(a!.id);
    await room.join(b!.id);
    await room.skip(a!.id, { roundId: room.snapshot().playback!.roundId });
    const playing = room.snapshot().playback;
    await room.join(c!.id);
    room.configureStage(3);
    const resized = room.snapshot();
    assert.deepEqual(resized.stage, [b!.id, a!.id, c!.id]);
    assert.deepEqual(resized.playback, playing);
    assertStageConsistent(resized);
    await room.skip(b!.id, { roundId: resized.playback!.roundId });
    assert.deepEqual(room.snapshot().stage, [a!.id, c!.id, b!.id]);
    await room.skip(a!.id, { roundId: room.snapshot().playback!.roundId });
    assert.deepEqual(room.snapshot().stage, [c!.id, b!.id, a!.id]);
    assertStageConsistent(room.snapshot());
  } finally {
    close();
  }
});
test('leaving validates legacy destinations, restores the supplied join point and advances playback only once', async () => {
  const {
    room,
    guests: [a, b],
    close,
  } = setup();
  try {
    const from = { x: 525.125, y: 503.5 };
    await room.join(a!.id, a!.id, 2, from);
    await room.join(b!.id, b!.id, 4);
    await room.join(a!.id, a!.id, undefined, { x: 850, y: 410 });
    const original = room.snapshot().playback!.roundId;
    for (const point of [
      { x: 500, y: 250 },
      { x: Infinity, y: 400 },
      { x: 500, y: 400, seat: 1 },
      { x: 500 },
    ]) {
      await assert.rejects(room.leave(a!.id, a!.id, point));
      assert.equal(room.snapshot().playback!.roundId, original);
    }
    const point = { x: 800, y: 510 };
    await room.leave(a!.id, a!.id, point);
    const state = room.snapshot();
    assertFloorPosition(
      state.users.find((user) => user.id === a!.id),
      from,
    );
    assert.equal(state.playback!.djId, b!.id);
    await assert.rejects(room.leave(a!.id, a!.id, {}), /已经在台下/);
    assert.equal(room.snapshot().playback!.roundId, state.playback!.roundId);
    assertFloorPosition(
      room.snapshot().users.find((user) => user.id === a!.id),
      from,
    );
  } finally {
    close();
  }
});
test('a join without a floor point captures the authoritative position mid-movement', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    room.motion(a!.id, {
      x: 200,
      y: 410,
      targetX: 380,
      targetY: 410,
      facingRight: true,
      clientMoveId: 1,
    });
    now += 250;
    await room.join(a!.id);
    now += 2000;
    await room.leave(a!.id);
    const user = room.snapshot().users[0]!;
    assertFloorPosition(user, { x: 245, y: 410 });
    assert.equal(user.facingRight, true);
    assert.equal(user.clientMoveId, undefined);
  } finally {
    close();
  }
});
test('force down preserves the floor point through seat rotation and reconnect and a later join saves a new point', async () => {
  const {
    room,
    guests: [a, b],
    close,
  } = setup();
  const me = () => room.snapshot().users.find((user) => user.id === a!.id);
  try {
    const from = { x: SCENE.walk.left, y: SCENE.walk.bottom };
    await room.join(a!.id, a!.id, undefined, from);
    await room.join(b!.id);
    await room.skip(a!.id, { roundId: room.snapshot().playback!.roundId });
    assert.equal(me()!.seat, 1);
    room.disconnect(a!.id, a!.id);
    room.connect(a!, { id: 'reconnected', replaced() {} });
    assert.equal(me()!.seat, 1);
    await room.forceLeave(a!.id);
    assertFloorPosition(me(), from);
    const next = { x: SCENE.walk.right, y: SCENE.walk.top };
    room.motion(a!.id, {
      ...next,
      targetX: next.x,
      targetY: next.y,
      facingRight: true,
      clientMoveId: 1,
    });
    await room.join(a!.id, 'reconnected');
    await room.leave(a!.id, 'reconnected', {});
    assertFloorPosition(me(), next);
  } finally {
    close();
  }
});
test('round robin physically rotates successful tracks once and rejects stale skips', async () => {
  const {
    db,
    room,
    guests: [a, b],
    close,
  } = setup();
  try {
    db.add(a!.id, track('4'));
    await room.join(a!.id);
    await room.join(b!.id);
    const first = room.snapshot().playback!;
    assert.equal(first.djId, a!.id);
    assert.deepEqual(
      db.tracks(a!.id).map((item) => item.id),
      ['4', '1'],
    );
    const afterFirst = db.playlist(a!.id);
    await room.join(a!.id);
    assert.deepEqual(db.playlist(a!.id), afterFirst);
    const results = await Promise.allSettled([
      room.skip(a!.id, { roundId: first.roundId }),
      room.skip(a!.id, { roundId: first.roundId }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(room.snapshot().playback!.djId, b!.id);
    await room.leave(b!.id);
    assert.equal(room.snapshot().playback!.track.id, '4');
    assert.deepEqual(
      db.tracks(a!.id).map((item) => item.id),
      ['1', '4'],
    );
    assert.equal(db.playlist(a!.id).revision, afterFirst.revision + 1);
    await assert.rejects(room.skip(a!.id, { roundId: first.roundId }));
    assert.throws(() => room.move(a!.id, { x: 400, y: 450 }));
  } finally {
    close();
  }
});
test('trial status propagates and playback advances at the preview duration', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const {
    room,
    guests: [a, b],
    close,
  } = setup({
    ...music,
    resolve: async (item) =>
      item.id === '1'
        ? {
            url: 'https://example.com/trial.mp3',
            durationMs: 30000,
            isTrial: true,
          }
        : music.resolve(item),
  });
  try {
    await room.join(a!.id);
    await room.join(b!.id);
    const first = room.snapshot().playback!;
    assert.equal(first.isTrial, true);
    assert.equal(first.durationMs, 30000);
    assert.equal(first.track.durationMs, 60000);
    context.mock.timers.tick(29999);
    assert.equal(room.snapshot().playback!.roundId, first.roundId);
    context.mock.timers.tick(1);
    // Queue behind the timer transition so the next resolution has completed.
    await room.join(b!.id);
    const next = room.snapshot().playback!;
    assert.equal(next.djId, b!.id);
    assert.equal(next.durationMs, 60000);
    assert.equal(next.isTrial, undefined);
    assert.notEqual(next.roundId, first.roundId);
  } finally {
    close();
  }
});
test('lyric offsets propagate without changing the preview resource timeline or rejecting playback', async () => {
  for (const offset of [
    undefined,
    null,
    0,
    60000,
    1500.5,
    -1,
    NaN,
    Infinity,
    '60000',
  ]) {
    const resolved = {
      url: 'https://example.com/trial.mp3',
      durationMs: 30000,
      isTrial: true,
      ...(offset === undefined ? {} : { lyricOffsetMs: offset }),
    };
    const {
      room,
      guests: [a],
      close,
    } = setup({
      ...music,
      resolve: async () =>
        resolved as Awaited<ReturnType<MusicService['resolve']>>,
    });
    try {
      await room.join(a!.id);
      const playback = room.snapshot().playback!;
      assert.ok(playback);
      assert.equal(playback.durationMs, 30000);
      assert.equal(playback.isTrial, true);
      assert.equal(playback.url, resolved.url);
      assert.equal(
        playback.lyricOffsetMs,
        offset === undefined
          ? undefined
          : typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
            ? offset
            : null,
      );
    } finally {
      close();
    }
  }
});
test('queued commands from a replaced socket cannot change the room', async () => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    room.connect(a!, { id: 'old', replaced() {} });
    const join = room.join(a!.id, 'old');
    room.connect(a!, { id: 'new', replaced() {} });
    await assert.rejects(join);
    assert.deepEqual(room.snapshot().stage, []);
  } finally {
    close();
  }
});
test('allowlisted emotes, cooldown and authoritative movement bounds', () => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    assert.throws(() => room.emote(a!.id, { id: 'nahida-1', text: 'hello' }));
    assert.throws(() => room.emote(a!.id, { id: 'custom' }));
    room.emote(a!.id, { id: 'nahida-1' });
    assert.throws(() => room.emote(a!.id, { id: 'nahida-2' }));
    assert.throws(() => room.move(a!.id, { x: 1, y: 1 }));
    const start = room.snapshot().users[0]!;
    const target = { x: start.x + SCENE.speed, y: start.y };
    room.move(a!.id, target);
    const duration = room.snapshot().users[0]!.durationMs;
    assert.ok(Math.abs(duration - 1000) < 1e-6);
    room.move(a!.id, { x: start.x, y: start.y });
    assert.ok(room.snapshot().users[0]!.x < target.x);
  } finally {
    close();
  }
});
test('all emote presets broadcast only a tiny identity-bound event without state or expiry timers', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const {
    db,
    room,
    guests: [a, b],
    close,
  } = setup();
  try {
    const events: RoomEmote[] = [];
    room.onEmote = (event) => events.push(event);
    const publish = context.mock.fn();
    room.onChange = publish;
    const timers = context.mock.method(globalThis, 'setTimeout');
    const before = room.snapshot();
    const groupsJson = (
      db.sql
        .prepare('SELECT groups_json FROM emote_catalog WHERE id=1')
        .get() as { groups_json: string }
    ).groups_json;
    const presets = (
      JSON.parse(groupsJson) as { items: { id: string }[] }[]
    ).flatMap((group) => group.items);
    for (const [index, preset] of presets.entries()) {
      room.emote(a!.id, { id: preset.id });
      assert.equal(events.length, index + 1);
      assert.deepEqual(events.at(-1), { userId: a!.id, id: preset.id });
      assert.deepEqual(room.snapshot(), { ...before, serverTime: Date.now() });
      assert.throws(
        () => room.emote(a!.id, { id: 'nahida-2' }),
        /表情发送太快/,
      );
      if (index < presets.length - 1)
        context.mock.timers.tick(EMOTE_COOLDOWN_MS);
    }
    room.emote(b!.id, { id: 'nahida-2' });
    assert.deepEqual(events.at(-1), { userId: b!.id, id: 'nahida-2' });
    const sent = [...events];
    context.mock.timers.tick(EMOTE_DURATION_MS + 1);
    assert.deepEqual(events, sent);
    assert.deepEqual(room.snapshot(), { ...before, serverTime: Date.now() });
    assert.equal(publish.mock.callCount(), 0);
    assert.equal(timers.mock.callCount(), 0);
    for (const input of [
      { id: 'custom' },
      { id: '/speech/heart.png' },
      { id: 'nahida-2', text: 'hello' },
      { id: 'nahida-2', url: 'https://example.com/sticker.png' },
      { id: 'nahida-2', userId: b!.id },
      { id: 'nahida-2', expiresAt: Date.now() + EMOTE_DURATION_MS },
    ])
      assert.throws(() => room.emote(a!.id, input));
    assert.deepEqual(events, sent);
    // Invalid payloads do not consume a valid sender's next cooldown slot.
    room.emote(a!.id, { id: 'nahida-2' });
    assert.deepEqual(events.at(-1), { userId: a!.id, id: 'nahida-2' });
  } finally {
    close();
  }
});
test('emotes reject absent, disconnected and closed identities and discard departed cooldowns', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const {
    room,
    guests: [a, b],
    close,
  } = setup();
  const events: RoomEmote[] = [];
  room.onEmote = (event) => events.push(event);
  try {
    assert.throws(() => room.emote('absent', { id: 'nahida-2' }), /重新连接/);
    room.emote(a!.id, { id: 'nahida-2' });
    room.disconnect(a!.id, a!.id);
    assert.throws(() => room.emote(a!.id, { id: 'nahida-2' }), /重新连接/);
    room.connect(a!, { id: 'reconnected', replaced() {} });
    assert.throws(() => room.emote(a!.id, { id: 'nahida-2' }), /表情发送太快/);
    room.disconnect(a!.id, 'reconnected');
    context.mock.timers.tick(15);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      room.snapshot().users.some((user) => user.id === a!.id),
      false,
    );
    room.connect(a!, { id: 'returned', replaced() {} });
    // Actual departure clears cooldown even though less than two seconds passed.
    room.emote(a!.id, { id: 'nahida-3' });
    room.emote(b!.id, { id: 'nahida-1' });
    assert.deepEqual(events, [
      { userId: a!.id, id: 'nahida-2' },
      { userId: a!.id, id: 'nahida-3' },
      { userId: b!.id, id: 'nahida-1' },
    ]);
    room.close();
    assert.equal(
      (Reflect.get(room, 'emoteTimes') as Map<string, number>).size,
      0,
    );
    assert.throws(() => room.emote(a!.id, { id: 'nahida-2' }), /重新连接/);
    context.mock.timers.tick(EMOTE_DURATION_MS + EMOTE_COOLDOWN_MS);
    assert.equal(events.length, 3);
  } finally {
    close();
  }
});
test('a full audience spawns across the six-seat width even in a one-seat room and reconnect retains position', async (context) => {
  const db = new Store(':memory:'),
    room = new Room(db, music, { stageCapacity: 1 });
  try {
    const guests = Array.from(
      { length: ROOM_CAPACITY },
      (_, index) => db.createGuest(`Cat${index}`).guest,
    );
    const samples = [0, 0, 0, 0, 0.99, 0.99];
    let seed = 0x12345678;
    const random = context.mock.method(Math, 'random', () => {
      if (samples.length) return samples.shift()!;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    guests.forEach((guest) =>
      room.connect(guest, { id: guest.id, replaced() {} }),
    );
    const { users } = room.snapshot();
    const seats = stageSeatXs(STAGE_CAPACITY);
    const left = seats[0]!;
    const right = seats.at(-1)!;
    for (const user of users) {
      assert.ok(user.x >= left && user.x <= right);
      assert.ok(user.y >= SCENE.walk.top && user.y <= SCENE.walk.bottom);
      assertFloorPosition(user, user);
    }
    assert.equal(
      new Set(users.map(({ x, y }) => `${x},${y}`)).size,
      ROOM_CAPACITY,
    );
    const first = guests[0]!;
    const before = users[0]!;
    assertFloorPosition(before, { x: left, y: SCENE.walk.top });
    // The second cat first samples the same point and retries.
    assertFloorPosition(users[1], {
      x: left + (right - left) * 0.99,
      y: SCENE.walk.top + (SCENE.walk.bottom - SCENE.walk.top) * 0.99,
    });
    const calls = random.mock.callCount();
    room.disconnect(first.id, first.id);
    room.connect(first, { id: 'reconnected', replaced() {} });
    assert.equal(random.mock.callCount(), calls);
    assertFloorPosition(room.snapshot().users[0], before);
    db.add(first.id, track('1'));
    await room.join(first.id);
    await room.leave(first.id);
    assert.equal(random.mock.callCount(), calls);
    assertFloorPosition(room.snapshot().users[0], before);
  } finally {
    room.close();
    db.close();
  }
});
test('reconnection retains seat and replaces one live connection; expiry advances', async () => {
  const {
    room,
    guests: [a, b],
    close,
  } = setup();
  let replaced = 0;
  try {
    room.connect(a!, {
      id: 'old',
      replaced: () => {
        replaced++;
      },
    });
    await room.join(a!.id);
    await room.join(b!.id);
    const round = room.snapshot().playback!.roundId;
    room.connect(a!, { id: 'new', replaced() {} });
    assert.equal(replaced, 1);
    room.disconnect(a!.id, 'old');
    assert.equal(room.snapshot().users[0]!.connected, true);
    room.disconnect(a!.id, 'new');
    room.connect(a!, { id: 'again', replaced() {} });
    assert.equal(room.snapshot().playback!.roundId, round);
    room.disconnect(a!.id, 'again');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      room.snapshot().users.some((user) => user.id === a!.id),
      false,
    );
    assert.equal(room.snapshot().playback!.djId, b!.id);
  } finally {
    close();
  }
});
test('failed and timed out resolutions stop after one traversal, new join can restart', async () => {
  let calls = 0;
  const {
    room,
    guests: [a, b],
    close,
  } = setup({
    ...music,
    resolve: async () => {
      calls++;
      throw new Error('unavailable');
    },
  });
  try {
    await room.join(a!.id);
    assert.equal(calls, 1);
    assert.equal(room.snapshot().playback, null);
    await room.join(b!.id);
    assert.equal(calls, 3);
    assert.equal(room.snapshot().resolving, false);
    assert.ok(room.snapshot().notice);
  } finally {
    close();
  }
  const timed = setup({ ...music, resolve: () => new Promise(() => {}) });
  try {
    await timed.room.join(timed.guests[0]!.id);
    assert.equal(timed.room.snapshot().resolving, false);
    assert.match(timed.room.snapshot().notice!, /本轮尝试.*解析超时.*稍后/);
    assert.doesNotMatch(
      timed.room.snapshot().notice!,
      /权限|登录|暂无可播放地址/,
    );
  } finally {
    timed.close();
  }
});
test('unavailable notice describes only this attempt; rejoining retries the head until explicitly reordered', async () => {
  const calls: string[] = [];
  const {
    room,
    db,
    guests: [a],
    close,
  } = setup({
    ...music,
    resolve: async (item) => {
      calls.push(item.id);
      if (item.id === '1') throw new MusicPlaybackError('unavailable');
      return music.resolve(item);
    },
  });
  try {
    db.remove(a!.id, '1');
    db.add(a!.id, { ...track('1'), title: '失败\n歌曲\u202e' });
    db.add(a!.id, { ...track('9'), title: '尚未尝试的可播放歌曲' });
    await room.join(a!.id);
    const notice = room.snapshot().notice!;
    assert.deepEqual(calls, ['1']);
    assert.match(notice, /本轮尝试的《失败歌曲》/);
    assert.match(notice, /暂无可播放地址.*登录.*权限/);
    assert.match(notice, /换歌.*调整歌单.*下台重新上台/);
    assert.doesNotMatch(notice, /尚未尝试|全部|整个歌单|\n|\u202e/);
    const beforeRetry = db.playlist(a!.id);
    await room.leave(a!.id);
    await room.join(a!.id);
    assert.deepEqual(calls, ['1', '1']);
    assert.deepEqual(db.playlist(a!.id), beforeRetry);
    await room.leave(a!.id);
    db.order(a!.id, ['9', '1']);
    await room.join(a!.id);
    assert.deepEqual(calls, ['1', '1', '9']);
    assert.equal(room.snapshot().playback!.track.id, '9');
    assert.equal(room.snapshot().notice, null);
  } finally {
    close();
  }
});
test('upstream and unknown failures use distinct safe retry notices', async () => {
  for (const failure of [
    new MusicPlaybackError('upstream'),
    new Error('MUSIC_U=private-cookie https://private.example'),
  ]) {
    const {
      room,
      guests: [a],
      close,
    } = setup({
      ...music,
      resolve: async () => {
        throw failure;
      },
    });
    try {
      await room.join(a!.id);
      const notice = room.snapshot().notice!;
      assert.match(notice, /本轮尝试.*稍后.*下台重新上台/);
      assert.match(
        notice,
        failure instanceof MusicPlaybackError
          ? /网易云暂时无法访问/
          : /播放地址解析失败/,
      );
      assert.doesNotMatch(notice, /MUSIC_U|private|权限|登录|暂无可播放地址/);
    } finally {
      close();
    }
  }
});
test('mixed failed attempts retain reasons without claiming whole playlists were tested', async () => {
  const calls: string[] = [];
  const {
    room,
    db,
    guests: [a, b],
    close,
  } = setup({
    ...music,
    resolve: async (item) => {
      calls.push(item.id);
      throw new MusicPlaybackError(
        item.id === '2' ? 'upstream' : 'unavailable',
      );
    },
  });
  try {
    await room.join(a!.id);
    db.add(a!.id, { ...track('9'), title: '未尝试的歌曲' });
    await room.join(b!.id);
    assert.deepEqual(calls, ['1', '1', '2']);
    const notice = room.snapshot().notice!;
    assert.match(notice, /本轮尝试的 2 首歌曲/);
    assert.match(notice, /有歌曲暂无可播放地址/);
    assert.match(notice, /网易云暂时无法访问/);
    assert.match(notice, /稍后/);
    assert.doesNotMatch(notice, /未尝试的歌曲|全部|整个歌单/);
    assert.equal(room.snapshot().playback, null);
    assert.equal(room.snapshot().resolving, false);
  } finally {
    close();
  }
});
test('failed URL resolution and invalid playback results leave every queue and revision unchanged', async () => {
  for (const resolve of [
    async () => {
      throw new MusicPlaybackError('unavailable');
    },
    async () => {
      throw new MusicPlaybackError('upstream');
    },
    () => new Promise<never>(() => {}),
    async () => ({ url: 'javascript:alert(1)', durationMs: 60000 }),
    async () => ({ url: 'not a URL', durationMs: 60000 }),
    async () => ({ url: 'https://example.com/song.mp3', durationMs: NaN }),
    async () => ({ url: 'https://example.com/song.mp3', durationMs: 0 }),
    async () => ({ url: 'https://example.com/song.mp3', durationMs: -1 }),
    async () => ({ url: 'https://example.com/song.mp3', durationMs: Infinity }),
  ]) {
    const calls: string[] = [];
    const {
      room,
      db,
      guests: [a, b],
      close,
    } = setup({
      ...music,
      resolve: async (item) => {
        calls.push(item.id);
        return resolve();
      },
    });
    try {
      db.add(a!.id, track('4'));
      db.add(b!.id, track('5'));
      const beforeA = db.playlist(a!.id),
        beforeB = db.playlist(b!.id);
      const updates: string[] = [];
      room.onPlaylistChange = (id) => updates.push(id);
      await room.join(a!.id);
      await room.join(b!.id);
      assert.deepEqual(calls, ['1', '1', '2']);
      assert.equal(room.snapshot().playback, null);
      assert.equal(room.snapshot().resolving, false);
      assert.deepEqual(db.playlist(a!.id), beforeA);
      assert.deepEqual(db.playlist(b!.id), beforeB);
      assert.deepEqual(updates, []);
    } finally {
      close();
    }
  }
});
test('successful resolution rotates the selected song within current edits without restoring deleted songs', async () => {
  for (const edit of [
    'reorder',
    'add',
    'remove',
    'replace-all',
    'already-last',
  ] as const) {
    let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const {
      room,
      db,
      guests: [a],
      close,
    } = setup(
      {
        ...music,
        resolve: () => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      { disconnectGraceMs: 15, resolveTimeoutMs: 1000 },
    );
    try {
      db.add(a!.id, track('4'));
      db.add(a!.id, track('5'));
      const updates: { id: string; ids: string[]; revision: number }[] = [];
      room.onPlaylistChange = (id, state) =>
        updates.push({
          id,
          ids: state.ids,
          revision: state.revision,
        });
      const joining = room.join(a!.id);
      await resolving;
      assert.equal(db.firstTrack(a!.id)!.id, '1');
      if (edit === 'reorder') {
        db.order(a!.id, ['5', '1', '4']);
        db.add(a!.id, track('6'));
      } else if (edit === 'add') {
        db.add(a!.id, track('6'));
      } else if (edit === 'already-last') {
        db.order(a!.id, ['4', '5', '1']);
      } else {
        db.remove(a!.id, '1');
        if (edit === 'replace-all') {
          db.remove(a!.id, '4');
          db.remove(a!.id, '5');
          db.add(a!.id, track('6'));
        }
      }
      const beforeResolved = db.playlist(a!.id);
      finish({ url: 'https://example.com/song.mp3', durationMs: 60000 });
      await joining;
      assert.equal(room.snapshot().playback!.track.id, '1');
      const expected =
        edit === 'reorder'
          ? ['5', '4', '6', '1']
          : edit === 'add'
            ? ['4', '5', '6', '1']
            : edit === 'already-last'
              ? ['4', '5', '1']
              : edit === 'remove'
                ? ['4', '5']
                : ['6'];
      assert.deepEqual(
        db.tracks(a!.id).map((track) => track.id),
        expected,
      );
      assert.equal(
        db.playlist(a!.id).revision,
        beforeResolved.revision + (['reorder', 'add'].includes(edit) ? 1 : 0),
      );
      assert.deepEqual(
        updates,
        ['reorder', 'add'].includes(edit)
          ? [
              {
                id: a!.id,
                ids: expected,
                revision: db.playlist(a!.id).revision,
              },
            ]
          : [],
      );
    } finally {
      close();
    }
  }
});
test('changing playlists during resolution keeps the pending song and rotates its original queue', async () => {
  let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    room,
    db,
    guests: [a],
    close,
  } = setup(
    {
      ...music,
      resolve: (item) => {
        if (item.id !== '1') return music.resolve(item);
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    { disconnectGraceMs: 15, resolveTimeoutMs: 1000 },
  );
  try {
    const id = a!.id;
    db.add(id, track('4'));
    db.createPlaylist(id);
    for (const trackId of ['7', '1', '8']) db.add(id, track(trackId));
    db.selectPlaylist(id, 1);

    const updates: PlaylistOrder[] = [];
    room.onPlaylistChange = (_id, state) => updates.push(state);
    const joining = room.join(id);
    await resolving;
    const selected = db.selectPlaylist(id, 2);
    finish(await music.resolve(track('1')));
    await joining;

    const playing = room.snapshot().playback!;
    assert.equal(playing.track.id, '1');
    assert.deepEqual(
      db.tracks(id, 1).map((item) => item.id),
      ['4', '1'],
    );
    assert.deepEqual(db.playlist(id), {
      ...selected,
      revision: selected.revision + 1,
    });
    assert.deepEqual(updates, []);

    await room.skip(id, { roundId: playing.roundId });
    assert.equal(room.snapshot().playback!.track.id, '7');
    assert.deepEqual(updates, [
      {
        ids: ['1', '8', '7'],
        slot: 2,
        revision: selected.revision + 2,
      },
    ]);
  } finally {
    close();
  }
});
test('selecting an empty playlist during playback leaves the DJ seated until the next turn', async () => {
  const {
    room,
    db,
    guests: [a, b],
    close,
  } = setup();
  try {
    const id = a!.id;
    const floor = room.snapshot().users[0]!;
    await room.join(id);
    await room.join(b!.id);
    const playing = room.snapshot().playback!;

    db.createPlaylist(id);
    assert.deepEqual(room.snapshot().playback, playing);
    assert.deepEqual(room.snapshot().stage, [id, b!.id]);

    await room.skip(id, { roundId: playing.roundId });
    assert.equal(room.snapshot().playback!.djId, b!.id);
    assert.deepEqual(room.snapshot().stage, [b!.id, id]);
    await room.skip(b!.id, { roundId: room.snapshot().playback!.roundId });
    const state = room.snapshot();
    assert.equal(state.playback!.djId, b!.id);
    assert.deepEqual(state.stage, [b!.id]);
    assertFloorPosition(
      state.users.find((user) => user.id === id),
      floor,
    );
    assert.deepEqual(
      db.tracks(id, 1).map((item) => item.id),
      ['1'],
    );
  } finally {
    close();
  }
});
test('closing during resolution cancels the pending loading notification and leaves the queue untouched', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    room,
    db,
    guests: [a],
    close,
  } = setup(
    {
      ...music,
      resolve: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    { disconnectGraceMs: 15, resolveTimeoutMs: 1000 },
  );
  try {
    db.add(a!.id, track('4'));
    const before = db.playlist(a!.id);
    let updates = 0;
    room.onPlaylistChange = () => updates++;
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    const revision = room.snapshot().revision;
    const joining = room.join(a!.id);
    await resolving;
    assert.equal(room.snapshot().resolving, true);
    assert.equal(snapshots.length, 0);
    const pendingTimers = [
      ...(Reflect.get(room, 'pendingTimers') as Set<
        ReturnType<typeof setTimeout>
      >),
    ];
    assert.equal(pendingTimers.length, 2);
    const clear = context.mock.method(globalThis, 'clearTimeout');
    room.close();
    for (const timer of pendingTimers)
      assert.ok(clear.mock.calls.some((call) => call.arguments[0] === timer));
    context.mock.timers.tick(0);
    assert.equal(snapshots.length, 0);
    finish({ url: 'https://example.com/song.mp3', durationMs: 60000 });
    await joining;
    context.mock.timers.tick(1000);
    assert.deepEqual(db.playlist(a!.id), before);
    assert.equal(room.snapshot().playback, null);
    assert.equal(updates, 0);
    assert.equal(playback.length, 0);
    assert.equal(room.snapshot().revision, revision);
    assert.equal(snapshots.length, 0);
    assert.equal(
      (Reflect.get(room, 'pendingTimers') as Set<ReturnType<typeof setTimeout>>)
        .size,
      0,
    );
  } finally {
    close();
  }
});
test('empty playlist rejected and 30 room users enforce capacity', async () => {
  const db = new Store(':memory:'),
    room = new Room(db, music);
  try {
    for (let index = 0; index < 30; index++) {
      const guest = db.createGuest(`Cat${index}`).guest;
      room.connect(guest, { id: guest.id, replaced() {} });
      if (!index) await assert.rejects(room.join(guest.id));
    }
    const extra = db.createGuest('Extra').guest;
    assert.throws(() => room.connect(extra, { id: extra.id, replaced() {} }));
    assert.equal(room.snapshot().users.length, 30);
  } finally {
    room.close();
    db.close();
  }
});
test('an emptied upcoming playlist removes that DJ and keeps the next turn', async () => {
  const {
    room,
    db,
    guests: [a, b, c],
    close,
  } = setup();
  try {
    const bFloor = room.snapshot().users[1]!;
    await room.join(a!.id);
    await room.join(b!.id);
    await room.join(c!.id);
    db.remove(b!.id, '2');
    const snapshots = collectSnapshots(room);
    const playback = collectPlayback(room);
    await room.skip(a!.id, { roundId: room.snapshot().playback!.roundId });
    assert.equal(room.snapshot().playback!.djId, c!.id);
    assert.deepEqual(room.snapshot().stage, [c!.id, a!.id]);
    assert.equal(snapshots.length, 1);
    assertStageConsistent(snapshots[0]!);
    assertFloorPosition(
      snapshots[0]!.users.find((user) => user.id === b!.id),
      bFloor,
    );
    assert.equal(playback.length, 0);
  } finally {
    close();
  }
});
test('shutdown disconnects cannot recreate grace timers', (context) => {
  const {
    room,
    guests: [a],
    close,
  } = setup();
  try {
    const motions = collectMotion(room);
    const revision = room.snapshot().revision;
    room.close();
    const timer = context.mock.method(globalThis, 'setTimeout');
    room.disconnect(a!.id, a!.id);
    assert.equal(timer.mock.callCount(), 0);
    assert.throws(() => room.connect(a!, { id: 'late', replaced() {} }));
    assert.throws(() => room.move(a!.id, { x: 600, y: 450 }));
    assert.throws(() => room.stop(a!.id));
    assert.throws(() =>
      room.motion(a!.id, {
        x: 400,
        y: 400,
        targetX: 450,
        targetY: 450,
        facingRight: true,
        clientMoveId: 1,
      }),
    );
    assert.equal(motions.length, 0);
    assert.equal(room.snapshot().revision, revision);
  } finally {
    close();
  }
});

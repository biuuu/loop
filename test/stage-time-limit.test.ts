import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Store } from '../src/server/db.js';
import { Room } from '../src/server/room.js';
import type { Guest, Track } from '../src/shared/contracts.js';

const START = 1_000_000;
const floor = { x: 700, y: 495 };

function setup(
  context: TestContext,
  durationMs: number,
  waitToResolve?: (track: Track) => Promise<void>,
) {
  const timers = context.mock.timers;
  timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  const db = new Store(':memory:');
  const rooms: Room[] = [];
  context.after(() => {
    for (const room of rooms) room.close();
    db.close();
  });
  const a = db.createGuest('DJ A').guest;
  const b = db.createGuest('DJ B').guest;
  const roomId = db.createRoom(a.id, 'Stage', 'cozy').id;
  const track = (id: string): Track => ({
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: '',
    cover: '',
    durationMs,
  });
  db.add(a.id, track('1'));
  db.add(b.id, track('2'));
  const resolved: string[] = [];
  return {
    a,
    b,
    timers,
    resolved,
    open(stageTimeLimitMinutes: number) {
      const room = new Room(
        db,
        {
          search: async () => [],
          detail: async (id) => track(id),
          resolve: async (track) => {
            resolved.push(track.id);
            await waitToResolve?.(track);
            return { url: `https://example.com/${track.id}.mp3`, durationMs };
          },
        },
        { roomId, stageTimeLimitMinutes },
      );
      rooms.push(room);
      return room;
    },
    connect(room: Room, guest: Guest, id = guest.id) {
      room.connect(guest, { id, replaced() {} });
    },
    load() {
      const checkpoint = db.roomCheckpoints(Date.now())[0]?.checkpoint;
      assert.ok(checkpoint);
      return checkpoint;
    },
  };
}

test('a zero-minute limit plays one track per join and returns the finished DJ to their floor spot', async (context) => {
  const { a, b, connect, open, resolved, timers } = setup(context, 20_000);
  const room = open(0);
  connect(room, a);
  connect(room, b);
  await room.join(a.id, a.id, undefined, floor);
  await room.join(b.id);
  const snapshots = context.mock.method(room, 'onChange');
  const playbackUpdates = context.mock.method(room, 'onPlaybackChange');

  timers.tick(19_999);
  assert.deepEqual(room.snapshot().stage, [a.id, b.id]);
  timers.tick(1);
  await nextTurn();

  const afterA = room.snapshot();
  assert.deepEqual(afterA.stage, [b.id]);
  assert.equal(afterA.playback?.djId, b.id);
  const { x, y, seat } = afterA.users.find(({ id }) => id === a.id)!;
  assert.deepEqual({ x, y, seat }, { ...floor, seat: null });
  assert.equal(snapshots.mock.callCount(), 1);
  assert.equal(playbackUpdates.mock.callCount(), 0);

  await room.skip(a.id, { roundId: afterA.playback!.roundId }, a.id, true);
  assert.deepEqual(room.snapshot().stage, []);
  assert.equal(room.snapshot().playback, null);
  assert.deepEqual(resolved, ['1', '2']);
  assert.equal(snapshots.mock.callCount(), 2);
  assert.equal(playbackUpdates.mock.callCount(), 0);
});

test('elapsed stage time follows the DJ through rotations and reconnects and only their own track removes them', async (context) => {
  const { a, b, connect, load, open, timers } = setup(context, 30_000);
  const room = open(1);
  connect(room, a);
  connect(room, b);
  await room.join(a.id);
  await room.join(b.id);

  timers.tick(30_000);
  await nextTurn();
  assert.deepEqual(room.snapshot().stage, [b.id, a.id]);
  assert.equal(room.snapshot().playback?.djId, b.id);

  timers.tick(20_000);
  room.disconnect(a.id, a.id);
  timers.tick(9_999);
  connect(room, a, 'a-reconnect');
  await room.join(a.id, 'a-reconnect');
  assert.equal(
    load().members.find(({ id }) => id === a.id)?.stageJoinedAt,
    START,
  );
  assert.deepEqual(room.snapshot().stage, [b.id, a.id]);

  timers.tick(1);
  await nextTurn();
  assert.deepEqual(room.snapshot().stage, [a.id]);
  const playback = room.snapshot().playback!;
  assert.equal(playback.djId, a.id);
  assert.equal(
    load().members.find(({ id }) => id === b.id)?.stageJoinedAt,
    undefined,
  );

  await room.skip(a.id, { roundId: playback.roundId }, 'a-reconnect');
  assert.deepEqual(room.snapshot().stage, []);
});

test('shortening an active stage limit waits for the track to finish and a new join starts a fresh stay', async (context) => {
  const { a, connect, load, open, timers } = setup(context, 90_000);
  const room = open(120);
  connect(room, a);
  await room.join(a.id);
  const first = room.snapshot();
  timers.tick(60_000);
  room.configureStageTimeLimit(1);
  assert.equal(room.snapshot().revision, first.revision);
  assert.deepEqual(room.snapshot().playback, first.playback);
  assert.deepEqual(room.snapshot().stage, [a.id]);

  timers.tick(30_000);
  await nextTurn();
  assert.deepEqual(room.snapshot().stage, []);
  await room.join(a.id);
  assert.equal(load().members[0]?.stageJoinedAt, START + 90_000);
  await room.skip(a.id, { roundId: room.snapshot().playback!.roundId });
  assert.deepEqual(room.snapshot().stage, [a.id]);
  assert.equal(room.snapshot().playback?.djId, a.id);
});

for (const durationMs of [59_999, 60_000]) {
  test(`restart evaluates an expired ${durationMs} ms track using its original completion time`, async (context) => {
    const { a, b, connect, load, open, resolved, timers } = setup(
      context,
      durationMs,
    );
    const original = open(1);
    connect(original, a);
    connect(original, b);
    await original.join(a.id, a.id, undefined, floor);
    await original.join(b.id);
    const checkpoint = load();
    original.close();
    timers.tick(70_000);

    const restored = open(1);
    restored.restoreCheckpoint(checkpoint);
    assert.deepEqual(
      restored.snapshot().stage,
      durationMs < 60_000 ? [b.id, a.id] : [b.id],
    );
    assert.equal(restored.snapshot().playback, null);
    assert.deepEqual(resolved, ['1']);
    if (durationMs === 60_000) {
      const { x, y, seat } = restored
        .snapshot()
        .users.find(({ id }) => id === a.id)!;
      assert.deepEqual({ x, y, seat }, { ...floor, seat: null });
    }
    connect(restored, b);
    await nextTurn();
    assert.equal(restored.snapshot().playback?.djId, b.id);
  });
}

test('a stage member restored from an older checkpoint starts timing at its save time', async (context) => {
  const { a, connect, load, open, timers } = setup(context, 70_000);
  const original = open(1);
  connect(original, a);
  await original.join(a.id);
  timers.tick(40_000);
  original.checkpoint();
  const checkpoint = load();
  delete checkpoint.members[0]!.stageJoinedAt;
  original.close();
  timers.tick(20_000);

  const restored = open(1);
  restored.restoreCheckpoint(checkpoint);
  connect(restored, a);
  assert.equal(load().members[0]?.stageJoinedAt, START + 40_000);
  const firstRoundId = restored.snapshot().playback?.roundId;
  assert.equal(firstRoundId, checkpoint.playback?.roundId);
  timers.tick(10_000);
  await nextTurn();
  assert.deepEqual(restored.snapshot().stage, [a.id]);
  assert.equal(restored.snapshot().playback?.djId, a.id);
  assert.notEqual(restored.snapshot().playback?.roundId, firstRoundId);
});

test('a failed URL resolution leaves the DJ on stage even under the one-track limit', async (context) => {
  const { a, connect, load, open, resolved } = setup(
    context,
    20_000,
    async () => {
      throw new Error('Failed to resolve');
    },
  );
  const room = open(0);
  connect(room, a);
  await room.join(a.id);
  assert.equal(room.snapshot().playback, null);
  assert.deepEqual(room.snapshot().stage, [a.id]);
  assert.equal(load().members[0]?.stageJoinedAt, START);
  assert.deepEqual(resolved, ['1']);
});

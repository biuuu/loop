import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/server/db.js';
import { Room } from '../src/server/room.js';
import { catSleepDelay } from '../src/shared/cat-activity.js';
import type { Guest, Track } from '../src/shared/contracts.js';

const track = (id: string): Track => ({
  id,
  title: `Track ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const db = new Store(':memory:');
  const dj = db.createGuest('DJ').guest;
  const listener = db.createGuest('Listener').guest;
  const roomId = db.createRoom(dj.id, 'Checkpoint', 'cozy').id;
  const resolved: string[] = [];
  const rooms: Room[] = [];
  const connect = (room: Room, guest: Guest) =>
    room.connect(guest, { id: guest.id, replaced() {} });
  const load = () => {
    const checkpoint = db.roomCheckpoints(Date.now())[0]?.checkpoint;
    assert.ok(checkpoint);
    return checkpoint;
  };
  function open(waitForTrack?: (id: string) => Promise<void> | undefined) {
    const room = new Room(
      db,
      {
        search: async () => [],
        detail: async (id) => track(id),
        resolve: async (item) => {
          resolved.push(item.id);
          await waitForTrack?.(item.id);
          return {
            url: `https://example.com/${item.id}.mp3`,
            durationMs: 10_000,
            isTrial: true,
            lyricOffsetMs: 35_000,
          };
        },
      },
      { roomId },
    );
    rooms.push(room);
    return room;
  }
  db.add(dj.id, track('1'));
  db.add(dj.id, track('2'));
  db.add(listener.id, track('3'));
  return {
    db,
    dj,
    listener,
    resolved,
    open,
    connect,
    load,
    close() {
      for (const room of rooms) room.close();
      db.close();
    },
  };
}

test('checkpoints sample movement once and load current public profiles without broadcasting', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { db, dj, listener, open, connect, load, close } = fixture();
  try {
    const room = open();
    connect(room, dj);
    connect(room, listener);
    room.motion(dj.id, {
      x: 700,
      y: 500,
      targetX: 700,
      targetY: 500,
      facingRight: true,
      clientMoveId: 1,
    });
    await room.join(dj.id, dj.id, undefined, { x: 700, y: 495 });
    const initial = load();
    room.motion(listener.id, {
      x: 200,
      y: 400,
      targetX: 380,
      targetY: 400,
      facingRight: true,
      clientMoveId: 2,
    });
    assert.deepEqual(load(), initial);
    context.mock.timers.tick(500);
    const save = context.mock.method(db, 'saveRoomCheckpoint');
    room.checkpoint();
    room.checkpoint();
    assert.equal(save.mock.callCount(), 1);
    const checkpoint = load();
    assert.deepEqual(checkpoint.members, [
      {
        id: dj.id,
        x: 700,
        y: 495,
        facingRight: true,
        stageJoinedAt: 1_000_000,
      },
      {
        id: listener.id,
        x: 290,
        y: 400,
        facingRight: true,
        sleepAt: 1_001_000 + catSleepDelay(listener.id),
      },
    ]);

    room.close();
    db.rename(dj.id, 'New DJ');
    const appearance = { coat: 'black', pattern: 'solid' } as const;
    db.updateAppearance(dj.id, appearance);

    const restored = open();
    const snapshots = context.mock.method(restored, 'onChange');
    const playbackUpdates = context.mock.method(restored, 'onPlaybackChange');
    restored.restoreCheckpoint(checkpoint);
    const snapshot = restored.snapshot();
    assert.equal(snapshot.users[0]!.nickname, 'New DJ');
    assert.deepEqual(snapshot.users[0]!.appearance, appearance);
    assert.equal(snapshot.users[0]!.sleepAt, undefined);
    assert.equal(snapshot.users[1]!.sleepAt, checkpoint.members[1]!.sleepAt);
    assert.equal(snapshots.mock.callCount(), 0);
    assert.equal(playbackUpdates.mock.callCount(), 0);
  } finally {
    close();
  }
});

test('checkpoint restore preserves expired sleep deadlines and supplies them for legacy audience members', (context) => {
  const now = 1_000_000;
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const { db, dj, listener, open, connect, load, close } = fixture();
  try {
    const legacy = db.createGuest('Legacy audience').guest;
    const room = open();
    const position = { x: 500, y: 450, facingRight: false };
    const expired = now - 500;
    room.restoreCheckpoint({
      savedAt: now - 100,
      members: [
        { ...position, id: dj.id, sleepAt: expired },
        { ...position, id: listener.id, sleepAt: expired },
        { ...position, id: legacy.id },
      ],
      stage: [dj.id],
      playback: null,
    });
    const sleepDeadlines = [undefined, expired, now + catSleepDelay(legacy.id)];
    assert.deepEqual(
      room.snapshot().users.map(({ sleepAt }) => sleepAt),
      sleepDeadlines,
    );
    assert.deepEqual(
      load().members.map(({ sleepAt }) => sleepAt),
      sleepDeadlines,
    );
    connect(room, listener);
    assert.equal(
      room.snapshot().users.find(({ id }) => id === listener.id)?.sleepAt,
      expired,
    );
  } finally {
    close();
  }
});

test('restored playback finishes in wall time while the room waits for a connection and the old grace deadline stays in force', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { dj, listener, resolved, open, connect, load, close } = fixture();
  try {
    const original = open();
    connect(original, dj);
    connect(original, listener);
    await original.join(dj.id);
    await original.join(listener.id);
    original.disconnect(listener.id, listener.id);
    const checkpoint = load();
    original.close();
    context.mock.timers.tick(6_000);

    let restored = open();
    restored.restoreCheckpoint(checkpoint);
    const reserved = load();
    assert.deepEqual(
      reserved.members.map(({ reconnectUntil }) => reconnectUntil),
      [1_036_000, 1_030_000],
    );
    restored.close();
    context.mock.timers.tick(2_000);
    restored = open();
    restored.restoreCheckpoint(reserved);
    assert.deepEqual(load().members, reserved.members);
    context.mock.timers.tick(1_999);
    assert.deepEqual(restored.snapshot().playback, checkpoint.playback);
    context.mock.timers.tick(1);
    await nextTurn();
    assert.equal(restored.snapshot().playback, null);
    assert.deepEqual(load().stage, [listener.id, dj.id]);
    assert.deepEqual(resolved, ['1']);

    context.mock.timers.tick(19_999);
    assert.equal(restored.hasMember(listener.id), true);
    context.mock.timers.tick(1);
    assert.equal(restored.hasMember(listener.id), false);
    assert.deepEqual(load().stage, [dj.id]);
    connect(restored, dj);
    await nextTurn();
    assert.deepEqual(resolved, ['1', '2']);
    assert.equal(restored.snapshot().playback!.track.id, '2');
  } finally {
    close();
  }
});

test('a skipped round is removed from the checkpoint before its successor resolves', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const { dj, listener, resolved, open, connect, load, close } = fixture();
  try {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const original = open((id) => {
      if (id !== '3') return;
      announce();
      return new Promise(() => {});
    });
    connect(original, dj);
    connect(original, listener);
    await original.join(dj.id);
    await original.join(listener.id);
    const firstRound = original.snapshot().playback!.roundId;
    const skipping = original.skip(dj.id, { roundId: firstRound });
    await started;
    const checkpoint = load();
    assert.equal(checkpoint.playback, null);
    assert.deepEqual(checkpoint.stage, [listener.id, dj.id]);
    original.close();
    await skipping;

    const restored = open();
    restored.restoreCheckpoint(checkpoint);
    assert.equal(restored.snapshot().resolving, false);
    assert.deepEqual(resolved, ['1', '3']);
    connect(restored, dj);
    await nextTurn();
    assert.deepEqual(resolved, ['1', '3', '3']);
    assert.equal(restored.snapshot().playback!.track.id, '3');
    assert.notEqual(restored.snapshot().playback!.roundId, firstRound);
  } finally {
    close();
  }
});

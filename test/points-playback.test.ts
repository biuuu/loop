import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Room } from '../src/server/room.js';
import { Store } from '../src/server/db.js';
import {
  type Guest,
  type MusicService,
  type Track,
} from '../src/shared/contracts.js';

const track: Track = {
  id: '1',
  title: 'Points fixture',
  artist: '',
  album: '',
  cover: '',
  durationMs: 600_000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: track.durationMs,
  }),
};

function setup(context: TestContext, start = Date.UTC(2026, 10, 26, 12)) {
  let now = start;
  context.mock.method(Date, 'now', () => now);
  const db = new Store(':memory:');
  const dj = db.createGuest('DJ').guest;
  const other = db.createGuest('Other DJ').guest;
  const roomId = db.createRoom(dj.id, 'Points room', 'cozy').id;
  const rooms: Room[] = [];
  db.add(dj.id, track);
  db.add(other.id, track);
  context.after(() => {
    for (const room of rooms) room.close();
    db.close();
  });
  return {
    db,
    dj,
    other,
    roomId,
    tick(ms: number) {
      now += ms;
    },
    open(id = roomId, service = music) {
      const room = new Room(db, service, { roomId: id });
      rooms.push(room);
      return room;
    },
    connect(room: Room, guest: Guest, id = guest.id) {
      room.connect(guest, { id, replaced() {} });
    },
  };
}

test('credits the current DJ at a checkpoint without counting queue time, resolution or seeks', async (context) => {
  const { db, dj, other, roomId, tick, open, connect } = setup(context);
  let beginResolution!: () => void;
  const resolving = new Promise<void>((resolve) => {
    beginResolution = resolve;
  });
  let finishResolution!: () => void;
  const resolved = new Promise<void>((resolve) => {
    finishResolution = resolve;
  });
  const room = open(roomId, {
    ...music,
    async resolve() {
      beginResolution();
      await resolved;
      return music.resolve(track);
    },
  });
  connect(room, dj);
  connect(room, other);
  const join = room.join(dj.id, dj.id);
  await resolving;
  tick(90_000);
  room.checkpoint();
  assert.equal(db.points(dj.id).daily.playedMs, 0);
  finishResolution();
  await join;
  await room.join(other.id, other.id);
  const roundId = room.snapshot().playback!.roundId;
  const awarded = context.mock.method(room, 'onPointsAwarded');

  tick(10_000);
  await room.seek(dj.id, { roundId, positionMs: 250_000 }, dj.id);
  assert.equal(db.points(dj.id).daily.playedMs, 10_000);
  tick(170_000);
  room.checkpoint();
  assert.equal(db.points(dj.id).daily.playedMs, 180_000);
  assert.equal(db.points(dj.id).balance, 5);
  tick(1);
  const revision = room.snapshot().revision;
  room.checkpoint();
  room.checkpoint();
  assert.equal(room.snapshot().revision, revision);
  assert.equal(db.points(dj.id).balance, 6);
  assert.equal(db.points(other.id).daily.playedMs, 0);
  assert.deepEqual(
    awarded.mock.calls.map(({ arguments: args }) => args),
    [[dj.id, 1]],
  );

  await room.skip(dj.id, { roundId }, dj.id);
  assert.equal(room.snapshot().playback?.djId, other.id);
  tick(15_000);
  await room.leave(other.id, other.id);
  assert.equal(db.points(other.id).daily.playedMs, 15_000);
});

test('credits time across rooms and midnight while excluding the disconnect gap', async (context) => {
  const start = Date.UTC(2026, 10, 26, 15, 59);
  const { db, dj, other, tick, open, connect } = setup(context, start);
  const old = open();
  connect(old, dj);
  await old.join(dj.id, dj.id);
  tick(80_000);
  old.disconnect(dj.id, dj.id);
  assert.equal(db.points(dj.id, start).daily.playedMs, 60_000);
  assert.equal(db.points(dj.id).daily.playedMs, 20_000);
  tick(10_000);
  connect(old, dj, 'reconnect');
  tick(50_000);
  await old.removeMember(dj.id, 'reconnect');
  assert.equal(db.points(dj.id).daily.playedMs, 70_000);

  const next = open(db.createRoom(other.id, 'Another room', 'cozy').id);
  connect(next, dj);
  await next.join(dj.id, dj.id);
  tick(110_001);
  next.checkpoint();
  assert.equal(db.points(dj.id).daily.awarded, true);
  assert.equal(db.points(dj.id).balance, 6);
});

test('room recovery resumes accrual after reconnection and stops at a media failure', async (context) => {
  const { db, dj, tick, open, connect } = setup(context);
  const room = open();
  connect(room, dj);
  await room.join(dj.id, dj.id);
  tick(65_000);
  room.checkpoint();
  const saved = db.roomCheckpoints(Date.now())[0]!.checkpoint;
  room.close();
  tick(48_000);

  const restored = open();
  restored.restoreCheckpoint(saved);
  tick(10_000);
  restored.checkpoint();
  assert.equal(db.points(dj.id).daily.playedMs, 65_000);
  connect(restored, dj);
  const { roundId } = restored.snapshot().playback!;
  assert.equal(roundId, saved.playback!.roundId);
  tick(20_000);
  await restored.mediaFailed(dj.id, { roundId }, dj.id);
  tick(200_000);
  restored.checkpoint();
  assert.equal(restored.snapshot().playback, null);
  assert.equal(db.points(dj.id).daily.playedMs, 85_000);
  assert.equal(db.points(dj.id).balance, 5);
});

test('a failed settlement is retried without interrupting rotation or crediting past the song end', async (context) => {
  const { db, dj, other, roomId, tick, open, connect } = setup(context);
  const room = open(roomId, {
    ...music,
    resolve: async () => ({
      url: 'https://example.com/song.mp3',
      durationMs: 45_000,
    }),
  });
  connect(room, dj);
  connect(room, other);
  await room.join(dj.id, dj.id);
  await room.join(other.id, other.id);
  const log = context.mock.method(console, 'error', () => {});
  const record = db.recordDjPlayback.bind(db);
  const writes = context.mock.method(
    db,
    'recordDjPlayback',
    (id: string, from: number, to: number) => {
      if (log.mock.callCount() === 0)
        throw new Error('temporary SQLite failure');
      return record(id, from, to);
    },
  );
  tick(150_000);
  await room.skip(dj.id, { roundId: room.snapshot().playback!.roundId }, dj.id);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(writes.mock.callCount(), 2);
  assert.equal(room.snapshot().playback?.djId, other.id);
  assert.equal(db.points(dj.id).daily.playedMs, 45_000);
  assert.equal(db.points(other.id).daily.playedMs, 0);
});

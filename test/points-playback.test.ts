import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
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

test('credits the DJ and waiting members once without counting resolution or seeks', async (context) => {
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
  assert.equal(db.points(other.id).daily.playedMs, 0);
  finishResolution();
  await join;
  await room.join(other.id, other.id);
  const roundId = room.snapshot().playback!.roundId;
  const awarded = context.mock.method(room, 'onPointsAwarded');

  tick(10_000);
  await room.seek(dj.id, { roundId, positionMs: 250_000 }, dj.id);
  assert.equal(db.points(dj.id).daily.playedMs, 10_000);
  assert.equal(db.points(other.id).daily.playedMs, 10_000);
  tick(170_000);
  room.checkpoint();
  assert.equal(db.points(dj.id).daily.playedMs, 180_000);
  assert.equal(db.points(dj.id).balance, 5);
  assert.equal(db.points(other.id).balance, 5);
  tick(1);
  const revision = room.snapshot().revision;
  room.checkpoint();
  room.checkpoint();
  assert.equal(room.snapshot().revision, revision);
  assert.equal(db.points(dj.id).balance, 6);
  assert.equal(db.points(other.id).balance, 6);
  assert.deepEqual(
    awarded.mock.calls.map(({ arguments: args }) => args),
    [
      [dj.id, 1],
      [other.id, 1],
    ],
  );

  await room.skip(dj.id, { roundId }, dj.id);
  assert.equal(room.snapshot().playback?.djId, other.id);
  tick(15_000);
  await room.leave(other.id, other.id);
  assert.equal(db.points(other.id).daily.playedMs, 180_001);
  assert.equal(awarded.mock.callCount(), 2);
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
  const { db, dj, other, tick, open, connect } = setup(context);
  const room = open();
  connect(room, dj);
  connect(room, other);
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
  assert.equal(db.points(other.id).daily.playedMs, 65_000);
  connect(restored, other);
  tick(5_000);
  connect(restored, dj);
  const { roundId } = restored.snapshot().playback!;
  assert.equal(roundId, saved.playback!.roundId);
  tick(20_000);
  await restored.mediaFailed(dj.id, { roundId }, dj.id);
  tick(200_000);
  restored.checkpoint();
  assert.equal(restored.snapshot().playback, null);
  assert.equal(db.points(dj.id).daily.playedMs, 85_000);
  assert.equal(db.points(other.id).daily.playedMs, 90_000);
  assert.equal(db.points(dj.id).balance, 5);
});

test('audience listening starts on entry and excludes time disconnected across socket replacements', async (context) => {
  const { db, dj, other, tick, open, connect } = setup(context);
  const room = open();
  connect(room, dj);
  await room.join(dj.id, dj.id);
  tick(40_000);
  connect(room, other);
  assert.equal(db.points(other.id).daily.playedMs, 0);
  tick(30_000);
  connect(room, other, 'replacement');
  room.disconnect(other.id, other.id);
  tick(20_000);
  room.disconnect(other.id, 'replacement');
  assert.equal(db.points(other.id).daily.playedMs, 50_000);
  room.disconnect(dj.id, dj.id);
  tick(25_000);
  room.checkpoint();
  assert.equal(db.points(other.id).daily.playedMs, 50_000);
  connect(room, other, 'reconnect');
  tick(40_000);
  await room.removeMember(other.id, 'reconnect');
  assert.equal(db.points(other.id).daily.playedMs, 90_000);
  assert.equal(db.points(dj.id).daily.playedMs, 90_000);
});

test('a failed settlement can retry after natural rotation without crediting past the song end', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
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
  let fail = true;
  context.mock.method(
    db,
    'recordDjPlayback',
    (id: string, from: number, to: number) => {
      if (fail && id === dj.id) throw new Error('temporary SQLite failure');
      return record(id, from, to);
    },
  );
  tick(150_000);
  context.mock.timers.tick(45_000);
  await immediate();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(room.snapshot().playback?.djId, other.id);
  assert.equal(db.points(dj.id).daily.playedMs, 0);
  assert.equal(db.points(other.id).daily.playedMs, 45_000);
  fail = false;
  db.retryPendingPlayback(room.onPointsAwarded);
  assert.equal(db.points(dj.id).daily.playedMs, 45_000);
  assert.equal(db.points(other.id).daily.playedMs, 45_000);
});

test('a listening interval from a former room is retried before a newer room contributes time', async (context) => {
  const { db, dj, other, tick, open, connect } = setup(context);
  const old = open();
  connect(old, dj);
  connect(old, other);
  await old.join(dj.id, dj.id);
  const log = context.mock.method(console, 'error', () => {});
  const record = db.recordDjPlayback.bind(db);
  let fail = true;
  context.mock.method(
    db,
    'recordDjPlayback',
    (id: string, from: number, to: number) => {
      if (fail && id === other.id) throw new Error('temporary SQLite failure');
      return record(id, from, to);
    },
  );
  tick(40_000);
  await old.removeMember(other.id);
  assert.equal(db.points(dj.id).daily.playedMs, 40_000);
  assert.equal(db.points(other.id).daily.playedMs, 0);
  old.close();

  tick(5_000);
  const next = open(db.createRoom(other.id, 'Next points room', 'cozy').id);
  connect(next, other);
  await next.join(other.id, other.id);
  tick(90_000);
  next.checkpoint();
  assert.equal(log.mock.callCount(), 2);
  assert.equal(db.points(other.id).daily.playedMs, 0);

  fail = false;
  tick(50_000);
  next.checkpoint();
  assert.equal(db.points(other.id).daily.playedMs, 180_000);
  assert.equal(db.points(other.id).balance, 5);
  tick(1);
  next.checkpoint();
  assert.equal(db.points(other.id).balance, 6);
});

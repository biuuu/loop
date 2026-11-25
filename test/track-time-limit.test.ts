import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Store } from '../src/server/db.js';
import { Room } from '../src/server/room.js';
import type { Guest, MusicService, Track } from '../src/shared/contracts.js';

const MINUTE = 60_000;
const START = 1_000_000;
const source = (id: string, durationMs: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs,
});
const resolveTrack: MusicService['resolve'] = async (track) => ({
  url: `https://example.com/${track.id}.mp3`,
  durationMs: track.durationMs,
});

function setup(context: TestContext, resolve = resolveTrack) {
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
  const roomId = db.createRoom(a.id, 'Track limit', 'cozy').id;
  return {
    a,
    b,
    db,
    timers,
    open(options?: {
      stageTimeLimitMinutes?: number;
      trackTimeLimitMinutes?: number;
    }) {
      const room = new Room(
        db,
        {
          search: async () => [],
          detail: async (id) => source(id, 0),
          resolve,
        },
        { roomId, ...options },
      );
      rooms.push(room);
      return room;
    },
    connect(room: Room, guest: Guest) {
      room.connect(guest, { id: guest.id, replaced() {} });
    },
    load() {
      const checkpoint = db.roomCheckpoints(Date.now())[0]?.checkpoint;
      assert.ok(checkpoint);
      return checkpoint;
    },
  };
}

test('the default ten-minute cap rotates a long song and completes the DJ turn normally', async (context) => {
  const { a, b, db, timers, open, connect, load } = setup(context);
  const long = source('1', 20 * MINUTE);
  db.add(a.id, long);
  db.add(a.id, source('2', MINUTE));
  db.add(b.id, source('3', MINUTE));
  const room = open({ stageTimeLimitMinutes: 10 });
  connect(room, a);
  connect(room, b);
  const floor = { x: 700, y: 495 };
  await room.join(a.id, a.id, undefined, floor);
  await room.join(b.id);

  const first = room.snapshot().playback!;
  assert.equal(first.durationMs, 10 * MINUTE);
  assert.deepEqual(first.track, long);
  assert.equal(first.url, 'https://example.com/1.mp3');
  assert.deepEqual(db.playlistOrder(a.id).ids, ['2', '1']);
  assert.deepEqual(load().playback, first);
  await assert.rejects(
    room.seek(a.id, { roundId: first.roundId, positionMs: 10 * MINUTE + 1 }),
    /播放进度超出范围/,
  );

  timers.tick(10 * MINUTE - 1);
  assert.deepEqual(room.snapshot().playback, first);
  timers.tick(1);
  await nextTurn();
  const after = room.snapshot();
  assert.deepEqual(after.stage, [b.id]);
  assert.equal(after.playback?.track.id, '3');
  assert.equal(after.playback?.startedAt, START + 10 * MINUTE);
  const { x, y, seat } = after.users.find(({ id }) => id === a.id)!;
  assert.deepEqual({ x, y, seat }, { ...floor, seat: null });
});

test('the cap uses the resolved duration of short tracks and previews', async (context) => {
  const preview = {
    durationMs: 25_000,
    isTrial: true,
    lyricOffsetMs: 75_000,
  } as const;
  const { a, db, open, connect, timers } = setup(context, async (track) => ({
    ...(await resolveTrack(track)),
    ...(track.id === '2' ? preview : {}),
  }));
  const short = source('1', 30_000);
  const trial = source('2', 17 * MINUTE);
  db.add(a.id, short);
  db.add(a.id, trial);
  const room = open();
  connect(room, a);
  await room.join(a.id);
  assert.equal(room.snapshot().playback?.durationMs, short.durationMs);
  timers.tick(short.durationMs);
  await nextTurn();
  const playback = room.snapshot().playback!;
  assert.deepEqual(playback.track, trial);
  assert.equal(playback.durationMs, preview.durationMs);
  assert.equal(playback.isTrial, true);
  assert.equal(playback.lyricOffsetMs, preview.lyricOffsetMs);
  timers.tick(preview.durationMs);
  await nextTurn();
  assert.equal(room.snapshot().playback?.track.id, short.id);
});

test('zero uses the full resolved duration and edits take effect on the next start', async (context) => {
  const durationMs = 18 * MINUTE;
  const { a, db, open, connect, timers } = setup(context, async (track) => ({
    ...(await resolveTrack(track)),
    durationMs,
  }));
  db.add(a.id, source('1', 20 * MINUTE));
  const room = open({ trackTimeLimitMinutes: 0 });
  connect(room, a);
  await room.join(a.id);
  const first = room.snapshot();
  assert.equal(first.playback?.durationMs, durationMs);

  timers.tick(MINUTE);
  room.configureTrackTimeLimit(1);
  assert.equal(room.snapshot().revision, first.revision);
  assert.deepEqual(room.snapshot().playback, first.playback);
  timers.tick(durationMs - MINUTE - 1);
  assert.equal(room.snapshot().playback?.roundId, first.playback?.roundId);
  timers.tick(1);
  await nextTurn();
  assert.notEqual(room.snapshot().playback?.roundId, first.playback?.roundId);
  assert.equal(room.snapshot().playback?.durationMs, MINUTE);
});

test('a restored round keeps its saved cap until the next round starts', async (context) => {
  const { a, db, open, connect, timers, load } = setup(context);
  db.add(a.id, source('1', 20 * MINUTE));
  const original = open({ trackTimeLimitMinutes: 4 });
  connect(original, a);
  await original.join(a.id);
  timers.tick(15_000);
  original.checkpoint();
  const checkpoint = load();
  assert.equal(checkpoint.playback?.durationMs, 4 * MINUTE);
  original.close();
  timers.tick(5_000);

  const restored = open({ trackTimeLimitMinutes: 1 });
  restored.restoreCheckpoint(checkpoint);
  connect(restored, a);
  assert.deepEqual(restored.snapshot().playback, checkpoint.playback);
  timers.tick(4 * MINUTE - 20_000 - 1);
  assert.deepEqual(restored.snapshot().playback, checkpoint.playback);
  timers.tick(1);
  await nextTurn();
  assert.notEqual(
    restored.snapshot().playback?.roundId,
    checkpoint.playback?.roundId,
  );
  assert.equal(restored.snapshot().playback?.durationMs, MINUTE);
});

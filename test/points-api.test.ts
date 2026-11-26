import assert from 'node:assert/strict';
import { test } from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { createServer } from '../src/server/app.js';
import { RAGDOLL_APPEARANCE } from '../src/shared/appearance.js';
import {
  DAILY_DJ_THRESHOLD_MS,
  type PointsAwarded,
  type PointsState,
} from '../src/shared/points.js';
import type {
  MusicService,
  RoomSnapshot,
  Track,
} from '../src/shared/contracts.js';

const track: Track = {
  id: '1',
  title: 'Points fixture',
  artist: '',
  cover: '',
  album: '',
  durationMs: 360_000,
};
const music: MusicService = {
  search: async () => [track],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: track.durationMs,
  }),
};

function socketEvent<T>(socket: Socket, event: string) {
  return new Promise<T>((resolve, reject) => {
    const receive = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`No ${event} event received`));
    }, 2000);
    socket.once(event, receive);
  });
}

test('only the authenticated account can spend its points and use its unlocked preset', async (context) => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  context.after(() => app.close());
  const a = db.createGuest('Alice');
  const b = db.createGuest('Bob');
  const alice = { cookie: `loop_guest=${a.token}` };
  const bob = { cookie: `loop_guest=${b.token}` };
  const points = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/api/me/points',
      headers,
    });
  const unlock = (headers: Record<string, string>, pattern: string) =>
    app.inject({
      method: 'POST',
      url: '/api/me/appearance/unlocks',
      headers,
      payload: { pattern },
    });
  const equip = (headers: Record<string, string>) =>
    app.inject({
      method: 'PATCH',
      url: '/api/me/appearance',
      headers,
      payload: RAGDOLL_APPEARANCE,
    });
  assert.equal((await points({})).statusCode, 401);
  assert.equal((await unlock({}, 'ragdoll')).statusCode, 401);
  const initial = await points(alice);
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers['cache-control'], 'no-store');
  assert.equal(initial.json<PointsState>().balance, 5);
  assert.deepEqual(initial.json<PointsState>().unlockedPresets, []);
  assert.equal((await equip(alice)).statusCode, 403);
  assert.equal((await unlock(alice, 'solid')).statusCode, 400);
  assert.equal(
    (await unlock({ ...alice, origin: 'https://unrelated.example' }, 'ragdoll'))
      .statusCode,
    403,
  );

  const [paid, repeated] = await Promise.all([
    unlock(alice, 'ragdoll'),
    unlock(alice, 'ragdoll'),
  ]);
  for (const response of [paid, repeated]) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<PointsState>().balance, 0);
    assert.deepEqual(response.json<PointsState>().unlockedPresets, ['ragdoll']);
  }
  assert.equal((await unlock(alice, 'cow')).statusCode, 409);
  assert.deepEqual(db.guestById(a.guest.id).appearance, a.guest.appearance);
  assert.equal((await equip(alice)).statusCode, 200);
  assert.deepEqual(db.guestById(a.guest.id).appearance, RAGDOLL_APPEARANCE);
  assert.equal((await equip(bob)).statusCode, 403);
  assert.equal((await points(bob)).json<PointsState>().balance, 5);
  const competing = await Promise.all([
    unlock(bob, 'cow'),
    unlock(bob, 'seal_point'),
  ]);
  assert.deepEqual(
    competing.map(({ statusCode }) => statusCode).sort(),
    [200, 409],
  );
  const remaining = (await points(bob)).json<PointsState>();
  assert.equal(remaining.balance, 0);
  assert.equal(remaining.unlockedPresets.length, 1);
});

test('a daily award is delivered privately to its DJ without a room snapshot', async (context) => {
  let now = Date.UTC(2026, 10, 26, 12);
  context.mock.method(Date, 'now', () => now);
  const { app, db, room } = await createServer({
    dbPath: ':memory:',
    music,
    singleRoom: true,
  });
  context.after(() => app.close());
  let url: string;
  try {
    url = await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    context.skip('Sandbox forbids TCP listeners');
    return;
  }
  const dj = db.createGuest('DJ');
  const listener = db.createGuest('Listener');
  db.add(dj.guest.id, track);
  db.recordDjPlayback(dj.guest.id, now - DAILY_DJ_THRESHOLD_MS, now);
  async function open(token: string) {
    const socket = connect(url, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      extraHeaders: { cookie: `loop_guest=${token}` },
    });
    context.after(() => {
      socket.disconnect();
    });
    const snapshot = socketEvent(socket, 'room:snapshot');
    socket.connect();
    await snapshot;
    return socket;
  }
  const own = await open(dj.token);
  const other = await open(listener.token);
  assert.equal(
    (await own.timeout(1000).emitWithAck('stage:join', {})).ok,
    true,
  );
  const initial = (await other
    .timeout(1000)
    .emitWithAck('room:sync')) as RoomSnapshot;
  assert.equal(initial.playback?.djId, dj.guest.id);

  let roomUpdates = 0;
  let otherAwards = 0;
  let ownAwards = 0;
  own.on('points:awarded', () => ownAwards++);
  other.on('points:awarded', () => otherAwards++);
  other.on('room:snapshot', () => roomUpdates++);
  other.on('playback:updated', () => roomUpdates++);
  const notification = socketEvent<PointsAwarded>(own, 'points:awarded');
  // Keep the real transport's ping deadline valid while the last millisecond accrues.
  now++;
  room.checkpoint();
  room.checkpoint();
  const award = await notification;
  const synced = (await other
    .timeout(1000)
    .emitWithAck('room:sync')) as RoomSnapshot;
  assert.equal(award.awarded, 1);
  assert.equal(award.points.balance, 6);
  assert.equal(award.points.daily.awarded, true);
  assert.equal(ownAwards, 1);
  assert.equal(otherAwards, 0);
  assert.equal(roomUpdates, 0);
  const playingDj = synced.users.find(({ id }) => id === dj.guest.id);
  assert.ok(playingDj);
  assert.equal('points' in playingDj, false);
});

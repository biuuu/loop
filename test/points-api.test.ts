import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { createServer } from '../src/server/app.js';
import {
  BLACK_CAT_APPEARANCE,
  RAGDOLL_APPEARANCE,
} from '../src/shared/appearance.js';
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
      payload: BLACK_CAT_APPEARANCE,
    });
  assert.equal((await points({})).statusCode, 401);
  assert.equal((await unlock({}, 'black_cat')).statusCode, 401);
  const initial = await points(alice);
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers['cache-control'], 'no-store');
  assert.equal(initial.json<PointsState>().balance, 5);
  assert.deepEqual(initial.json<PointsState>().unlockedPresets, []);
  assert.equal((await equip(alice)).statusCode, 403);
  assert.equal((await unlock(alice, 'solid')).statusCode, 400);
  assert.equal((await unlock(alice, 'tortoiseshell')).statusCode, 400);
  assert.equal(
    (
      await unlock(
        { ...alice, origin: 'https://unrelated.example' },
        'black_cat',
      )
    ).statusCode,
    403,
  );

  const [paid, repeated] = await Promise.all([
    unlock(alice, 'black_cat'),
    unlock(alice, 'black_cat'),
  ]);
  for (const response of [paid, repeated]) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<PointsState>().balance, 0);
    assert.deepEqual(response.json<PointsState>().unlockedPresets, [
      'black_cat',
    ]);
  }
  assert.equal((await unlock(alice, 'cow')).statusCode, 409);
  assert.deepEqual(db.guestById(a.guest.id).appearance, a.guest.appearance);
  assert.equal((await equip(alice)).statusCode, 200);
  assert.deepEqual(db.guestById(a.guest.id).appearance, BLACK_CAT_APPEARANCE);
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

test('development can use locked coats at zero balance without granting production unlocks', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-dev-coats-'));
  const dbPath = join(root, 'loop.sqlite');
  let server = await createServer({ dbPath, music });
  context.after(async () => {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { guest, token } = server.db.createGuest('Developer');
  server.db.unlockAppearance(guest.id, 'calico');
  const headers = { cookie: `loop_guest=${token}` };
  const equip = () =>
    server.app.inject({
      method: 'PATCH',
      url: '/api/me/appearance',
      headers,
      payload: RAGDOLL_APPEARANCE,
    });
  const points = async () =>
    (
      await server.app.inject({
        url: '/api/me/points',
        headers,
      })
    ).json<PointsState>();
  assert.equal((await equip()).statusCode, 403);

  await server.app.close();
  server = await createServer({ dbPath, music, freeSpecialCoats: true });
  const developmentPoints = await points();
  assert.equal(developmentPoints.freeSpecialCoats, true);
  assert.equal(developmentPoints.balance, 0);
  assert.equal((await equip()).statusCode, 200);
  assert.deepEqual(
    server.db.guestById(guest.id).appearance,
    RAGDOLL_APPEARANCE,
  );
  const unlock = await server.app.inject({
    method: 'POST',
    url: '/api/me/appearance/unlocks',
    headers,
    payload: { pattern: 'ragdoll' },
  });
  assert.equal(unlock.statusCode, 200);
  assert.deepEqual(unlock.json<PointsState>(), developmentPoints);

  await server.app.close();
  server = await createServer({ dbPath, music, freeSpecialCoats: true });
  assert.deepEqual(
    server.db.guestById(guest.id).appearance,
    RAGDOLL_APPEARANCE,
  );
  await server.app.close();
  server = await createServer({
    dbPath,
    music,
    buildId: 'test-build',
    freeSpecialCoats: true,
  });
  assert.deepEqual(server.db.guestById(guest.id).appearance, {
    coat: 'white',
    pattern: 'solid',
  });
  const productionPoints = await points();
  assert.equal(productionPoints.freeSpecialCoats, undefined);
  assert.equal(productionPoints.balance, 0);
  assert.deepEqual(productionPoints.unlockedPresets, ['calico']);
  assert.equal((await equip()).statusCode, 403);
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

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { Socket } from 'socket.io-client';
import { useRoom } from '../src/client/room';
import { CALICO_APPEARANCE } from '../src/shared/appearance';
import {
  COAT_UNLOCK_COST,
  DAILY_DJ_THRESHOLD_MS,
  INITIAL_POINTS,
  type PointsState,
} from '../src/shared/points';

function points(): PointsState {
  return {
    balance: INITIAL_POINTS,
    unlockedPresets: [],
    daily: { date: '2026-11-26', playedMs: 0, awarded: false },
    revision: 1,
  };
}

function fixture(context: TestContext) {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  let guest = { id: 'a', nickname: 'A' };
  const requests: {
    path: string;
    init?: RequestInit;
    reply: (response: Response) => void;
  }[] = [];
  context.mock.method(
    globalThis,
    'fetch',
    async (path: string, init?: RequestInit) => {
      if (path === '/api/me') return Response.json({ guest });
      if (path === '/api/playlist')
        return Response.json({ slot: 1, count: 1, tracks: [], revision: 0 });
      if (path === '/api/emotes')
        return Response.json({ enabled: true, groups: [], revision: 1 });
      return new Promise<Response>((reply) => {
        requests.push({ path, init, reply });
      });
    },
  );
  return {
    room,
    requests,
    setGuest(id: string) {
      guest = { id, nickname: id.toUpperCase() };
    },
  };
}

test('wardrobe reads cannot undo a newer unlock, newer same-day progress, or the next day', async (context) => {
  const { room, requests } = fixture(context);
  await room.initialize();
  const before = points();
  const delayed = room.loadPoints();
  const unlock = room.unlockAppearance('calico');
  assert.equal(requests[0]?.path, '/api/me/points');
  assert.equal(requests[0]?.init?.cache, 'no-store');
  assert.equal(requests[1]?.path, '/api/me/appearance/unlocks');
  assert.equal(requests[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    pattern: 'calico',
  });
  const after: PointsState = {
    ...before,
    balance: before.balance - COAT_UNLOCK_COST,
    unlockedPresets: ['calico'],
    revision: 2,
  };
  requests[1]!.reply(Response.json(after));
  assert.equal(await unlock, true);
  assert.equal(room.guest?.appearance, undefined);
  requests[0]!.reply(Response.json(before));
  await delayed;
  assert.deepEqual(room.points, after);

  const updated: PointsState = {
    ...after,
    balance: after.balance + 1,
    revision: 3,
    daily: {
      ...after.daily,
      playedMs: DAILY_DJ_THRESHOLD_MS + 1,
      awarded: true,
    },
  };
  async function receive(state: PointsState) {
    const load = room.loadPoints();
    requests.at(-1)!.reply(Response.json(state));
    await load;
  }
  await receive(updated);
  await receive({ ...updated, daily: { ...updated.daily, playedMs: 10_000 } });
  await receive({ ...updated, daily: { ...updated.daily, awarded: false } });
  assert.deepEqual(room.points, updated);

  const nextDay: PointsState = {
    ...updated,
    daily: { date: '2026-11-27', playedMs: 0, awarded: false },
  };
  await receive(nextDay);
  await receive(updated);
  assert.deepEqual(room.points, nextDay);

  const save = room.setAppearance(CALICO_APPEARANCE);
  const saveRequest = requests.at(-1)!;
  assert.equal(saveRequest.path, '/api/me/appearance');
  assert.equal(saveRequest.init?.method, 'PATCH');
  saveRequest.reply(
    Response.json({
      guest: { id: 'a', nickname: 'A', appearance: CALICO_APPEARANCE },
    }),
  );
  assert.equal(await save, true);
  assert.deepEqual(room.guest?.appearance, CALICO_APPEARANCE);
});

test('late wardrobe responses are ignored after leaving a room or changing identity', async (context) => {
  const { room, requests, setGuest } = fixture(context);
  await room.initialize();
  const initial = room.loadPoints();
  requests[0]!.reply(Response.json(points()));
  await initial;

  const staleGet = room.loadPoints();
  await room.leave();
  requests[1]!.reply(Response.json({ ...points(), balance: 99, revision: 99 }));
  assert.equal(await staleGet, false);
  assert.deepEqual(room.points, points());

  const staleUnlock = room.unlockAppearance('calico');
  const staleSave = room.setAppearance(CALICO_APPEARANCE);
  setGuest('b');
  await room.initialize();
  assert.equal(room.points, null);
  requests[2]!.reply(Response.json({ error: 'late failure' }, { status: 409 }));
  requests[3]!.reply(
    Response.json({
      guest: { id: 'a', nickname: 'A', appearance: CALICO_APPEARANCE },
    }),
  );
  assert.equal(await staleUnlock, false);
  assert.equal(await staleSave, false);
  assert.equal(room.points, null);
  assert.equal(room.guest?.id, 'b');
  assert.equal(room.guest?.appearance, undefined);
});

test('a delayed private award after midnight shows once while newer points stay intact', async (context) => {
  const { room, requests, setGuest } = fixture(context);
  let transport!: Socket;
  context.mock.method(Socket.prototype, 'connect', function (this: Socket) {
    transport = this;
    this.connected = true;
    for (const listener of this.listeners('connect')) listener();
    return this;
  });
  context.mock.method(Socket.prototype, 'emit', function (this: Socket) {
    return this;
  });
  context.mock.method(Socket.prototype, 'disconnect', function (this: Socket) {
    this.connected = false;
    return this;
  });
  await room.initialize();
  await room.connect('first');
  const receiveAward = transport.listeners('points:awarded')[0]!;
  const awarded: PointsState = {
    ...points(),
    balance: INITIAL_POINTS + 1,
    daily: { date: '2026-11-27', playedMs: 0, awarded: false },
    revision: 2,
  };
  const newest: PointsState = {
    ...awarded,
    balance: awarded.balance - COAT_UNLOCK_COST,
    unlockedPresets: ['cow'],
    revision: 3,
  };
  const load = room.loadPoints();
  requests.at(-1)!.reply(Response.json(newest));
  await load;

  receiveAward({ points: awarded, awarded: 1 });
  assert.equal(room.pointsReward, '累计听歌或放歌，获得 1 积分');
  assert.deepEqual(room.points, newest);
  room.pointsReward = '';
  receiveAward({ points: awarded, awarded: 1 });
  assert.equal(room.pointsReward, '');

  setGuest('b');
  await room.initialize();
  receiveAward({ points: awarded, awarded: 1 });
  assert.equal(room.pointsReward, '');
  assert.equal(room.points, null);
  await room.connect('second');
  transport.listeners('points:awarded')[0]!({ points: awarded, awarded: 1 });
  assert.equal(room.pointsReward, '累计听歌或放歌，获得 1 积分');
  assert.deepEqual(room.points, awarded);
});

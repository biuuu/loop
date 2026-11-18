import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createPinia, setActivePinia } from 'pinia';
import { Server, type Socket } from 'socket.io';
import {
  createNavigation,
  roomPath,
  routeFor,
  type Route,
} from '../src/client/navigation';
import { createDirectoryPoller } from '../src/client/room-directory';
import { useRoom } from '../src/client/room';
import type {
  ClientEvents,
  ServerEvents,
  RoomSnapshot,
  RoomInfo,
} from '../src/shared/contracts';

test('room links stay stable and history back delivers its explicit route', () => {
  assert.deepEqual(routeFor('/admin/netease'), { kind: 'admin-netease' });
  assert.deepEqual(routeFor('/admin/netease/'), { kind: 'admin-netease' });
  assert.deepEqual(routeFor('/admin/emotes'), { kind: 'admin-emotes' });
  assert.deepEqual(routeFor('/admin/emotes/'), { kind: 'admin-emotes' });
  assert.deepEqual(routeFor('/123'), { kind: 'room', roomId: '123' });
  assert.deepEqual(routeFor('/123/'), { kind: 'room', roomId: '123' });
  assert.equal(roomPath('123'), '/123');
  assert.equal(roomPath('old-uuid', 123), '/123');
  assert.deepEqual(routeFor('/9007199254740991'), {
    kind: 'room',
    roomId: '9007199254740991',
  });
  for (const path of [
    '/0',
    '/01',
    '/-1',
    '/1.5',
    '/1e3',
    '/123/a',
    '/9007199254740992',
    '/api',
    '/assets',
  ])
    assert.deepEqual(routeFor(path), { kind: 'directory' });
  assert.deepEqual(routeFor('/rooms/a%20b'), { kind: 'room', roomId: 'a b' });
  assert.equal(roomPath('a b'), '/rooms/a%20b');
  for (const path of [
    '/',
    '/rooms/',
    '/rooms/a/b',
    '/rooms/%E0%A4%A',
    '/rooms/a%2Fb',
  ])
    assert.deepEqual(routeFor(path), { kind: 'directory' });
  const location = { pathname: '/' };
  let callback: (() => void) | undefined;
  const visited: Route[] = [];
  const navigation = createNavigation(
    {
      location,
      history: {
        pushState(_data, _unused, url) {
          location.pathname = url;
        },
        replaceState(_data, _unused, url) {
          location.pathname = url;
        },
      },
      addEventListener(_name, listener) {
        callback = listener;
      },
      removeEventListener(_name, listener) {
        if (callback === listener) callback = undefined;
      },
    },
    (route) => visited.push(route),
  );
  navigation.write({ kind: 'room', roomId: 'a' });
  assert.equal(location.pathname, '/rooms/a');
  navigation.write({ kind: 'room', roomId: '123' });
  assert.equal(location.pathname, '/123');
  navigation.write({ kind: 'admin-netease' });
  assert.equal(location.pathname, '/admin/netease');
  location.pathname = '/';
  callback!();
  assert.deepEqual(visited, [{ kind: 'directory' }]);
  navigation.close();
  assert.equal(callback, undefined);
});

test('directory polling stops when hidden or closed and coalesces overlapping reads', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let visible = true;
  let calls = 0;
  let release!: () => void;
  const poller = createDirectoryPoller({
    visible: () => visible,
    intervalMs: 10,
    refresh: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  poller.start();
  assert.equal(calls, 1);
  context.mock.timers.tick(25);
  assert.equal(calls, 1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  visible = false;
  poller.visibility();
  context.mock.timers.tick(25);
  assert.equal(calls, 1);
  visible = true;
  poller.visibility();
  assert.equal(calls, 2);
  poller.close();
  release();
  context.mock.timers.tick(25);
  assert.equal(calls, 2);
});

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Client room transition timed out');
}
function snapshot(roomId: string, revision = 1): RoomSnapshot {
  return {
    roomId,
    revision,
    serverTime: Date.now(),
    users: [
      {
        id: 'user',
        nickname: 'cat',
        seat: null,
        connected: true,
        x: 300,
        y: 400,
        targetX: 300,
        targetY: 400,
        movingSince: 0,
        durationMs: 0,
      },
    ],
    stage: [],
    playback: null,
    resolving: false,
    notice: null,
    capacity: 30,
    stageCapacity: 6,
  };
}
async function fixture(context: TestContext) {
  const http = createServer();
  const server = new Server<ClientEvents, ServerEvents>(http);
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
  } catch (cause) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if ((cause as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Sandbox forbids TCP listeners');
      return;
    }
    throw cause;
  }
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(`http://127.0.0.1:${address.port}`),
  });
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (input === '/api/me')
      return Response.json({
        guest: { id: 'user', nickname: 'cat' },
        auth: { emailEnabled: false },
      });
    if (input === '/api/playlist')
      return Response.json({
        tracks: [
          {
            id: '1',
            title: 'Personal song',
            artist: '',
            album: '',
            cover: '',
            durationMs: 10000,
          },
        ],
        revision: 1,
      });
    throw new Error(`Unexpected request ${String(input)}`);
  });
  const peers: Socket<ClientEvents, ServerEvents>[] = [];
  const syncs: { id: string; ack: (state: RoomSnapshot) => void }[] = [];
  const leaves: (() => void)[] = [];
  let holdAdmission: (() => void) | undefined;
  server.use((peer, next) => {
    if (peer.handshake.auth.roomId === 'closed')
      return next(new Error('房间暂停新访客进入'));
    if (peer.handshake.auth.roomId === 'slow') {
      holdAdmission = () => next();
      return;
    }
    next();
  });
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('room:sync', (ack) =>
      syncs.push({ id: peer.handshake.auth.roomId, ack }),
    );
    peer.on('room:leave', (ack) => leaves.push(() => ack({ ok: true })));
    peer.emit('room:snapshot', snapshot(peer.handshake.auth.roomId));
  });
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(async () => {
    room.close();
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await room.initialize();
  return { room, peers, syncs, leaves, admission: () => holdAdmission };
}

test('identity initialization stays in lobby; failed entry preserves the active room and playlist', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await delay(20);
  assert.equal(f.peers.length, 0);
  assert.equal(f.room.snapshot, null);
  assert.equal(await f.room.connect('a'), true);
  await waitFor(() => f.room.snapshot?.roomId === 'a');
  const old = f.room.snapshot;
  assert.equal(await f.room.connect('closed'), false);
  assert.equal(f.room.roomId, 'a');
  assert.equal(f.room.connection, 'connected');
  assert.equal(f.room.snapshot, old);
  assert.equal(f.room.playlist[0]!.title, 'Personal song');
});

test('live environments update without replacing room state and stale sync metadata cannot revert them', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a' && f.syncs.length === 1);
  const info: RoomInfo = {
    number: 1,
    id: 'a',
    ownerId: 'user',
    ownerNickname: 'cat',
    name: 'Room',
    environmentId: 'cozy',
    stageCapacity: 6,
    joinPolicy: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const state = f.room.snapshot;
  f.peers[0]!.emit('room:updated', {
    ...info,
    environmentId: 'rooftop',
    revision: 2,
  });
  await waitFor(() => f.room.roomInfo?.environmentId === 'rooftop');
  assert.equal(f.room.snapshot, state);
  assert.equal(
    f.syncs.length,
    1,
    'a theme update requests no extra synchronization',
  );
  f.syncs[0]!.ack({ ...snapshot('a', 2), room: info });
  await waitFor(() => f.room.snapshot?.revision === 2);
  assert.equal(f.room.roomInfo!.environmentId, 'rooftop');
  f.peers[0]!.emit('room:updated', {
    ...info,
    id: 'b',
    environmentId: 'seaside',
    revision: 10,
  });
  f.peers[0]!.emit('room:updated', info);
  await delay(15);
  assert.equal(f.room.roomInfo!.environmentId, 'rooftop');
  await f.room.connect('b');
  await waitFor(() => f.room.snapshot?.roomId === 'b');
  f.peers
    .at(-1)!
    .emit('room:updated', { ...info, id: 'b', environmentId: 'greenhouse' });
  await waitFor(() => f.room.roomInfo?.environmentId === 'greenhouse');
  assert.equal(
    f.room.roomInfo!.revision,
    1,
    'metadata revisions reset when changing rooms',
  );
});

test('A to B to A rejects stale syncs, mismatched room events and old transient emotes', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a' && f.syncs.length === 1);
  f.peers[0]!.emit('room:emote', {
    roomId: 'a',
    userId: 'user',
    id: 'nahida-1',
  });
  await waitFor(() => !!f.room.emoteFor('user'));
  await f.room.connect('b');
  await waitFor(() => f.room.snapshot?.roomId === 'b' && f.syncs.length === 2);
  assert.equal(f.room.emoteFor('user'), undefined);
  f.syncs[0]!.ack(snapshot('a', 100));
  await delay(15);
  assert.equal(f.room.snapshot!.roomId, 'b');
  f.peers[1]!.emit('room:snapshot', snapshot('a', 200));
  await delay(15);
  assert.equal(f.room.snapshot!.revision, 1);
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a' && f.syncs.length === 3);
  f.syncs[1]!.ack(snapshot('b', 300));
  await delay(15);
  assert.equal(f.room.snapshot!.revision, 1);
  f.syncs[2]!.ack(snapshot('a', 2));
  await waitFor(() => f.room.snapshot?.revision === 2);
});

test('superseded candidate settles and explicit leave clears state before its acknowledgement', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a');
  const pending = f.room.connect('slow');
  await waitFor(() => !!f.admission());
  const admitted = f.room.connect('b');
  assert.equal(await pending, false);
  assert.equal(await admitted, true);
  await waitFor(() => f.room.snapshot?.roomId === 'b');
  f.admission()!();
  await delay(20);
  assert.equal(f.room.roomId, 'b');
  const leaving = f.room.leave();
  assert.equal(f.room.snapshot, null);
  assert.equal(f.room.roomId, null);
  await waitFor(() => f.leaves.length === 1);
  f.peers.at(-1)!.emit('room:snapshot', snapshot('b', 900));
  await delay(15);
  assert.equal(f.room.snapshot, null);
  f.leaves[0]!();
  await leaving;
  assert.equal(f.room.connection, 'idle');
  assert.equal(f.room.playlist.length, 1);
});

test('returning to the active route cancels an unfinished candidate without reconnecting the old room', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a');
  const pending = f.room.connect('slow');
  await waitFor(() => !!f.admission());
  f.room.cancelPendingEntry();
  assert.equal(await pending, false);
  f.admission()!();
  await delay(20);
  assert.equal(f.room.roomId, 'a');
  assert.equal(f.room.connection, 'connected');
  assert.equal(
    f.peers[0]!.connected,
    true,
    'the original room socket stays connected',
  );
  await waitFor(() =>
    f.peers.every(
      (peer) =>
        peer.handshake.auth.roomId === 'a' || peer.conn.readyState === 'closed',
    ),
  );
  assert.equal(
    f.peers.filter((peer) => peer.handshake.auth.roomId === 'a').length,
    1,
    'returning to A does not establish a replacement A socket',
  );
  f.syncs[0]!.ack(snapshot('a', 2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  f.room.sync();
  await waitFor(() => f.syncs.length === 2);
  assert.equal(
    f.syncs[1]!.id,
    'a',
    'subsequent commands still use the original room',
  );
});

test('being removed immediately clears room state while preserving the identity and playlist', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a');
  f.peers[0]!.emit('room:removed', { roomId: 'a', reason: 'deleted' });
  await waitFor(() => f.room.snapshot === null);
  assert.equal(f.room.roomId, null);
  assert.equal(f.room.guest?.id, 'user');
  assert.equal(f.room.playlist.length, 1);
  assert.match(f.room.error, /删除/);
});

test('failed email verification preserves live events and successful binding survives old-session removal', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  await f.room.connect('a');
  await waitFor(() => f.room.snapshot?.roomId === 'a');
  const fallback = globalThis.fetch;
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input !== '/api/auth/email/verify')
        return fallback(input as RequestInfo, init);
      const body = JSON.parse(String(init?.body)) as { code: string };
      if (body.code === '000000')
        return Response.json({ error: '验证码错误' }, { status: 400 });
      f.peers[0]!.emit('room:removed', {
        roomId: 'a',
        reason: '账号会话已结束，请重新登录',
      });
      await waitFor(() => f.room.snapshot === null);
      return Response.json({
        guest: {
          id: 'user',
          nickname: 'cat',
          registered: true,
          email: 'c***@example.com',
        },
      });
    },
  );
  await assert.rejects(
    f.room.authenticate('challenge', '000000'),
    /验证码错误/,
  );
  f.peers[0]!.emit('room:snapshot', snapshot('a', 2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  await f.room.authenticate('challenge', '123456');
  assert.equal(f.room.guest?.registered, true);
  assert.equal(f.room.guest?.id, 'user');
  assert.equal(f.room.playlist.length, 1);
  assert.equal(f.room.roomId, null);
  assert.equal(f.room.error, '');
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import {
  setImmediate as immediate,
  setTimeout as delay,
} from 'node:timers/promises';
import { createPinia, setActivePinia } from 'pinia';
import { Server, type Socket } from 'socket.io';
import { Socket as ClientSocket } from 'socket.io-client';
import { useRoom } from '../src/client/room';
import type {
  ClientEvents,
  Guest,
  PlaylistOrder,
  PlaylistState,
  ServerEvents,
  Track,
} from '../src/shared/contracts';

function track(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    cover: '/cover',
    durationMs: 60_000,
  };
}
function state(ids: string[], revision: number): PlaylistState {
  return { tracks: ids.map(track), revision };
}
async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('Playlist update timed out');
    await immediate();
  }
}
interface HeldRequest {
  resolve: (value: PlaylistState) => void;
  fail: (message: string) => void;
}
async function fixture(context: TestContext) {
  const http = createServer();
  const server = new Server<ClientEvents, ServerEvents>(http);
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Sandbox forbids TCP listeners');
      return;
    }
    throw error;
  }
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(`http://127.0.0.1:${address.port}`),
  });
  const on = context.mock.method(ClientSocket.prototype, 'on');
  let guest: Guest = { id: 'a', nickname: 'a' };
  let playlistGets = 0;
  const reloads: HeldRequest[] = [];
  const mutations: HeldRequest[] = [];
  const held = (requests: HeldRequest[]) =>
    new Promise<Response>((resolve) =>
      requests.push({
        resolve: (value) => resolve(Response.json(value)),
        fail: (message) =>
          resolve(Response.json({ error: message }, { status: 500 })),
      }),
    );
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input === '/api/me') return Response.json({ guest });
      if (input === '/api/guest') {
        guest = { id: 'b', nickname: 'b' };
        return Response.json({ guest });
      }
      if (input === '/api/playlist' && init?.method === 'POST')
        return held(mutations);
      if (input === '/api/playlist') {
        playlistGets++;
        if (playlistGets === 1 || guest.id === 'b')
          return Response.json(
            state(guest.id === 'a' ? ['1', '2', '3'] : ['b'], 1),
          );
        return held(reloads);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    },
  );
  const peers: Socket<ClientEvents, ServerEvents>[] = [];
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('room:sync', (ack) =>
      ack({
        revision: 1,
        serverTime: Date.now(),
        users: [],
        stage: [],
        playback: null,
        resolving: false,
        notice: null,
        capacity: 30,
        stageCapacity: 6,
      }),
    );
  });
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(async () => {
    room.close();
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await room.initialize();
  void room.connect();
  await waitFor(() => room.connection === 'connected' && peers.length === 1);
  const callback = () =>
    on.mock.calls
      .filter((call) => call.arguments[0] === 'playlist:reordered')
      .at(-1)!.arguments[1] as (order: PlaylistOrder) => void;
  return {
    room,
    peers,
    reloads,
    mutations,
    callback,
    gets: () => playlistGets,
  };
}

test('cached playlist orders reuse metadata and avoid HTTP, with revisions fencing mutation responses', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const original = f.room.playlist.slice();
  const mutation = f.room.add('4');
  await waitFor(() => f.mutations.length === 1);
  f.peers[0]!.emit('playlist:reordered', { ids: ['3', '1', '2'], revision: 4 });
  await waitFor(() => f.room.playlistRevision === 4);
  assert.equal(f.room.playlist[0], original[2]);
  assert.equal(f.room.playlist[1], original[0]);
  assert.equal(f.room.playlist[2], original[1]);
  f.mutations[0]!.resolve(state(['1', '2', '3', '4'], 2));
  await mutation;
  assert.deepEqual(
    f.room.playlist.map((track) => track.id),
    ['3', '1', '2'],
  );
  f.peers[0]!.emit('playlist:reordered', { ids: ['1', '3'], revision: 5 });
  await waitFor(() => f.room.playlistRevision === 5);
  f.peers[0]!.emit('playlist:reordered', { ids: ['2', '3', '1'], revision: 3 });
  await delay(20);
  assert.deepEqual(
    f.room.playlist.map((track) => track.id),
    ['1', '3'],
  );
  assert.equal(f.gets(), 1);
});

test('unknown IDs coalesce recovery, reject stale metadata and retry only for a newer outstanding order', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const original = f.room.playlist;
  const mutation = f.room.add('4');
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['2', '3', '4', '1'],
    revision: 3,
  });
  await waitFor(() => f.reloads.length === 1);
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['3', '4', '5', '1', '2'],
    revision: 4,
  });
  await delay(20);
  assert.equal(f.reloads.length, 1);
  assert.equal(f.room.playlist, original);
  f.mutations[0]!.resolve(state(['1', '2', '3', '4'], 2));
  await mutation;
  assert.equal(f.room.playlist, original);
  f.reloads[0]!.resolve(state(['2', '3', '4', '1'], 3));
  await waitFor(() => f.reloads.length === 2);
  assert.equal(f.room.playlist, original);
  f.reloads[1]!.resolve(state(['3', '4', '5', '1', '2'], 4));
  await waitFor(() => f.room.playlistRevision === 4);
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['4', '5', '1', '2', '3'],
    revision: 5,
  });
  await waitFor(() => f.room.playlistRevision === 5);
  assert.equal(f.gets(), 3);
  assert.equal(f.room.error, '');
});

test('recovery failure preserves the queue, stops repeated stale responses and permits a later retry', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const original = f.room.playlist;
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['4', '1', '2', '3'],
    revision: 3,
  });
  await waitFor(() => f.reloads.length === 1);
  f.reloads[0]!.fail('Recovery unavailable');
  await waitFor(() => f.room.error === 'Recovery unavailable');
  assert.equal(f.room.playlist, original);
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['4', '1', '2', '3'],
    revision: 3,
  });
  await waitFor(() => f.reloads.length === 2);
  f.reloads[1]!.resolve(state(['1', '2', '3'], 2));
  await waitFor(() => f.reloads.length === 3);
  f.reloads[2]!.resolve(state(['1', '2', '3'], 2));
  await waitFor(() => f.room.error === '歌单同步失败，请稍后重试');
  await delay(20);
  assert.equal(f.reloads.length, 3);
  assert.equal(f.room.playlist, original);
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['4', '1', '2', '3'],
    revision: 3,
  });
  await waitFor(() => f.reloads.length === 4);
  f.reloads[3]!.resolve(state(['4', '1', '2', '3'], 3));
  await waitFor(() => f.room.playlistRevision === 3);
});

test('reconnect and identity changes isolate recovery requests, errors and old socket callbacks', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const oldCallback = f.callback();
  f.peers[0]!.emit('playlist:reordered', {
    ids: ['4', '1', '2', '3'],
    revision: 3,
  });
  await waitFor(() => f.reloads.length === 1);
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  oldCallback({ ids: ['5'], revision: 99 });
  assert.equal(f.reloads.length, 1);
  await waitFor(
    () => f.peers.length === 2 && f.room.connection === 'connected',
  );
  f.peers[1]!.emit('playlist:updated', state(['1', '2', '3', '4'], 4));
  await waitFor(() => f.room.playlistRevision === 4);
  f.peers[1]!.emit('playlist:reordered', {
    ids: ['5', '1', '2', '3', '4'],
    revision: 5,
  });
  await waitFor(() => f.reloads.length === 2);
  f.reloads[0]!.fail('Obsolete recovery error');
  await delay(20);
  assert.equal(f.room.error, '');
  f.peers[1]!.emit('playlist:reordered', {
    ids: ['1', '2', '3', '4', '5'],
    revision: 6,
  });
  await delay(20);
  assert.equal(f.reloads.length, 2);
  const oldIdentityCallback = f.callback();
  await f.room.enter('b');
  void f.room.connect();
  await waitFor(
    () => f.peers.length === 3 && f.room.connection === 'connected',
  );
  f.reloads[1]!.resolve(state(['5', '1', '2', '3', '4'], 100));
  oldIdentityCallback({ ids: ['4'], revision: 101 });
  await delay(20);
  assert.equal(f.room.guest!.id, 'b');
  assert.deepEqual(
    f.room.playlist.map((track) => track.id),
    ['b'],
  );
  assert.equal(f.room.playlistRevision, 1);
  assert.equal(f.room.error, '');
  const closedCallback = f.callback();
  f.room.close();
  closedCallback({ ids: ['unknown'], revision: 2 });
  assert.equal(f.gets(), 4);
});

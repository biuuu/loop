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
import { applyPlaybackUpdate, useRoom } from '../src/client/room';
import { SCENE, stageSeatXs } from '../src/shared/contracts';
import type {
  ClientEvents,
  ClientMotion,
  Guest,
  PlaybackState,
  RoomSnapshot,
  ServerEvents,
} from '../src/shared/contracts';

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('Playback update timed out');
    await immediate();
  }
}

function snapshot(revision = 1, id = 'a'): RoomSnapshot {
  return {
    revision,
    serverTime: Date.now(),
    users: [
      { id, nickname: id, seat: null, x: 300, y: 400 },
      { id: 'dj', nickname: 'DJ', seat: 2, x: 444, y: 255 },
    ].map((user) => ({
      ...user,
      targetX: user.x,
      targetY: user.y,
      movingSince: 0,
      durationMs: 0,
      connected: true,
    })),
    stage: ['dj'],
    playback: null,
    resolving: false,
    notice: null,
    capacity: 30,
    stageCapacity: 6,
  };
}

function playbackState(revision: number): PlaybackState {
  return {
    revision,
    serverTime: Date.now() + 1000,
    playback: {
      roundId: `round-${revision}`,
      djId: 'dj',
      track: {
        id: String(revision),
        title: 'Song',
        artist: 'Artist',
        album: '',
        cover: '',
        durationMs: 60_000,
      },
      url: 'https://audio.invalid/song.mp3',
      startedAt: Date.now(),
      durationMs: 60_000,
      isTrial: true,
      lyricOffsetMs: 15_000,
    },
    resolving: false,
    notice: null,
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
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (input === '/api/me') return Response.json({ guest });
    if (input === '/api/guest') {
      guest = { id: 'b', nickname: 'b' };
      return Response.json({ guest });
    }
    if (input === '/api/playlist')
      return Response.json({ slot: 1, count: 1, tracks: [], revision: 0 });
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const peers: Socket<ClientEvents, ServerEvents>[] = [];
  const requests: { ack: (state: RoomSnapshot) => void }[] = [];
  const motions: ClientMotion[] = [];
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('room:sync', (ack) => requests.push({ ack }));
    peer.on('room:motion', (report, ack) => {
      motions.push(report);
      ack({ ok: true });
    });
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
  await waitFor(() => requests.length === 1);
  return {
    room,
    peers,
    requests,
    motions,
    playbackCallback: () => {
      const calls = on.mock.calls.filter(
        (call) => call.arguments[0] === 'playback:updated',
      );
      return calls.at(-1)!.arguments[1] as (state: PlaybackState) => void;
    },
  };
}

test('playback deltas merge only playback fields, preserving members, seats, emotes and local motion', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.snapshot !== null);
  const users = f.room.snapshot!.users;
  const stage = f.room.snapshot!.stage;
  f.peers[0]!.emit('room:emote', { userId: 'dj', id: 'nahida-2' });
  await waitFor(() => f.room.emoteFor('dj') !== undefined);
  const emote = f.room.emoteFor('dj');
  f.room.moveDirection('right');
  const renderTime = Date.now() + 10;
  const moving = f.room.renderParticipant(f.room.me!, renderTime);
  const state = playbackState(2);
  // Even an accidental extra membership field must not enter the room state.
  f.peers[0]!.emit('playback:updated', {
    ...state,
    users: [],
    stage: [],
    capacity: 0,
    stageCapacity: 0,
  } as PlaybackState);
  await waitFor(() => f.room.snapshot?.revision === 2);
  assert.deepEqual(f.room.snapshot!.playback, state.playback);
  assert.equal(f.room.snapshot!.serverTime, state.serverTime);
  assert.equal(f.room.snapshot!.users, users);
  assert.equal(f.room.snapshot!.stage, stage);
  assert.equal(f.room.snapshot!.capacity, 30);
  assert.equal(f.room.snapshot!.stageCapacity, 6);
  assert.equal(f.room.emoteFor('dj'), emote);
  assert.deepEqual(f.room.renderParticipant(f.room.me!, renderTime), moving);
  f.room.moveDirection('down');
  f.room.flushMovement();
  await waitFor(() => f.motions.length === 2);
  assert.equal(f.motions[1]!.targetY, 555);

  f.peers[0]!.emit('playback:updated', {
    revision: 3,
    serverTime: state.serverTime + 1,
    playback: null,
    resolving: true,
    notice: '正在解析',
  });
  await waitFor(() => f.room.snapshot?.revision === 3);
  assert.equal(f.room.snapshot!.playback, null);
  assert.equal(f.room.snapshot!.resolving, true);
  assert.equal(f.room.snapshot!.notice, '正在解析');
  f.peers[0]!.emit('playback:updated', {
    revision: 4,
    serverTime: state.serverTime + 2,
    playback: null,
    resolving: false,
    notice: null,
  });
  await waitFor(() => f.room.snapshot?.revision === 4);
  assert.equal(f.room.snapshot!.resolving, false);
  assert.equal(f.room.snapshot!.notice, null);
  assert.equal(f.room.emoteFor('dj'), emote);
});

test('a compact stage rotation moves only seated cats and cannot change membership', () => {
  const initial = snapshot();
  const positions = stageSeatXs(initial.stageCapacity);
  const firstX = positions[0]!;
  const secondX = positions[1]!;
  const first = {
    ...initial.users[1]!,
    seat: 0,
    x: firstX,
    targetX: firstX,
    y: SCENE.stageY,
    targetY: SCENE.stageY,
  };
  const second = {
    ...first,
    id: 'next',
    seat: 1,
    x: secondX,
    targetX: secondX,
  };
  const audience = { ...initial.users[0]!, targetX: 500, durationMs: 1000 };
  initial.users = [audience, first, second];
  initial.stage = [first.id, second.id];

  const update = playbackState(2);
  update.playback!.djId = second.id;
  const moved = applyPlaybackUpdate(initial, {
    ...update,
    stage: [second.id, first.id],
  });
  assert.deepEqual(moved.stage, [second.id, first.id]);
  assert.deepEqual(moved.users, [
    audience,
    { ...first, seat: 1, x: secondX, targetX: secondX },
    { ...second, seat: 0, x: firstX, targetX: firstX },
  ]);
  assert.equal(moved.users[0], audience);
  assert.equal(moved.playback, update.playback);
  for (const stage of [
    [first.id],
    [first.id, first.id],
    [second.id, audience.id],
  ]) {
    const invalid = applyPlaybackUpdate(initial, { ...update, stage });
    assert.equal(invalid.stage, initial.stage);
    assert.equal(invalid.users, initial.users);
  }
});

test('playback revision fences stale deltas, full snapshots and a held sync acknowledgement', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('room:snapshot', snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  const initial = playbackState(4);
  f.peers[0]!.emit('playback:updated', initial);
  await waitFor(() => f.room.snapshot?.revision === 4);
  const seek = {
    ...initial,
    revision: 5,
    playback: {
      ...initial.playback!,
      startedAt: initial.playback!.startedAt - 15_000,
    },
  };
  f.peers[0]!.emit('playback:updated', seek);
  await waitFor(() => f.room.snapshot?.revision === 5);
  assert.deepEqual(f.room.snapshot!.playback, seek.playback);
  const current = f.room.snapshot;
  f.peers[0]!.emit('playback:updated', initial);
  f.peers[0]!.emit('room:snapshot', {
    ...snapshot(4),
    playback: initial.playback,
    users: [],
    stage: [],
  });
  f.requests[0]!.ack(snapshot(1));
  await delay(30);
  assert.equal(f.room.snapshot, current);

  f.peers[0]!.emit('playback:updated', {
    ...seek,
    notice: 'same revision',
  });
  await waitFor(() => f.room.snapshot?.notice === 'same revision');
  f.peers[0]!.emit('room:snapshot', {
    ...snapshot(6),
    stage: [],
    users: snapshot(6).users.slice(0, 1),
  });
  await waitFor(() => f.room.snapshot?.revision === 6);
  assert.equal(f.room.snapshot!.playback, null);
  assert.equal(f.room.snapshot!.users.length, 1);
  assert.deepEqual(f.room.snapshot!.stage, []);
});

test('playback deltas wait for a full snapshot on initial connection and reconnection', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('playback:updated', playbackState(99));
  await delay(30);
  assert.equal(f.room.snapshot, null);
  f.requests[0]!.ack(snapshot(1));
  await waitFor(() => f.room.snapshot?.revision === 1);
  const oldCallback = f.playbackCallback();
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  oldCallback(playbackState(99));
  assert.equal(f.room.snapshot!.revision, 1);
  await waitFor(() => f.requests.length === 2);
  assert.equal(f.room.snapshot, null);
  f.peers[1]!.emit('playback:updated', playbackState(99));
  await delay(30);
  assert.equal(f.room.snapshot, null);
  f.requests[1]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  f.peers[1]!.emit('playback:updated', playbackState(3));
  await waitFor(() => f.room.snapshot?.revision === 3);
});

test('callbacks from replaced sockets and identities cannot update playback; closed callbacks are inert', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.snapshot !== null);
  const oldSocketCallback = f.playbackCallback();
  f.room.connect();
  await waitFor(() => f.requests.length === 2);
  f.requests[1]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  oldSocketCallback(playbackState(99));
  assert.equal(f.room.snapshot!.revision, 2);
  const oldIdentityCallback = f.playbackCallback();
  await f.room.enter('b');
  void f.room.connect();
  await waitFor(() => f.requests.length === 3);
  f.requests[2]!.ack(snapshot(3, 'b'));
  await waitFor(() => f.room.me?.id === 'b');
  oldIdentityCallback(playbackState(99));
  assert.equal(f.room.snapshot!.revision, 3);
  const callback = f.playbackCallback();
  f.peers[2]!.emit('room:replaced');
  await waitFor(() => f.room.connection === 'replaced');
  callback(playbackState(99));
  assert.equal(f.room.snapshot, null);
  f.room.close();
  callback(playbackState(99));
  assert.equal(f.room.snapshot, null);
});

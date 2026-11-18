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
import { movementPosition } from '../src/client/keyboard-movement';
import { createRemoteMovement } from '../src/client/remote-movement';
import type {
  ClientEvents,
  ClientMotion,
  Guest,
  PlaybackState,
  RoomMotion,
  RoomSnapshot,
  ServerEvents,
} from '../src/shared/contracts';

const START = 1_000_000;
async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('Motion update timed out');
    await immediate();
  }
}
function snapshot(revision = 1, id = 'a'): RoomSnapshot {
  return {
    revision,
    serverTime: START,
    users: [
      { id, nickname: id, seat: null, x: 300, y: 400, connected: true },
      {
        id: 'peer',
        nickname: 'Peer',
        seat: null,
        x: 500,
        y: 400,
        connected: true,
      },
      {
        id: 'offline',
        nickname: 'Offline',
        seat: null,
        x: 550,
        y: 400,
        connected: false,
      },
      { id: 'dj', nickname: 'DJ', seat: 2, x: 444, y: 255, connected: true },
    ].map((user) => ({
      ...user,
      targetX: user.x,
      targetY: user.y,
      movingSince: START,
      durationMs: 0,
      facingRight: false,
      appearance: { coat: 'gray' as const, pattern: 'solid' as const },
    })),
    stage: ['dj'],
    playback: null,
    resolving: false,
    notice: 'room notice',
    capacity: 30,
    stageCapacity: 6,
  };
}
function motion(revision = 2, userId = 'peer'): RoomMotion {
  return {
    revision,
    serverTime: START + 100,
    userId,
    x: 550,
    y: 400,
    targetX: 750,
    targetY: 400,
    movingSince: START + 100,
    durationMs: 1000,
    facingRight: true,
    clientMoveId: 1,
  };
}
function echo(report: ClientMotion, revision: number): RoomMotion {
  return {
    ...report,
    revision,
    serverTime: START,
    userId: 'a',
    movingSince: START,
    durationMs:
      (Math.hypot(report.targetX - report.x, report.targetY - report.y) / 180) *
      1000,
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
  let now = START;
  context.mock.method(Date, 'now', () => now);
  const on = context.mock.method(ClientSocket.prototype, 'on');
  let guest: Guest = { id: 'a', nickname: 'a' };
  const fetches: unknown[] = [];
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    fetches.push(input);
    if (input === '/api/me') return Response.json({ guest });
    if (input === '/api/guest') {
      guest = { id: 'b', nickname: 'b' };
      return Response.json({ guest });
    }
    if (input === '/api/playlist')
      return Response.json({ tracks: [], revision: 0 });
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
    fetches,
    advance(ms: number) {
      now += ms;
    },
    callback() {
      return on.mock.calls
        .filter((call) => call.arguments[0] === 'room:motion')
        .at(-1)!.arguments[1] as (state: RoomMotion) => void;
    },
  };
}

test('sender motion echoes preserve newer local input and the immediate final stop', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.me !== undefined);
  f.room.moveDirection('right');
  await waitFor(() => f.motions.length === 1);
  const first = f.motions[0]!;
  f.advance(100);
  f.room.moveDirection('down');
  const before = f.room.renderParticipant(f.room.me!, START + 120);
  f.peers[0]!.emit('room:motion', echo(first, 2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  assert.deepEqual(f.room.renderParticipant(f.room.me!, START + 120), before);
  f.advance(100);
  f.room.stopMovement();
  const stopped = f.room.renderParticipant(f.room.me!, START + 200);
  assert.equal(stopped.durationMs, 0);
  await waitFor(() => f.motions.at(-1)?.clientMoveId === stopped.clientMoveId);
  const final = f.motions.at(-1)!;
  f.peers[0]!.emit('room:motion', {
    ...echo(final, 3),
    movingSince: START + 200,
  });
  await waitFor(() => f.room.snapshot?.revision === 3);
  assert.deepEqual(
    movementPosition(
      f.room.renderParticipant(f.room.me!, START + 300),
      START + 300,
    ),
    { x: final.x, y: final.y },
  );
  f.peers[0]!.emit('room:motion', echo(first, 4));
  await waitFor(() => f.room.snapshot?.revision === 4);
  const settled = f.room.renderParticipant(f.room.me!, START + 400);
  assert.equal(settled.clientMoveId, final.clientMoveId);
  assert.equal(settled.facingRight, final.facingRight);
  assert.deepEqual(movementPosition(settled, START + 400), {
    x: final.x,
    y: final.y,
  });
  assert.equal(f.requests.length, 1);
});

test('peer motion merges explicit fields, preserves transient state and keeps remote correction and gait smooth', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const initial = snapshot();
  Object.assign(initial.users[1]!, {
    targetX: 700,
    movingSince: START,
    durationMs: 1000,
    clientMoveId: 9,
  });
  f.requests[0]!.ack(initial);
  await waitFor(() => f.room.snapshot !== null);
  f.peers[0]!.emit('room:emote', { userId: 'peer', id: 'nahida-2' });
  await waitFor(() => f.room.emoteFor('peer') !== undefined);
  const emote = f.room.emoteFor('peer');
  const original = f.room.snapshot!;
  const peer = original.users[1]!;
  const presentation = createRemoteMovement();
  const before = presentation.view(peer, START + 100);
  const update = motion();
  delete update.clientMoveId;
  f.peers[0]!.emit('room:motion', {
    ...update,
    nickname: 'overwrite',
    appearance: { coat: 'orange', pattern: 'tabby' },
    seat: 0,
    connected: false,
    stage: [],
    playback: {},
    users: [],
    capacity: 1,
    stageCapacity: 1,
  } as RoomMotion);
  await waitFor(() => f.room.snapshot?.revision === 2);
  const current = f.room.snapshot!;
  const moved = current.users[1]!;
  const { clientMoveId: _oldMarker, ...unchanged } = peer;
  assert.deepEqual(moved, {
    ...unchanged,
    x: update.x,
    y: update.y,
    targetX: update.targetX,
    targetY: update.targetY,
    movingSince: update.movingSince,
    durationMs: update.durationMs,
    facingRight: true,
  });
  assert.equal(Object.hasOwn(moved, 'clientMoveId'), false);
  assert.equal(current.serverTime, update.serverTime);
  assert.equal(current.stage, original.stage);
  assert.equal(current.playback, original.playback);
  assert.equal(current.resolving, original.resolving);
  assert.equal(current.notice, original.notice);
  assert.equal(current.capacity, original.capacity);
  assert.equal(current.stageCapacity, original.stageCapacity);
  for (const index of [0, 2, 3])
    assert.equal(current.users[index], original.users[index]);
  assert.equal(f.room.emoteFor('peer'), emote);
  const onReceipt = presentation.view(moved, START + 100);
  assert.equal(onReceipt.x, before.x);
  assert.equal(onReceipt.y, before.y);
  assert.equal(onReceipt.walkStartedAt, before.walkStartedAt);
  const later = presentation.view(moved, START + 220);
  assert.ok(later.x > 550 && later.x < 574);
  assert.equal(later.y, 400);
  assert.ok(later.visualDx > 0);
  assert.equal(later.walkStartedAt, START);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.fetches, ['/api/me', '/api/playlist', '/api/emotes']);
});

test('motion shares revision ordering with full snapshots, sync and playback, while stage placement fences floor updates', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('room:snapshot', snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  f.peers[0]!.emit('room:motion', motion(4));
  await waitFor(() => f.room.snapshot?.revision === 4);
  const current = f.room.snapshot;
  f.peers[0]!.emit('room:motion', motion(3));
  f.peers[0]!.emit('room:snapshot', snapshot(3));
  f.peers[0]!.emit('playback:updated', {
    revision: 3,
    serverTime: START,
    playback: null,
    resolving: true,
    notice: 'stale',
  });
  f.requests[0]!.ack(snapshot(1));
  await delay(30);
  assert.equal(f.room.snapshot, current);
  const playback: PlaybackState = {
    revision: 5,
    serverTime: START,
    playback: null,
    resolving: true,
    notice: 'loading',
  };
  f.peers[0]!.emit('playback:updated', playback);
  await waitFor(() => f.room.snapshot?.revision === 5);
  f.callback()(motion(4));
  assert.equal(f.room.snapshot!.resolving, true);
  assert.equal(f.room.snapshot!.revision, 5);
  f.peers[0]!.emit('room:motion', { ...motion(5), x: 560 });
  await waitFor(() => f.room.snapshot!.users[1]!.x === 560);
  const seated = snapshot(6);
  Object.assign(seated.users[1]!, {
    seat: 1,
    x: 350,
    y: 255,
    targetX: 350,
    targetY: 255,
  });
  seated.stage.push('peer');
  f.peers[0]!.emit('room:snapshot', seated);
  await waitFor(() => f.room.snapshot?.revision === 6);
  const stage = f.room.snapshot;
  f.callback()(motion(5));
  f.callback()(motion(7));
  assert.equal(f.room.snapshot, stage);
  assert.equal(f.room.snapshot!.users[1]!.seat, 1);
});

test('motion waits for initialized membership and ignores unknown, disconnected and staged participants without advancing revision', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('room:motion', motion(99));
  await delay(30);
  assert.equal(f.room.snapshot, null);
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.snapshot !== null);
  const current = f.room.snapshot;
  for (const id of ['unknown', 'offline', 'dj']) f.callback()(motion(99, id));
  assert.equal(f.room.snapshot, current);
  f.peers[0]!.emit('room:motion', motion(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  assert.equal(f.room.snapshot!.users.length, 4);
});

test('disconnected, reconnected, replaced and old identity callbacks cannot change active motion', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.snapshot !== null);
  const beforeDisconnect = f.callback();
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  beforeDisconnect(motion(99));
  assert.equal(f.room.snapshot!.revision, 1);
  await waitFor(() => f.requests.length === 2);
  assert.equal(f.room.snapshot, null);
  f.peers[1]!.emit('room:motion', motion(99));
  await delay(30);
  assert.equal(f.room.snapshot, null);
  f.requests[1]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  f.peers[1]!.emit('room:motion', motion(3));
  await waitFor(() => f.room.snapshot?.revision === 3);
  const oldSocket = f.callback();
  f.room.connect();
  await waitFor(() => f.requests.length === 3);
  f.requests[2]!.ack(snapshot(4));
  await waitFor(() => f.room.snapshot?.revision === 4);
  oldSocket(motion(99));
  assert.equal(f.room.snapshot!.revision, 4);
  const oldIdentity = f.callback();
  await f.room.enter('b');
  void f.room.connect();
  await waitFor(() => f.requests.length === 4);
  f.requests[3]!.ack(snapshot(5, 'b'));
  await waitFor(() => f.room.me?.id === 'b');
  oldIdentity(motion(99));
  assert.equal(f.room.snapshot!.revision, 5);
  const active = f.callback();
  f.peers[3]!.emit('room:replaced');
  await waitFor(() => f.room.connection === 'replaced');
  active(motion(99));
  assert.equal(f.room.snapshot, null);
  f.room.close();
  active(motion(99));
  assert.equal(f.room.snapshot, null);
});

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
import { movementPosition } from '../src/client/keyboard-movement';
import { useRoom } from '../src/client/room';
import type {
  Ack,
  ClientEvents,
  ClientMotion,
  Guest,
  RoomSnapshot,
  ServerEvents,
  StageJoin,
  StageLeave,
} from '../src/shared/contracts';

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('Stage join update timed out');
    await immediate();
  }
}

function snapshot(
  revision = 1,
  id = 'a',
  seat: number | null = null,
): RoomSnapshot {
  const x = seat === null ? 300 : 340;
  const y = seat === null ? 400 : 255;
  return {
    revision,
    serverTime: Date.now(),
    users: [
      {
        id,
        nickname: id,
        x,
        y,
        targetX: x,
        targetY: y,
        movingSince: 0,
        durationMs: 0,
        connected: true,
        seat,
      },
    ],
    stage: seat === null ? [] : [id],
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
  let now = 100_000;
  context.mock.method(Date, 'now', () => now);
  const emit = context.mock.method(ClientSocket.prototype, 'emit');
  let guest: Guest = { id: 'a', nickname: 'a' };
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
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
  const commands: string[] = [];
  const joins: { payload: StageJoin; ack: (result: Ack) => void }[] = [];
  const leaves: StageLeave[] = [];
  const motions: { report: ClientMotion; ack: (result: Ack) => void }[] = [];
  server.on('connection', (peer) => {
    const id = guest.id;
    peers.push(peer);
    peer.onAny((event) => {
      if (event !== 'room:sync') commands.push(event);
    });
    peer.on('room:sync', (ack) => ack(snapshot(1, id)));
    peer.on('stage:join', (payload, ack) => joins.push({ payload, ack }));
    peer.on('room:motion', (report, ack) => motions.push({ report, ack }));
    peer.on('stage:leave', (payload, ack) => {
      leaves.push(payload);
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
  await waitFor(() => room.me?.id === 'a');
  return {
    room,
    peers,
    commands,
    joins,
    leaves,
    motions,
    advance: (ms: number) => (now += ms),
    rendered: () => room.renderParticipant(room.me!, now),
    joinCallback: () => {
      const calls = emit.mock.calls.filter(
        (call) => call.arguments[0] === 'stage:join',
      );
      return calls.at(-1)!.arguments[2] as (
        error: Error | null,
        result?: Ack,
      ) => void;
    },
  };
}

test('stationary stage join sends one stage command and no preliminary floor motion', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const joined = f.room.joinStage();
  assert.equal(f.rendered().durationMs, 0);
  assert.equal(f.room.stagePending, true);
  await waitFor(() => f.joins.length === 1);
  assert.deepEqual(f.commands, ['stage:join']);
  assert.deepEqual(f.joins[0]!.payload, { from: { x: 300, y: 400 } });
  f.peers[0]!.emit('room:snapshot', snapshot(2, 'a', 0));
  f.joins[0]!.ack({ ok: true });
  assert.equal(await joined, true);
  await waitFor(() => f.room.onStage);
  await delay(180);
  assert.deepEqual(f.commands, ['stage:join']);
  assert.equal(f.rendered().x, 340);
});

test('stage join without a local floor participant leaves the position to the server', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('room:snapshot', { ...snapshot(2), users: [] });
  await waitFor(() => !f.room.me);
  const joined = f.room.joinStage();
  await waitFor(() => f.joins.length === 1);
  assert.deepEqual(f.joins[0]!.payload, {});
  f.joins[0]!.ack({ ok: true });
  assert.equal(await joined, true);
  assert.deepEqual(f.commands, ['stage:join']);
});

test('moving stage join cancels trailing reports and preserves the seat against old motion rejections', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.room.moveDirection('right');
  f.advance(40);
  f.room.moveDirection('down');
  f.advance(40);
  const point = movementPosition(f.rendered(), Date.now());
  const joined = f.room.joinStage();
  const stopped = f.rendered();
  assert.deepEqual({ x: stopped.x, y: stopped.y }, point);
  assert.equal(stopped.targetX, point.x);
  assert.equal(stopped.targetY, point.y);
  assert.equal(stopped.durationMs, 0);
  await waitFor(() => f.joins.length === 1);
  assert.deepEqual(f.commands, ['room:motion', 'stage:join']);
  assert.deepEqual(f.joins[0]!.payload, { from: point });
  assert.equal(f.motions.length, 1);
  f.motions[0]!.ack({ ok: false, error: 'Old floor rejection' });
  await delay(20);
  assert.deepEqual(f.rendered(), stopped, 'old ack cannot discard local stop');
  assert.equal(f.room.error, '');
  f.peers[0]!.emit('room:snapshot', snapshot(2, 'a', 0));
  f.joins[0]!.ack({ ok: true });
  assert.equal(await joined, true);
  await waitFor(() => f.room.onStage);
  f.room.flushMovement();
  await delay(180);
  assert.deepEqual(f.commands, ['room:motion', 'stage:join']);
  assert.equal(f.rendered().x, 340);
  assert.equal(f.rendered().seat, 0);
});

test('rejected join publishes exactly one final stopped segment and permits later movement', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.room.moveDirection('right');
  f.advance(40);
  f.room.moveDirection('down');
  f.advance(40);
  const joined = f.room.joinStage();
  const stopped = f.rendered();
  await waitFor(() => f.joins.length === 1);
  assert.equal(f.room.connection, 'connected');
  assert.equal(f.room.stagePending, true);
  f.joins[0]!.ack({ ok: false, error: 'Stage full' });
  assert.equal(await joined, false);
  await waitFor(() => f.motions.length === 2);
  assert.equal(f.room.stagePending, false);
  assert.equal(f.room.onStage, false);
  assert.equal(f.room.error, 'Stage full');
  const final = f.motions[1]!.report;
  assert.equal(final.x, stopped.x);
  assert.equal(final.y, stopped.y);
  assert.equal(final.targetX, stopped.x);
  assert.equal(final.targetY, stopped.y);
  assert.equal(final.facingRight, stopped.facingRight);
  f.room.flushMovement();
  await delay(180);
  assert.deepEqual(f.commands, ['room:motion', 'stage:join', 'room:motion']);
  f.advance(200);
  f.room.moveDirection('left');
  assert.ok(f.rendered().durationMs > 0);
  await waitFor(() => f.motions.length === 3);
});

test('join timeout publishes the local stop once; later duplicate completion cannot affect a new join', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.room.moveDirection('right');
  f.advance(40);
  const joined = f.room.joinStage();
  await waitFor(() => f.joins.length === 1);
  // Invoke the captured timeout acknowledgement without waiting 75 seconds.
  const finished = f.joinCallback();
  finished(new Error('operation has timed out'));
  assert.equal(await joined, false);
  await waitFor(() => f.motions.length === 2);
  assert.equal(f.motions[1]!.report.x, f.motions[1]!.report.targetX);
  assert.equal(f.motions[1]!.report.y, f.motions[1]!.report.targetY);
  assert.match(f.room.error, /操作尚未确认/);
  const retry = f.room.joinStage();
  await waitFor(() => f.joins.length === 2);
  finished(null, { ok: false, error: 'Late rejection' });
  assert.equal(f.room.stagePending, true);
  f.joins[1]!.ack({ ok: true });
  assert.equal(await retry, true);
  await delay(180);
  assert.equal(f.motions.length, 2);
});

test('identity replacement ignores an old join callback while a new join is pending', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  const oldJoin = f.room.joinStage();
  await waitFor(() => f.joins.length === 1);
  const oldFinished = f.joinCallback();
  await f.room.enter('b');
  void f.room.connect();
  await waitFor(() => f.room.me?.id === 'b');
  const newJoin = f.room.joinStage();
  await waitFor(() => f.joins.length === 2);
  oldFinished(null, { ok: false, error: 'Wrong identity' });
  assert.equal(await oldJoin, false);
  assert.equal(f.room.stagePending, true);
  assert.equal(f.room.error, '');
  assert.equal(f.motions.length, 0);
  f.joins[1]!.ack({ ok: true });
  assert.equal(await newJoin, true);
});

test('disconnect and reconnect reject old join fallback on the same Socket instance', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.room.moveDirection('right');
  const oldJoin = f.room.joinStage();
  await waitFor(() => f.joins.length === 1);
  const oldFinished = f.joinCallback();
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  await waitFor(
    () =>
      f.peers.length === 2 &&
      f.room.connection === 'connected' &&
      f.room.me?.id === 'a',
  );
  const newJoin = f.room.joinStage();
  await waitFor(() => f.joins.length === 2);
  oldFinished(new Error('Old timeout'));
  assert.equal(await oldJoin, false);
  assert.equal(f.room.stagePending, true);
  assert.equal(f.room.error, '');
  assert.equal(f.motions.length, 1);
  f.joins[1]!.ack({ ok: true });
  assert.equal(await newJoin, true);
});

test('replaced and closed connections never publish a failed join stop', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.room.moveDirection('right');
  const joined = f.room.joinStage();
  await waitFor(() => f.joins.length === 1);
  const finished = f.joinCallback();
  f.peers[0]!.emit('room:replaced');
  await waitFor(() => f.room.connection === 'replaced');
  assert.equal(f.room.stagePending, false);
  finished(new Error('Old timeout'));
  assert.equal(await joined, false);
  assert.equal(f.room.error, '');
  f.room.close();
  finished(null, { ok: false, error: 'Old rejection' });
  await delay(30);
  assert.equal(f.motions.length, 1);
  assert.equal(f.room.error, '');
});

test('stage leave after reconnect sends only a leave command with no position', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.emit('room:snapshot', snapshot(2, 'a', 0));
  await waitFor(() => f.room.onStage);
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  await waitFor(
    () => f.peers.length === 2 && f.room.connection === 'connected',
  );
  f.peers[1]!.emit('room:snapshot', snapshot(2, 'a', 0));
  await waitFor(() => f.room.onStage);
  assert.equal(await f.room.leaveStage(), true);
  assert.deepEqual(f.commands, ['stage:leave']);
  assert.deepEqual(f.leaves, [{}]);
});

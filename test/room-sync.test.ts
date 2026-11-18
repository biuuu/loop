import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import {
  setImmediate as immediate,
  setTimeout as delay,
} from 'node:timers/promises';
import { createPinia, setActivePinia } from 'pinia';
import { Server, type Socket } from 'socket.io';
import { createRenderer, h, nextTick } from 'vue';
import { useAudio } from '../src/client/audio';
import { useRoom } from '../src/client/room';
import type {
  ClientEvents,
  Guest,
  RoomSnapshot,
  ServerEvents,
} from '../src/shared/contracts';

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error('Store update timed out');
    await immediate();
  }
}

function snapshot(revision = 1, id = 'a'): RoomSnapshot {
  return {
    revision,
    serverTime: Date.now(),
    users: [
      {
        id,
        nickname: id,
        x: 300,
        y: 400,
        targetX: 300,
        targetY: 400,
        movingSince: 0,
        durationMs: 0,
        connected: true,
        seat: 0,
      },
    ],
    stage: [id],
    playback: {
      roundId: 'round',
      track: {
        id: '1',
        title: 'Song',
        artist: 'Artist',
        album: '',
        cover: '',
        durationMs: 60_000,
      },
      djId: id,
      url: 'https://audio.invalid/song.mp3',
      startedAt: Date.now() - 2000,
      durationMs: 60_000,
    },
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
  const requests: {
    peer: Socket<ClientEvents, ServerEvents>;
    ack: (state: RoomSnapshot) => void;
  }[] = [];
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('room:sync', (ack) => requests.push({ peer, ack }));
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
  return { room, peers, requests };
}

test('join sync coalesces a burst while awaiting its ack and allows an immediate fresh sync afterward', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  for (let i = 0; i < 10; i++) f.room.sync();
  await delay(30);
  assert.equal(f.requests.length, 1);
  f.requests[0]!.ack(snapshot());
  await waitFor(() => f.room.snapshot !== null);
  assert.equal(f.room.onStage, true);
  await delay(30);
  assert.equal(
    f.requests.length,
    1,
    'coalescing never queues a trailing request',
  );
  f.room.sync();
  await waitFor(() => f.requests.length === 2);
  f.requests[1]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
});

test('empty and timed-out sync acknowledgements release the request for retry', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.requests[0]!.ack(null as unknown as RoomSnapshot);
  await delay(30);
  f.room.sync();
  await waitFor(() => f.requests.length === 2);
  // Socket.IO captures its timer functions when constructing the connection.
  // Exercise the real acknowledgement deadline rather than mocking later timers.
  await delay(8100);
  f.room.sync();
  await waitFor(() => f.requests.length === 3);
  f.requests[1]!.ack(snapshot(99));
  await delay(20);
  assert.equal(f.room.snapshot, null, 'late ack after timeout is ignored');
  f.room.sync();
  await delay(20);
  assert.equal(
    f.requests.length,
    3,
    'late ack cannot release a newer pending sync',
  );
  f.requests[2]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
});

test('reconnect and identity replacement create fresh requests while rejecting older acknowledgements', async (context) => {
  const f = await fixture(context);
  if (!f) return;
  f.peers[0]!.conn.close();
  await waitFor(() => f.room.connection === 'disconnected');
  await waitFor(() => f.requests.length === 2);
  f.requests[0]!.ack(snapshot(99));
  f.room.sync();
  await delay(30);
  assert.equal(f.requests.length, 2);
  assert.equal(f.room.snapshot, null);
  f.requests[1]!.ack(snapshot(2));
  await waitFor(() => f.room.snapshot?.revision === 2);
  f.room.sync();
  await waitFor(() => f.requests.length === 3);
  await f.room.enter('b');
  void f.room.connect();
  await waitFor(() => f.requests.length === 4);
  f.requests[2]!.ack(snapshot(99));
  await delay(30);
  f.room.sync();
  await delay(30);
  assert.equal(f.requests.length, 4);
  assert.equal(f.room.snapshot, null);
  f.requests[3]!.ack(snapshot(3, 'b'));
  await waitFor(() => f.room.snapshot?.revision === 3);
  assert.equal(f.room.me?.id, 'b');
});

test('slower subsequent syncs retain the quickest recent clock sample', async (context) => {
  let now = 100_000;
  context.mock.method(Date, 'now', () => now);
  const f = await fixture(context);
  if (!f) return;
  now += 10;
  f.requests[0]!.ack({ ...snapshot(), serverTime: 100_100 });
  await waitFor(() => f.room.snapshot !== null);
  assert.equal(f.room.offset, 95);
  f.room.sync();
  await waitFor(() => f.requests.length === 2);
  now += 200;
  f.requests[1]!.ack({ ...snapshot(2), serverTime: 100_500 });
  await waitFor(() => f.room.snapshot?.revision === 2);
  assert.equal(f.room.offset, 95);
});

class FakeAudio extends EventTarget {
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = 60;
  readyState = 1;
  paused = true;
  ended = false;
  src = '';
  error = null;
  playCalls = 0;
  load() {}
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  async play() {
    this.playCalls++;
    this.paused = false;
  }
}

test('audio metadata and connection changes do not request sync; foreground restoration does', async (context) => {
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const document = Object.assign(new EventTarget(), { hidden: false });
  let audio!: FakeAudio;
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: class extends FakeAudio {
      constructor() {
        super();
        audio = this;
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  });
  setActivePinia(createPinia());
  const room = useRoom();
  const sync = context.mock.method(room, 'sync', () => {});
  // A minimal Vue host exercises setup/unmount hooks without a DOM or browser.
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const root = {};
  try {
    room.connection = 'connected';
    room.snapshot = snapshot();
    renderer.render(
      h({
        setup() {
          useAudio();
          return () => null;
        },
      }),
      root,
    );
    await nextTick();
    assert.equal(
      audio.src,
      room.snapshot.playback!.url,
      'mounting during an existing round loads its source immediately',
    );
    assert.equal(sync.mock.callCount(), 0);
    assert.equal(audio.src, room.snapshot.playback!.url);
    audio.currentTime = 0;
    audio.dispatchEvent(new Event('loadedmetadata'));
    await nextTick();
    assert.equal(sync.mock.callCount(), 0);
    assert.ok(
      audio.currentTime >= 2,
      'metadata still seeks to the room timeline',
    );
    assert.ok(audio.playCalls > 0);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(sync.mock.callCount(), 0);
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(sync.mock.callCount(), 1);
    room.connection = 'disconnected';
    await nextTick();
    room.connection = 'connected';
    await nextTick();
    assert.equal(sync.mock.callCount(), 1);
    room.snapshot = null;
    assert.equal(
      audio.src,
      '',
      'explicit room cleanup synchronously removes old audio',
    );
    assert.equal(audio.paused, true);
    renderer.render(null, root);
    document.dispatchEvent(new Event('visibilitychange'));
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(
      sync.mock.callCount(),
      1,
      'unmount removes media/document listeners',
    );
  } finally {
    renderer.render(null, root);
    room.close();
    for (const [key, descriptor] of [
      ['Audio', originalAudio],
      ['document', originalDocument],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

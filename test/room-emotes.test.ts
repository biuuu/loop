import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPinia, setActivePinia } from 'pinia';
import { Server, type Socket } from 'socket.io';
import { createRoomEmotes } from '../src/client/room-emotes';
import { useRoom } from '../src/client/room';
import {
  EMOTE_DURATION_MS,
  type Ack,
  type ClientEvents,
  type Guest,
  type Participant,
  type RoomEmote,
  type RoomSnapshot,
  type ServerEvents,
} from '../src/shared/contracts';

test('emotes use the local receipt time for exactly three seconds', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 100_000);
  const expected = { id: 'nahida-1', receivedAt: 100_000, expiresAt: 103_000 };
  assert.equal(EMOTE_DURATION_MS, 3000);
  assert.equal(emotes.get('a', 99_999), undefined);
  assert.deepEqual(emotes.get('a', 100_000), expected);
  assert.deepEqual(emotes.get('a', 102_999), expected);
  assert.equal(emotes.get('a', 103_000), undefined);
  assert.equal(emotes.get('a', 100_000), undefined);
});

test('a new event replaces the same cat and survives the previous deadline', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 0);
  emotes.receive({ userId: 'a', id: 'nahida-2' }, 2000);
  assert.deepEqual(emotes.get('a', 3000), {
    id: 'nahida-2',
    receivedAt: 2000,
    expiresAt: 5000,
  });
  assert.equal(emotes.get('a', 5000), undefined);
});

test('an active image keeps its original URL through a catalog edit until it expires', () => {
  const emotes = createRoomEmotes();
  emotes.receive(
    { userId: 'a', id: 'nahida-1' },
    100,
    'https://img.nga.cn/a.gif',
  );
  assert.equal(emotes.get('a', 150)?.url, 'https://img.nga.cn/a.gif');
  assert.equal(emotes.get('a', 3100), undefined);
});

test('repeating the same preset starts a fresh local display interval', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 10);
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 2010);
  assert.deepEqual(emotes.get('a', 3010), {
    id: 'nahida-1',
    receivedAt: 2010,
    expiresAt: 5010,
  });
});

test('two cats keep independent values and expire lazily without timers', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-3' }, 0);
  emotes.receive({ userId: 'b', id: 'nahida-4' }, 1000);
  assert.equal(emotes.get('a', 3000), undefined);
  assert.equal(emotes.get('b', 3000)?.id, 'nahida-4');
  assert.equal(emotes.get('b', 4000), undefined);
});

test('retaining room members preserves active deadlines and prunes departures', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 100);
  emotes.receive({ userId: 'b', id: 'nahida-2' }, 200);
  const original = emotes.get('a', 300);
  emotes.retain(['a', 'b', 'new']);
  assert.equal(emotes.get('a', 1000), original);
  emotes.retain(new Set(['a']));
  assert.equal(emotes.get('a', 2000), original);
  assert.equal(emotes.get('b', 2000), undefined);
  emotes.retain([]);
  assert.equal(emotes.get('a', 2000), undefined);
});

test('clearing for a new identity or connection never replays past events', () => {
  const emotes = createRoomEmotes();
  for (let i = 0; i < 2; i++) {
    emotes.receive({ userId: 'a', id: 'nahida-1' }, 100);
    emotes.receive({ userId: 'b', id: 'nahida-2' }, 100);
    emotes.clear();
    emotes.retain(['a', 'b']);
    assert.equal(emotes.get('a', 200), undefined);
    assert.equal(emotes.get('b', 200), undefined);
  }
});

test('invalid local clocks and malformed events cannot replace valid events', () => {
  const emotes = createRoomEmotes();
  emotes.receive({ userId: 'a', id: 'nahida-1' }, 100);
  for (const now of [NaN, Infinity, -Infinity]) {
    emotes.receive({ userId: 'a', id: 'nahida-2' }, now);
    assert.equal(emotes.get('a', now), undefined);
  }
  for (const event of [
    { userId: 'a', id: '' },
    { userId: '', id: 'nahida-1' },
    { userId: '   ', id: 'nahida-1' },
    null,
  ])
    emotes.receive(event as RoomEmote, 200);
  assert.deepEqual(emotes.get('a', 300), {
    id: 'nahida-1',
    receivedAt: 100,
    expiresAt: 3100,
  });
  assert.equal(emotes.get('', 300), undefined);
  assert.equal(emotes.get('   ', 300), undefined);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Store update timed out');
    await delay(5);
  }
}

function participant(id: string): Participant {
  return {
    id,
    nickname: id,
    x: 300,
    y: 400,
    targetX: 300,
    targetY: 400,
    movingSince: 0,
    durationMs: 0,
    connected: true,
    seat: null,
  };
}

test('the actual store receives only live events and clears them across membership and connection changes', async (context) => {
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
  const originalFetch = globalThis.fetch;
  const guest: Guest = { id: 'a', nickname: 'a' };
  let state: RoomSnapshot = {
    revision: 1,
    serverTime: Date.now() + 60_000,
    users: [participant('a'), { ...participant('b'), sleepAt: 1 }],
    stage: [],
    playback: null,
    resolving: false,
    notice: null,
    capacity: 30,
    stageCapacity: 6,
  };
  const peers: Socket<ClientEvents, ServerEvents>[] = [];
  const commands: { id: string; ack: (result: Ack) => void }[] = [];
  server.on('connection', (peer) => {
    peers.push(peer);
    peer.on('room:sync', (ack) => ack(state));
    peer.on('room:emote', ({ id }, ack) => commands.push({ id, ack }));
  });
  globalThis.fetch = async (input) => {
    if (input === '/api/me') return Response.json({ guest });
    if (input === '/api/playlist')
      return Response.json({ slot: 1, count: 1, tracks: [], revision: 0 });
    if (input === '/api/emotes')
      return Response.json({ enabled: true, revision: 0, groups: [] });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  setActivePinia(createPinia());
  const room = useRoom();
  const snapshot = (users = state.users) => {
    state = { ...state, revision: state.revision + 1, users };
    peers.at(-1)!.emit('room:snapshot', state);
  };
  try {
    await room.initialize();
    void room.connect();
    await waitFor(() => room.snapshot !== null);
    assert.ok(room.offset > 50_000, 'server clock differs from local clock');
    const before = Date.now();
    const previous = state;
    const sleepAt = state.serverTime + 130_000;
    state = {
      ...state,
      revision: state.revision + 1,
      users: [state.users[0]!, { ...state.users[1]!, sleepAt }],
    };
    peers[0]!.emit('room:emote', {
      userId: 'b',
      id: 'nahida-2',
      activity: { sleepAt, revision: state.revision },
    });
    await waitFor(() => room.emoteFor('b') !== undefined);
    const first = room.emoteFor('b')!;
    assert.ok(first.receivedAt >= before && first.receivedAt <= Date.now());
    assert.equal(first.expiresAt - first.receivedAt, 3000);
    assert.equal('emote' in room.snapshot!.users[1]!, false);
    assert.equal(room.snapshot!.users[1]!.sleepAt, sleepAt);
    assert.equal(room.snapshot!.revision, state.revision);
    peers[0]!.emit('room:snapshot', previous);
    await delay(20);
    assert.equal(room.snapshot!.users[1]!.sleepAt, sleepAt);
    snapshot();
    await waitFor(() => room.snapshot?.revision === state.revision);
    assert.equal(room.emoteFor('b'), first);
    room.sync();
    await delay(20);
    assert.equal(room.emoteFor('b'), first);
    peers[0]!.emit('room:emote', { userId: 'unknown', id: 'nahida-1' });
    snapshot(
      state.users.map((user) => ({ ...user, connected: user.id === 'a' })),
    );
    await waitFor(() => !room.snapshot!.users[1]!.connected);
    assert.equal(room.emoteFor('b'), undefined);
    assert.equal(room.emoteFor('unknown'), undefined);
    peers[0]!.emit('room:emote', { userId: 'b', id: 'nahida-1' });
    await delay(20);
    assert.equal(room.emoteFor('b'), undefined);
    snapshot(state.users.map((user) => ({ ...user, connected: true })));
    await waitFor(() => room.snapshot!.users[1]!.connected);
    assert.equal(room.emoteFor('b'), undefined);

    room.emote('nahida-1');
    await waitFor(() => commands.length === 1);
    assert.equal(room.emoteFor('a'), undefined, 'no optimistic second display');
    peers[0]!.emit('room:emote', { userId: 'a', id: 'nahida-1' });
    await waitFor(() => room.emoteFor('a') !== undefined);
    commands[0]!.ack({ ok: true });
    peers[0]!.disconnect();
    await waitFor(() => room.connection === 'disconnected');
    assert.equal(room.emoteFor('a'), undefined);
    room.emote('nahida-2');
    room.connect();
    await waitFor(() => peers.length === 2 && room.snapshot !== null);
    assert.equal(room.emoteFor('a'), undefined);
    await delay(20);
    assert.equal(commands.length, 1, 'offline sends are never queued');
    peers[1]!.emit('room:emote', { userId: 'b', id: 'nahida-3' });
    await waitFor(() => room.emoteFor('b') !== undefined);
    peers[1]!.emit('room:replaced');
    await waitFor(() => room.connection === 'replaced');
    assert.equal(room.emoteFor('b'), undefined);
    assert.equal(room.snapshot, null);
    room.connect();
    await waitFor(() => peers.length === 3 && room.snapshot !== null);
    peers[2]!.emit('room:emote', { userId: 'a', id: 'nahida-1' });
    await waitFor(() => room.emoteFor('a') !== undefined);
    room.close();
    assert.equal(room.emoteFor('a'), undefined);
  } finally {
    room.close();
    globalThis.fetch = originalFetch;
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

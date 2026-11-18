import assert from 'node:assert/strict';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createServer } from '../src/server/app';
import type { MusicService, Track } from '../src/shared/contracts';
const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/a.mp3',
    durationMs: 60000,
  }),
};
test('real multi-room sockets isolate scoped snapshots, movement, emotes, queues and owner moderation', async (context) => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    await app.close();
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Sandbox forbids TCP listeners');
      return;
    }
    throw error;
  }
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const peers: ReturnType<typeof io>[] = [];
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    for (const user of [a, b])
      db.sql
        .prepare('INSERT INTO auth_identities VALUES (?,?,?,?)')
        .run(
          user.guest.id,
          'email',
          `${user.guest.nickname}@example.com`,
          Date.now(),
        );
    const one = db.createRoom(a.guest.id, 'One', 'cozy'),
      two = db.createRoom(b.guest.id, 'Two', 'cozy');
    const open = async (token: string, roomId: string) => {
      const peer = io(origin, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
        extraHeaders: { cookie: `loop_guest=${token}` },
        auth: { roomId },
      });
      peers.push(peer);
      const events: Array<[string, any]> = [];
      peer.onAny((name, payload) => events.push([name, payload]));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('socket timeout')),
          2000,
        );
        peer.once('room:snapshot', () => {
          clearTimeout(timer);
          resolve();
        });
        peer.once('connect_error', reject);
        peer.connect();
      });
      await peer.timeout(1000).emitWithAck('room:sync');
      return { peer, events };
    };
    const first = await open(a.token, one.id),
      second = await open(b.token, two.id);
    first.events.length = 0;
    second.events.length = 0;
    const motion = {
      x: 300,
      y: 400,
      targetX: 450,
      targetY: 400,
      facingRight: true,
      clientMoveId: 1,
    };
    assert.equal(
      (await first.peer.timeout(1000).emitWithAck('room:motion', motion)).ok,
      true,
    );
    assert.equal(
      (
        await first.peer
          .timeout(1000)
          .emitWithAck('room:emote', { id: 'nahida-4' })
      ).ok,
      true,
    );
    db.add(a.guest.id, track);
    db.add(a.guest.id, { ...track, id: '2' });
    assert.equal(
      (await first.peer.timeout(1000).emitWithAck('stage:join', { seat: 0 }))
        .ok,
      true,
    );
    const current = await first.peer.timeout(1000).emitWithAck('room:sync');
    await second.peer.timeout(1000).emitWithAck('room:sync');
    assert.equal(current.roomId, one.id);
    assert.equal(current.room.ownerId, a.guest.id);
    assert.equal(current.playback.djId, a.guest.id);
    assert.equal(
      second.events.length,
      0,
      'unrelated room receives no movement, emote, playback or private queue',
    );
    assert.ok(first.events.some(([name]) => name === 'playlist:reordered'));
    for (const [name, event] of first.events)
      if (name !== 'playlist:reordered') assert.equal(event.roomId, one.id);
    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${one.id}`,
      headers: { cookie: `loop_guest=${b.token}` },
      payload: { name: 'stolen', expectedRevision: one.revision },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(
      (await first.peer.timeout(1000).emitWithAck('room:leave')).ok,
      true,
    );
    const state = await second.peer.timeout(1000).emitWithAck('room:sync');
    assert.equal(state.roomId, two.id);
    assert.equal(state.users.length, 1);
  } finally {
    peers.forEach((peer) => peer.disconnect());
    await app.close();
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import type { Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createServer } from '../src/server/app.js';
import { hashToken, Store } from '../src/server/db.js';
import {
  readRoomCheckpoint,
  ROOM_CHECKPOINT_MAX_AGE_MS,
  type RoomCheckpoint,
} from '../src/server/room-checkpoint.js';
import { catSleepDelay } from '../src/shared/cat-activity.js';
import type {
  Guest,
  MusicService,
  RoomSnapshot,
  Track,
} from '../src/shared/contracts.js';

const track = (id: string): Track => ({
  id,
  title: `Track ${id}`,
  artist: 'Artist',
  cover: '',
  album: '',
  durationMs: 60_000,
});
const music: MusicService = {
  search: async () => [],
  detail: async (id) => track(id),
  resolve: async (song) => ({
    url: `https://example.com/${song.id}.mp3`,
    durationMs: song.durationMs,
  }),
};
type Server = Awaited<ReturnType<typeof createServer>>;
function attach(server: Server, roomId: string, guest: Guest, token: string) {
  const socket = {
    id: randomUUID(),
    join() {},
    leave() {},
    emit() {},
    disconnect() {},
  } as unknown as Socket;
  return {
    room: server.registry.connect(roomId, guest, socket, hashToken(token)),
    socket,
  };
}
function checkpoint(userId: string, now: number): RoomCheckpoint {
  return {
    savedAt: now,
    members: [{ id: userId, x: 480, y: 430, facingRight: true }],
    stage: [userId],
    playback: {
      roundId: randomUUID(),
      track: track('1'),
      djId: userId,
      url: 'https://example.com/1.mp3',
      startedAt: now,
      durationMs: 30_000,
      isTrial: true,
      lyricOffsetMs: 60_000,
    },
  };
}

test('graceful restart restores the current round, seek, queue and approximate positions', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const root = mkdtempSync(join(tmpdir(), 'loop-checkpoint-'));
  const dbPath = join(root, 'rooms.sqlite');
  let server: Server | undefined;
  let resolutions = 0;
  const testMusic: MusicService = {
    ...music,
    async resolve(song) {
      resolutions++;
      return song.id === '1'
        ? {
            url: 'https://example.com/preview.mp3',
            durationMs: 30_000,
            isTrial: true,
            lyricOffsetMs: 60_000,
          }
        : music.resolve(song);
    },
  };
  try {
    server = await createServer({ dbPath, music: testMusic });
    const owner = server.db.createUser('Owner');
    const dj = server.db.createGuest('DJ');
    const next = server.db.createGuest('Next');
    const audience = server.db.createGuest('Audience');
    const { id } = owner.createdRoom;
    server.db.add(dj.guest.id, track('1'));
    server.db.add(dj.guest.id, track('2'));
    server.db.add(next.guest.id, track('3'));
    const { room, socket: djSocket } = attach(server, id, dj.guest, dj.token);
    const { socket: nextSocket } = attach(server, id, next.guest, next.token);
    attach(server, id, audience.guest, audience.token);
    attach(server, id, owner.guest, owner.token);
    const returnPoint = { x: 580, y: 440 };
    await room.join(dj.guest.id, djSocket.id, undefined, returnPoint);
    await room.join(next.guest.id, nextSocket.id);
    const { roundId } = room.snapshot().playback!;
    const directory = server.db.roomsForDirectory();
    const queue = server.db.playlist(dj.guest.id);
    assert.deepEqual(
      queue.tracks.map(({ id }) => id),
      ['2', '1'],
    );

    now += 2_000;
    await room.seek(dj.guest.id, { roundId, positionMs: 12_000 }, djSocket.id);
    const playback = room.snapshot().playback!;
    assert.equal(playback.startedAt, now - 12_000);
    const closed = await server.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      headers: { cookie: `loop_guest=${owner.token}` },
      payload: { joinPolicy: 'closed', expectedRevision: 1 },
    });
    assert.equal(closed.statusCode, 200);

    room.motion(audience.guest.id, {
      x: 480,
      y: 410,
      targetX: 660,
      targetY: 410,
      facingRight: true,
      clientMoveId: 3,
    });
    now += 500;
    room.emote(owner.guest.id, { id: 'nahida-1' });
    const ownerSleepAt = now + catSleepDelay(owner.guest.id);
    const sleepAt = now + 500 + catSleepDelay(audience.guest.id);
    await server.app.close();
    server = undefined;

    now += 1_500;
    server = await createServer({ dbPath, music: testMusic });
    assert.equal(server.registry.runtimeCount(), 1);
    const restored = server.registry.snapshot(id);
    assert.deepEqual(restored.playback, playback);
    assert.equal(restored.serverTime - restored.playback!.startedAt, 14_000);
    assert.deepEqual(restored.stage, [dj.guest.id, next.guest.id]);
    assert.equal(
      restored.users.every((user) => !user.connected),
      true,
    );
    assert.equal(server.registry.summaries()[0]?.online, 0);
    assert.throws(() => server!.registry.admit(id, 'stranger'), /暂停新成员/);
    const position = restored.users.find(({ id }) => id === audience.guest.id)!;
    assert.deepEqual(
      [
        position.x,
        position.y,
        position.durationMs,
        position.facingRight,
        position.clientMoveId,
        position.sleepAt,
      ],
      [570, 410, 0, true, undefined, sleepAt],
    );
    assert.equal(
      restored.users.find(({ id }) => id === owner.guest.id)?.sleepAt,
      ownerSleepAt,
    );
    assert.deepEqual(server.db.playlist(dj.guest.id), queue);
    assert.equal(
      server.db.roomsForDirectory()[0]?.lastPlayedAt,
      directory[0]?.lastPlayedAt,
    );
    assert.equal(resolutions, 1);

    const restoredDJ = attach(server, id, dj.guest, dj.token);
    attach(server, id, next.guest, next.token);
    assert.deepEqual(restoredDJ.room.snapshot().playback, playback);
    await restoredDJ.room.leave(dj.guest.id, restoredDJ.socket.id);
    assert.equal(restoredDJ.room.snapshot().playback?.djId, next.guest.id);
    const down = restoredDJ.room
      .snapshot()
      .users.find(({ id }) => id === dj.guest.id)!;
    assert.deepEqual(
      [down.x, down.y, down.seat],
      [returnPoint.x, returnPoint.y, null],
    );
    assert.equal(down.sleepAt, now + catSleepDelay(dj.guest.id));
    assert.deepEqual(server.db.playlist(dj.guest.id), queue);
  } finally {
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('expired tracks advance the original queue only when someone reconnects, with stale and banned reservations removed', async (context) => {
  const now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const root = mkdtempSync(join(tmpdir(), 'loop-checkpoint-expired-'));
  const dbPath = join(root, 'rooms.sqlite');
  let server: Server | undefined;
  const db = new Store(dbPath);
  let resolutions = 0;
  try {
    const owner = db.createUser('Owner');
    const dj = db.createGuest('Original DJ');
    const next = db.createGuest('Next DJ');
    const excluded = db.createGuest('Banned');
    const expired = db.createGuest('Past grace');
    const stale = db.createUser('Old room');
    const { id } = owner.createdRoom;
    db.add(next.guest.id, track('2'));
    const saved = checkpoint(dj.guest.id, now - 35_000);
    saved.members.push(
      { ...saved.members[0]!, id: next.guest.id },
      { ...saved.members[0]!, id: excluded.guest.id },
      { ...saved.members[0]!, id: expired.guest.id, reconnectUntil: now - 1 },
    );
    saved.stage.push(next.guest.id, excluded.guest.id, expired.guest.id);
    db.saveRoomCheckpoint(id, saved);
    db.ban(id, excluded.guest.id);
    db.saveRoomCheckpoint(
      stale.createdRoom.id,
      checkpoint(stale.guest.id, now - ROOM_CHECKPOINT_MAX_AGE_MS - 1),
    );
    db.close();

    server = await createServer({
      dbPath,
      music: {
        ...music,
        async resolve(song) {
          resolutions++;
          return music.resolve(song);
        },
      },
    });
    assert.equal(server.registry.runtimeCount(), 1);
    const state = server.registry.snapshot(id);
    assert.deepEqual(state.stage, [next.guest.id, dj.guest.id]);
    assert.equal(state.playback, null);
    assert.equal(resolutions, 0);
    const { room } = attach(server, id, next.guest, next.token);
    const deadline = performance.now() + 1000;
    while (!room.snapshot().playback && performance.now() < deadline)
      await immediate();
    assert.equal(room.snapshot().playback?.track.id, '2');
    assert.equal(resolutions, 1);
  } finally {
    if (db.sql.open) db.close();
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint decoder rejects malformed, out-of-bounds and mismatched room state', () => {
  const saved = checkpoint('dj', 100_000);
  const decode = (value: object) =>
    readRoomCheckpoint(saved.savedAt, JSON.stringify(value));
  assert.deepEqual(decode(saved), saved);
  assert.equal(readRoomCheckpoint(saved.savedAt, '{broken'), null);
  assert.equal(
    decode({ ...saved, members: [{ ...saved.members[0], x: -20 }] }),
    null,
  );
  assert.equal(decode({ ...saved, stage: ['someone-else'] }), null);
  assert.equal(
    decode({
      ...saved,
      playback: { ...saved.playback, url: 'file:///music.mp3' },
    }),
    null,
  );
});

test('a failed playlist rotation rolls back the new checkpoint and room activity together', () => {
  const db = new Store(':memory:');
  try {
    const now = Date.now();
    const owner = db.createUser('Owner');
    const roomId = owner.createdRoom.id;
    const dj = owner.guest.id;
    db.add(dj, track('1'));
    db.add(dj, track('2'));
    const existing = checkpoint(dj, now - 1000);
    db.saveRoomCheckpoint(roomId, existing);
    const newRound = checkpoint(dj, now);
    const playlist = db.playlist(dj);
    db.sql.exec(`
      CREATE TRIGGER fail_rotation BEFORE UPDATE OF position ON playlist
        BEGIN SELECT RAISE(ABORT, 'test rotation failure'); END;
    `);

    assert.throws(
      () =>
        db.rotateTrack(dj, '1', {
          roomId,
          startedAt: now,
          checkpoint: newRound,
        }),
      /test rotation failure/,
    );
    assert.deepEqual(db.playlist(dj), playlist);
    assert.deepEqual(db.roomCheckpoints(now), [
      { roomId, checkpoint: existing },
    ]);
    assert.equal(db.roomsForDirectory()[0]?.lastPlayedAt, null);
  } finally {
    db.close();
  }
});

test('joining a different room releases the old restart reservation and deletes its empty checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-checkpoint-transfer-'));
  const dbPath = join(root, 'rooms.sqlite');
  const db = new Store(dbPath);
  let server: Server | undefined;
  try {
    const dj = db.createUser('DJ');
    const other = db.createUser('Other room');
    db.saveRoomCheckpoint(
      dj.createdRoom.id,
      checkpoint(dj.guest.id, Date.now()),
    );
    db.close();

    server = await createServer({ dbPath, music });
    assert.equal(
      server.registry.snapshot(dj.createdRoom.id).users[0]?.connected,
      false,
    );
    attach(server, other.createdRoom.id, dj.guest, dj.token);
    assert.equal(server.registry.runtimeCount(), 1);
    assert.throws(() => server!.registry.snapshot(dj.createdRoom.id), /已结束/);
    const saved = server.db.roomCheckpoints(Date.now());
    assert.deepEqual(
      saved.map(({ roomId }) => roomId),
      [other.createdRoom.id],
    );
    assert.deepEqual(saved[0]?.checkpoint.stage, []);
  } finally {
    if (db.sql.open) db.close();
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live socket reconnects after a server restart and syncs the same playing round', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const root = mkdtempSync(join(tmpdir(), 'loop-checkpoint-wire-'));
  const dbPath = join(root, 'rooms.sqlite');
  const db = new Store(dbPath);
  let server: Server | undefined;
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const owner = db.createUser('Owner');
    const { id } = owner.createdRoom;
    const saved = checkpoint(owner.guest.id, now - 10_000);
    db.saveRoomCheckpoint(id, saved);
    db.close();
    const launch = () =>
      createServer({
        dbPath,
        music: {
          ...music,
          resolve: async () => {
            throw new Error('A restored round must not resolve again');
          },
        },
      });
    server = await launch();
    try {
      await server.app.listen({ port: 0, host: '127.0.0.1' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      context.skip('Sandbox forbids TCP listeners');
      return;
    }
    const address = server.app.server.address();
    assert.ok(address && typeof address === 'object');
    socket = connect(`http://127.0.0.1:${address.port}`, {
      auth: { roomId: id },
      transports: ['websocket'],
      extraHeaders: { cookie: `loop_guest=${owner.token}` },
      reconnectionDelay: 25,
      reconnectionDelayMax: 100,
      randomizationFactor: 0,
    });
    const nextSnapshot = () =>
      new Promise<RoomSnapshot>((resolve, reject) => {
        const received = (state: RoomSnapshot) => {
          clearTimeout(timer);
          resolve(state);
        };
        const timer = setTimeout(() => {
          socket!.off('room:snapshot', received);
          reject(new Error('Room snapshot timed out'));
        }, 4000);
        socket!.once('room:snapshot', received);
      });
    const initial = await nextSnapshot();
    assert.deepEqual(initial.playback, saved.playback);
    const reconnected = nextSnapshot();
    // Attach the handler before shutting down so a fast reconnect cannot race it.
    await server.app.close();
    server = undefined;
    now += 2_000;
    server = await launch();
    await server.app.listen({ port: address.port, host: '127.0.0.1' });
    const restored = await reconnected;
    assert.deepEqual(restored.playback, saved.playback);
    assert.equal(
      restored.users.find(({ id }) => id === owner.guest.id)?.connected,
      true,
    );
    const sync = (await socket
      .timeout(1000)
      .emitWithAck('room:sync')) as RoomSnapshot;
    assert.deepEqual(sync.playback, saved.playback);
    assert.equal(sync.serverTime - sync.playback!.startedAt, 12_000);
  } finally {
    socket?.disconnect();
    await server?.app.close();
    if (db.sql.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

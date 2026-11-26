import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import {
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  type MusicService,
  type RoomDetails,
  type Track,
} from '../src/shared/contracts.js';

const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 15 * 60_000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: track.durationMs,
  }),
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });
const connection = (id: string) =>
  ({
    id,
    join() {},
    leave() {},
    emit() {},
    disconnect() {},
  }) as unknown as Socket;

test('migration 19 defaults existing and new rooms to ten minutes and persists zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-track-time-'));
  const path = join(root, 'rooms.sqlite');
  const previous = join(root, 'migrations');
  let db: Store | undefined;
  try {
    mkdirSync(previous);
    for (const name of readdirSync('migrations').filter((name) =>
      /^01[1-8]-.*\.sql$/.test(name),
    ))
      copyFileSync(join('migrations', name), join(previous, name));
    db = new Store(path, previous);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 18);
    const { createdRoom } = db.createUser('Owner');
    db.close();
    db = undefined;

    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 24);
    assert.equal(
      db.roomDetails(createdRoom.id)?.trackTimeLimitMinutes,
      DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    );
    const update = db.sql.prepare(
      'UPDATE rooms SET track_time_limit_minutes=? WHERE id=?',
    );
    for (const invalid of [-1, 1.5, 'limit', null, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => update.run(invalid, createdRoom.id), /constraint/i);
    assert.equal(
      db.updateRoom(createdRoom.id, createdRoom.revision, {
        ...createdRoom,
        trackTimeLimitMinutes: 0,
      }),
      true,
    );
    db.close();
    db = undefined;

    db = new Store(path);
    assert.equal(db.roomDetails(createdRoom.id)?.trackTimeLimitMinutes, 0);
    assert.equal(
      db.roomDetails(db.createUser('New').createdRoom.id)
        ?.trackTimeLimitMinutes,
      DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    );
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('track limits use owner settings, update live room metadata and apply to the following round', async () => {
  const { app, db, io, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createUser('Owner');
    const other = db.createUser('Other');
    const { id, number, revision } = owner.createdRoom;
    const url = `/api/rooms/${id}`;
    const patch = (
      payload: Record<string, unknown>,
      token: string | null = owner.token,
    ) =>
      app.inject({
        method: 'PATCH',
        url,
        headers: token === null ? undefined : headers(token),
        payload,
      });
    const limits = { trackTimeLimitMinutes: 1, expectedRevision: revision };
    assert.equal((await patch(limits, null)).statusCode, 401);
    assert.equal((await patch(limits, other.token)).statusCode, 403);
    for (const trackTimeLimitMinutes of [
      -1,
      1.5,
      '1',
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.equal(
        (await patch({ ...limits, trackTimeLimitMinutes })).statusCode,
        400,
      );

    const initial = await patch(limits);
    assert.equal(initial.statusCode, 200, initial.body);
    const configured = initial.json<{ room: RoomDetails }>().room;
    assert.equal(configured.trackTimeLimitMinutes, 1);
    assert.equal((await patch(limits)).statusCode, 409);
    assert.equal(registry.runtimeCount(), 0);

    const socket = connection('owner');
    const room = registry.connect(id, owner.guest, socket, 'test-hash');
    db.add(owner.guest.id, track);
    await room.join(owner.guest.id, socket.id);
    const before = registry.snapshot(id);
    assert.equal(before.room?.trackTimeLimitMinutes, 1);
    assert.ok(before.playback);
    assert.equal(before.playback.durationMs, 60_000);

    const broadcasts: Array<[unknown, string, unknown]> = [];
    io.to = ((channel: unknown) => ({
      emit: (event: string, payload: unknown) => {
        broadcasts.push([channel, event, payload]);
      },
    })) as typeof io.to;
    const changed = await patch({
      trackTimeLimitMinutes: 0,
      expectedRevision: configured.revision,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const saved = changed.json<{ room: RoomDetails }>().room;
    assert.equal(saved.trackTimeLimitMinutes, 0);
    assert.deepEqual(broadcasts, [[`room:${id}`, 'room:updated', saved]]);
    const after = registry.snapshot(id);
    assert.deepEqual(after.room, saved);
    assert.deepEqual(after.playback, before.playback);
    assert.deepEqual(after.stage, before.stage);

    await room.skip(
      owner.guest.id,
      { roundId: before.playback.roundId },
      socket.id,
    );
    assert.equal(room.snapshot().playback?.durationMs, track.durationMs);
    const rename = await patch({
      name: 'Renamed',
      expectedRevision: saved.revision,
    });
    assert.equal(rename.statusCode, 200, rename.body);
    const settings = await app.inject({
      url: `${url}/settings`,
      headers: headers(owner.token),
    });
    assert.equal(settings.statusCode, 200, settings.body);
    assert.deepEqual(settings.json(), rename.json());
    assert.equal(settings.json().room.trackTimeLimitMinutes, 0);
    assert.equal(
      db.roomDetails(other.createdRoom.id)?.trackTimeLimitMinutes,
      DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    );
    for (const path of [url, `/api/rooms/${number}`]) {
      const publicRoom = await app.inject(path);
      assert.equal(publicRoom.statusCode, 200, publicRoom.body);
      assert.equal(
        Object.hasOwn(publicRoom.json().room, 'trackTimeLimitMinutes'),
        false,
      );
    }
    const directory = await app.inject('/api/rooms');
    assert.equal(directory.statusCode, 200, directory.body);
    for (const item of directory.json().rooms)
      assert.equal(Object.hasOwn(item, 'trackTimeLimitMinutes'), false);
  } finally {
    await app.close();
  }
});

test('restored rooms retain the original round and read the persisted limit for the next round', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-track-time-runtime-'));
  const dbPath = join(root, 'rooms.sqlite');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({ dbPath, music });
    const { guest, createdRoom, token } = server.db.createUser('Owner');
    const { id, revision } = createdRoom;
    server.db.add(guest.id, track);
    const socket = connection('owner');
    const room = server.registry.connect(id, guest, socket, 'test-hash');
    await room.join(guest.id, socket.id);
    const playback = room.snapshot().playback;
    assert.ok(playback);
    assert.equal(
      playback.durationMs,
      DEFAULT_TRACK_TIME_LIMIT_MINUTES * 60_000,
    );
    const changed = await server.app.inject({
      method: 'PATCH',
      url: `/api/rooms/${id}`,
      headers: headers(token),
      payload: { trackTimeLimitMinutes: 2, expectedRevision: revision },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    await server.app.close();
    server = undefined;

    server = await createServer({ dbPath, music });
    assert.equal(server.registry.runtimeCount(), 1);
    const reconnect = connection('owner-reconnect');
    const restored = server.registry.connect(id, guest, reconnect, 'test-hash');
    assert.deepEqual(restored.snapshot().playback, playback);
    await restored.skip(guest.id, { roundId: playback.roundId }, reconnect.id);
    assert.equal(restored.snapshot().playback?.durationMs, 120_000);
  } finally {
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

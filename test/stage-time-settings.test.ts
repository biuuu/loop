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
  DEFAULT_STAGE_TIME_LIMIT_MINUTES,
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  MAX_STAGE_TIME_LIMIT_MINUTES,
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
  durationMs: 120_000,
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

test('migration 18 gives existing rooms a 120-minute limit and persists zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-stage-time-'));
  const path = join(root, 'rooms.sqlite');
  const previous = join(root, 'migrations');
  let db: Store | undefined;
  try {
    mkdirSync(previous);
    for (const name of readdirSync('migrations').filter((name) =>
      /^01[1-7]-.*\.sql$/.test(name),
    ))
      copyFileSync(join('migrations', name), join(previous, name));
    db = new Store(path, previous);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 17);
    const { createdRoom } = db.createUser('Owner');
    db.close();
    db = undefined;

    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 23);
    assert.deepEqual(db.roomDetails(createdRoom.id), {
      ...createdRoom,
      description: '',
      stageTimeLimitMinutes: DEFAULT_STAGE_TIME_LIMIT_MINUTES,
      trackTimeLimitMinutes: DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    });
    const update = db.sql.prepare(
      'UPDATE rooms SET stage_time_limit_minutes=? WHERE id=?',
    );
    for (const invalid of [
      -1,
      MAX_STAGE_TIME_LIMIT_MINUTES + 1,
      1.5,
      'limit',
      null,
    ])
      assert.throws(() => update.run(invalid, createdRoom.id), /constraint/i);
    assert.equal(
      db.updateRoom(createdRoom.id, createdRoom.revision, {
        ...createdRoom,
        stageTimeLimitMinutes: 0,
      }),
      true,
    );
    db.close();
    db = undefined;

    db = new Store(path);
    assert.equal(db.roomDetails(createdRoom.id)?.stageTimeLimitMinutes, 0);
    assert.equal(
      db.roomDetails(db.createUser('New').createdRoom.id)
        ?.stageTimeLimitMinutes,
      DEFAULT_STAGE_TIME_LIMIT_MINUTES,
    );
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner can save stage time limits through the existing settings revision and metadata event', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const { app, db, io, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createUser('Owner');
    const other = db.createUser('Other');
    const { id, number } = owner.createdRoom;
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
    const limits = { stageTimeLimitMinutes: 0, expectedRevision: 1 };
    assert.equal((await patch(limits, null)).statusCode, 401);
    assert.equal((await patch(limits, other.token)).statusCode, 403);
    for (const stageTimeLimitMinutes of [
      -1,
      MAX_STAGE_TIME_LIMIT_MINUTES + 1,
      1.5,
      '1',
      null,
    ])
      assert.equal(
        (await patch({ ...limits, stageTimeLimitMinutes })).statusCode,
        400,
      );

    const update = await patch(limits);
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(
      update.json<{ room: RoomDetails }>().room.stageTimeLimitMinutes,
      0,
    );
    assert.equal(
      (await patch({ ...limits, stageTimeLimitMinutes: 1 })).statusCode,
      409,
    );
    const rename = await patch({ name: 'Renamed', expectedRevision: 2 });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal(
      rename.json<{ room: RoomDetails }>().room.stageTimeLimitMinutes,
      0,
    );
    const maximum = await patch({
      stageTimeLimitMinutes: MAX_STAGE_TIME_LIMIT_MINUTES,
      expectedRevision: 3,
    });
    assert.equal(maximum.statusCode, 200, maximum.body);

    const socket = connection('owner');
    const room = registry.connect(id, owner.guest, socket, 'test-hash');
    db.add(owner.guest.id, track);
    await room.join(owner.guest.id, socket.id);
    const before = registry.snapshot(id);
    assert.equal(
      before.room?.stageTimeLimitMinutes,
      MAX_STAGE_TIME_LIMIT_MINUTES,
    );
    const broadcasts: Array<[unknown, string, unknown]> = [];
    io.to = ((channel: unknown) => ({
      emit: (event: string, payload: unknown) => {
        broadcasts.push([channel, event, payload]);
      },
    })) as typeof io.to;

    const changed = await patch({
      stageTimeLimitMinutes: 1,
      expectedRevision: 4,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const saved = changed.json<{ room: RoomDetails }>().room;
    assert.equal(saved.stageTimeLimitMinutes, 1);
    assert.deepEqual(broadcasts, [[`room:${id}`, 'room:updated', saved]]);
    assert.deepEqual(registry.snapshot(id), { ...before, room: saved });
    assert.equal(
      db.roomDetails(other.createdRoom.id)?.stageTimeLimitMinutes,
      DEFAULT_STAGE_TIME_LIMIT_MINUTES,
    );
    const settings = await app.inject({
      url: `${url}/settings`,
      headers: headers(owner.token),
    });
    assert.deepEqual(settings.json().room, saved);
    for (const path of [url, `/api/rooms/${number}`])
      assert.equal(
        Object.hasOwn(
          (await app.inject(path)).json().room,
          'stageTimeLimitMinutes',
        ),
        false,
      );
    assert.equal(
      (await app.inject('/api/rooms'))
        .json()
        .rooms.some((item: object) =>
          Object.hasOwn(item, 'stageTimeLimitMinutes'),
        ),
      false,
    );

    const roundId = before.playback!.roundId;
    now += 61_000;
    await room.skip(owner.guest.id, { roundId }, socket.id);
    assert.deepEqual(registry.snapshot(id).stage, []);
  } finally {
    await app.close();
  }
});

test('new and restored runtimes apply the persisted stage time limit', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const root = mkdtempSync(join(tmpdir(), 'loop-stage-time-runtime-'));
  const dbPath = join(root, 'rooms.sqlite');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({ dbPath, music });
    const { guest, createdRoom } = server.db.createUser('Owner');
    const { id, revision } = createdRoom;
    assert.equal(
      server.db.updateRoom(id, revision, {
        ...createdRoom,
        stageTimeLimitMinutes: 1,
      }),
      true,
    );
    server.db.add(guest.id, track);
    const socket = connection('owner');
    const room = server.registry.connect(id, guest, socket, 'test-hash');
    await room.join(guest.id, socket.id);
    now += 60_000;
    await room.skip(
      guest.id,
      { roundId: room.snapshot().playback!.roundId },
      socket.id,
    );
    assert.deepEqual(room.snapshot().stage, []);

    await room.join(guest.id, socket.id);
    const roundId = room.snapshot().playback!.roundId;
    now += 30_000;
    await server.app.close();
    server = undefined;

    now += 1_000;
    server = await createServer({ dbPath, music });
    assert.equal(server.registry.runtimeCount(), 1);
    const reconnect = connection('owner-reconnect');
    const restored = server.registry.connect(id, guest, reconnect, 'test-hash');
    assert.equal(restored.snapshot().playback?.roundId, roundId);
    now += 29_000;
    await restored.skip(guest.id, { roundId }, reconnect.id);
    assert.deepEqual(restored.snapshot().stage, []);
  } finally {
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

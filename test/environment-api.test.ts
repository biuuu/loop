import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import type { RoomRegistry } from '../src/server/room-registry.js';
import type {
  Guest,
  MusicService,
  RoomInfo,
  Track,
} from '../src/shared/contracts.js';
import { ENVIRONMENTS } from '../src/shared/environments.js';

const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: 60_000,
  }),
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });
let socketIndex = 0;
function connect(registry: RoomRegistry, roomId: string, guest: Guest) {
  const id = `environment-${++socketIndex}`;
  const socket = {
    id,
    join: () => {},
    leave: () => {},
    emit: () => {},
    disconnect() {
      registry.disconnect(roomId, guest.id, id);
    },
  } as unknown as Socket;
  return { room: registry.connect(roomId, guest, socket, 'test-hash'), socket };
}

test('room settings and bans survive reopening and preserve SQLite constraints', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-environment-store-'));
  let db: Store | undefined;
  try {
    const path = join(root, 'rooms.sqlite');
    db = new Store(path);
    const owner = db.createGuest('Owner'),
      other = db.createGuest('Other'),
      banned = db.createGuest('Banned');
    const first = db.createRoom(owner.guest.id, 'First', 'cozy', 2);
    const second = db.createRoom(other.guest.id, 'Second', 'seaside', 5);
    db.updateRoom(first.id, 1, {
      name: 'Saved',
      environmentId: 'greenhouse',
      joinPolicy: 'closed',
    });
    db.ban(first.id, banned.guest.id);
    db.ban(second.id, banned.guest.id);
    db.ban(second.id, owner.guest.id);
    db.add(owner.guest.id, track);
    db.add(owner.guest.id, { ...track, id: '2' });
    db.rotateTrack(owner.guest.id, '1');
    const rooms = db.rooms(),
      bans = db.sql
        .prepare('SELECT * FROM room_bans ORDER BY room_id,user_id')
        .all();
    const playlist = db.playlist(owner.guest.id);
    const identities = db.sql
      .prepare('SELECT * FROM sessions ORDER BY user_id')
      .all();
    db.close();
    db = undefined;
    db = new Store(path);
    assert.equal(db.sql.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.deepEqual(db.rooms(), rooms);
    assert.deepEqual(
      db.sql.prepare('SELECT * FROM room_bans ORDER BY room_id,user_id').all(),
      bans,
    );
    assert.deepEqual(db.playlist(owner.guest.id), playlist);
    assert.deepEqual(db.guest(owner.token), owner.guest);
    assert.deepEqual(db.guest(banned.token), banned.guest);
    assert.deepEqual(
      db.sql.prepare('SELECT * FROM sessions ORDER BY user_id').all(),
      identities,
    );
    assert.throws(
      () => db!.createRoom(owner.guest.id, 'Duplicate', 'cozy'),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db!.sql
          .prepare('UPDATE rooms SET environment_id=? WHERE id=?')
          .run('unknown', first.id),
      /CHECK/,
    );
    assert.throws(
      () =>
        db!.sql
          .prepare('UPDATE rooms SET stage_capacity=0 WHERE id=?')
          .run(first.id),
      /CHECK/,
    );
    assert.throws(
      () => db!.ban('missing-room', banned.guest.id),
      /FOREIGN KEY/,
    );
    assert.throws(() => db!.ban(first.id, 'missing-user'), /FOREIGN KEY/);
    db.deleteRoom(first.id);
    assert.deepEqual(db.bans(first.id), []);
    assert.equal(db.bans(second.id).length, 2);
    db.sql.prepare('DELETE FROM guests WHERE id=?').run(banned.guest.id);
    assert.equal(db.bans(second.id).length, 1);
    db.sql.prepare('DELETE FROM guests WHERE id=?').run(other.guest.id);
    assert.equal(db.room(second.id), null);
    assert.deepEqual(db.bans(second.id), []);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('environment API rejects unknown IDs and enforces owner identity and optimistic revisions', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const owner = db.createGuest('Owner'),
      other = db.createGuest('Other');
    for (const environmentId of [
      'unknown',
      'Cozy',
      '',
      null,
      1,
      { id: 'cozy' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: headers(owner.token),
        payload: { name: 'Invalid', environmentId },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(db.rooms().length, 0);
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(owner.token),
      payload: { name: 'Default' },
    });
    assert.equal(create.statusCode, 200, create.body);
    const room: RoomInfo = create.json().room;
    assert.equal(room.environmentId, 'cozy');
    const patch = (payload: object, token: string | undefined = owner.token) =>
      app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers: token ? headers(token) : {},
        payload,
      });
    for (const environmentId of ['unknown', 'Cozy', '', null, 1, ['cozy']])
      assert.equal(
        (await patch({ environmentId, expectedRevision: 1 })).statusCode,
        400,
      );
    assert.equal(
      (
        await patch(
          { environmentId: 'seaside', expectedRevision: 1 },
          other.token,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await patch({ environmentId: 'seaside', expectedRevision: 1 }, ''))
        .statusCode,
      401,
    );
    assert.equal((await patch({ environmentId: 'seaside' })).statusCode, 400);
    assert.deepEqual(db.room(room.id), room);
    const saved = await patch({
      environmentId: 'seaside',
      expectedRevision: 1,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().room.revision, 2);
    assert.equal(
      (await patch({ environmentId: 'rooftop', expectedRevision: 1 }))
        .statusCode,
      409,
    );
    assert.equal(db.room(room.id)!.environmentId, 'seaside');
    assert.equal(db.room(room.id)!.revision, 2);
  } finally {
    await app.close();
  }
});

test('every preset can be created and edited, persists after reopening and survives empty runtime release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-environment-api-')),
    dbPath = join(root, 'rooms.sqlite');
  let server = await createServer({ dbPath, music });
  try {
    const saved: Array<{ room: RoomInfo; owner: Guest }> = [];
    for (const [index, preset] of ENVIRONMENTS.entries()) {
      const owner = server.db.createGuest(`Owner ${index}`);
      const create = await server.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: headers(owner.token),
        payload: {
          name: preset.name,
          environmentId: preset.id,
          stageCapacity: index + 1,
        },
      });
      assert.equal(create.statusCode, 200, create.body);
      const room: RoomInfo = create.json().room;
      assert.equal(room.environmentId, preset.id);
      const next = ENVIRONMENTS[(index + 1) % ENVIRONMENTS.length]!;
      const edit = await server.app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers: headers(owner.token),
        payload: { environmentId: next.id, expectedRevision: 1 },
      });
      assert.equal(edit.statusCode, 200, edit.body);
      assert.equal(edit.json().room.environmentId, next.id);
      saved.push({ room: edit.json().room, owner: owner.guest });
    }
    assert.equal(server.registry.runtimeCount(), 0);
    await server.app.close();
    server = await createServer({ dbPath, music });
    const directory = (await server.app.inject('/api/rooms')).json()
      .rooms as RoomInfo[];
    for (const { room, owner } of saved) {
      assert.deepEqual(
        (await server.app.inject(`/api/rooms/${room.id}`)).json().room,
        room,
      );
      assert.equal(
        directory.find((item) => item.id === room.id)!.environmentId,
        room.environmentId,
      );
      const live = connect(server.registry, room.id, owner);
      assert.deepEqual(server.registry.snapshot(room.id).room, room);
      server.registry.leave(room.id, owner.id, live.socket.id);
      assert.equal(server.registry.runtimeCount(), 0);
      const reloaded = connect(server.registry, room.id, owner);
      assert.deepEqual(server.registry.snapshot(room.id).room, room);
      server.registry.leave(room.id, owner.id, reloaded.socket.id);
    }
  } finally {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live environment changes emit only room metadata in the correct room and preserve playback and movement', async () => {
  const { app, db, registry, io } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createGuest('Owner'),
      audience = db.createGuest('Audience'),
      other = db.createGuest('Other');
    const info = db.createRoom(owner.guest.id, 'Room', 'cozy', 3),
      otherInfo = db.createRoom(other.guest.id, 'Other', 'greenhouse');
    const live = connect(registry, info.id, owner.guest);
    connect(registry, info.id, audience.guest);
    const unrelated = connect(registry, otherInfo.id, other.guest);
    db.add(owner.guest.id, track);
    db.add(other.guest.id, track);
    await live.room.join(owner.guest.id, live.socket.id, 2);
    await unrelated.room.join(other.guest.id, unrelated.socket.id, 0);
    live.room.motion(audience.guest.id, {
      x: 200,
      y: 400,
      targetX: 700,
      targetY: 450,
      facingRight: true,
      clientMoveId: 7,
    });
    const before = registry.snapshot(info.id),
      beforeOther = registry.snapshot(otherInfo.id),
      playlist = db.playlist(owner.guest.id);
    const broadcasts: Array<{
      channel: unknown;
      event: string;
      payload: unknown;
    }> = [];
    io.to = ((channel: unknown) => ({
      emit: (event: string, payload: unknown) => {
        broadcasts.push({ channel, event, payload });
      },
    })) as typeof io.to;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${info.id}`,
      headers: headers(owner.token),
      payload: { environmentId: 'rooftop', expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const after = registry.snapshot(info.id),
      afterOther = registry.snapshot(otherInfo.id);
    assert.deepEqual(after.room, response.json().room);
    assert.deepEqual(after.users, before.users);
    assert.deepEqual(after.stage, before.stage);
    assert.deepEqual(after.playback, before.playback);
    assert.equal(after.resolving, before.resolving);
    assert.equal(after.stageCapacity, before.stageCapacity);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(db.playlist(owner.guest.id), playlist);
    assert.deepEqual(broadcasts, [
      {
        channel: `room:${info.id}`,
        event: 'room:updated',
        payload: response.json().room,
      },
    ]);
    assert.deepEqual(afterOther.room, beforeOther.room);
    assert.deepEqual(afterOther.users, beforeOther.users);
    assert.deepEqual(afterOther.stage, beforeOther.stage);
    assert.deepEqual(afterOther.playback, beforeOther.playback);
    assert.equal(afterOther.revision, beforeOther.revision);
  } finally {
    await app.close();
  }
});

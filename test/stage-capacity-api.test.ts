import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import type { RoomRegistry } from '../src/server/room-registry.js';
import {
  SCENE,
  stageSeatXs,
  type Guest,
  type MusicService,
  type RoomSnapshot,
  type Track,
} from '../src/shared/contracts.js';

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
  const id = `capacity-${++socketIndex}`;
  const socket = {
    id,
    join: () => {},
    leave: () => {},
    emit: () => {},
    disconnect() {
      registry.disconnect(roomId, guest.id, id);
    },
  } as unknown as Socket;
  const room = registry.connect(roomId, guest, socket, 'test-hash');
  return { room, socket };
}

test('SQLite accepts one to six stage seats and preserves capacities through reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-stage-store-'));
  const path = join(root, 'rooms.sqlite');
  let db: Store | undefined;
  try {
    db = new Store(path);
    const owner = db.createGuest('Legacy').guest;
    const id = randomUUID();
    db.sql
      .prepare(
        'INSERT INTO rooms (id,owner_user_id,name,environment_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, owner.id, 'Legacy', 'cozy', 1, 1);
    db.sql.prepare('INSERT INTO room_numbers (room_id) VALUES (?)').run(id);
    assert.equal(db.room(id)!.stageCapacity, 6);
    const other = db.createGuest('New').guest;
    const created = db.createRoom(other.id, 'New', 'cozy', 1);
    assert.equal(created.stageCapacity, 1);
    assert.equal(
      db.updateRoom(created.id, 1, {
        name: 'Rename',
        environmentId: 'cozy',
        joinPolicy: 'open',
      }),
      true,
    );
    assert.equal(
      db.room(created.id)!.stageCapacity,
      1,
      'settings edits that omit capacity preserve the stored capacity',
    );
    assert.throws(
      () =>
        db!.sql.prepare('UPDATE rooms SET stage_capacity=0 WHERE id=?').run(id),
      /CHECK/,
    );
    assert.throws(
      () =>
        db!.sql.prepare('UPDATE rooms SET stage_capacity=7 WHERE id=?').run(id),
      /CHECK/,
    );
    db.close();
    db = undefined;
    db = new Store(path);
    assert.equal(db.room(id)!.stageCapacity, 6);
    assert.equal(db.room(created.id)!.stageCapacity, 1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('room capacity API strictly validates integers, defaults new rooms to five seats, and requires owner identity', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const owner = db.createGuest('Owner'),
      other = db.createGuest('Other');
    for (const invalid of [0, 7, -1, 2.5, '3', null]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: headers(owner.token),
        payload: { name: 'Invalid', stageCapacity: invalid },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(db.rooms().length, 0);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/rooms',
          payload: { name: 'Anonymous', stageCapacity: 2 },
        })
      ).statusCode,
      401,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(owner.token),
      payload: { name: 'Default' },
    });
    assert.equal(created.statusCode, 200, created.body);
    const room = created.json().room;
    assert.equal(room.stageCapacity, 5);
    for (const invalid of [0, 7, 1.5, '2', null]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers: headers(owner.token),
        payload: { stageCapacity: invalid, expectedRevision: 1 },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    for (const identity of [undefined, headers(other.token)]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers: identity,
        payload: { stageCapacity: 2, expectedRevision: 1 },
      });
      assert.equal(response.statusCode, identity ? 403 : 401, response.body);
    }
    assert.equal(db.room(room.id)!.revision, 1);
    assert.equal(db.room(room.id)!.stageCapacity, 5);
  } finally {
    await app.close();
  }
});

test('created and edited room capacities persist, enforce revisions and initialize later empty-room runtimes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-stage-api-'));
  const dbPath = join(root, 'room.sqlite');
  let server = await createServer({ dbPath, music });
  try {
    const owner = server.db.createGuest('Owner');
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(owner.token),
      payload: { name: 'Three', stageCapacity: 3 },
    });
    assert.equal(create.statusCode, 200, create.body);
    const room = create.json().room;
    assert.equal(room.stageCapacity, 3);
    assert.equal(server.registry.runtimeCount(), 0);
    const patch = (revision: number, stageCapacity?: number) =>
      server.app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room.id}`,
        headers: headers(owner.token),
        payload: { name: 'Saved', stageCapacity, expectedRevision: revision },
      });
    assert.equal((await patch(1, 4)).statusCode, 200);
    assert.equal((await patch(1, 1)).statusCode, 409);
    assert.equal((await patch(2)).json().room.stageCapacity, 4);
    assert.equal(server.registry.runtimeCount(), 0);
    await server.app.close();
    server = await createServer({ dbPath, music });
    assert.equal(
      (await server.app.inject(`/api/rooms/${room.id}`)).json().room
        .stageCapacity,
      4,
    );
    assert.equal(
      (await server.app.inject('/api/rooms')).json().rooms[0].stageCapacity,
      4,
    );
    const live = connect(server.registry, room.id, owner.guest);
    assert.equal(live.room.snapshot().stageCapacity, 4);
    server.registry.leave(room.id, owner.guest.id, live.socket.id);
    assert.equal(server.registry.runtimeCount(), 0);
    assert.equal(
      connect(server.registry, room.id, owner.guest).room.snapshot()
        .stageCapacity,
      4,
    );
  } finally {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('occupied and disconnected reserved stage members prevent shrinking without persistence or runtime changes', async () => {
  const { app, db, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createGuest('Owner'),
      guest = db.createGuest('Guest');
    const info = db.createRoom(owner.guest.id, 'Room', 'cozy', 6);
    const a = connect(registry, info.id, owner.guest),
      b = connect(registry, info.id, guest.guest);
    for (const user of [owner, guest]) db.add(user.guest.id, track);
    await a.room.join(owner.guest.id, a.socket.id, 5);
    await b.room.join(guest.guest.id, b.socket.id, 3);
    for (const disconnected of [false, true]) {
      if (disconnected)
        registry.disconnect(info.id, guest.guest.id, b.socket.id);
      const before = registry.snapshot(info.id),
        saved = db.room(info.id);
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${info.id}`,
        headers: headers(owner.token),
        payload: {
          name: 'Should not save',
          stageCapacity: 1,
          expectedRevision: 1,
        },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /请先让.*下台/);
      assert.deepEqual(db.room(info.id), saved);
      const after = registry.snapshot(info.id);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.stage, before.stage);
      assert.deepEqual(after.users, before.users);
      assert.deepEqual(after.playback, before.playback);
    }
  } finally {
    await app.close();
  }
});

test('successful capacity edits broadcast a consistent remapped stage and leave other rooms unchanged', async () => {
  const { app, db, registry, io } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createGuest('Owner'),
      guest = db.createGuest('Guest'),
      other = db.createGuest('Other');
    const info = db.createRoom(owner.guest.id, 'Room', 'cozy', 6),
      otherInfo = db.createRoom(other.guest.id, 'Other', 'cozy', 1);
    const a = connect(registry, info.id, owner.guest),
      b = connect(registry, info.id, guest.guest),
      c = connect(registry, otherInfo.id, other.guest);
    for (const user of [owner, guest, other]) db.add(user.guest.id, track);
    await a.room.join(owner.guest.id, a.socket.id, 5);
    await b.room.join(guest.guest.id, b.socket.id, 0);
    await c.room.join(other.guest.id, c.socket.id, 0);
    const before = registry.snapshot(info.id),
      unrelated = registry.snapshot(otherInfo.id);
    const broadcasts: Array<{ channel: unknown; event: string; payload: any }> =
      [];
    io.to = ((channel: unknown) => ({
      emit: (event: string, payload: unknown) => {
        broadcasts.push({ channel, event, payload });
      },
    })) as typeof io.to;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${info.id}`,
      headers: headers(owner.token),
      payload: { stageCapacity: 2, expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json().room;
    assert.equal(result.stageCapacity, 2);
    assert.equal(result.revision, 2);
    const after = registry.snapshot(info.id);
    assert.deepEqual(
      after.stage,
      before.stage,
      'DJ turn order survives physical seat reassignment',
    );
    assert.deepEqual(after.playback, before.playback);
    assert.equal(after.resolving, before.resolving);
    assert.equal(after.stageCapacity, 2);
    assert.deepEqual(after.room, result);
    const occupied = after.users.filter((user) => user.seat !== null);
    assert.deepEqual(occupied.map((user) => user.seat).sort(), [0, 1]);
    for (const user of occupied) {
      assert.equal(user.x, stageSeatXs(2)[user.seat!]);
      assert.equal(user.targetX, user.x);
      assert.equal(user.y, SCENE.stageY);
      assert.equal(user.targetY, SCENE.stageY);
    }
    assert.ok(after.revision > before.revision);
    assert.deepEqual(
      broadcasts.map((item) => [item.channel, item.event]),
      [
        [`room:${info.id}`, 'room:snapshot'],
        [`room:${info.id}`, 'room:updated'],
      ],
    );
    const snapshot = broadcasts[0]!.payload as RoomSnapshot;
    assert.equal(snapshot.stageCapacity, 2);
    assert.deepEqual(snapshot.room, result);
    assert.deepEqual(broadcasts[1]!.payload, result);
    assert.deepEqual(registry.snapshot(otherInfo.id).users, unrelated.users);
    assert.deepEqual(
      registry.snapshot(otherInfo.id).playback,
      unrelated.playback,
    );
    assert.equal(registry.snapshot(otherInfo.id).stageCapacity, 1);
    const directory = (await app.inject('/api/rooms')).json().rooms;
    assert.equal(
      directory.find((room: { id: string }) => room.id === info.id)
        .stageCapacity,
      2,
    );
    assert.equal(
      directory.find((room: { id: string }) => room.id === otherInfo.id)
        .stageCapacity,
      1,
    );
    const audience = db.createGuest('Audience').guest;
    const d = connect(registry, otherInfo.id, audience);
    db.add(audience.id, track);
    await assert.rejects(d.room.join(audience.id, d.socket.id, 1), /舞台|上台/);
  } finally {
    await app.close();
  }
});

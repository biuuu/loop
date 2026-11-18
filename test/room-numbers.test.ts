import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import type { MusicService, Track } from '../src/shared/contracts.js';

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

test('SQLite reopening preserves room numbers, settings, bans and identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-room-numbers-persist-'));
  let db: Store | undefined;
  try {
    const path = join(root, 'rooms.sqlite');
    db = new Store(path);
    const owners = ['First', 'Second', 'Third'].map((name) =>
      db!.createGuest(name),
    );
    const rooms = owners.map(({ guest }, index) => {
      const room = db!.createRoom(
        guest.id,
        guest.nickname,
        'seaside',
        index + 1,
      );
      db!.sql
        .prepare('UPDATE rooms SET created_at=? WHERE id=?')
        .run([30, 10, 20][index], room.id);
      return room;
    });
    db.updateRoom(rooms[0]!.id, 1, {
      name: 'Saved name',
      environmentId: 'rooftop',
      joinPolicy: 'closed',
      stageCapacity: 4,
    });
    db.ban(rooms[0]!.id, owners[1]!.guest.id);
    db.ban(rooms[2]!.id, owners[0]!.guest.id);
    db.add(owners[0]!.guest.id, track);
    db.add(owners[0]!.guest.id, { ...track, id: '2' });
    db.rotateTrack(owners[0]!.guest.id, '1');
    const expected = db.rooms();
    assert.deepEqual(
      expected.map((room) => room.number),
      [2, 3, 1],
    );
    const tables = ['rooms', 'room_bans', 'guests', 'sessions', 'playlist'];
    const saved = tables.map((table) =>
      db!.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    db.close();
    db = undefined;
    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 11);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.deepEqual(db.rooms(), expected);
    for (const [index, table] of tables.entries())
      assert.deepEqual(
        db.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        saved[index],
      );
    for (const room of expected)
      assert.deepEqual(db.roomByNumber(room.number), room);
    for (const owner of owners)
      assert.deepEqual(db.guest(owner.token), owner.guest);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('room creation allocates numbers atomically and never reuses deleted numbers across reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-room-numbers-create-'));
  const path = join(root, 'rooms.sqlite');
  let db: Store | undefined;
  try {
    db = new Store(path);
    const owner = db.createGuest('Owner'),
      other = db.createGuest('Other');
    db.sql.exec(`CREATE TRIGGER reject_number BEFORE INSERT ON room_numbers
      BEGIN SELECT RAISE(ABORT, 'number allocation failed'); END`);
    assert.throws(
      () => db!.createRoom(owner.guest.id, 'Rejected', 'cozy'),
      /number allocation failed/,
    );
    assert.equal(
      (
        db.sql.prepare('SELECT COUNT(*) AS count FROM rooms').get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.deepEqual(db.sql.prepare('SELECT * FROM room_numbers').all(), []);
    db.sql.exec('DROP TRIGGER reject_number');
    const first = db.createRoom(owner.guest.id, 'First', 'cozy'),
      second = db.createRoom(other.guest.id, 'Second', 'greenhouse');
    assert.equal(first.number, 1);
    assert.equal(second.number, 2);
    assert.notEqual(first.id, second.id);
    assert.throws(
      () => db!.createRoom(owner.guest.id, 'Duplicate owner', 'cozy'),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db!.sql
          .prepare('INSERT INTO room_numbers (room_id) VALUES (?)')
          .run(first.id),
      /UNIQUE/,
    );
    assert.deepEqual(
      db
        .rooms()
        .map((room) => room.number)
        .sort(),
      [1, 2],
    );
    db.deleteRoom(second.id);
    assert.equal(db.roomByNumber(second.number), null);
    db.close();
    db = undefined;
    db = new Store(path);
    assert.deepEqual(db.roomByNumber(first.number), first);
    const third = db.createRoom(other.guest.id, 'Third', 'rooftop');
    assert.equal(third.number, 3);
    db.sql.prepare('DELETE FROM guests WHERE id=?').run(other.guest.id);
    assert.equal(db.roomByNumber(third.number), null);
    const replacement = db.createGuest('Replacement');
    assert.equal(
      db.createRoom(replacement.guest.id, 'Fourth', 'cozy').number,
      4,
    );
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    for (const invalid of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.equal(db.roomByNumber(invalid), null);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('numeric room reads preserve UUID identity and current metadata while management keeps UUID parameters', async () => {
  const { app, db, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createGuest('Owner');
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(owner.token),
      payload: {
        name: 'Numbered room',
        environmentId: 'seaside',
        stageCapacity: 3,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const info = created.json().room;
    assert.equal(info.number, 1);
    assert.match(info.id, /^[a-f0-9-]{36}$/);
    const socket = {
      id: 'numeric-room-owner',
      join: () => {},
      leave: () => {},
      emit: () => {},
      disconnect: () => {},
    } as unknown as Socket;
    registry.connect(info.id, owner.guest, socket, 'test-hash');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${info.id}`,
      headers: headers(owner.token),
      payload: {
        name: 'Current name',
        environmentId: 'rooftop',
        expectedRevision: 1,
      },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const numeric = await app.inject(`/api/rooms/${info.number}`),
      uuid = await app.inject(`/api/rooms/${info.id}`);
    assert.equal(numeric.statusCode, 200, numeric.body);
    assert.deepEqual(numeric.json(), uuid.json());
    assert.deepEqual(numeric.json().room, patch.json().room);
    const directory = (await app.inject('/api/rooms')).json().rooms;
    assert.equal(directory[0].number, info.number);
    assert.equal(directory[0].id, info.id);
    assert.equal(directory[0].online, 1);
    assert.equal(
      (await app.inject(`/api/rooms/${Number.MAX_SAFE_INTEGER}`)).statusCode,
      404,
    );
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/api/rooms/${info.number}`,
        headers: headers(owner.token),
        ...(method === 'PATCH'
          ? { payload: { name: 'Wrong', expectedRevision: 2 } }
          : {}),
      });
      assert.equal(
        response.statusCode,
        method === 'DELETE' ? 404 : 400,
        response.body,
      );
    }
    assert.equal(
      (
        await app.inject({
          url: `/api/rooms/${info.number}/members`,
          headers: headers(owner.token),
        })
      ).statusCode,
      400,
    );
    assert.equal(registry.snapshot(info.id).room!.number, info.number);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${info.id}`,
      headers: headers(owner.token),
    });
    assert.equal(deleted.statusCode, 404, deleted.body);
    assert.equal(
      (await app.inject(`/api/rooms/${info.number}`)).statusCode,
      200,
    );
    assert.equal((await app.inject(`/api/rooms/${info.id}`)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('room number aliases reject noncanonical and unsafe forms before database lookup', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const owner = db.createGuest('Owner');
    db.createRoom(owner.guest.id, 'One', 'cozy');
    let lookups = 0;
    const read = db.roomByNumber.bind(db);
    db.roomByNumber = (number) => {
      lookups++;
      return read(number);
    };
    for (const invalid of [
      '0',
      '-1',
      '01',
      '0001',
      '1.0',
      '1.5',
      '1e0',
      '+1',
      ' 1',
      '1 ',
      'NaN',
      'Infinity',
      '9007199254740992',
      '9007199254740993',
      '1'.repeat(80),
      'not-a-uuid',
    ]) {
      const response = await app.inject(
        `/api/rooms/${encodeURIComponent(invalid)}`,
      );
      assert.equal(response.statusCode, 400, `${invalid}: ${response.body}`);
    }
    assert.equal(lookups, 0);
    // Fastify rejects overlong route parameters before this handler runs.
    assert.equal(
      (await app.inject(`/api/rooms/${'1'.repeat(400)}`)).statusCode,
      404,
    );
    assert.equal(lookups, 0);
    assert.equal((await app.inject('/api/rooms/1')).statusCode, 200);
    assert.equal(lookups, 1);
  } finally {
    await app.close();
  }
});

test(
  'numeric and legacy page links load the production app shell for direct visits and refreshes',
  { skip: !existsSync('dist/client/index.html') },
  async () => {
    const { app } = await createServer({ dbPath: ':memory:', music });
    try {
      for (const path of ['/1', '/123/', '/rooms/123']) {
        const response = await app.inject(path);
        assert.equal(response.statusCode, 200, response.body);
        assert.match(String(response.headers['content-type']), /text\/html/);
        assert.match(response.body, /id="app"/);
      }
      assert.equal((await app.inject('/api/missing')).statusCode, 404);
    } finally {
      await app.close();
    }
  },
);

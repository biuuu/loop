import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { ACCESSORY_UNLOCK_COST } from '../src/shared/accessories.js';
import { CALICO_APPEARANCE } from '../src/shared/appearance.js';
import type {
  AccountProfile,
  MusicService,
  RoomSnapshot,
} from '../src/shared/contracts.js';
import {
  DAILY_DJ_THRESHOLD_MS,
  INITIAL_POINTS,
  type PointsState,
} from '../src/shared/points.js';

const music: MusicService = {
  search: async () => [],
  detail: async () => {
    throw new Error('No tracks in accessory tests');
  },
  resolve: async () => {
    throw new Error('No tracks in accessory tests');
  },
};
const bow = { chest: { id: 'bow', color: 'rose' } } as const;
const beret = { head: { id: 'beret' } } as const;

function cookie(token: string) {
  return { cookie: `loop_guest=${token}` };
}

function accessoryApi(app: Awaited<ReturnType<typeof createServer>>['app']) {
  return {
    profile: (headers: Record<string, string>) =>
      app
        .inject({ url: '/api/me', headers })
        .then((response) => response.json<{ guest: AccountProfile }>().guest),
    points: (headers: Record<string, string>) =>
      app
        .inject({ url: '/api/me/points', headers })
        .then((response) => response.json<PointsState>()),
    unlock: (
      headers: Record<string, string>,
      payload: Record<string, unknown>,
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/me/accessories/unlocks',
        headers,
        payload,
      }),
    equip: (
      headers: Record<string, string>,
      payload: Record<string, unknown>,
    ) =>
      app.inject({
        method: 'PATCH',
        url: '/api/me/accessories',
        headers,
        payload,
      }),
  };
}

test('accessory unlocks charge once per base item and equip checks account ownership, slots and colors', async (context) => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music,
    freeSpecialCoats: true,
  });
  context.after(() => app.close());
  const a = db.createGuest('Alice');
  const b = db.createGuest('Bob');
  const alice = cookie(a.token);
  const bob = cookie(b.token);
  const { profile, points, unlock, equip } = accessoryApi(app);
  const initial = await points(alice);

  assert.equal(initial.balance, INITIAL_POINTS);
  assert.equal(initial.unlockedAccessories, undefined);
  assert.equal(initial.freeSpecialCoats, true);
  assert.equal((await equip({}, bow)).statusCode, 401);
  assert.equal((await unlock({}, { id: 'bow' })).statusCode, 401);
  assert.equal((await equip(alice, bow)).statusCode, 403);
  for (const payload of [
    { head: { id: 'bow' } },
    { head: { id: 'beret', color: 'sage' } },
    { chest: { id: 'bow', color: 'blue' } },
    { chest: [{ id: 'bow' }, { id: 'scarf' }] },
    { face: { id: 'daisy' } },
  ])
    assert.equal((await equip(alice, payload)).statusCode, 400);
  assert.equal((await unlock(alice, { id: 'wizard-hat' })).statusCode, 400);
  assert.equal(
    (await unlock(alice, { id: 'bow', color: 'rose' })).statusCode,
    400,
  );

  db.sql
    .exec(`CREATE TRIGGER interrupt_accessory_unlock BEFORE INSERT ON accessory_unlocks
    BEGIN SELECT RAISE(ABORT, 'test inventory write failure'); END;`);
  assert.equal((await unlock(alice, { id: 'bow' })).statusCode, 500);
  assert.deepEqual(await points(alice), initial);
  db.sql.exec('DROP TRIGGER interrupt_accessory_unlock');

  const [purchase, repeat] = await Promise.all([
    unlock(alice, { id: 'bow' }),
    unlock(alice, { id: 'bow' }),
  ]);
  const paid = purchase.json<PointsState>();
  assert.equal(purchase.statusCode, 200);
  assert.equal(repeat.statusCode, 200);
  assert.equal(purchase.headers['cache-control'], 'no-store');
  assert.deepEqual(paid, repeat.json<PointsState>());
  assert.ok(paid.revision > initial.revision);
  assert.equal(paid.balance, INITIAL_POINTS - ACCESSORY_UNLOCK_COST);
  assert.deepEqual(paid.unlockedAccessories, ['bow']);
  assert.equal((await profile(alice)).accessories, undefined);
  assert.equal((await unlock(alice, { id: 'scarf' })).statusCode, 409);
  assert.equal((await equip(bob, bow)).statusCode, 403);
  assert.equal((await points(bob)).balance, INITIAL_POINTS);

  const saved = await equip(alice, bow);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(
    saved.json<{ guest: AccountProfile }>().guest.accessories,
    bow,
  );
  assert.equal((await equip(alice, { ...bow, ...beret })).statusCode, 403);
  assert.deepEqual((await profile(alice)).accessories, bow);
  const alternate = { chest: { id: 'bow', color: 'sage' } };
  assert.equal((await equip(alice, alternate)).statusCode, 200);
  assert.deepEqual((await profile(alice)).accessories, alternate);
  assert.equal((await equip(alice, {})).statusCode, 200);
  assert.deepEqual((await profile(alice)).accessories, {});
  assert.deepEqual(await points(alice), paid);

  const competing = await Promise.all([
    unlock(bob, { id: 'scarf' }),
    unlock(bob, { id: 'beret' }),
  ]);
  assert.deepEqual(
    competing.map(({ statusCode }) => statusCode).sort(),
    [200, 409],
  );
  assert.equal((await points(bob)).unlockedAccessories?.length, 1);
});

test('migration 29 preserves accounts, rooms and coat points and persists new accessories across restarts', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-accessories-migration-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const oldMigrations = join(root, 'migrations');
  cpSync('migrations', oldMigrations, {
    recursive: true,
    filter: (path) => basename(path) !== '029-accessories.sql',
  });
  const path = join(root, 'loop.sqlite');
  const old = new Store(path, oldMigrations);
  const date = Date.UTC(2026, 10, 27, 12);
  const { guest, token, createdRoom } = old.createUser('Owner');
  const { id } = guest;
  old.unlockAppearance(id, 'calico');
  old.updateAppearance(id, CALICO_APPEARANCE);
  for (let day = 0; day < ACCESSORY_UNLOCK_COST; day++) {
    const start = date - day * 86_400_000;
    old.recordDjPlayback(id, start, start + DAILY_DJ_THRESHOLD_MS + 1);
  }
  const previousPoints = old.points(id, date);
  old.close();

  const db = new Store(path);
  try {
    assert.equal(db.sql.pragma('user_version', { simple: true }), 29);
    assert.deepEqual(db.guest(token), {
      ...guest,
      appearance: CALICO_APPEARANCE,
    });
    assert.deepEqual(db.room(createdRoom.id), createdRoom);
    assert.deepEqual(db.points(id, date), previousPoints);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.equal(db.unlockAccessory(id, 'bow').balance, 0);
    db.updateAccessories(id, bow);
  } finally {
    db.close();
  }

  const restarted = new Store(path);
  try {
    assert.deepEqual(restarted.guest(token)?.accessories, bow);
    assert.deepEqual(restarted.unlockAccessory(id, 'bow').unlockedAccessories, [
      'bow',
    ]);
    assert.deepEqual(restarted.points(id).unlockedPresets, ['calico']);
    assert.equal(restarted.points(id).balance, 0);
  } finally {
    restarted.close();
  }
});

test('accessory updates stay in the active room and cleared gear stays cleared on reconnect and restart', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-accessory-room-'));
  const dbPath = join(root, 'loop.sqlite');
  let server = await createServer({ dbPath, music, disconnectGraceMs: 60_000 });
  context.after(async () => {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const alice = server.db.createUser('Alice');
  const bob = server.db.createUser('Bob');
  const observer = server.db.createGuest('Observer');
  const ownRoom = alice.createdRoom.id;
  const otherRoom = bob.createdRoom.id;
  const emitted: { channel: string; event: string; snapshot: RoomSnapshot }[] =
    [];
  context.mock.method(server.io, 'to', (channel: string) => ({
    emit(event: string, snapshot: RoomSnapshot) {
      emitted.push({ channel, event, snapshot });
    },
  }));

  let socketCount = 0;
  function connect(token: string, roomId: string) {
    const guest = server.db.guest(token);
    assert.ok(guest);
    const socket = {
      id: `socket-${++socketCount}`,
      join() {},
      disconnect() {},
    } as unknown as Socket;
    server.registry.connect(roomId, guest, socket, token);
    return socket.id;
  }
  const own = connect(alice.token, ownRoom);
  connect(observer.token, ownRoom);
  connect(bob.token, otherRoom);
  emitted.length = 0;
  const { equip, unlock } = accessoryApi(server.app);
  const headers = cookie(alice.token);
  const member = (snapshot = server.registry.snapshot(ownRoom)) => {
    assert.equal(snapshot.roomId, ownRoom);
    const guest = snapshot.users.find(({ id }) => id === alice.guest.id);
    assert.ok(guest);
    return guest;
  };
  function published() {
    assert.equal(emitted.length, 1);
    const publication = emitted.pop()!;
    assert.equal(publication.channel, `room:${ownRoom}`);
    assert.equal(publication.event, 'room:snapshot');
    return member(publication.snapshot);
  }

  assert.equal((await unlock(headers, { id: 'beret' })).statusCode, 200);
  assert.equal(member().accessories, undefined);
  assert.deepEqual(emitted, []);
  assert.equal((await equip(headers, beret)).statusCode, 200);
  const equipped = published();
  assert.deepEqual(equipped.accessories, beret);
  assert.equal('unlockedAccessories' in equipped, false);

  server.registry.disconnect(ownRoom, alice.guest.id, own);
  assert.equal(published().connected, false);
  assert.equal((await equip(headers, {})).statusCode, 200);
  assert.deepEqual(published().accessories, {});
  connect(alice.token, ownRoom);
  assert.deepEqual(published().accessories, {});
  assert.equal(
    server.registry.snapshot(otherRoom).users[0]!.accessories,
    undefined,
  );

  assert.equal((await equip(headers, beret)).statusCode, 200);
  assert.deepEqual(published().accessories, beret);
  await server.app.close();

  const offline = new Store(dbPath);
  try {
    offline.updateAccessories(alice.guest.id, {});
  } finally {
    offline.close();
  }
  server = await createServer({ dbPath, music, disconnectGraceMs: 60_000 });
  assert.deepEqual(member().accessories, {});
  assert.equal(member().connected, false);
  connect(alice.token, ownRoom);
  assert.deepEqual(member().accessories, {});
  assert.equal(member().connected, true);
});

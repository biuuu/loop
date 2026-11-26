import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'socket.io';
import { createServer } from '../src/server/app.js';
import { Store, hashToken } from '../src/server/db.js';
import {
  NICKNAME_CHANGE_COOLDOWN_MS,
  type MusicService,
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
    durationMs: track.durationMs,
  }),
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });

test('nickname cooldown survives a restart, applies to both endpoints, and allows edits at expiry', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const root = mkdtempSync(join(tmpdir(), 'loop-nickname-'));
  const dbPath = join(root, 'test.sqlite');
  const migrations = join(root, 'migrations');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    mkdirSync(migrations);
    for (const name of ['011-baseline.sql', '012-room-last-played.sql'])
      copyFileSync(join('migrations', name), join(migrations, name));
    const original = new Store(dbPath, migrations);
    let owner: ReturnType<Store['createUser']>;
    try {
      owner = original.createUser('Original');
      original.sql
        .prepare('INSERT INTO playlist VALUES (?,?,?,?)')
        .run(owner.guest.id, track.id, 0, JSON.stringify(track));
      original.sql
        .prepare('UPDATE guests SET playlist_revision=1 WHERE id=?')
        .run(owner.guest.id);
      original.sql
        .prepare('INSERT INTO guests (id,nickname,token_hash) VALUES (?,?,?)')
        .run('legacy', 'Legacy', hashToken('legacy-token'));
      assert.equal(original.sql.pragma('user_version', { simple: true }), 12);
    } finally {
      original.close();
    }
    const ownerHeaders = headers(owner.token);
    const patch = (nickname: string) =>
      server!.app.inject({
        method: 'PATCH',
        url: '/api/me/nickname',
        headers: ownerHeaders,
        payload: { nickname },
      });
    const legacy = (nickname: string) =>
      server!.app.inject({
        method: 'POST',
        url: '/api/guest',
        headers: ownerHeaders,
        payload: { nickname },
      });
    const profile = async (requestHeaders = ownerHeaders) =>
      (
        await server!.app.inject({ url: '/api/me', headers: requestHeaders })
      ).json().guest;

    server = await createServer({ dbPath, music });
    const firstApp = server.app;
    assert.equal(server.db.sql.pragma('user_version', { simple: true }), 26);
    const initial = await profile();
    assert.deepEqual(initial, { ...owner.guest, registered: false });
    const noChange = await patch(' Original ');
    assert.equal(noChange.statusCode, 200);
    assert.deepEqual(noChange.json(), { guest: initial });
    assert.equal(noChange.headers['set-cookie'], undefined);

    for (const requestHeaders of [{}, headers('unknown')]) {
      const response = await firstApp.inject({
        method: 'PATCH',
        url: '/api/me/nickname',
        headers: requestHeaders,
        payload: { nickname: 'Unauthorized' },
      });
      assert.equal(response.statusCode, 401);
    }
    for (const payload of [
      {},
      { nickname: '  ' },
      { nickname: '😺' },
      { nickname: 'a'.repeat(17) },
      { nickname: 'Target', id: 'legacy' },
    ]) {
      const response = await firstApp.inject({
        method: 'PATCH',
        url: '/api/me/nickname',
        headers: ownerHeaders,
        payload,
      });
      assert.equal(response.statusCode, 400);
    }

    const changed = await patch(' New name ');
    const availableAt = now + NICKNAME_CHANGE_COOLDOWN_MS;
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.headers['set-cookie'], undefined);
    const changedProfile = {
      ...initial,
      nickname: 'New name',
      nicknameChangeAvailableAt: availableAt,
    };
    assert.deepEqual(changed.json(), { guest: changedProfile });
    const blocked = {
      error: '两次昵称修改需间隔 7 天',
      nicknameChangeAvailableAt: availableAt,
    };
    const legacyBlocked = await legacy('Bypass');
    assert.equal(legacyBlocked.statusCode, 429);
    assert.deepEqual(legacyBlocked.json(), blocked);
    assert.equal(legacyBlocked.headers['retry-after'], '604800');

    const otherResponse = await server.app.inject({
      method: 'PATCH',
      url: '/api/me/nickname',
      headers: headers('legacy-token'),
      payload: { nickname: 'Independent' },
    });
    assert.equal(otherResponse.statusCode, 200, otherResponse.body);
    assert.equal(otherResponse.json().guest.id, 'legacy');
    assert.deepEqual(await profile(), changedProfile);

    await server.app.close();
    server = undefined;
    now = availableAt - 1;
    server = await createServer({ dbPath, music });
    assert.deepEqual(await profile(), changedProfile);
    const same = await legacy('New name');
    assert.equal(same.statusCode, 200);
    assert.equal(same.headers['set-cookie'], undefined);
    assert.deepEqual(same.json(), { guest: changedProfile });
    const tooSoon = await patch('Too soon');
    assert.equal(tooSoon.statusCode, 429);
    assert.equal(tooSoon.headers['retry-after'], '1');
    assert.deepEqual(tooSoon.json(), blocked);

    now = availableAt;
    const edits = await Promise.all([legacy('Legacy edit'), patch('New edit')]);
    assert.deepEqual(
      edits.map((response) => response.statusCode).sort(),
      [200, 429],
    );
    const success = edits.find((response) => response.statusCode === 200)!;
    const rejection = edits.find((response) => response.statusCode === 429)!;
    const named = success.json().guest.nickname;
    assert.equal(success.headers['set-cookie'], undefined);
    assert.deepEqual(success.json(), {
      guest: {
        ...changedProfile,
        nickname: named,
        nicknameChangeAvailableAt: now + NICKNAME_CHANGE_COOLDOWN_MS,
      },
    });
    assert.equal(
      rejection.json().nicknameChangeAvailableAt,
      now + NICKNAME_CHANGE_COOLDOWN_MS,
    );
    assert.deepEqual(await profile(), success.json().guest);
    assert.deepEqual(server.db.guest(owner.token), {
      ...owner.guest,
      nickname: named,
    });
    assert.deepEqual(server.db.playlist(owner.guest.id), {
      tracks: [track],
      revision: 1,
      slot: 1,
      count: 3,
    });
    assert.deepEqual(server.db.rooms(), [
      { ...owner.createdRoom, ownerNickname: named },
    ]);
    const listed = (await server.app.inject('/api/rooms')).json().rooms;
    assert.equal(listed[0].ownerNickname, named);
    assert.equal(Object.hasOwn(listed[0], 'nicknameChangeAvailableAt'), false);
    assert.equal(
      (await profile(headers('legacy-token'))).nickname,
      'Independent',
    );
  } finally {
    await server?.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('renaming a live participant updates their cat and the owned room metadata', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const { app, db, io, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const owner = db.createUser('Owner');
    const listener = db.createUser('Listener');
    const ownerRoom = owner.createdRoom;
    const listenerRoom = listener.createdRoom;
    const description = '一起听歌。';
    assert.equal(
      db.updateRoom(ownerRoom.id, ownerRoom.revision, {
        ...ownerRoom,
        description,
      }),
      true,
    );
    const ownerDetails = db.roomDetails(ownerRoom.id)!;
    const socket = (id: string) =>
      ({
        id,
        join: () => {},
        emit: () => {},
        disconnect: () => {},
      }) as unknown as Socket;
    registry.connect(
      ownerRoom.id,
      listener.guest,
      socket('listener'),
      'listener',
    );
    const current = registry.connect(
      listenerRoom.id,
      owner.guest,
      socket('owner'),
      'owner',
    );
    db.add(owner.guest.id, track);
    await current.join(owner.guest.id, 'owner');
    const before = registry.snapshot(listenerRoom.id);
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
    const patch = (nickname: string) =>
      app.inject({
        method: 'PATCH',
        url: '/api/me/nickname',
        headers: headers(owner.token),
        payload: { nickname },
      });
    assert.equal((await patch('New')).statusCode, 200);
    const after = registry.snapshot(listenerRoom.id);
    assert.deepEqual(after, {
      ...before,
      users: [{ ...before.users[0]!, nickname: 'New' }],
      revision: before.revision + 1,
    });
    assert.equal(
      registry.isCurrent(listenerRoom.id, owner.guest.id, 'owner'),
      true,
    );
    assert.deepEqual(broadcasts, [
      {
        channel: `room:${listenerRoom.id}`,
        event: 'room:snapshot',
        payload: after,
      },
      {
        channel: `room:${ownerRoom.id}`,
        event: 'room:updated',
        payload: { ...ownerDetails, ownerNickname: 'New' },
      },
    ]);
    broadcasts.length = 0;
    assert.equal((await patch('New')).statusCode, 200);
    assert.equal((await patch('Blocked')).statusCode, 429);
    assert.deepEqual(broadcasts, []);

    const active = socket('owner-next');
    registry.connect(ownerRoom.id, owner.guest, active, 'owner');
    broadcasts.length = 0;
    now += NICKNAME_CHANGE_COOLDOWN_MS;
    assert.equal((await patch('Again')).statusCode, 200);
    const home = registry.snapshot(ownerRoom.id);
    assert.equal(home.room!.ownerNickname, 'Again');
    assert.equal(home.room!.description, description);
    assert.deepEqual(broadcasts, [
      {
        channel: `room:${ownerRoom.id}`,
        event: 'room:snapshot',
        payload: home,
      },
    ]);
  } finally {
    await app.close();
  }
});

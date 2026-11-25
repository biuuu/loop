import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server/app.js';
import { createTextFilter, loadTextFilter } from '../src/server/text-filter.js';
import type { MusicService } from '../src/shared/contracts.js';

const textFilter = createTextFilter('qxcat\n纸月回声');
const music: MusicService = {
  search: async () => [],
  detail: async () => assert.fail('Track details should not be requested'),
  resolve: async () => assert.fail('Audio should not be resolved'),
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });

function assertBlocked(
  response: { statusCode: number; body: string; json: () => unknown },
  field: RegExp,
  submitted: string,
) {
  assert.equal(response.statusCode, 400, response.body);
  const body = response.json() as { error: string };
  assert.deepEqual(Object.keys(body), ['error']);
  assert.match(body.error, field);
  assert.doesNotMatch(body.error, /qxcat|纸月回声/i);
  assert.ok(!body.error.includes(submitted));
}

test('text matching handles UTF-8 list syntax, compatibility forms, and literal boundaries', () => {
  const blocked = createTextFilter(
    '\uFEFF  QxCat  \r\n  # comment word\r\n\r\n纸月回声\nCafé\nblue+moon',
  );
  for (const value of [
    '请听（ＱＸＣＡＴ）！',
    'qX\u200bcAt',
    '晚风里的纸月\uFE0F回声',
    'CAFE\u0301',
    'the blue+moon room',
  ])
    assert.equal(blocked(value), true, value);
  for (const value of [
    '',
    'comment word',
    'aQxCat',
    'QxCat2',
    'blueemoon',
    '纸月与回声',
  ])
    assert.equal(blocked(value), false, value);
});

test('configured word lists read UTF-8 once and report unreadable paths', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'loop-text-filter-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'terms.txt');
  assert.throws(() => loadTextFilter(path), { code: 'ENOENT' });

  writeFileSync(path, '纸月回声\n', 'utf8');
  const initial = loadTextFilter(path);
  assert.ok(initial);
  assert.equal(initial('晚风里的纸月回声'), true);

  writeFileSync(path, '另一条\n', 'utf8');
  assert.equal(initial('纸月回声'), true);
  assert.equal(loadTextFilter(path)?.('纸月回声'), false);
});

test('blocked signup nicknames create no account, session, or home and skip Netease requests', async (context) => {
  const userPlaylists = context.mock.fn(async () => {
    throw new Error('Netease user playlists should not be requested');
  });
  const playlist = context.mock.fn(async () => {
    throw new Error('Netease playlist should not be requested');
  });
  const { app, db } = await createServer({
    dbPath: ':memory:',
    textFilter,
    music: { ...music, userPlaylists, playlist },
  });
  context.after(() => app.close());

  const nickname = 'ＱｘＣＡＴ';
  const guest = await app.inject({
    method: 'POST',
    url: '/api/guest',
    payload: { nickname },
  });
  const imported = await app.inject({
    method: 'POST',
    url: '/api/guest/from-netease',
    payload: { userId: '123', playlistId: '7', playlistOffset: 0, nickname },
  });
  for (const response of [guest, imported]) {
    assertBlocked(response, /昵称/, nickname);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(userPlaylists.mock.callCount(), 0);
  assert.equal(playlist.mock.callCount(), 0);
  assert.deepEqual(db.sql.prepare('SELECT id FROM guests').all(), []);
  assert.deepEqual(db.sql.prepare('SELECT user_id FROM sessions').all(), []);
  assert.deepEqual(db.rooms(), []);

  const allowed = 'Ｆｏｒｅｓｔ猫';
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/guest',
    payload: { nickname: allowed },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().guest.nickname, allowed);
  assert.equal(accepted.json().createdRoom.name, `${allowed}的房间`);
});

test('both nickname edit routes reject matches without changes or broadcasts and accept a saved nickname', async (context) => {
  const { app, db, io } = await createServer({
    dbPath: ':memory:',
    textFilter,
    music,
  });
  context.after(() => app.close());

  const legacy = db.createUser('纸月回声猫');
  const broadcast = context.mock.method(io, 'to');
  const patch = (nickname: string) =>
    app.inject({
      method: 'PATCH',
      url: '/api/me/nickname',
      headers: headers(legacy.token),
      payload: { nickname },
    });
  const post = (nickname: string) =>
    app.inject({
      method: 'POST',
      url: '/api/guest',
      headers: headers(legacy.token),
      payload: { nickname },
    });

  for (const edit of [patch, post]) {
    const rejected = '夜里的纸月回声';
    assertBlocked(await edit(rejected), /昵称/, rejected);
    const unchanged = await edit(legacy.guest.nickname);
    assert.equal(unchanged.statusCode, 200, unchanged.body);
    assert.equal(unchanged.json().guest.nickname, legacy.guest.nickname);
    assert.equal(unchanged.headers['set-cookie'], undefined);
  }
  assert.deepEqual(db.guest(legacy.token), legacy.guest);
  assert.equal(db.nicknameChangeAvailableAt(legacy.guest.id), undefined);
  assert.deepEqual(db.rooms(), [legacy.createdRoom]);
  assert.equal(broadcast.mock.callCount(), 0);

  const allowed = '晴天猫';
  const edited = await patch(allowed);
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(db.guest(legacy.token)?.nickname, allowed);
});

test('room creation and settings reject changed matches and preserve existing room text', async (context) => {
  const { app, db, io } = await createServer({
    dbPath: ':memory:',
    textFilter,
    music,
  });
  context.after(() => app.close());

  const legacy = db.createGuest('Legacy owner');
  const create = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(legacy.token),
      payload: { name },
    });
  const owner = db.createUser('纸月回声');
  const room = owner.createdRoom;
  const legacyDescription = '来听纸月回声。';
  assert.equal(
    db.updateRoom(room.id, room.revision, {
      ...room,
      description: legacyDescription,
    }),
    true,
  );
  const before = db.roomDetails(room.id)!;
  const broadcast = context.mock.method(io, 'to');
  const patch = (
    changes: Record<string, unknown>,
    revision = before.revision,
  ) =>
    app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}`,
      headers: headers(owner.token),
      payload: { ...changes, expectedRevision: revision },
    });

  const blockedName = '不听纸月回声的夜晚';
  assertBlocked(await create(blockedName), /房间名/, blockedName);
  assert.deepEqual(
    db.rooms().map(({ id }) => id),
    [room.id],
  );
  assertBlocked(await patch({ name: blockedName }), /房间名/, blockedName);
  const blockedDescription = '今晚听 qx\u200bcat';
  assertBlocked(
    await patch({ name: '新房间', description: blockedDescription }),
    /简介/,
    blockedDescription,
  );
  assert.deepEqual(db.roomDetails(room.id), before);
  assert.equal(broadcast.mock.callCount(), 0);

  const unchanged = await patch({
    name: before.name,
    description: before.description,
    joinPolicy: 'closed',
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  const saved = unchanged.json().room;
  assert.equal(saved.name, before.name);
  assert.equal(saved.description, before.description);
  assert.equal(saved.joinPolicy, 'closed');

  const name = 'Ｆｏｒｅｓｔ 房间';
  const description = '欢迎进来。\n<x>一起听歌</x>';
  const updated = await patch({ name, description }, saved.revision);
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(db.roomDetails(room.id)?.name, name);
  assert.equal(db.roomDetails(room.id)?.description, description);
  const created = await create('橘猫客厅');
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().room.name, '橘猫客厅');
});

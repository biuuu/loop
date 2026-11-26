import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { io as connect } from 'socket.io-client';
import { Store, hashToken } from '../src/server/db.js';
import { createServer } from '../src/server/app.js';
import { catSleepDelay } from '../src/shared/cat-activity.js';
import type {
  Ack,
  MusicService,
  PlaybackState,
  PlaylistState,
  PlaylistOrder,
  RoomEmote,
  RoomMotion,
  RoomSnapshot,
  Track,
} from '../src/shared/contracts.js';
import { NICKNAME_CHANGE_COOLDOWN_MS, SCENE } from '../src/shared/contracts.js';
import {
  CALICO_APPEARANCE,
  CAT_APPEARANCE_PRESETS,
  DEFAULT_CAT_APPEARANCE,
  catAppearanceSchema,
  type CatAppearance,
} from '../src/shared/appearance.js';
import { INITIAL_POINTS } from '../src/shared/points.js';

function seedUnlockedAppearances(db: Store, guestId: string) {
  const unlock = db.sql.prepare(
    'INSERT INTO coat_unlocks (guest_id,pattern) VALUES (?,?)',
  );
  for (const { appearance } of CAT_APPEARANCE_PRESETS)
    unlock.run(guestId, appearance.pattern);
}

const track = (id: string): Track => ({
  id,
  title: 'Authoritative',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const music: MusicService = {
  search: async () => [track('1')],
  detail: async (id) => track(id),
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: 60_000,
  }),
};
test('guest appearance has schema defaults, checks enums and persists edits through rename and reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-appearance-'));
  const path = join(root, 'test.sqlite');
  let db = new Store(path);
  try {
    db.sql
      .prepare('INSERT INTO guests (id,nickname,token_hash) VALUES (?,?,?)')
      .run('legacy', 'Legacy', hashToken('legacy-token'));
    db.sql
      .prepare(
        'INSERT INTO points_ledger (guest_id,source,reference,delta) VALUES (?,?,?,?)',
      )
      .run('legacy', 'initial', 'account', INITIAL_POINTS);
    db.close();
    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 26);
    assert.deepEqual(
      db.guest('legacy-token')!.appearance,
      DEFAULT_CAT_APPEARANCE,
    );
    const fresh = db.createGuest('Fresh');
    assert.ok(catAppearanceSchema.safeParse(fresh.guest.appearance).success);
    assert.deepEqual(db.guest(fresh.token), fresh.guest);
    for (const column of ['coat', 'pattern']) {
      assert.throws(
        () =>
          db.sql
            .prepare(`UPDATE guests SET ${column}='invalid' WHERE id=?`)
            .run('legacy'),
        /CHECK/,
      );
      assert.throws(
        () =>
          db.sql
            .prepare(`UPDATE guests SET ${column}=NULL WHERE id=?`)
            .run('legacy'),
        /NOT NULL/,
      );
    }
    const appearance = CALICO_APPEARANCE;
    db.unlockAppearance('legacy', appearance.pattern);
    db.updateAppearance('legacy', appearance);
    assert.deepEqual(
      db.rename('legacy', 'Renamed').guest.appearance,
      appearance,
    );
    db.close();
    db = new Store(path);
    assert.deepEqual(db.guest('legacy-token'), {
      id: 'legacy',
      nickname: 'Renamed',
      appearance,
    });
    assert.deepEqual(db.guest(fresh.token), fresh.guest);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('all black and white coat variants preserve identities and playlists across reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-extra-coats-'));
  const path = join(root, 'test.sqlite');
  let db = new Store(path);
  try {
    const a = db.createGuest('Black'),
      b = db.createGuest('White');
    db.updateAppearance(a.guest.id, { coat: 'black', pattern: 'socks' });
    db.updateAppearance(b.guest.id, { coat: 'white', pattern: 'tabby' });
    for (const guest of [a.guest, b.guest]) {
      const insert = db.sql.prepare(
        'INSERT INTO playlist (guest_id,track_id,position,track_json) VALUES (?,?,?,?)',
      );
      insert.run(
        guest.id,
        '2',
        0,
        JSON.stringify({ ...track('2'), title: 'Preserve 原始 JSON' }),
      );
      insert.run(guest.id, '1', 1, JSON.stringify(track('1')));
    }
    const guestsBefore = db.sql
      .prepare('SELECT * FROM guests ORDER BY id')
      .all() as { id: string; token_hash: string }[];
    const playlistBefore = db.sql
      .prepare('SELECT * FROM playlist ORDER BY guest_id,position')
      .all();
    db.close();
    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 26);
    assert.equal(db.sql.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(
      db.sql.prepare('SELECT * FROM guests ORDER BY id').all(),
      guestsBefore,
    );
    assert.deepEqual(
      db.sql.prepare('SELECT * FROM playlist ORDER BY guest_id,position').all(),
      playlistBefore,
    );
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.equal(db.guest(a.token)!.appearance!.coat, 'black');
    assert.equal(db.guest(b.token)!.appearance!.coat, 'white');
    assert.throws(
      () =>
        db.sql
          .prepare(
            "INSERT INTO playlist (guest_id,track_id,position,track_json) VALUES ('missing','1',0,'{}')",
          )
          .run(),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        db.sql
          .prepare('INSERT INTO playlist SELECT * FROM playlist LIMIT 1')
          .run(),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db.sql
          .prepare('UPDATE guests SET token_hash=? WHERE id=?')
          .run(
            guestsBefore.find((row) => row.id === a.guest.id)!.token_hash,
            b.guest.id,
          ),
      /UNIQUE/,
    );
    db.updateAppearance(a.guest.id, { coat: 'pure_black', pattern: 'solid' });
    db.updateAppearance(b.guest.id, { coat: 'pure_white', pattern: 'socks' });
    db.close();
    db = new Store(path);
    assert.equal(db.guest(a.token)!.appearance!.coat, 'pure_black');
    assert.equal(db.guest(b.token)!.appearance!.coat, 'pure_white');
    assert.deepEqual(
      db.sql.prepare('SELECT * FROM playlist ORDER BY guest_id,position').all(),
      playlistBefore,
    );
    db.sql.prepare('DELETE FROM guests WHERE id=?').run(a.guest.id);
    assert.deepEqual(db.tracks(a.guest.id), []);
    assert.equal(db.tracks(b.guest.id).length, 2);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('appearance API authenticates, rejects unknown fields and only edits the cookie identity', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const { app, db } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    const appearance = CALICO_APPEARANCE;
    for (const cookie of [undefined, 'loop_guest=unknown']) {
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/me/appearance',
            headers: cookie ? { cookie } : {},
            payload: appearance,
          })
        ).statusCode,
        401,
      );
    }
    const create = async (nickname: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/guest',
        payload: { nickname },
      });
      return {
        guest: response.json().guest,
        headers: {
          cookie: (response.headers['set-cookie'] as string).split(';')[0]!,
        },
      };
    };
    const a = await create('A'),
      b = await create('B');
    assert.ok(catAppearanceSchema.safeParse(a.guest.appearance).success);
    assert.ok(catAppearanceSchema.safeParse(b.guest.appearance).success);
    const renameOnly = await app.inject({
      method: 'POST',
      url: '/api/guest',
      headers: a.headers,
      payload: { nickname: 'A renamed' },
    });
    assert.equal(renameOnly.statusCode, 200);
    assert.deepEqual(renameOnly.json().guest.appearance, a.guest.appearance);
    assert.equal(renameOnly.json().guest.id, a.guest.id);
    a.guest = renameOnly.json().guest;
    for (const payload of [
      {},
      { coat: 'blue', pattern: 'solid' },
      { coat: 'gray', pattern: 'spots' },
      { coat: 'white', pattern: 'red_point' },
      { coat: 'white', pattern: 'silver_shaded' },
      ...CAT_APPEARANCE_PRESETS.map(({ appearance }) => ({
        ...appearance,
        coat: 'pure_white',
      })),
      { coat: 'gray' },
      { ...appearance, id: b.guest.id },
      { ...appearance, nickname: 'B' },
      { appearance },
      { ...appearance, accessory: 'hat' },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/me/appearance',
            headers: a.headers,
            payload,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/me/appearance',
          headers: { ...a.headers, origin: 'https://evil.example' },
          payload: appearance,
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(
      (await app.inject({ url: '/api/me', headers: a.headers })).json().guest,
      a.guest,
    );
    seedUnlockedAppearances(db, a.guest.id);
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/me/appearance',
      headers: a.headers,
      payload: appearance,
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().guest, { ...a.guest, appearance });
    assert.deepEqual(
      (await app.inject({ url: '/api/me', headers: b.headers })).json().guest,
      b.guest,
    );
    now += NICKNAME_CHANGE_COOLDOWN_MS;
    const renamed = await app.inject({
      method: 'POST',
      url: '/api/guest',
      headers: a.headers,
      payload: { nickname: 'Renamed' },
    });
    assert.deepEqual(renamed.json().guest, {
      ...a.guest,
      nickname: 'Renamed',
      appearance,
      nicknameChangeAvailableAt: now + NICKNAME_CHANGE_COOLDOWN_MS,
    });
    for (const appearance of [
      { coat: 'pure_black', pattern: 'solid' },
      { coat: 'pure_white', pattern: 'solid' },
      ...CAT_APPEARANCE_PRESETS.slice(1).map(({ appearance }) => appearance),
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/me/appearance',
        headers: a.headers,
        payload: appearance,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().guest.appearance, appearance);
      assert.deepEqual(
        (await app.inject({ url: '/api/me', headers: a.headers })).json().guest
          .appearance,
        appearance,
      );
    }
  } finally {
    await app.close();
  }
});
test('tokens are hashed and identities and playlists survive reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-db-')),
    path = join(root, 'test.sqlite');
  let db = new Store(path);
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    db.add(a.guest.id, track('1'));
    db.add(a.guest.id, track('2'));
    assert.deepEqual(db.tracks(b.guest.id), []);
    assert.throws(() => db.order(a.guest.id, ['1', '1']));
    db.order(a.guest.id, ['2', '1']);
    assert.equal(db.firstTrack(a.guest.id)!.id, '2');
    db.rotateTrack(a.guest.id, '2');
    assert.deepEqual(db.playlist(a.guest.id), {
      tracks: [track('1'), track('2')],
      revision: 4,
      slot: 1,
      count: 3,
    });
    assert.notEqual(
      (
        db.sql
          .prepare('SELECT token_hash FROM guests WHERE id=?')
          .get(a.guest.id) as { token_hash: string }
      ).token_hash,
      a.token,
    );
    db.close();
    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 26);
    assert.deepEqual(db.guest(a.token), a.guest);
    assert.equal(db.firstTrack(a.guest.id)!.id, '1');
    assert.equal(db.playlist(a.guest.id).revision, 4);
    assert.deepEqual(
      db.tracks(a.guest.id).map((item) => item.id),
      ['1', '2'],
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('SQL migrations require contiguous versions, roll back a failed batch, and apply once', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-migrations-')),
    path = join(root, 'test.sqlite'),
    migrations = join(root, 'migrations');
  let db: Store | undefined;
  try {
    mkdirSync(migrations);
    copyFileSync(
      'migrations/011-baseline.sql',
      join(migrations, '011-baseline.sql'),
    );
    const migration13 = join(migrations, '013-follow-up.sql');
    writeFileSync(
      migration13,
      'CREATE TABLE rolled_back (value TEXT); INVALID SQL;',
    );
    assert.throws(() => new Store(path, migrations), /Missing migration 0?12/);
    writeFileSync(
      join(migrations, '012-marker.sql'),
      "CREATE TABLE migration_marker (value TEXT); INSERT INTO migration_marker VALUES ('version 12');",
    );
    assert.throws(() => new Store(path, migrations), /syntax error/i);
    const rolledBack = new Database(path, { readonly: true });
    try {
      assert.equal(rolledBack.pragma('user_version', { simple: true }), 0);
      assert.deepEqual(
        rolledBack.prepare('SELECT name FROM sqlite_schema').all(),
        [],
      );
    } finally {
      rolledBack.close();
    }

    writeFileSync(
      migration13,
      "INSERT INTO migration_marker VALUES ('version 13');",
    );
    db = new Store(path, migrations);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 13);
    const markers = [{ value: 'version 12' }, { value: 'version 13' }];
    assert.deepEqual(
      db.sql.prepare('SELECT value FROM migration_marker ORDER BY rowid').all(),
      markers,
    );
    db.close();
    db = new Store(path, migrations);
    assert.deepEqual(
      db.sql.prepare('SELECT value FROM migration_marker ORDER BY rowid').all(),
      markers,
    );
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('startup rejects unversioned data and unsupported schema versions without modifying the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-unsupported-db-'));
  try {
    for (const [version, error] of [
      [0, /Unversioned database is not empty/i],
      [1, /Unsupported database version 1; first supported version is 11/i],
      [10, /Unsupported database version 10; first supported version is 11/i],
      [27, /Database version 27 is newer than supported version 26/i],
    ] as const) {
      const path = join(root, `version-${version}.sqlite`);
      const fixture = new Database(path);
      try {
        fixture.exec(
          "CREATE TABLE saved_data (value TEXT); INSERT INTO saved_data VALUES ('keep me');",
        );
        fixture.pragma(`user_version = ${version}`);
      } finally {
        fixture.close();
      }
      const before = readFileSync(path);
      assert.throws(() => new Store(path), error);
      assert.deepEqual(readFileSync(path), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('DATABASE_PATH selects the default persistent database', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-env-')),
    previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(root, 'env.sqlite');
  const db = new Store();
  try {
    assert.equal(db.sql.name, process.env.DATABASE_PATH);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('deleting middle tracks normalizes order before appending', () => {
  const db = new Store(':memory:');
  try {
    const { guest } = db.createGuest('A');
    ['1', '2', '3', '4'].forEach((id) => db.add(guest.id, track(id)));
    db.remove(guest.id, '2');
    db.add(guest.id, track('5'));
    assert.deepEqual(
      db.tracks(guest.id).map((item) => item.id),
      ['1', '3', '4', '5'],
    );
    assert.deepEqual(
      db.sql
        .prepare(
          'SELECT position FROM playlist WHERE guest_id=? ORDER BY position',
        )
        .all(guest.id),
      [{ position: 0 }, { position: 1 }, { position: 2 }, { position: 3 }],
    );
  } finally {
    db.close();
  }
});
test('playlist edits and rotation use physical order with monotonic revisions and stable reads', () => {
  const db = new Store(':memory:');
  try {
    const { guest } = db.createGuest('A');
    const ids = () => db.playlist(guest.id).tracks.map((item) => item.id);
    assert.deepEqual(db.playlist(guest.id), {
      tracks: [],
      revision: 0,
      slot: 1,
      count: 3,
    });
    assert.equal(db.firstTrack(guest.id), null);
    ['1', '2', '3', '4'].forEach((id) => db.add(guest.id, track(id)));
    assert.equal(db.firstTrack(guest.id)!.id, '1');
    assert.equal(db.firstTrack(guest.id)!.id, '1');
    assert.equal(db.playlist(guest.id).revision, 4);
    db.rotateTrack(guest.id, '1');
    assert.deepEqual(ids(), ['2', '3', '4', '1']);
    db.order(guest.id, ['4', '3', '2', '1']);
    db.add(guest.id, track('5'));
    assert.equal(db.firstTrack(guest.id)!.id, '4');
    db.remove(guest.id, '4');
    assert.equal(db.firstTrack(guest.id)!.id, '3');
    db.remove(guest.id, '2');
    assert.deepEqual(ids(), ['3', '1', '5']);
    assert.equal(db.playlist(guest.id).revision, 9);
    const before = db.playlist(guest.id);
    db.add(guest.id, track('3'));
    db.remove(guest.id, 'absent');
    db.rotateTrack(guest.id, 'absent');
    db.order(guest.id, ids());
    assert.throws(() => db.order(guest.id, ['3', '3', '1']));
    assert.deepEqual(db.playlist(guest.id), before);
    ['3', '1', '5'].forEach((id) => db.remove(guest.id, id));
    assert.equal(db.firstTrack(guest.id), null);
    db.add(guest.id, track('6'));
    const single = db.playlist(guest.id);
    db.rotateTrack(guest.id, '6');
    assert.deepEqual(db.playlist(guest.id), single);
    assert.equal(db.firstTrack(guest.id)!.id, '6');
    assert.deepEqual(
      db.sql.prepare('SELECT pointer FROM guests WHERE id=?').get(guest.id),
      { pointer: 0 },
    );
  } finally {
    db.close();
  }
});
test('room playback timestamp rolls back if playlist rotation fails', () => {
  const db = new Store(':memory:');
  try {
    const { guest, createdRoom } = db.createUser('DJ');
    db.add(guest.id, track('1'));
    db.add(guest.id, track('2'));
    db.rotateTrack(guest.id, '1', { roomId: createdRoom.id, startedAt: 100 });
    const before = db.playlist(guest.id);
    db.sql
      .exec(`CREATE TRIGGER reject_rotation BEFORE UPDATE OF position ON playlist
      BEGIN SELECT RAISE(ABORT, 'playlist rotation failed'); END`);
    assert.throws(
      () =>
        db.rotateTrack(guest.id, '2', {
          roomId: createdRoom.id,
          startedAt: 200,
        }),
      /playlist rotation failed/,
    );
    assert.deepEqual(db.playlist(guest.id), before);
    assert.deepEqual(db.roomsForDirectory(), [
      { ...createdRoom, lastPlayedAt: 100 },
    ]);
  } finally {
    db.close();
  }
});
test('playlist order reads only IDs and revision, including when metadata is unavailable', () => {
  const db = new Store(':memory:');
  try {
    const { guest } = db.createGuest('A');
    assert.deepEqual(db.playlistOrder(guest.id), {
      ids: [],
      revision: 0,
      slot: 1,
    });
    ['1', '2', '3'].forEach((id) => db.add(guest.id, track(id)));
    db.rotateTrack(guest.id, '1');
    db.sql
      .prepare('UPDATE playlist SET track_json=? WHERE guest_id=?')
      .run('invalid metadata', guest.id);
    assert.deepEqual(db.playlistOrder(guest.id), {
      ids: ['2', '3', '1'],
      revision: 4,
      slot: 1,
    });
    assert.throws(() => db.playlist(guest.id));
    assert.throws(() => db.playlistOrder('missing'), /游客不存在/);
  } finally {
    db.close();
  }
});
test('HTTP validates input, secures identity and keeps playlists isolated', async () => {
  const { app } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    assert.equal((await app.inject({ url: '/api/playlist' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/guest',
          payload: { nickname: 'A', extra: 1 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/guest',
          headers: { origin: 'https://evil.example' },
          payload: { nickname: 'A' },
        })
      ).statusCode,
      403,
    );
    const guest = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'A' },
    });
    const cookie = guest.headers['set-cookie'] as string;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const headers = { cookie: cookie.split(';')[0]! };
    const added = await app.inject({
      method: 'POST',
      url: '/api/playlist',
      headers,
      payload: { id: '1' },
    });
    assert.equal(added.statusCode, 200);
    assert.equal(added.json().tracks[0].title, 'Authoritative');
    assert.equal(added.json().revision, 1);
    assert.deepEqual(
      (await app.inject({ url: '/api/playlist', headers })).json(),
      added.json(),
    );
    const addSecond = await app.inject({
      method: 'POST',
      url: '/api/playlist',
      headers,
      payload: { id: '2' },
    });
    assert.equal(addSecond.json().revision, 2);
    const ordered = await app.inject({
      method: 'PUT',
      url: '/api/playlist/order',
      headers,
      payload: { ids: ['2', '1'] },
    });
    assert.equal(ordered.json().revision, 3);
    assert.deepEqual(
      ordered.json().tracks.map((item: Track) => item.id),
      ['2', '1'],
    );
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/playlist/2',
      headers,
    });
    assert.deepEqual(removed.json(), {
      tracks: [track('1')],
      revision: 4,
      slot: 1,
      count: 3,
    });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist',
          headers,
          payload: { id: '2', url: 'https://evil.example' },
        })
      ).statusCode,
      400,
    );
    const other = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'B' },
    });
    assert.deepEqual(
      (
        await app.inject({
          url: '/api/playlist',
          headers: {
            cookie: (other.headers['set-cookie'] as string).split(';')[0]!,
          },
        })
      ).json(),
      { tracks: [], revision: 0, slot: 1, count: 3 },
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/playlist/order',
          headers,
          payload: { ids: [] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: '/api/audio?url=https://example.com' }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
test('upstream detail/search failures produce sanitized gateway errors', async () => {
  const { app } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music: {
      ...music,
      detail: async () => {
        throw new Error('private upstream detail');
      },
      search: async () => {
        throw new Error('private upstream search');
      },
    },
  });
  try {
    const guest = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'A' },
    });
    const headers = {
      cookie: (guest.headers['set-cookie'] as string).split(';')[0]!,
    };
    for (const response of [
      await app.inject({
        method: 'POST',
        url: '/api/playlist',
        headers,
        payload: { id: '1' },
      }),
      await app.inject({ url: '/api/search?q=test', headers }),
    ]) {
      assert.equal(response.statusCode, 502);
      assert.doesNotMatch(response.body, /private upstream/);
    }
  } finally {
    await app.close();
  }
});
test('socket stop and client motion only affect the authenticated current connection identity', async (context) => {
  const { app, room, db, io } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  const open = (cookie?: string) => {
    const socket = connect(url, {
      transports: ['websocket'],
      extraHeaders: cookie ? { cookie } : {},
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  };
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    const denied = open();
    await new Promise<void>((resolve) =>
      denied.once('connect_error', () => resolve()),
    );
    const first = open(`loop_guest=${a.token}`);
    await new Promise<void>((resolve) =>
      first.once('room:snapshot', () => resolve()),
    );
    const staleStop = io.sockets.sockets
      .get(first.id!)!
      .listeners('room:stop')[0]!;
    const staleMotion = io.sockets.sockets
      .get(first.id!)!
      .listeners('room:motion')[0]!;
    const other = open(`loop_guest=${b.token}`);
    await new Promise<void>((resolve) =>
      other.once('room:snapshot', () => resolve()),
    );
    const disconnected = new Promise<void>((resolve) =>
      first.once('disconnect', () => resolve()),
    );
    const current = open(`loop_guest=${a.token}`);
    await new Promise<void>((resolve) =>
      current.once('room:snapshot', () => resolve()),
    );
    await disconnected;
    assert.equal(first.connected, false);
    await Promise.all([
      current.timeout(1000).emitWithAck('room:sync'),
      other.timeout(1000).emitWithAck('room:sync'),
    ]);
    const senderMotions: RoomMotion[] = [],
      observerMotions: RoomMotion[] = [];
    const snapshots: RoomSnapshot[] = [];
    current.on('room:motion', (event: RoomMotion) => senderMotions.push(event));
    other.on('room:motion', (event: RoomMotion) => observerMotions.push(event));
    current.on('room:snapshot', (state: RoomSnapshot) => snapshots.push(state));
    other.on('room:snapshot', (state: RoomSnapshot) => snapshots.push(state));
    const revision = room.snapshot().revision;
    assert.equal(
      (
        await current
          .timeout(1000)
          .emitWithAck('room:move', { x: SCENE.walk.right, y: 500 })
      ).ok,
      true,
    );
    const me = () =>
      room.snapshot().users.find((user) => user.id === a.guest.id)!;
    const moving = me();
    assert.ok(moving.durationMs > 0);
    assert.equal((await other.timeout(1000).emitWithAck('room:stop')).ok, true);
    assert.deepEqual(me(), moving);
    // Invoke a real registered handler after replacement to cover a queued stale command.
    const staleAck = await new Promise<{ ok: boolean; error?: string }>(
      (resolve) => staleStop(resolve),
    );
    assert.equal(staleAck.ok, false);
    assert.match(staleAck.error!, /替换/);
    assert.deepEqual(me(), moving);
    assert.equal(
      (await current.timeout(1000).emitWithAck('room:stop')).ok,
      true,
    );
    const stopped = me();
    assert.equal(stopped.durationMs, 0);
    assert.equal(stopped.x, stopped.targetX);
    assert.equal(stopped.y, stopped.targetY);
    assert.ok(stopped.x >= moving.x && stopped.x <= moving.targetX);
    assert.equal(stopped.facingRight, true);
    const motion = {
      x: 300.125,
      y: 450.25,
      targetX: 700,
      targetY: 500,
      facingRight: true,
      clientMoveId: 1,
    };
    assert.equal(
      (await current.timeout(1000).emitWithAck('room:motion', motion)).ok,
      true,
    );
    const reported = me();
    assert.equal(reported.x, motion.x);
    assert.equal(reported.y, motion.y);
    assert.equal(reported.clientMoveId, 1);
    assert.equal(
      (
        await other
          .timeout(1000)
          .emitWithAck('room:motion', { ...motion, x: 500, clientMoveId: 9 })
      ).ok,
      true,
    );
    assert.deepEqual(me(), reported);
    const staleMotionAck = await new Promise<{ ok: boolean; error?: string }>(
      (resolve) => staleMotion(motion, resolve),
    );
    assert.equal(staleMotionAck.ok, false);
    assert.match(staleMotionAck.error!, /替换/);
    assert.deepEqual(me(), reported);
    assert.equal(
      (
        await current
          .timeout(1000)
          .emitWithAck('room:motion', { ...motion, id: b.guest.id })
      ).ok,
      false,
    );
    assert.deepEqual(me(), reported);
    const final = {
      ...motion,
      x: 615.75,
      y: 510.5,
      targetX: 615.75,
      targetY: 510.5,
      facingRight: false,
      clientMoveId: 2,
    };
    assert.equal(
      (await current.timeout(1000).emitWithAck('room:motion', final)).ok,
      true,
    );
    assert.equal(me().x, final.x);
    assert.equal(me().y, final.y);
    assert.equal(me().durationMs, 0);
    assert.equal(me().clientMoveId, 2);
    assert.equal(me().facingRight, false);
    const [synced] = await Promise.all([
      current.timeout(1000).emitWithAck('room:sync') as Promise<RoomSnapshot>,
      other.timeout(1000).emitWithAck('room:sync'),
    ]);
    assert.equal(senderMotions.length, 6);
    assert.deepEqual(observerMotions, senderMotions);
    assert.equal(snapshots.length, 0);
    assert.deepEqual(
      senderMotions.map((event) => event.userId),
      [a.guest.id, b.guest.id, a.guest.id, a.guest.id, b.guest.id, a.guest.id],
    );
    assert.deepEqual(
      senderMotions.map((event) => event.revision),
      Array.from({ length: 6 }, (_, index) => revision + index + 1),
    );
    for (const event of senderMotions) {
      assert.deepEqual(Object.keys(event).sort(), [
        ...(event.clientMoveId === undefined ? [] : ['clientMoveId']),
        'durationMs',
        'facingRight',
        'movingSince',
        'revision',
        'serverTime',
        'sleepAt',
        'targetX',
        'targetY',
        'userId',
        'x',
        'y',
      ]);
      assert.equal(typeof event.facingRight, 'boolean');
      assert.equal(
        event.sleepAt,
        event.movingSince + event.durationMs + catSleepDelay(event.userId),
      );
    }
    const restored = synced.users.find((user) => user.id === a.guest.id)!;
    for (const key of [
      'x',
      'y',
      'targetX',
      'targetY',
      'facingRight',
      'clientMoveId',
    ] as const)
      assert.equal(restored[key], final[key]);
    assert.equal(restored.durationMs, 0);
    assert.equal(restored.sleepAt, senderMotions.at(-1)!.sleepAt);
    assert.equal(synced.revision, senderMotions.at(-1)!.revision);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('socket authentication, replacement, capacity and shared room snapshots', async (context) => {
  const { app, room, db } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const guest = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'A' },
    });
    const cookie = (guest.headers['set-cookie'] as string).split(';')[0]!;
    const open = (headers: Record<string, string>) => {
      const socket = connect(url, {
        transports: ['websocket'],
        extraHeaders: headers,
        reconnection: false,
      });
      sockets.push(socket);
      return socket;
    };
    const denied = open({});
    await new Promise<void>((resolve) =>
      denied.once('connect_error', () => resolve()),
    );
    const first = open({ cookie });
    await new Promise<void>((resolve) =>
      first.once('room:snapshot', () => resolve()),
    );
    const replaced = new Promise<void>((resolve) =>
      first.once('room:replaced', () => resolve()),
    );
    const second = open({ cookie });
    await new Promise<void>((resolve) =>
      second.once('room:snapshot', () => resolve()),
    );
    await replaced;
    assert.equal(room.snapshot().users.length, 1);
    const ack = await second
      .timeout(1000)
      .emitWithAck('room:emote', { id: 'nahida-1', text: 'forbidden' });
    assert.equal(ack.ok, false);
    const emoteBroadcast = new Promise<RoomEmote>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.off('room:emote', receive);
        reject(new Error('Emote event was not broadcast'));
      }, 1000);
      const receive = (event: RoomEmote) => {
        clearTimeout(timer);
        second.off('room:emote', receive);
        resolve(event);
      };
      second.on('room:emote', receive);
    });
    assert.equal(
      (await second.timeout(1000).emitWithAck('room:emote', { id: 'nahida-3' }))
        .ok,
      true,
    );
    const emoted = await emoteBroadcast;
    const state = room.snapshot();
    assert.deepEqual(emoted, {
      userId: state.users[0]!.id,
      id: 'nahida-3',
      activity: { sleepAt: state.users[0]!.sleepAt, revision: state.revision },
    });
    assert.equal(
      (await second.timeout(1000).emitWithAck('room:emote', { id: 'nahida-2' }))
        .ok,
      false,
    );
    assert.equal(
      (await second.timeout(1000).emitWithAck('room:move', { x: 600, y: 450 }))
        .ok,
      true,
    );
    assert.equal(room.snapshot().users[0]!.targetX, 600);
    db.add(room.snapshot().users[0]!.id, track('1'));
    assert.equal(
      (await second.timeout(1000).emitWithAck('stage:join', { seat: 8 })).ok,
      false,
    );
    assert.equal(
      (
        await second
          .timeout(1000)
          .emitWithAck('stage:join', { from: { x: 500, y: SCENE.stageY } })
      ).ok,
      false,
    );
    const returnPoint = { x: 550.25, y: 450.5 };
    await second.timeout(1000).emitWithAck('room:sync');
    const joinSnapshots: RoomSnapshot[] = [];
    const joinUpdates: unknown[] = [];
    const recordJoin = (state: RoomSnapshot) => joinSnapshots.push(state);
    const recordQueue = (state: unknown) => joinUpdates.push(state);
    second.on('room:snapshot', recordJoin);
    second.on('playlist:updated', recordQueue);
    second.on('playlist:reordered', recordQueue);
    try {
      assert.equal(
        (
          await second
            .timeout(1000)
            .emitWithAck('stage:join', { seat: 3, from: returnPoint })
        ).ok,
        true,
      );
      await second.timeout(1000).emitWithAck('room:sync');
    } finally {
      second.off('room:snapshot', recordJoin);
      second.off('playlist:updated', recordQueue);
      second.off('playlist:reordered', recordQueue);
    }
    assert.equal(joinSnapshots.length, 1);
    assert.equal(joinSnapshots[0]!.resolving, false);
    assert.equal(joinSnapshots[0]!.playback!.track.id, '1');
    assert.equal(joinSnapshots[0]!.users[0]!.seat, 0);
    // Rotating a one-song queue changes neither order nor revision.
    assert.equal(joinUpdates.length, 0);
    assert.equal(db.playlist(room.snapshot().users[0]!.id).revision, 1);
    assert.equal(room.snapshot().users[0]!.seat, 0);
    const checkAppearanceBroadcast = async (appearance: CatAppearance) => {
      const before = room.snapshot();
      const broadcast = new Promise<RoomSnapshot>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Appearance snapshot was not broadcast')),
          1000,
        );
        second.once('room:snapshot', (snapshot: RoomSnapshot) => {
          clearTimeout(timer);
          resolve(snapshot);
        });
      });
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/me/appearance',
        headers: { cookie },
        payload: appearance,
      });
      assert.equal(response.statusCode, 200);
      const state = await broadcast;
      assert.equal(state.revision, before.revision + 1);
      assert.deepEqual(state.users[0], { ...before.users[0], appearance });
      assert.deepEqual(state.stage, before.stage);
      assert.deepEqual(state.playback, before.playback);
    };
    await checkAppearanceBroadcast({ coat: 'cream', pattern: 'socks' });
    assert.equal(
      (await second.timeout(1000).emitWithAck('stage:leave', { x: 500, y: -1 }))
        .ok,
      false,
    );
    assert.equal(room.snapshot().users[0]!.seat, 0);
    await second.timeout(1000).emitWithAck('room:sync');
    const leaveSnapshots: RoomSnapshot[] = [];
    const recordLeave = (state: RoomSnapshot) => leaveSnapshots.push(state);
    second.on('room:snapshot', recordLeave);
    assert.equal(
      (
        await second
          .timeout(1000)
          .emitWithAck('stage:leave', { x: 700, y: 430 })
      ).ok,
      true,
    );
    await second.timeout(1000).emitWithAck('room:sync');
    second.off('room:snapshot', recordLeave);
    assert.equal(leaveSnapshots.length, 1);
    assert.equal(leaveSnapshots[0]!.playback, null);
    assert.equal(leaveSnapshots[0]!.resolving, false);
    assert.deepEqual(leaveSnapshots[0]!.stage, []);
    assert.equal(leaveSnapshots[0]!.users[0]!.seat, null);
    const audience = room.snapshot().users[0]!;
    assert.equal(audience.seat, null);
    assert.equal(audience.x, returnPoint.x);
    assert.equal(audience.y, returnPoint.y);
    assert.equal(
      (await second.timeout(1000).emitWithAck('stage:leave', {})).ok,
      false,
    );
    assert.equal(
      (await second.timeout(1000).emitWithAck('room:move', { x: 850, y: 500 }))
        .ok,
      true,
    );
    // Finish the move event before listening for the appearance revision.
    await second.timeout(1000).emitWithAck('room:sync');
    seedUnlockedAppearances(db, room.snapshot().users[0]!.id);
    for (const { appearance } of CAT_APPEARANCE_PRESETS)
      await checkAppearanceBroadcast(appearance);
    for (let index = 0; index < 29; index++) {
      const guest = db.createGuest(`Cat${index}`).guest;
      room.connect(guest, { id: guest.id, replaced() {} });
    }
    const extra = db.createGuest('Extra');
    const full = open({ cookie: `loop_guest=${extra.token}` });
    const capacityError = await new Promise<Error>((resolve) =>
      full.once('connect_error', resolve),
    );
    assert.equal(capacityError.message, '房间已满');
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('slow first stage join sends a full loading snapshot and playback-only completion with one private queue rotation between them', async (context) => {
  let release!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
  let resolveCalls = 0;
  const resolution = new Promise<Awaited<ReturnType<MusicService['resolve']>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const { app, db } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music: {
      ...music,
      resolve: () => {
        resolveCalls++;
        return resolution;
      },
    },
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  const listeners: (() => void)[] = [];
  const nextEvent = <T>(socket: ReturnType<typeof connect>, event: string) =>
    new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, receive);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${event}`));
      }, 1000);
      const receive = (state: T) => {
        cleanup();
        resolve(state);
      };
      socket.once(event, receive);
      listeners.push(cleanup);
    });
  const open = async (token: string) => {
    const socket = connect(url, {
      transports: ['websocket'],
      extraHeaders: { cookie: `loop_guest=${token}` },
      reconnection: false,
      autoConnect: false,
    });
    sockets.push(socket);
    const ready = nextEvent<PlaylistState>(socket, 'playlist:updated');
    socket.connect();
    return { socket, playlist: await ready };
  };
  const trace = (socket: ReturnType<typeof connect>) => {
    const events: string[] = [];
    const snapshots: RoomSnapshot[] = [];
    const updates: PlaylistOrder[] = [];
    const playback: PlaybackState[] = [];
    const recordSnapshot = (state: RoomSnapshot) => {
      events.push('room:snapshot');
      snapshots.push(state);
    };
    const recordQueue = (state: PlaylistOrder) => {
      events.push('playlist:reordered');
      updates.push(state);
    };
    const recordPlayback = (state: PlaybackState) => {
      events.push('playback:updated');
      playback.push(state);
    };
    socket.on('room:snapshot', recordSnapshot);
    socket.on('playback:updated', recordPlayback);
    socket.on('playlist:reordered', recordQueue);
    listeners.push(() => {
      socket.off('room:snapshot', recordSnapshot);
      socket.off('playback:updated', recordPlayback);
      socket.off('playlist:reordered', recordQueue);
    });
    return { events, snapshots, updates, playback };
  };
  try {
    const a = db.createGuest('DJ'),
      b = db.createGuest('Observer');
    ['1', '2'].forEach((id) => db.add(a.guest.id, track(id)));
    db.add(b.guest.id, track('9'));
    const sender = await open(a.token);
    const observer = await open(b.token);
    assert.deepEqual(sender.playlist, {
      tracks: [track('1'), track('2')],
      revision: 2,
      slot: 1,
      count: 3,
    });
    assert.deepEqual(observer.playlist, {
      tracks: [track('9')],
      revision: 1,
      slot: 1,
      count: 3,
    });
    const sync = () =>
      Promise.all(
        [sender, observer].map(({ socket }) =>
          socket.timeout(1000).emitWithAck('room:sync'),
        ),
      );
    const initial = (await sync()) as RoomSnapshot[];
    for (const state of initial) {
      assert.deepEqual(state.stage, []);
      assert.equal(
        state.users.find((user) => user.id === a.guest.id)!.seat,
        null,
      );
    }
    const sent = trace(sender.socket);
    const observed = trace(observer.socket);
    const loading = Promise.all([
      nextEvent<RoomSnapshot>(sender.socket, 'room:snapshot'),
      nextEvent<RoomSnapshot>(observer.socket, 'room:snapshot'),
    ]);
    const joined = sender.socket.timeout(2000).emitWithAck('stage:join', {});
    // Keep a failed loading assertion from leaving an unobserved ack timeout.
    void joined.catch(() => {});
    for (const state of await loading) {
      assert.equal(state.resolving, true);
      assert.equal(state.playback, null);
    }
    assert.deepEqual(sent.events, ['room:snapshot']);
    assert.deepEqual(observed.events, ['room:snapshot']);
    assert.deepEqual(db.playlist(a.guest.id), sender.playlist);
    release({ url: 'https://example.com/song.mp3', durationMs: 60_000 });
    assert.equal((await joined).ok, true);
    await sync();
    assert.deepEqual(sent.events, [
      'room:snapshot',
      'playlist:reordered',
      'playback:updated',
    ]);
    assert.deepEqual(observed.events, ['room:snapshot', 'playback:updated']);
    assert.equal(resolveCalls, 1);
    for (const recorded of [sent, observed]) {
      for (const state of recorded.snapshots) {
        const dj = state.users.find((user) => user.id === a.guest.id)!;
        assert.deepEqual(state.stage, [a.guest.id]);
        assert.equal(dj.seat, 0);
        assert.equal(dj.x, SCENE.seatXs[0]);
        assert.equal(dj.y, SCENE.stageY);
        assert.equal(dj.targetX, dj.x);
        assert.equal(dj.targetY, dj.y);
        if (state.playback) {
          assert.equal(state.playback.djId, dj.id);
          assert.equal(state.playback.track.id, '1');
        }
      }
      assert.equal(recorded.snapshots.length, 1);
      assert.equal(recorded.playback.length, 1);
      const final = recorded.playback[0]!;
      assert.deepEqual(Object.keys(final).sort(), [
        'notice',
        'playback',
        'resolving',
        'revision',
        'serverTime',
      ]);
      assert.equal(final.resolving, false);
      assert.equal(final.playback!.djId, a.guest.id);
      assert.equal(final.playback!.track.id, '1');
      assert.equal(final.revision, recorded.snapshots[0]!.revision + 1);
    }
    assert.deepEqual(sent.updates, [{ ids: ['2', '1'], revision: 3, slot: 1 }]);
    assert.deepEqual(db.playlistOrder(a.guest.id), sent.updates[0]);
    assert.deepEqual(Object.keys(sent.updates[0]!).sort(), [
      'ids',
      'revision',
      'slot',
    ]);
    assert.deepEqual(observed.updates, []);
    assert.deepEqual(db.playlist(b.guest.id), observer.playlist);
  } finally {
    release({ url: 'https://example.com/song.mp3', durationMs: 60_000 });
    listeners.forEach((remove) => remove());
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('emotes reach sender and observer exactly once without snapshots, expiry traffic or replay', async (context) => {
  const { app, room, db, io } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  const open = (token: string) => {
    const socket = connect(url, {
      transports: ['websocket'],
      extraHeaders: { cookie: `loop_guest=${token}` },
      reconnection: false,
    });
    sockets.push(socket);
    const emotes: RoomEmote[] = [];
    const snapshots: RoomSnapshot[] = [];
    socket.on('room:emote', (event: RoomEmote) => emotes.push(event));
    socket.on('room:snapshot', (snapshot: RoomSnapshot) =>
      snapshots.push(snapshot),
    );
    const ready = new Promise<void>((resolve) =>
      socket.once('playlist:updated', () => resolve()),
    );
    return { socket, emotes, snapshots, ready };
  };
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    const stale = open(a.token);
    await stale.ready;
    const staleEmote = io.sockets.sockets
      .get(stale.socket.id!)!
      .listeners('room:emote')[0]!;
    const observer = open(b.token);
    await observer.ready;
    const disconnected = new Promise<void>((resolve) =>
      stale.socket.once('disconnect', () => resolve()),
    );
    const sender = open(a.token);
    await sender.ready;
    assert.equal(sender.snapshots.length, 1, 'initial snapshot is sent once');
    await disconnected;
    const sync = async () => {
      const states: RoomSnapshot[] = await Promise.all(
        [sender, observer].map(({ socket }) =>
          socket.timeout(1000).emitWithAck('room:sync'),
        ),
      );
      for (const state of states)
        assert.ok(state.users.every((user) => !('emote' in user)));
      return states;
    };
    await sync();
    const snapshotCounts = [sender.snapshots.length, observer.snapshots.length];
    const before = room.snapshot();
    // Fake only after connection handshakes; acknowledgements and real TCP I/O remain active.
    context.mock.timers.enable({
      apis: ['setTimeout', 'Date'],
      now: Date.now(),
    });
    const activity = {
      sleepAt: Date.now() + catSleepDelay(a.guest.id),
      revision: before.revision + 1,
    };
    const expectedUsers = before.users.map((user) =>
      user.id === a.guest.id ? { ...user, sleepAt: activity.sleepAt } : user,
    );
    const assertQuiet = async () => {
      const states = await sync();
      assert.deepEqual(
        [sender.snapshots.length, observer.snapshots.length],
        snapshotCounts,
      );
      assert.deepEqual(sender.emotes, [
        { userId: a.guest.id, id: 'nahida-3', activity },
      ]);
      assert.deepEqual(observer.emotes, sender.emotes);
      assert.deepEqual(stale.emotes, []);
      for (const state of states) {
        assert.equal(state.revision, activity.revision);
        assert.deepEqual(state.users, expectedUsers);
      }
    };
    assert.deepEqual(
      await sender.socket
        .timeout(1000)
        .emitWithAck('room:emote', { id: 'nahida-3' }),
      { ok: true },
    );
    await assertQuiet();
    for (const payload of [
      { id: 'custom' },
      { id: 'nahida-2', text: 'forbidden' },
      { id: 'nahida-2', userId: b.guest.id },
      { id: 'nahida-2', expiresAt: Date.now() + 3000 },
      { id: 'nahida-2' },
    ]) {
      const ack = await sender.socket
        .timeout(1000)
        .emitWithAck('room:emote', payload);
      assert.equal(ack.ok, false);
      assert.ok(ack.error);
    }
    const staleAck = await new Promise<{ ok: boolean; error?: string }>(
      (resolve) => staleEmote({ id: 'nahida-2' }, resolve),
    );
    assert.equal(staleAck.ok, false);
    assert.match(staleAck.error!, /替换/);
    await assertQuiet();
    context.mock.timers.tick(3001);
    await assertQuiet();
    const late = open(db.createGuest('Late').token);
    await late.ready;
    const lateState: RoomSnapshot = await late.socket
      .timeout(1000)
      .emitWithAck('room:sync');
    assert.deepEqual(late.emotes, []);
    assert.ok(late.snapshots.length > 0);
    for (const state of [...late.snapshots, lateState]) {
      assert.ok(state.users.every((user) => !('emote' in user)));
      assert.equal(
        state.users.find(({ id }) => id === a.guest.id)?.sleepAt,
        activity.sleepAt,
      );
    }
    await sync();
    assert.equal(sender.emotes.length, 1);
    assert.equal(observer.emotes.length, 1);
  } finally {
    context.mock.timers.reset();
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('playlist rotation events reach only the current authenticated owner and carry HTTP revisions', async (context) => {
  const { app, room, db } = await createServer({
    singleRoom: true,
    dbPath: ':memory:',
    music,
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  const open = (token: string) => {
    const socket = connect(url, {
      transports: ['websocket'],
      extraHeaders: { cookie: `loop_guest=${token}` },
      reconnection: false,
    });
    sockets.push(socket);
    const initial: PlaylistState[] = [];
    const updates: PlaylistOrder[] = [];
    socket.on('playlist:updated', (state) => initial.push(state));
    socket.on('playlist:reordered', (state) => updates.push(state));
    const ready = new Promise<void>((resolve) =>
      socket.once('playlist:updated', () => resolve()),
    );
    return { socket, initial, updates, ready };
  };
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    ['1', '2', '3'].forEach((id) => db.add(a.guest.id, track(id)));
    db.add(b.guest.id, track('9'));
    const stale = open(a.token);
    await stale.ready;
    const other = open(b.token);
    await other.ready;
    const disconnected = new Promise<void>((resolve) =>
      stale.socket.once('disconnect', () => resolve()),
    );
    const current = open(a.token);
    await current.ready;
    await disconnected;
    assert.deepEqual(current.initial, [
      {
        tracks: [track('1'), track('2'), track('3')],
        revision: 3,
        slot: 1,
        count: 3,
      },
    ]);
    const headers = { cookie: `loop_guest=${a.token}` };
    assert.equal(
      (
        await current.socket
          .timeout(1000)
          .emitWithAck('stage:join', { seat: 0 })
      ).ok,
      true,
    );
    assert.deepEqual(current.updates.at(-1), {
      ids: ['2', '3', '1'],
      revision: 4,
      slot: 1,
    });
    const httpPlaylist = (
      await app.inject({ url: '/api/playlist', headers })
    ).json<PlaylistState>();
    assert.deepEqual(
      {
        ids: httpPlaylist.tracks.map((track) => track.id),
        revision: httpPlaylist.revision,
        slot: httpPlaylist.slot,
      },
      current.updates.at(-1),
    );
    const round = room.snapshot().playback!.roundId;
    assert.equal(
      (
        await current.socket
          .timeout(1000)
          .emitWithAck('playback:skip', { roundId: round })
      ).ok,
      true,
    );
    assert.deepEqual(current.updates.at(-1), {
      ids: ['3', '1', '2'],
      revision: 5,
      slot: 1,
    });
    assert.equal(
      (
        await current.socket
          .timeout(1000)
          .emitWithAck('playback:skip', { roundId: round })
      ).ok,
      false,
    );
    assert.equal(current.updates.length, 2);
    const ordered = await app.inject({
      method: 'PUT',
      url: '/api/playlist/order',
      headers,
      payload: { ids: ['1', '3', '2'] },
    });
    assert.deepEqual(ordered.json(), {
      tracks: [track('1'), track('3'), track('2')],
      revision: 6,
      slot: 1,
      count: 3,
    });
    assert.equal(
      (
        await current.socket.timeout(1000).emitWithAck('playback:skip', {
          roundId: room.snapshot().playback!.roundId,
        })
      ).ok,
      true,
    );
    assert.deepEqual(current.updates.at(-1), {
      ids: ['3', '2', '1'],
      revision: 7,
      slot: 1,
    });
    await other.socket.timeout(1000).emitWithAck('room:sync');
    assert.deepEqual(
      current.updates.map((state) => state.revision),
      [4, 5, 7],
    );
    assert.equal(stale.initial.length, 1);
    assert.equal(stale.updates.length, 0);
    assert.deepEqual(other.initial, [
      { tracks: [track('9')], revision: 1, slot: 1, count: 3 },
    ]);
    assert.equal(other.updates.length, 0);
    assert.equal(current.initial.length, 1);
    for (const state of current.updates)
      assert.deepEqual(Object.keys(state).sort(), ['ids', 'revision', 'slot']);
    assert.deepEqual(db.playlistOrder(a.guest.id), current.updates.at(-1));
    assert.deepEqual(db.playlist(b.guest.id), {
      tracks: [track('9')],
      revision: 1,
      slot: 1,
      count: 3,
    });
    assert.equal('playlist' in room.snapshot(), false);
    const currentRound = room.snapshot().playback!.roundId;
    const switched = await app.inject({
      method: 'PUT',
      url: '/api/playlists/active',
      headers,
      payload: { slot: 2 },
    });
    assert.equal(switched.statusCode, 200);
    await current.socket.timeout(1000).emitWithAck('room:sync');
    assert.equal(current.initial.length, 2);
    assert.deepEqual(current.initial.at(-1), switched.json());
    assert.equal(switched.json().slot, 2);
    assert.equal(room.snapshot().playback!.roundId, currentRound);
    await other.socket.timeout(1000).emitWithAck('room:sync');
    assert.equal(other.initial.length, 1);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('a DJ seek broadcasts compact playback in the room and preserves playlist and directory data', async (context) => {
  const { app, db, io, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
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
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const owner = db.createGuest('Owner');
    const dj = db.createGuest('DJ');
    const { id: roomId } = db.createRoom(owner.guest.id, 'Room', 'cozy');
    for (const id of ['1', '2']) db.add(dj.guest.id, track(id));
    const open = async (token: string) => {
      const socket = connect(url, {
        auth: { roomId },
        transports: ['websocket'],
        extraHeaders: { cookie: `loop_guest=${token}` },
        reconnection: false,
      });
      sockets.push(socket);
      const events: Array<[string, unknown]> = [];
      socket.onAny((event, payload) => events.push([event, payload]));
      await new Promise<void>((resolve, reject) => {
        socket.once('playlist:updated', () => resolve());
        socket.once('connect_error', reject);
      });
      return { socket, events };
    };
    const observer = await open(owner.token);
    const replaced = await open(dj.token);
    const replacedSeek = io.sockets.sockets
      .get(replaced.socket.id!)!
      .listeners('playback:seek')[0]!;
    assert.deepEqual(
      await replaced.socket.timeout(1000).emitWithAck('stage:join', {}),
      { ok: true },
    );
    const sender = await open(dj.token);
    await observer.socket.timeout(1000).emitWithAck('room:sync');
    const before = registry.snapshot(roomId);
    const playlist = db.playlist(dj.guest.id);
    const directory = db.roomsForDirectory();
    assert.ok(directory[0]?.lastPlayedAt);
    observer.events.length = 0;
    sender.events.length = 0;
    const payload = { roundId: before.playback!.roundId, positionMs: 20_000 };

    const denied: Ack = await observer.socket
      .timeout(1000)
      .emitWithAck('playback:seek', payload);
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /当前歌曲/);
    const staleAck = await new Promise<Ack>((resolve) =>
      replacedSeek(payload, resolve),
    );
    assert.equal(staleAck.ok, false);
    assert.match(staleAck.error!, /替换/);
    assert.equal(registry.snapshot(roomId).revision, before.revision);

    assert.deepEqual(
      await sender.socket.timeout(1000).emitWithAck('playback:seek', payload),
      { ok: true },
    );
    await observer.socket.timeout(1000).emitWithAck('room:sync');
    assert.deepEqual(observer.events, sender.events);
    assert.deepEqual(
      sender.events.map(([event]) => event),
      ['playback:updated'],
    );
    const update = sender.events[0]![1] as PlaybackState;
    const after = registry.snapshot(roomId);
    assert.ok(
      update.serverTime - after.playback!.startedAt >= payload.positionMs,
    );
    assert.deepEqual(update, {
      roomId,
      revision: before.revision + 1,
      serverTime: update.serverTime,
      playback: { ...before.playback!, startedAt: after.playback!.startedAt },
      resolving: false,
      notice: null,
    });
    assert.deepEqual(after.users, before.users);
    assert.deepEqual(after.stage, before.stage);
    assert.deepEqual(db.playlist(dj.guest.id), playlist);
    assert.deepEqual(db.roomsForDirectory(), directory);
    assert.deepEqual(
      await observer.socket.timeout(1000).emitWithAck('playback:skip', {
        roundId: payload.roundId,
      }),
      { ok: true },
    );
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  }
});
test('pending skip rotates current HTTP edits only when resolution changes order and rejects queued stale skips', async (context) => {
  for (const edit of ['add', 'delete', 'already-last', 'failure'] as const) {
    let finish!: (result: Awaited<ReturnType<MusicService['resolve']>>) => void;
    let reject!: (error: Error) => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const { app, room, db } = await createServer({
      singleRoom: true,
      dbPath: ':memory:',
      music: {
        ...music,
        resolve: async (item) => {
          if (++calls === 1) return music.resolve(item);
          started();
          return new Promise((resolve, fail) => {
            finish = resolve;
            reject = fail;
          });
        },
      },
    });
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
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
    const guest = db.createGuest('DJ');
    ['1', '2', '3'].forEach((id) => db.add(guest.guest.id, track(id)));
    const headers = { cookie: `loop_guest=${guest.token}` };
    const socket = connect(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      extraHeaders: headers,
      reconnection: false,
      autoConnect: false,
    });
    const initial: PlaylistState[] = [];
    const orders: PlaylistOrder[] = [];
    socket.on('playlist:updated', (state) => initial.push(state));
    socket.on('playlist:reordered', (state) => orders.push(state));
    const ready = new Promise<void>((resolve) =>
      socket.once('playlist:updated', () => resolve()),
    );
    try {
      socket.connect();
      await ready;
      assert.equal(
        (await socket.timeout(1000).emitWithAck('stage:join', { seat: 0 })).ok,
        true,
      );
      assert.deepEqual(orders, [
        { ids: ['2', '3', '1'], revision: 4, slot: 1 },
      ]);
      const oldRound = room.snapshot().playback!.roundId;
      const skipping = socket
        .timeout(2000)
        .emitWithAck('playback:skip', { roundId: oldRound });
      void skipping.catch(() => {});
      await resolving;
      const staleSkip = socket
        .timeout(2000)
        .emitWithAck('playback:skip', { roundId: oldRound });
      void staleSkip.catch(() => {});
      let edited;
      if (edit === 'delete') {
        edited = await app.inject({
          method: 'DELETE',
          url: '/api/playlist/2',
          headers,
        });
      } else if (edit === 'already-last') {
        edited = await app.inject({
          method: 'PUT',
          url: '/api/playlist/order',
          headers,
          payload: { ids: ['3', '1', '2'] },
        });
      } else {
        edited = await app.inject({
          method: 'POST',
          url: '/api/playlist',
          headers,
          payload: { id: '4' },
        });
      }
      assert.equal(edited.statusCode, 200);
      const beforeResolved = edited.json<PlaylistState>();
      assert.equal(orders.length, 1, 'HTTP edits do not emit rotation events');
      if (edit === 'failure') reject(new Error('upstream failed'));
      else finish({ url: 'https://example.com/song.mp3', durationMs: 60000 });
      assert.equal((await skipping).ok, true);
      assert.equal((await staleSkip).ok, false);
      await socket.timeout(1000).emitWithAck('room:sync');
      const after = (
        await app.inject({ url: '/api/playlist', headers })
      ).json<PlaylistState>();
      if (edit === 'add') {
        assert.deepEqual(orders.at(-1), {
          ids: ['3', '1', '4', '2'],
          revision: beforeResolved.revision + 1,
          slot: 1,
        });
        assert.equal(orders.length, 2);
        assert.deepEqual(db.playlistOrder(guest.guest.id), orders.at(-1));
      } else {
        assert.equal(
          orders.length,
          1,
          `${edit} produces no rotation when revision is unchanged`,
        );
        assert.deepEqual(after, beforeResolved);
      }
      if (edit === 'failure') assert.equal(room.snapshot().playback, null);
      else assert.equal(room.snapshot().playback!.track.id, '2');
      assert.equal(
        initial.length,
        1,
        'full metadata is sent only for initial connection',
      );
      for (const order of orders)
        assert.deepEqual(Object.keys(order).sort(), [
          'ids',
          'revision',
          'slot',
        ]);
      assert.equal(after.revision, db.playlistOrder(guest.guest.id).revision);
      assert.equal(calls, 2, 'stale skip cannot start another resolution');
    } finally {
      socket.disconnect();
      await app.close();
    }
  }
});

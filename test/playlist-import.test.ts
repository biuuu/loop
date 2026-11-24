import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import {
  PLAYLIST_LIMIT,
  type MusicService,
  type NeteasePlaylistEntry,
  type NeteasePlaylistPage,
  type Track,
} from '../src/shared/contracts.js';

const track = (id: string): Track => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60000,
});
const entries = (ids: (string | null)[], offset = 0): NeteasePlaylistEntry[] =>
  ids.map((id, index) => ({
    position: offset + index + 1,
    id: id ?? '9',
    track: id ? track(id) : null,
  }));
const page = (
  tracks: NeteasePlaylistEntry[],
  offset = 0,
): NeteasePlaylistPage => ({
  playlist: {
    id: '7',
    name: 'Source',
    creator: 'Creator',
    cover: '',
    trackCount: 120,
  },
  total: 120,
  offset,
  tracks,
});
const base: MusicService = {
  search: async () => [],
  detail: async (id) => track(id),
  resolve: async () => {
    throw new Error('must not resolve audio');
  },
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });
const fill = (db: Store, guestId: string, count: number) => {
  for (let i = 1; i <= count; i++) db.add(guestId, track(String(i)));
};

test('playlist metadata and import APIs authenticate, reject foreign origins and validate before upstream', async () => {
  let calls = 0;
  const music = {
    ...base,
    searchPlaylists: async (query: string, offset = 0) => {
      calls++;
      assert.equal(query, '猫');
      assert.equal(offset, 60);
      return { playlists: [], total: 0, more: false };
    },
    playlist: async (id: string, offset = 0, limit = PLAYLIST_LIMIT) => {
      calls++;
      assert.equal(id, '7');
      assert.equal(offset, 60);
      assert.equal(limit, 20);
      return page([], offset);
    },
  };
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const a = db.createGuest('A');
    const paths = [
      '/api/music/playlists/search?q=猫',
      '/api/music/playlists/7',
    ];
    for (const url of paths) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url,
            headers: { ...headers(a.token), origin: 'https://evil.example' },
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          payload: { playlistId: '7' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: { ...headers(a.token), origin: 'https://evil.example' },
          payload: { playlistId: '7' },
        })
      ).statusCode,
      403,
    );
    for (const url of [
      '/api/music/playlists/search?q=',
      '/api/music/playlists/search?q=猫&offset=-1',
      '/api/music/playlists/search?q=猫&offset=1.2',
      '/api/music/playlists/search?q=猫&extra=x',
      '/api/music/playlists/bad',
      '/api/music/playlists/7?limit=101',
      '/api/music/playlists/7?offset=-1',
      '/api/music/playlists/7?limit=0',
    ])
      assert.equal(
        (await app.inject({ url, headers: headers(a.token) })).statusCode,
        400,
        url,
      );
    for (const payload of [
      {},
      { playlistId: 'bad' },
      { playlistId: '7', start: 0 },
      { playlistId: '7', start: 1.5 },
      { playlistId: '7', start: '1' },
      { playlistId: '7', start: -1 },
      { playlistId: '7', start: 1, replace: true },
      { playlistId: '7', mode: 'clear' },
      { playlistId: '7', mode: null },
      { playlistId: '7', mode: 1 },
    ])
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/playlist/import',
            headers: headers(a.token),
            payload,
          })
        ).statusCode,
        400,
      );
    assert.equal(calls, 0);
    assert.equal(
      (
        await app.inject({
          url: '/api/music/playlists/search?q=%E7%8C%AB&offset=60',
          headers: headers(a.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/music/playlists/7?offset=60&limit=20',
          headers: headers(a.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test('replace imports a selected source window into a full queue without treating old IDs as duplicates', async () => {
  const calls: { offset: number; limit: number }[] = [];
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async (_id, offset = 0, limit = PLAYLIST_LIMIT) => {
        calls.push({ offset, limit });
        return page(entries(['2', null, '500', '500', '501'], offset), offset);
      },
    },
  });
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    fill(db, a.guest.id, PLAYLIST_LIMIT);
    db.add(b.guest.id, track('999'));
    const before = db.playlist(a.guest.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7', start: 61, mode: 'replace' },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.deepEqual(
      result.tracks.map((item: Track) => item.id),
      ['2', '500', '501'],
    );
    assert.deepEqual(
      {
        revision: result.revision,
        imported: result.imported,
        duplicates: result.duplicates,
        unavailable: result.unavailable,
        overflow: result.overflow,
        scanned: result.scanned,
        start: result.start,
        end: result.end,
      },
      {
        revision: before.revision + 1,
        imported: 3,
        duplicates: 1,
        unavailable: 1,
        overflow: 0,
        scanned: 5,
        start: 61,
        end: 65,
      },
    );
    assert.deepEqual(calls, [{ offset: 60, limit: PLAYLIST_LIMIT }]);
    assert.deepEqual(db.playlist(b.guest.id), {
      tracks: [track('999')],
      revision: 1,
      slot: 1,
      count: 3,
    });
  } finally {
    await app.close();
  }
});

test('replace preserves the queue and revision when selected entries yield the same order', async () => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async (_id, offset = 0) =>
        page(entries(['2', '1', '2'], offset), offset),
    },
  });
  try {
    const a = db.createGuest('A');
    db.add(a.guest.id, track('2'));
    db.add(a.guest.id, track('1'));
    const before = db.playlist(a.guest.id);
    const result = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7', mode: 'replace' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().revision, before.revision);
    assert.equal(result.json().imported, 2);
    assert.equal(result.json().duplicates, 1);
    assert.deepEqual(db.playlist(a.guest.id), before);
  } finally {
    await app.close();
  }
});

test('replace keeps the old queue on unusable metadata, upstream failure and SQL failure', async () => {
  let failUpstream = false;
  let unusable = true;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async () => {
        if (failUpstream) throw new Error('MUSIC_U=private');
        return page(unusable ? entries([null, null]) : entries(['500', '501']));
      },
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, 2);
    const before = db.playlist(a.guest.id);
    const replace = () =>
      app.inject({
        method: 'POST',
        url: '/api/playlist/import',
        headers: headers(a.token),
        payload: { playlistId: '7', mode: 'replace' },
      });
    const empty = await replace();
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().error, /原歌单已保留/);
    assert.deepEqual(db.playlist(a.guest.id), before);
    failUpstream = true;
    const failed = await replace();
    assert.equal(failed.statusCode, 502);
    assert.doesNotMatch(failed.body, /MUSIC_U|private/);
    assert.deepEqual(db.playlist(a.guest.id), before);
    failUpstream = false;
    unusable = false;
    db.sql.exec(
      "CREATE TRIGGER fail_replace BEFORE INSERT ON playlist WHEN NEW.track_id='501' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const sqlFailed = await replace();
    assert.equal(sqlFailed.statusCode, 500);
    assert.doesNotMatch(sqlFailed.body, /test failure/);
    assert.deepEqual(db.playlist(a.guest.id), before);
  } finally {
    await app.close();
  }
});

test('replace caps selected source IDs at 100 and persists the one revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-playlist-replace-'));
  const path = join(root, 'loop.sqlite');
  let db = new Store(path);
  try {
    const a = db.createGuest('A');
    db.add(a.guest.id, track('999'));
    const before = db.playlist(a.guest.id);
    const source = entries(
      Array.from({ length: PLAYLIST_LIMIT + 2 }, (_, i) => String(i + 1)),
    );
    const result = db.importTracks(a.guest.id, source, 1, 'replace');
    assert.equal(result.imported, PLAYLIST_LIMIT);
    assert.equal(result.overflow, 2);
    assert.equal(result.revision, before.revision + 1);
    assert.deepEqual(
      result.tracks.map((item) => item.id),
      source.slice(0, PLAYLIST_LIMIT).map((item) => item.id),
    );
    db.sql.close();
    db = new Store(path);
    assert.deepEqual(db.playlist(a.guest.id), {
      tracks: result.tracks,
      revision: result.revision,
      slot: 1,
      count: 3,
    });
  } finally {
    if (db.sql.open) db.sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('playlist features return safe 503 for injected services without optional methods', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music: base });
  try {
    const a = db.createGuest('A');
    for (const url of [
      '/api/music/playlists/search?q=猫',
      '/api/music/playlists/7',
    ])
      assert.equal(
        (await app.inject({ url, headers: headers(a.token) })).statusCode,
        503,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: headers(a.token),
          payload: { playlistId: '7' },
        })
      ).statusCode,
      503,
    );
  } finally {
    await app.close();
  }
});

test('batch import appends a fixed source window, summarizes each position, isolates identity and revises once', async () => {
  let calls = 0;
  const music = {
    ...base,
    playlist: async (id: string, offset = 0, limit = PLAYLIST_LIMIT) => {
      calls++;
      assert.equal(id, '7');
      assert.equal(offset, 10);
      assert.equal(limit, PLAYLIST_LIMIT);
      return page(
        entries(
          [
            '2',
            '500',
            null,
            '500',
            '501',
            '502',
            ...Array.from({ length: 94 }, (_, i) => String(600 + i)),
          ],
          offset,
        ),
        offset,
      );
    },
  };
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    fill(db, a.guest.id, PLAYLIST_LIMIT - 2);
    db.add(b.guest.id, track('999'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7', start: 11, mode: 'append' },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.deepEqual(
      { ...result, tracks: undefined },
      {
        tracks: undefined,
        revision: 99,
        slot: 1,
        count: 3,
        imported: 2,
        duplicates: 2,
        unavailable: 1,
        overflow: 95,
        scanned: 100,
        start: 11,
        end: 110,
      },
    );
    assert.deepEqual(result.tracks.slice(-2), [track('500'), track('501')]);
    assert.deepEqual(db.playlist(b.guest.id), {
      tracks: [track('999')],
      revision: 1,
      slot: 1,
      count: 3,
    });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('all duplicate imports preserve revision and out-of-range imports return a clear 400', async () => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async (_id, offset = 0) =>
        page(offset ? [] : entries(['2', '1', '2'])),
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, 2);
    for (const start of [1, 201]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/playlist/import',
        headers: headers(a.token),
        payload: { playlistId: '7', start },
      });
      assert.equal(response.statusCode, start === 1 ? 200 : 400);
      if (start === 1) {
        assert.equal(response.json().revision, 2);
        assert.equal(response.json().imported, 0);
        assert.equal(response.json().end, 3);
      } else assert.match(response.json().error, /起始序号/);
    }
    assert.deepEqual(
      db.tracks(a.guest.id).map((t) => t.id),
      ['1', '2'],
    );
  } finally {
    await app.close();
  }
});

test('single additions enforce 100 in store and API, while duplicates remain unchanged', async () => {
  let details = 0,
    sources = 0;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      detail: async (id) => {
        details++;
        return track(id);
      },
      playlist: async () => {
        sources++;
        return page([]);
      },
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, PLAYLIST_LIMIT);
    const before = db.playlist(a.guest.id);
    assert.throws(() => db.add(a.guest.id, track('999')), /100/);
    assert.deepEqual(db.add(a.guest.id, track('1')), before.tracks);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist',
          headers: headers(a.token),
          payload: { id: '999' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: headers(a.token),
          payload: { playlistId: '7' },
        })
      ).statusCode,
      400,
    );
    assert.equal(details, 0);
    assert.equal(sources, 0);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist',
          headers: headers(a.token),
          payload: { id: '1' },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(db.playlist(a.guest.id), before);
  } finally {
    await app.close();
  }
});

test('historical queues above 100 stay intact and support reorder/remove without permitting additions', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music: base });
  try {
    const a = db.createGuest('A');
    const insert = db.sql.prepare(
      'INSERT INTO playlist (guest_id,track_id,position,track_json) VALUES (?,?,?,?)',
    );
    for (let i = 1; i <= 120; i++)
      insert.run(
        a.guest.id,
        String(i),
        i - 1,
        JSON.stringify(track(String(i))),
      );
    const ids = db
      .tracks(a.guest.id)
      .map((t) => t.id)
      .reverse();
    assert.throws(() => db.add(a.guest.id, track('999')), /100/);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: headers(a.token),
          payload: { playlistId: '7' },
        })
      ).statusCode,
      400,
    );
    assert.equal(db.tracks(a.guest.id).length, 120);
    const reordered = await app.inject({
      method: 'PUT',
      url: '/api/playlist/order',
      headers: headers(a.token),
      payload: { ids },
    });
    assert.equal(reordered.statusCode, 200);
    assert.deepEqual(
      reordered.json().tracks.map((t: Track) => t.id),
      ids,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/playlist/120',
          headers: headers(a.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(db.tracks(a.guest.id).length, 119);
    assert.deepEqual(
      db.tracks(a.guest.id).map((t) => t.id),
      ids.slice(1),
    );
  } finally {
    await app.close();
  }
});

test('import rechecks latest queue after await, preserving edits and concurrent batch capacity/deduplication', async () => {
  const pending: (() => void)[] = [];
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async (_id, offset = 0) => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return page(
          entries(
            offset ? ['500', '502', '503'] : ['500', '501', '502'],
            offset,
          ),
          offset,
        );
      },
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, PLAYLIST_LIMIT - 2);
    const first = app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7' },
    });
    const second = app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7', start: 51 },
    });
    while (pending.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    db.remove(a.guest.id, '1');
    db.order(
      a.guest.id,
      db
        .tracks(a.guest.id)
        .map((t) => t.id)
        .reverse(),
    );
    db.add(a.guest.id, track('999'));
    const before = db.playlist(a.guest.id);
    pending[0]!();
    const firstResult = (await first).json();
    pending[1]!();
    const secondResult = (await second).json();
    assert.equal(firstResult.imported, 2);
    assert.equal(firstResult.overflow, 1);
    assert.equal(firstResult.revision, before.revision + 1);
    assert.equal(secondResult.imported, 0);
    assert.equal(secondResult.duplicates, 1);
    assert.equal(secondResult.overflow, 2);
    assert.equal(secondResult.revision, firstResult.revision);
    assert.deepEqual(db.tracks(a.guest.id), [
      ...before.tracks,
      track('500'),
      track('501'),
    ]);
  } finally {
    await app.close();
  }
});

test('concurrent single additions cannot bypass store cap after upstream await', async () => {
  const pending: (() => void)[] = [];
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      detail: async (id) => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return track(id);
      },
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, PLAYLIST_LIMIT - 1);
    const add = (id: string) =>
      app.inject({
        method: 'POST',
        url: '/api/playlist',
        headers: headers(a.token),
        payload: { id },
      });
    const first = add('500'),
      second = add('501');
    while (pending.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    pending[0]!();
    assert.equal((await first).statusCode, 200);
    pending[1]!();
    assert.equal((await second).statusCode, 400);
    assert.equal(db.tracks(a.guest.id).length, PLAYLIST_LIMIT);
    assert.equal(db.playlist(a.guest.id).revision, PLAYLIST_LIMIT);
  } finally {
    await app.close();
  }
});

test('all three playlists are available immediately and selection stays private to the account', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music: base });
  try {
    const a = db.createGuest('A');
    const b = db.createGuest('B');
    fill(db, a.guest.id, PLAYLIST_LIMIT);
    const select = (token: string, slot: number) =>
      app.inject({
        method: 'PUT',
        url: '/api/playlists/active',
        headers: headers(token),
        payload: { slot },
      });
    const add = (token: string, id: string, slot: string) =>
      app.inject({
        method: 'POST',
        url: `/api/playlist?slot=${slot}`,
        headers: headers(token),
        payload: { id },
      });
    assert.equal((await select('invalid', 2)).statusCode, 401);
    assert.equal((await select(a.token, 4)).statusCode, 400);
    const second = await select(a.token, 2);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), {
      tracks: [],
      slot: 2,
      count: 3,
      revision: 101,
    });
    assert.equal((await add(a.token, '1', '2')).statusCode, 200);
    assert.deepEqual((await select(b.token, 2)).json().tracks, []);
    assert.equal((await select(b.token, 1)).statusCode, 200);
    assert.equal((await add(a.token, '7', 'bad')).statusCode, 400);
    const third = await select(a.token, 3);
    assert.equal(third.statusCode, 200);
    assert.deepEqual(third.json(), {
      tracks: [],
      slot: 3,
      count: 3,
      revision: 103,
    });
    const selected = await select(a.token, 1);
    assert.equal(selected.json().tracks.length, PLAYLIST_LIMIT);
    assert.equal(selected.json().slot, 1);
    assert.equal(selected.json().count, 3);
    assert.deepEqual((await select(a.token, 1)).json(), selected.json());
    assert.deepEqual((await select(a.token, 2)).json().tracks, [track('1')]);
    assert.deepEqual(db.playlist(b.guest.id), {
      tracks: [],
      slot: 1,
      count: 3,
      revision: 2,
    });
  } finally {
    await app.close();
  }
});

test('an in-flight import keeps its original slot and returns the latest active playlist', async () => {
  let resolveSource!: (page: NeteasePlaylistPage) => void;
  let startLookup!: () => void;
  const lookup = new Promise<void>((resolve) => {
    startLookup = resolve;
  });
  const source = new Promise<NeteasePlaylistPage>((resolve) => {
    resolveSource = resolve;
  });
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async () => {
        startLookup();
        return source;
      },
    },
  });
  const a = db.createGuest('A');
  const credentials = headers(a.token);
  db.add(a.guest.id, track('1'));
  const importing = app
    .inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: credentials,
      payload: { playlistId: '7', mode: 'replace' },
    })
    .then((response) => response);
  try {
    await lookup;
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/playlists/active',
          headers: credentials,
          payload: { slot: 2 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist?slot=2',
          headers: credentials,
          payload: { id: '2' },
        })
      ).statusCode,
      200,
    );
    resolveSource(page(entries(['3'])));
    const imported = await importing;
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().imported, 1);
    assert.equal(imported.json().slot, 2);
    assert.deepEqual(imported.json().tracks, [track('2')]);
    assert.deepEqual(db.tracks(a.guest.id, 1), [track('3')]);
  } finally {
    resolveSource(page([]));
    await importing;
    await app.close();
  }
});

test('metadata failure and SQL batch failure leave the playlist atomically unchanged', async () => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async () => {
        throw new Error('MUSIC_U=private');
      },
    },
  });
  try {
    const a = db.createGuest('A');
    fill(db, a.guest.id, 2);
    const before = db.playlist(a.guest.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { playlistId: '7' },
    });
    assert.equal(response.statusCode, 502);
    assert.doesNotMatch(response.body, /MUSIC_U|private/);
    assert.deepEqual(db.playlist(a.guest.id), before);
    db.sql.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON playlist WHEN NEW.track_id='501' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    assert.throws(
      () => db.importTracks(a.guest.id, entries(['500', '501']), 1),
      /test failure/,
    );
    assert.deepEqual(db.playlist(a.guest.id), before);
  } finally {
    await app.close();
  }
});

test('empty source playlists reject import, while final partial windows report exact source range', async () => {
  let empty = true;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async (_id, offset = 0) => ({
        ...page(empty ? [] : entries(['500', null, '501'], offset), offset),
        total: empty ? 0 : 63,
      }),
    },
  });
  try {
    const a = db.createGuest('A');
    const payload = { playlistId: '7' };
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload,
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /没有歌曲/);
    assert.deepEqual(db.playlist(a.guest.id), {
      tracks: [],
      revision: 0,
      slot: 1,
      count: 3,
    });
    empty = false;
    const imported = await app.inject({
      method: 'POST',
      url: '/api/playlist/import',
      headers: headers(a.token),
      payload: { ...payload, start: 61 },
    });
    assert.equal(imported.statusCode, 200);
    const result = imported.json();
    assert.equal(result.start, 61);
    assert.equal(result.end, 63);
    assert.equal(result.scanned, 3);
    assert.equal(result.imported, 2);
    assert.equal(result.unavailable, 1);
    assert.equal(result.revision, 1);
  } finally {
    await app.close();
  }
});

test('metadata queries and imports have bounded rate limits with imports isolated by identity', async () => {
  let sources = 0,
    searches = 0;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...base,
      playlist: async () => {
        sources++;
        return page(entries(['1']));
      },
      searchPlaylists: async () => {
        searches++;
        return { playlists: [], total: 0, more: false };
      },
    },
  });
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/playlist/import',
            headers: headers(a.token),
            payload: { playlistId: '7' },
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: headers(a.token),
          payload: { playlistId: '7' },
        })
      ).statusCode,
      429,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import',
          headers: headers(b.token),
          payload: { playlistId: '7' },
        })
      ).statusCode,
      200,
    );
    assert.equal(sources, 11);
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await app.inject({
            url: '/api/music/playlists/search?q=cat',
            headers: headers(a.token),
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          url: '/api/music/playlists/search?q=cat',
          headers: headers(a.token),
        })
      ).statusCode,
      429,
    );
    assert.equal(searches, 60);
  } finally {
    await app.close();
  }
});

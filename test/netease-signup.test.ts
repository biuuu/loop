import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';
import type {
  MusicService,
  NeteasePlaylistEntry,
  Track,
} from '../src/shared/contracts.js';

const track = (id: string): Track => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const entries = (ids: Array<string | null>): NeteasePlaylistEntry[] =>
  ids.map((id, index) => ({
    position: index + 1,
    id: id ?? String(index + 1),
    track: id ? track(id) : null,
  }));
const playlist = (tracks: NeteasePlaylistEntry[]) => ({
  playlist: {
    id: '7',
    name: 'Source',
    cover: '',
    creator: 'Cloud Cat',
    trackCount: tracks.length,
  },
  tracks,
  total: tracks.length,
  offset: 0,
});
const body = {
  userId: '123',
  playlistId: '7',
  playlistOffset: 20,
  nickname: 'Cloud Cat',
};
const post = async (
  app: Awaited<ReturnType<typeof createServer>>['app'],
  payload: Record<string, unknown> = body,
  cookie?: string,
) =>
  await app.inject({
    method: 'POST',
    url: '/api/guest/from-netease',
    payload,
    headers: cookie ? { cookie } : {},
  });
const service = (
  tracks: NeteasePlaylistEntry[],
  calls: string[],
): MusicService => ({
  search: async () => [],
  detail: async () => track('1'),
  resolve: async () => {
    throw new Error('not used');
  },
  userPlaylists: async (id, offset) => {
    calls.push(`user:${id}:${offset}`);
    return {
      playlists: offset === 20 ? [playlist(tracks).playlist] : [],
      offset: offset ?? 0,
      more: false,
    };
  },
  playlist: async (id, offset, limit) => {
    calls.push(`playlist:${id}:${offset}:${limit}`);
    return playlist(tracks);
  },
});

test('Netease signup imports first 100 source positions into the default playlist and creates a restorable identity and room', async () => {
  const calls: string[] = [];
  const tracks = entries(
    Array.from({ length: 105 }, (_, index) => String(index + 1)),
  );
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: service(tracks, calls),
  });
  try {
    const response = await post(app);
    assert.equal(response.statusCode, 200, response.body);
    const { guest, createdRoom } = response.json();
    assert.equal(guest.nickname, 'Cloud Cat');
    assert.equal(createdRoom.ownerId, guest.id);
    const state = db.playlist(guest.id);
    assert.equal(state.tracks.length, 100);
    assert.equal(state.tracks.at(-1)?.id, '100');
    assert.equal(state.slot, 1);
    assert.equal(state.count, 1);
    assert.deepEqual(calls, ['user:123:20', 'playlist:7:0:100']);
    const cookie = (response.headers['set-cookie'] as string).split(';')[0]!;
    const restored = await app.inject({ url: '/api/me', headers: { cookie } });
    assert.equal(restored.json().guest.id, guest.id);
  } finally {
    await app.close();
  }
});

test('Netease signup leaves no identity, room, or session after unusable data, upstream failure, or SQL failure', async () => {
  for (const failure of ['empty', 'upstream', 'sql'] as const) {
    const calls: string[] = [];
    const tracks = entries(failure === 'empty' ? [null, null] : ['1']);
    const music = service(tracks, calls);
    if (failure === 'upstream')
      music.playlist = async () => {
        throw new Error('private upstream detail');
      };
    const { app, db } = await createServer({ dbPath: ':memory:', music });
    try {
      if (failure === 'sql')
        db.sql.exec(
          "CREATE TRIGGER fail_import BEFORE INSERT ON playlist BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        );
      const response = await post(app);
      assert.equal(
        response.statusCode,
        failure === 'empty' ? 400 : failure === 'upstream' ? 502 : 500,
      );
      assert.equal(response.headers['set-cookie'], undefined);
      assert.doesNotMatch(
        response.body,
        /private upstream detail|test failure/,
      );
      for (const table of ['guests', 'sessions', 'rooms', 'playlist'])
        assert.equal(
          (
            db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
              n: number;
            }
          ).n,
          0,
        );
    } finally {
      await app.close();
    }
  }
});

test('Netease signup validates selection, protects existing identities, and limits costly upstream requests', async () => {
  const calls: string[] = [];
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: service(entries(['1']), calls),
  });
  try {
    for (const payload of [
      { ...body, userId: 'abc' },
      { ...body, playlistId: 'no' },
      { ...body, playlistOffset: 19 },
      { ...body, nickname: 'bad!' },
      { ...body, extra: true },
    ])
      assert.equal((await post(app, payload)).statusCode, 400);
    assert.deepEqual(calls, []);
    const existing = db.createUser('Existing');
    const conflict = await post(app, body, `loop_guest=${existing.token}`);
    assert.equal(conflict.statusCode, 409);
    assert.equal(db.guest(existing.token)?.nickname, 'Existing');
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
  const nextCalls: string[] = [];
  const next = await createServer({
    dbPath: ':memory:',
    music: service(entries(['1']), nextCalls),
  });
  try {
    const result = await post(next.app, { ...body, playlistId: '8' });
    assert.equal(result.statusCode, 400);
    assert.equal(next.db.rooms().length, 0);
    assert.equal(nextCalls.length, 1);
    for (let i = 0; i < 4; i++)
      await post(next.app, { ...body, playlistId: '8' });
    assert.equal((await post(next.app)).statusCode, 429);
    assert.equal(nextCalls.length, 5);
  } finally {
    await next.app.close();
  }
});

test('pre-signup Netease user discovery enforces origin and shared IP rate limits', async () => {
  let calls = 0;
  const music: MusicService = {
    ...service(entries(['1']), []),
    searchUsers: async () => {
      calls++;
      return { users: [], total: 0, more: false };
    },
  };
  const { app } = await createServer({ dbPath: ':memory:', music });
  try {
    const path = '/api/music/users/search?q=cat';
    assert.equal(
      (
        await app.inject({
          url: path,
          headers: { origin: 'https://other.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(calls, 0);
    for (let i = 0; i < 60; i++)
      assert.equal((await app.inject({ url: path })).statusCode, 200);
    assert.equal((await app.inject({ url: path })).statusCode, 429);
    assert.equal(calls, 60);
  } finally {
    await app.close();
  }
});

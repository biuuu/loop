import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'undici';
import { createServer } from '../src/server/app.js';
import { createMusicService } from '../src/server/music.js';
import {
  createNeteaseRequest,
  NeteaseRequestError,
} from '../src/server/netease-protocol.js';
import type { MusicService, Track } from '../src/shared/contracts.js';

const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60000,
};
const base: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => {
    throw new Error('not used');
  },
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });

test('Netease user calls use exact paths and normalize metadata', async () => {
  const calls: Array<{ path: string; data: Record<string, unknown> }> = [];
  const music = createMusicService(async (path, data) => {
    calls.push({ path, data });
    if (path === '/api/cloudsearch/pc')
      return {
        result: {
          userprofileCount: 42,
          userprofiles: [
            {
              userId: 123,
              nickname: '  猫咪  ',
              avatarUrl: 'http://images.example/cat.jpg',
            },
            {
              userId: '456',
              nickname: '另一只',
              avatarUrl: 'javascript:alert(1)',
            },
            { userId: 'bad', nickname: 'Bad' },
          ],
        },
      };
    assert.equal(path, '/api/user/playlist');
    return {
      more: true,
      playlist: [
        {
          id: 555,
          name: '  我的歌单  ',
          coverImgUrl: 'http://images.example/cover.jpg',
          trackCount: 7,
          creator: { nickname: '猫咪' },
        },
        {
          id: '666',
          name: '第二张',
          coverImgUrl: 'file:///private',
          trackCount: 0,
          creator: null,
        },
        { id: 'bad', name: 'Bad', trackCount: 4 },
      ],
    };
  });
  assert.deepEqual(await music.searchUsers!(' 猫 ', 20), {
    users: [
      { id: '123', nickname: '猫咪', avatar: 'https://images.example/cat.jpg' },
      { id: '456', nickname: '另一只', avatar: '' },
    ],
    total: 42,
    more: true,
  });
  assert.deepEqual(await music.userPlaylists!('123', 40), {
    playlists: [
      {
        id: '555',
        name: '我的歌单',
        cover: 'https://images.example/cover.jpg',
        creator: '猫咪',
        trackCount: 7,
      },
      {
        id: '666',
        name: '第二张',
        cover: '',
        creator: '未知创建者',
        trackCount: 0,
      },
    ],
    offset: 40,
    more: true,
  });
  assert.deepEqual(calls, [
    {
      path: '/api/cloudsearch/pc',
      data: { s: '猫', type: 1002, limit: 20, offset: 20, total: true },
    },
    {
      path: '/api/user/playlist',
      data: { uid: '123', limit: 20, offset: 40, includeVideo: true },
    },
  ]);
});

test('user playlist request uses WEAPI and server cookie; upstream 301 stays identifiable', async () => {
  const request = createNeteaseRequest(
    'MUSIC_U=private-token; __csrf=private-csrf',
    async (url, init) => {
      assert.equal(url, 'https://music.163.com/weapi/user/playlist');
      assert.equal(init.method, 'POST');
      const cookie = (init.headers as Record<string, string>).Cookie;
      assert.match(cookie, /MUSIC_U=private-token/);
      assert.match(cookie, /__csrf=private-csrf/);
      const body = new URLSearchParams(String(init.body));
      assert.ok(body.get('params'));
      assert.match(body.get('encSecKey')!, /^[0-9a-f]{256}$/);
      assert.equal(body.get('e_r'), null);
      return new Response(JSON.stringify({ code: 301 }));
    },
  );
  await assert.rejects(
    request('/api/user/playlist', {
      uid: '123',
      limit: 20,
      offset: 0,
      includeVideo: true,
    }),
    (error: unknown) =>
      error instanceof NeteaseRequestError &&
      error.code === 301 &&
      !error.message.includes('private-token'),
  );
});

test('Netease user API permits signup discovery, validates input, sanitizes failures, and removes LOOP-user routes', async () => {
  const calls: string[] = [];
  const music: MusicService = {
    ...base,
    searchUsers: async (q, offset) => {
      calls.push(`search:${q}:${offset}`);
      return { users: [], total: 0, more: false };
    },
    userPlaylists: async (id, offset) => {
      calls.push(`playlists:${id}:${offset}`);
      return { playlists: [], offset: offset ?? 0, more: false };
    },
  };
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const user = db.createGuest('Tester');
    for (const url of [
      '/api/music/users/search?q=cat',
      '/api/music/users/123/playlists',
    ]) {
      assert.equal((await app.inject({ url })).statusCode, 200);
      assert.equal(
        (
          await app.inject({
            url,
            headers: { ...headers(user.token), origin: 'https://evil.example' },
          })
        ).statusCode,
        403,
      );
    }
    calls.length = 0;
    for (const url of [
      '/api/music/users/search?q=',
      '/api/music/users/search?q=cat&offset=-1',
      '/api/music/users/search?q=cat&offset=1.2',
      '/api/music/users/search?q=cat&extra=1',
      `/api/music/users/search?q=${'x'.repeat(101)}`,
      '/api/music/users/abc/playlists',
      '/api/music/users/123/playlists?offset=-1',
      '/api/music/users/123/playlists?offset=1.2',
      '/api/music/users/123/playlists?extra=1',
    ])
      assert.equal(
        (await app.inject({ url, headers: headers(user.token) })).statusCode,
        400,
        url,
      );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await app.inject({
          url: '/api/music/users/search?q=%20cat%20&offset=20',
          headers: headers(user.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/music/users/123/playlists?offset=40',
          headers: headers(user.token),
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(calls, ['search:cat:20', 'playlists:123:40']);
    assert.equal(
      (
        await app.inject({
          url: '/api/users?q=cat',
          headers: headers(user.token),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/users/${user.guest.id}/playlist`,
          headers: headers(user.token),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/playlist/import-user',
          headers: headers(user.token),
          payload: { userId: user.guest.id },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }

  for (const [service, searchStatus, playlistStatus] of [
    [base, 503, 503],
    [
      {
        ...base,
        searchUsers: async () => {
          throw new Error('private secret');
        },
        userPlaylists: async () => {
          throw new Error('private secret');
        },
      },
      502,
      502,
    ],
    [
      {
        ...base,
        searchUsers: async () => ({ users: [], total: 0, more: false }),
        userPlaylists: async () => {
          throw new NeteaseRequestError('response', 301);
        },
      },
      200,
      502,
    ],
  ] as const) {
    const { app, db } = await createServer({
      dbPath: ':memory:',
      music: service,
    });
    try {
      const user = db.createGuest('Tester');
      const search = await app.inject({
        url: '/api/music/users/search?q=cat',
        headers: headers(user.token),
      });
      const playlists = await app.inject({
        url: '/api/music/users/123/playlists',
        headers: headers(user.token),
      });
      assert.equal(search.statusCode, searchStatus);
      assert.equal(playlists.statusCode, playlistStatus);
      assert.doesNotMatch(
        search.body + playlists.body,
        /private secret|MUSIC_U/,
      );
      if (
        service !== base &&
        'userPlaylists' in service &&
        playlistStatus === 502 &&
        searchStatus === 200
      )
        assert.match(playlists.body, /需要登录/);
    } finally {
      await app.close();
    }
  }
});

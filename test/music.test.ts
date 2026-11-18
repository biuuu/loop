import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { createMusicService } from '../src/server/music.js';
import {
  encryptEapi,
  NeteaseRequestError,
} from '../src/server/netease-protocol.js';
import { MusicPlaybackError } from '../src/server/music-errors.js';
import type { Track } from '../src/shared/contracts.js';

const track: Track = {
  id: '123',
  title: '星星',
  artist: '小猫',
  album: '',
  cover: '',
  durationMs: 180000,
};
test('EAPI payload retains the upstream signature and can be decrypted', () => {
  const path = '/api/cloudsearch/pc';
  const data = { s: '星星', type: 1 };
  const cipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from('e82ckenh8dichen8'),
    null,
  );
  const plain = Buffer.concat([
    cipher.update(Buffer.from(encryptEapi(path, data), 'hex')),
    cipher.final(),
  ]).toString();
  const digest = createHash('md5')
    .update(`nobody${path}use${JSON.stringify(data)}md5forencrypt`)
    .digest('hex');
  assert.equal(
    plain,
    `${path}-36cd479b6b5-${JSON.stringify(data)}-36cd479b6b5-${digest}`,
  );
});
test('search normalizes metadata, ignores malformed songs and caches authoritative detail', async () => {
  let calls = 0;
  const music = createMusicService(async (path, data) => {
    calls++;
    assert.equal(path, '/api/cloudsearch/pc');
    assert.equal(data.s, '猫');
    return {
      result: {
        songs: [
          {
            id: 123,
            name: '星星',
            dt: 180000,
            ar: [{ name: '小猫' }],
            al: { name: '夜晚', picUrl: 'http://example.com/cover.jpg' },
          },
          { id: 4 },
        ],
      },
    };
  });
  const results = await music.search(' 猫 ');
  assert.equal(results.length, 1);
  assert.equal(results[0].cover, 'https://example.com/cover.jpg');
  assert.deepEqual(await music.detail('123'), results[0]);
  assert.equal(calls, 1);
});
test('resolver accepts low bitrate full tracks and refuses missing or restricted URLs', async () => {
  const music = createMusicService(async (_path, data) => {
    assert.equal(data.level, 'standard');
    assert.equal(data.encodeType, 'mp3');
    return {
      data: [
        {
          url: 'http://music.example/song.mp3',
          time: 120000,
          code: 200,
          br: 128000,
          freeTrialInfo: null,
        },
      ],
    };
  });
  assert.deepEqual(await music.resolve(track), {
    url: 'https://music.example/song.mp3',
    durationMs: 120000,
  });
  for (const resource of [
    { url: null },
    { url: null, code: -110, fee: 1 },
    { url: 'https://music.example/not-authorized', code: -110 },
    { url: 'file:///tmp/music' },
  ]) {
    await assert.rejects(
      createMusicService(async () => ({ data: [resource] })).resolve(track),
      (error: unknown) =>
        error instanceof MusicPlaybackError && error.kind === 'unavailable',
    );
  }
});
test('preview duration uses its seconds interval capped by the actual resource time', async () => {
  for (const [resource, durationMs] of [
    [{ freeTrialInfo: { start: 60, end: 90 }, time: 200000 }, 30000],
    [{ freeTrialInfo: { start: 60, end: 90 }, time: 21000 }, 21000],
    [{ freeTrialInfo: { start: 0, end: 30 } }, 30000],
    [{ freeTrialInfo: { start: 1.5, end: 2 } }, 500],
  ] as const) {
    const music = createMusicService(async () => ({
      data: [{ url: 'https://music.example/trial', code: 200, ...resource }],
    }));
    assert.deepEqual(await music.resolve(track), {
      url: 'https://music.example/trial',
      durationMs,
      isTrial: true,
      lyricOffsetMs: resource.freeTrialInfo.start * 1000,
    });
  }
});
test('malformed preview info never falls back to full song duration', async () => {
  for (const freeTrialInfo of [
    {},
    { start: 90, end: 60 },
    { start: -1, end: 30 },
    { start: NaN, end: 30 },
    { start: 0, end: Infinity },
    { start: '0', end: '30' },
    { start: 60, end: 60 },
    [],
    true,
  ]) {
    for (const time of [undefined, 200000, 30001, 0, -1, NaN, Infinity]) {
      const music = createMusicService(async () => ({
        data: [
          {
            url: 'https://music.example/trial',
            code: 200,
            freeTrialInfo,
            time,
          },
        ],
      }));
      await assert.rejects(
        music.resolve(track),
        (error) =>
          error instanceof MusicPlaybackError && error.kind === 'unavailable',
      );
    }
    const shortResource = createMusicService(async () => ({
      data: [
        {
          url: 'https://music.example/trial',
          code: 200,
          freeTrialInfo,
          time: 25000,
        },
      ],
    }));
    assert.deepEqual(await shortResource.resolve(track), {
      url: 'https://music.example/trial',
      durationMs: 25000,
      isTrial: true,
      lyricOffsetMs: null,
    });
  }
  const full = createMusicService(async () => ({
    data: [{ url: 'https://music.example/full', code: 200 }],
  }));
  assert.deepEqual(await full.resolve(track), {
    url: 'https://music.example/full',
    durationMs: track.durationMs,
  });
});
test('resolver wraps Netease access errors without exposing upstream details', async () => {
  for (const kind of ['network', 'http', 'response'] as const) {
    const upstream = new NeteaseRequestError(kind, 503);
    upstream.message = 'private cookie MUSIC_U=secret';
    await assert.rejects(
      createMusicService(async () => {
        throw upstream;
      }).resolve(track),
      (error) => {
        assert.ok(error instanceof MusicPlaybackError);
        assert.equal(error.kind, 'upstream');
        assert.doesNotMatch(error.message, /MUSIC_U|secret|503/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  await assert.rejects(
    createMusicService(async () => {
      throw new Error('MUSIC_U=secret');
    }).resolve(track),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /MUSIC_U|secret/);
      return true;
    },
  );
});
test('invalid song identifiers never reach the upstream', async () => {
  const music = createMusicService(async () => {
    throw new Error('should not run');
  });
  await assert.rejects(music.detail('https://example.com'));
  await assert.rejects(music.resolve({ ...track, id: '1,2' }));
});

test('native upstream request timeouts keep the timeout classification', async () => {
  for (const code of ['TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    const music = createMusicService(async () => {
      throw new NeteaseRequestError('network', code);
    });
    await assert.rejects(
      music.resolve(track),
      (error: unknown) =>
        error instanceof MusicPlaybackError && error.kind === 'timeout',
    );
  }
});

test('playlist search sends Netease type 1000 and normalizes metadata with pagination', async () => {
  const music = createMusicService(async (path, data) => {
    assert.equal(path, '/api/cloudsearch/pc');
    assert.deepEqual(data, {
      s: '猫',
      type: 1000,
      limit: 20,
      offset: 60,
      total: true,
    });
    return {
      result: {
        playlistCount: 100,
        playlists: [
          {
            id: 123,
            name: '夜晚',
            coverImgUrl: 'http://example.com/cover',
            creator: { nickname: '猫' },
            trackCount: 82,
          },
          {
            id: '456',
            name: '清晨',
            coverImgUrl: 'file:///private',
            trackCount: 0,
          },
          { id: 'bad', name: 'bad', trackCount: 1 },
          { id: 4, name: '', trackCount: 1 },
          { id: 5, name: 'bad', trackCount: -1 },
        ],
      },
    };
  });
  assert.deepEqual(await music.searchPlaylists!(' 猫 ', 60), {
    playlists: [
      {
        id: '123',
        name: '夜晚',
        cover: 'https://example.com/cover',
        creator: '猫',
        trackCount: 82,
      },
      {
        id: '456',
        name: '清晨',
        cover: '',
        creator: '未知创建者',
        trackCount: 0,
      },
    ],
    total: 100,
    more: true,
  });
});

test('playlist browsing slices complete trackIds before validation, preserving missing and repeated source positions', async () => {
  const rawSong = (id: number) => ({
    id,
    name: `Song ${id}`,
    dt: 60000,
    ar: [{ name: 'Artist' }],
  });
  const calls: string[] = [];
  const music = createMusicService(async (path, data) => {
    calls.push(path);
    if (path === '/api/v6/playlist/detail') {
      assert.deepEqual(data, { id: '8', n: 100000, s: 8 });
      const trackIds: unknown[] = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
      }));
      trackIds[51] = { id: 'invalid' };
      trackIds[52] = { id: 51 };
      return {
        playlist: {
          id: 8,
          name: 'Full list',
          trackCount: 120,
          trackIds,
          tracks: [rawSong(1)],
        },
      };
    }
    assert.equal(path, '/api/v3/song/detail');
    assert.deepEqual(JSON.parse(String(data.c)), [
      { id: '51' },
      { id: '54' },
      { id: '55' },
    ]);
    return {
      songs: [
        rawSong(55),
        rawSong(51),
        { id: 54, name: 'Unavailable' },
        rawSong(999),
      ],
    };
  });
  const page = await music.playlist!('8', 50, 5);
  assert.equal(page.total, 120);
  assert.equal(page.offset, 50);
  assert.deepEqual(
    page.tracks.map((entry) => [
      entry.position,
      entry.id,
      entry.track?.id ?? null,
    ]),
    [
      [51, '51', '51'],
      [52, '', null],
      [53, '51', '51'],
      [54, '54', null],
      [55, '55', '55'],
    ],
  );
  assert.equal((await music.detail('55')).title, 'Song 55');
  assert.equal(calls.length, 2);
});

test('playlist source windows never backfill from position 51 and beyond-end avoids song requests', async () => {
  const music = createMusicService(async (path, data) => {
    if (path === '/api/v6/playlist/detail')
      return {
        playlist: {
          id: 1,
          name: 'Large',
          trackCount: 101,
          trackIds: Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })),
        },
      };
    const ids = JSON.parse(String(data.c)) as { id: string }[];
    assert.equal(ids.length, 50);
    assert.equal(ids[0]!.id, '1');
    assert.equal(ids.at(-1)!.id, '50');
    return { songs: [] };
  });
  const page = await music.playlist!('1');
  assert.equal(page.tracks.length, 50);
  assert.ok(page.tracks.every((entry) => entry.track === null));
  assert.deepEqual((await music.playlist!('1', 200)).tracks, []);
});

test('invalid playlist inputs never reach upstream and malformed source responses fail safely', async () => {
  let calls = 0;
  const music = createMusicService(async () => {
    calls++;
    return {};
  });
  for (const [query, offset] of [
    ['', 0],
    ['x'.repeat(101), 0],
    ['ok', -1],
    ['ok', 0.5],
    ['ok', Infinity],
  ] as const)
    await assert.rejects(music.searchPlaylists!(query, offset));
  for (const [id, offset, limit] of [
    ['url', 0, 50],
    ['1', -1, 50],
    ['1', 0, 0],
    ['1', 0, 51],
    ['1', 0, 1.5],
  ] as const)
    await assert.rejects(music.playlist!(id, offset, limit));
  assert.equal(calls, 0);
  await assert.rejects(music.playlist!('1'));
  assert.equal(calls, 1);
});

test(
  'live public Netease playlist search and first metadata page',
  { skip: process.env.LOOP_LIVE_MUSIC !== '1' },
  async () => {
    const music = createMusicService();
    const results = await music.searchPlaylists!('轻音乐');
    assert.ok(results.playlists.length > 0);
    const source = results.playlists.find((item) => item.trackCount > 0)!;
    assert.ok(source);
    const page = await music.playlist!(source.id, 0, 2);
    assert.equal(page.playlist.id, source.id);
    assert.equal(page.offset, 0);
    assert.ok(page.total > 0);
    assert.ok(page.tracks.length > 0 && page.tracks.length <= 2);
    assert.deepEqual(
      page.tracks.map((entry) => entry.position),
      page.tracks.map((_, i) => i + 1),
    );
    assert.ok(page.tracks.some((entry) => entry.track));
  },
);

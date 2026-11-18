import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicService } from '../src/server/music.js';
import { createServer } from '../src/server/app.js';
import type { MusicService } from '../src/shared/contracts.js';

test('lyrics request returns only original and translated LRC and validates string IDs before upstream', async () => {
  let calls = 0;
  const music = createMusicService(async (path, data) => {
    calls++;
    assert.equal(path, '/api/song/lyric');
    assert.deepEqual(data, {
      id: '12345678901234567890',
      tv: -1,
      lv: -1,
      rv: -1,
      kv: -1,
      _nmclfl: 1,
    });
    return {
      lrc: { lyric: '[00:01.50]原文' },
      tlyric: { lyric: '[00:01.50]翻译' },
      romalrc: { lyric: 'romanization' },
      ruby: 'reading',
      yrc: { lyric: 'word timing' },
      phonetic: 'reading',
      cookie: 'MUSIC_U=private',
    };
  });
  assert.deepEqual(await music.lyrics!('12345678901234567890'), {
    trackId: '12345678901234567890',
    original: '[00:01.50]原文',
    translation: '[00:01.50]翻译',
  });
  for (const id of [
    'bad',
    '1,2',
    '-1',
    '',
    '1'.repeat(21),
    'https://music.163.com/1',
  ])
    await assert.rejects(music.lyrics!(id));
  assert.equal(calls, 1);
});

test('lyrics handle missing, instrumental and uncollected text without falling back to pronunciation', async () => {
  for (const body of [
    {},
    { lrc: null, tlyric: null },
    { lrc: { lyric: 1 }, tlyric: { lyric: [] } },
    { romalrc: { lyric: '[00:01]reading' }, yrc: { lyric: 'words' } },
    { nolyric: true, lrc: { lyric: 'ignore' }, tlyric: { lyric: 'ignore' } },
    { uncollected: true, lrc: { lyric: 'ignore' } },
  ]) {
    let calls = 0;
    const music = createMusicService(async () => {
      calls++;
      return body;
    });
    const expected = { trackId: '1', original: '', translation: '' };
    assert.deepEqual(await music.lyrics!('1'), expected);
    assert.deepEqual(await music.lyrics!('1'), expected);
    assert.equal(calls, 1, 'empty lyrics also use the short-lived cache');
  }
});

test('lyrics deduplicate 30 concurrent listeners, isolate cached values and expire after five minutes', async (context) => {
  let now = 1000000;
  context.mock.method(Date, 'now', () => now);
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const music = createMusicService(async () => {
    calls++;
    await wait;
    return { lrc: { lyric: '[00:01]原文' } };
  });
  const listeners = Array.from({ length: 30 }, () => music.lyrics!('1'));
  assert.equal(calls, 1);
  release();
  const values = await Promise.all(listeners);
  values[0]!.original = 'mutated';
  assert.equal((await music.lyrics!('1')).original, '[00:01]原文');
  assert.equal(values[1]!.original, '[00:01]原文');
  now += 299999;
  await music.lyrics!('1');
  assert.equal(calls, 1);
  now++;
  await music.lyrics!('1');
  assert.equal(calls, 2);
});

test('lyrics cache stays bounded and truncates oversized text', async () => {
  let calls = 0;
  const music = createMusicService(async () => {
    calls++;
    return {
      lrc: { lyric: 'x'.repeat(200001) },
      tlyric: { lyric: 'y'.repeat(200001) },
    };
  });
  const first = await music.lyrics!('1');
  assert.equal(first.original.length, 200000);
  assert.equal(first.translation.length, 200000);
  for (let id = 2; id <= 101; id++) await music.lyrics!(String(id));
  await music.lyrics!('1');
  assert.equal(calls, 102);
});

test('failed lyrics requests are sanitized and retry after rejection', async () => {
  let calls = 0;
  const music = createMusicService(async () => {
    calls++;
    if (calls === 1) throw new Error('MUSIC_U=private upstream URL');
    return { lrc: { lyric: 'retry works' } };
  });
  await assert.rejects(music.lyrics!('1'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /MUSIC_U|private|URL/);
    return true;
  });
  assert.equal((await music.lyrics!('1')).original, 'retry works');
  assert.equal(calls, 2);
});

const baseMusic: MusicService = {
  search: async () => [],
  detail: async () => {
    throw new Error('unused');
  },
  resolve: async () => {
    throw new Error('unused');
  },
};

test('lyrics API checks authentication, source and input before calling upstream, and sanitizes failures', async () => {
  let calls = 0;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...baseMusic,
      lyrics: async (id) => {
        calls++;
        if (id === '2')
          throw new Error('MUSIC_U=private https://upstream/private');
        return { trackId: id, original: '[00:01]原文', translation: '' };
      },
    },
  });
  try {
    assert.equal((await app.inject({ url: '/api/lyrics/1' })).statusCode, 401);
    const guest = db.createGuest('Cat');
    const headers = { cookie: `loop_guest=${guest.token}` };
    assert.equal(
      (
        await app.inject({
          url: '/api/lyrics/1',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    for (const url of [
      '/api/lyrics/bad',
      '/api/lyrics/1%2C2',
      '/api/lyrics/123456789012345678901',
      '/api/lyrics/1?extra=1',
    ])
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    assert.equal(calls, 0);
    const good = await app.inject({
      url: '/api/lyrics/1',
      headers: {
        ...headers,
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
      },
    });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(good.json(), {
      trackId: '1',
      original: '[00:01]原文',
      translation: '',
    });
    const failed = await app.inject({ url: '/api/lyrics/2', headers });
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), { error: '歌词暂时不可用' });
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test('lyrics API returns safe 503 when optional provider is absent and applies metadata rate limit', async () => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: baseMusic,
  });
  try {
    const guest = db.createGuest('Cat');
    const headers = { cookie: `loop_guest=${guest.token}` };
    for (let i = 0; i < 60; i++) {
      const reply = await app.inject({ url: '/api/lyrics/1', headers });
      assert.equal(reply.statusCode, 503);
      assert.deepEqual(reply.json(), { error: '歌词暂时不可用' });
    }
    assert.equal(
      (await app.inject({ url: '/api/lyrics/1', headers })).statusCode,
      429,
    );
  } finally {
    await app.close();
  }
});

test(
  'live Netease original lyrics metadata contains timestamps',
  { skip: process.env.LOOP_LIVE_MUSIC !== '1' },
  async () => {
    const lyrics = await createMusicService().lyrics!('26348051');
    assert.equal(lyrics.trackId, '26348051');
    assert.match(lyrics.original, /\[\d+:\d+(?:\.\d+)?\]/);
    assert.equal(typeof lyrics.translation, 'string');
  },
);

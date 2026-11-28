import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createServer } from '../src/server/app.js';
import { resolveListenHost } from '../src/server/request-ip.js';
import { readSignupSettings } from '../src/server/signup.js';
import type { MusicService, Track } from '../src/shared/contracts.js';

const siteKey = 'public-site-key';
const secretKey = 'private-test-secret';
const hostname = 'loop.example';
const configured = readSignupSettings({
  TURNSTILE_SITE_KEY: siteKey,
  TURNSTILE_SECRET_KEY: secretKey,
  TURNSTILE_HOSTNAME: hostname,
});
const unconfigured = readSignupSettings({});
const verified = { success: true, hostname, action: 'signup' };
const neteaseSignup = {
  userId: '8',
  playlistId: '7',
  playlistOffset: 0,
  nickname: 'Netease Cat',
};
const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
};
const playlist = {
  id: '7',
  name: 'Source',
  cover: '',
  creator: 'Cat',
  trackCount: 1,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => {
    throw new Error('unused');
  },
  searchUsers: async () => ({ users: [], total: 0, more: false }),
  userPlaylists: async () => ({
    playlists: [playlist],
    offset: 0,
    more: false,
  }),
  playlist: async () => ({
    playlist,
    tracks: [{ position: 1, id: '1', track }],
    total: 1,
    offset: 0,
  }),
};

function signup(
  app: FastifyInstance,
  path: '/api/guest' | '/api/guest/from-netease',
  fields: Record<string, unknown> = {},
  options: Pick<InjectOptions, 'headers' | 'remoteAddress'> = {},
) {
  return app.inject({
    ...options,
    method: 'POST',
    url: path,
    payload: {
      ...(path === '/api/guest/from-netease'
        ? neteaseSignup
        : { nickname: 'Guest Cat' }),
      ...fields,
    },
  });
}

test('signup settings require all Turnstile fields and explicit loopback for tunnel trust', () => {
  assert.deepEqual(unconfigured, { maxPerHour: 5, turnstile: null });
  assert.equal(readSignupSettings({ SIGNUP_MAX_PER_HOUR: '2' }).maxPerHour, 2);
  for (const invalid of ['0', '-1', '2.5', 'unlimited', '10001'])
    assert.throws(
      () => readSignupSettings({ SIGNUP_MAX_PER_HOUR: invalid }),
      /SIGNUP_MAX_PER_HOUR/,
    );
  for (const env of [
    { TURNSTILE_SITE_KEY: siteKey },
    { TURNSTILE_SECRET_KEY: secretKey },
    { TURNSTILE_HOSTNAME: hostname },
  ])
    assert.throws(
      () => readSignupSettings(env),
      (error: Error) => {
        assert.match(error.message, /together/);
        assert.ok(!error.message.includes(secretKey));
        return true;
      },
    );
  assert.throws(
    () =>
      readSignupSettings({
        TURNSTILE_SITE_KEY: siteKey,
        TURNSTILE_SECRET_KEY: secretKey,
        TURNSTILE_HOSTNAME: `https://${hostname}/`,
      }),
    /hostname without a scheme/,
  );
  assert.equal(resolveListenHost({}), '0.0.0.0');
  for (const host of [undefined, '', '0.0.0.0', '::', 'localhost', '192.0.2.1'])
    assert.throws(
      () => resolveListenHost({ HOST: host, TRUST_CLOUDFLARE_TUNNEL: 'true' }),
      /requires HOST=127\.0\.0\.1 or HOST=::1/,
    );
  for (const host of ['127.0.0.1', '::1'])
    assert.equal(
      resolveListenHost({ HOST: host, TRUST_CLOUDFLARE_TUNNEL: 'true' }),
      host,
    );
});

test('signup config is public and uncached with only the optional site key', async () => {
  for (const settings of [configured, unconfigured]) {
    const { app } = await createServer({
      dbPath: ':memory:',
      music,
      signupSettings: settings,
    });
    try {
      const response = await app.inject('/api/signup/config');
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), {
        turnstileSiteKey: settings.turnstile?.siteKey ?? null,
      });
    } finally {
      await app.close();
    }
  }
});

test('both signup routes verify Turnstile before writing identities or calling Netease', async () => {
  const calls: string[] = [];
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...music,
      userPlaylists: (...args) => {
        calls.push('netease:user');
        return music.userPlaylists!(...args);
      },
      playlist: (...args) => {
        calls.push('netease:playlist');
        return music.playlist!(...args);
      },
    },
    signupSettings: configured,
    trustCloudflareTunnel: true,
    signupFetch: async (url, init) => {
      assert.equal(
        url,
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      );
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('secret'), secretKey);
      assert.equal(init.body.get('remoteip'), '2001:db8::1');
      const token = init.body.get('response')!;
      calls.push(token.length > 20 ? 'verify:2048' : `verify:${token}`);
      if (token === 'wrong-action')
        return Response.json({ ...verified, action: 'login' });
      if (token === 'wrong-host')
        return Response.json({ ...verified, hostname: 'wrong.example' });
      if (token === 'rejected') return Response.json({ success: false });
      return Response.json(verified);
    },
  });
  const ip = { headers: { 'cf-connecting-ip': '2001:0db8:0:0::1' } };
  const guest = '/api/guest';
  const netease = '/api/guest/from-netease';
  try {
    for (const path of [guest, netease] as const) {
      for (const fields of [
        {},
        { turnstileToken: 'x'.repeat(2049) },
        { turnstileToken: 42 },
      ]) {
        const response = await signup(app, path, fields, ip);
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.headers['set-cookie'], undefined);
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(
      (await signup(app, guest, { turnstileToken: 'wrong-action' }, ip))
        .statusCode,
      400,
    );
    assert.equal(
      (await signup(app, netease, { turnstileToken: 'wrong-host' }, ip))
        .statusCode,
      400,
    );
    assert.equal(
      (await signup(app, netease, { turnstileToken: 'rejected' }, ip))
        .statusCode,
      400,
    );
    assert.deepEqual(calls, [
      'verify:wrong-action',
      'verify:wrong-host',
      'verify:rejected',
    ]);
    assert.equal(db.rooms().length, 0);

    const createdGuest = await signup(
      app,
      guest,
      { turnstileToken: 'x'.repeat(2048) },
      ip,
    );
    const createdImport = await signup(
      app,
      netease,
      { turnstileToken: 'unique-import' },
      ip,
    );
    for (const response of [createdGuest, createdImport]) {
      assert.equal(response.statusCode, 200, response.body);
      assert.match(String(response.headers['set-cookie']), /loop_guest=/);
      assert.ok(!response.body.includes(secretKey));
      assert.equal(
        response.json().createdRoom.ownerId,
        response.json().guest.id,
      );
    }
    assert.deepEqual(calls.slice(3), [
      'verify:2048',
      'verify:unique-import',
      'netease:user',
      'netease:playlist',
    ]);
    assert.deepEqual(db.playlist(createdImport.json().guest.id).tracks, [
      track,
    ]);
  } finally {
    await app.close();
  }
});

test('verification timeouts, transport failures and unusable responses fail closed and release signup quota', async (context) => {
  let timeoutMs = 0;
  context.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeoutMs = ms;
    return AbortSignal.abort(
      new DOMException('Siteverify timeout', 'TimeoutError'),
    );
  });
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music,
    signupSettings: { ...configured, maxPerHour: 1 },
    signupFetch: async (_url, init) => {
      const token = (init!.body as URLSearchParams).get('response');
      if (token === 'timeout') init!.signal!.throwIfAborted();
      if (token === 'error') throw new Error(secretKey);
      if (token === 'unavailable')
        return new Response(secretKey, { status: 502 });
      if (token === 'malformed') return new Response(secretKey);
      if (token === 'invalid-shape') return Response.json({ success: 'true' });
      return Response.json(verified);
    },
  });
  try {
    for (const token of [
      'timeout',
      'error',
      'unavailable',
      'malformed',
      'invalid-shape',
    ]) {
      const response = await signup(app, '/api/guest', {
        turnstileToken: token,
      });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.ok(!response.body.includes(secretKey));
      assert.equal(db.rooms().length, 0);
    }
    assert.equal(timeoutMs, 5000);
    assert.equal(
      (await signup(app, '/api/guest', { turnstileToken: 'fresh' })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('Turnstile tokens are guarded against concurrent and immediate replay across routes and IPs', async () => {
  let now = Date.now();
  let calls = 0;
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music,
    signupSettings: configured,
    signupNow: () => now,
    signupFetch: async () => {
      calls++;
      start();
      await paused;
      return Response.json(calls === 1 ? verified : { success: false });
    },
  });
  const token = { turnstileToken: 'one token' };
  const initial = signup(app, '/api/guest', token);
  try {
    await started;
    const replay = () =>
      signup(app, '/api/guest/from-netease', token, {
        remoteAddress: '192.0.2.1',
      });
    assert.equal((await replay()).statusCode, 400);
    assert.equal(calls, 1);
    finish();
    assert.equal((await initial).statusCode, 200);
    assert.equal((await replay()).statusCode, 400);
    assert.equal(db.rooms().length, 1);
    now += 5 * 60_000;
    // After TTL, an expired token reaches Siteverify for the definitive decision.
    assert.equal((await replay()).statusCode, 400);
    assert.equal(calls, 2);
    assert.equal(db.rooms().length, 1);
  } finally {
    finish();
    await app.close();
  }
});

test('nickname and Netease signup share five successful creations per IP in a rolling hour', async () => {
  let now = Date.now();
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music,
    signupSettings: unconfigured,
    signupNow: () => now,
  });
  const guest = () => signup(app, '/api/guest');
  const netease = (fields?: Record<string, unknown>) =>
    signup(app, '/api/guest/from-netease', fields);
  try {
    assert.equal((await netease({ playlistId: '9' })).statusCode, 400);
    db.sql.exec(
      "CREATE TRIGGER fail_signup BEFORE INSERT ON guests BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    assert.equal((await guest()).statusCode, 500);
    db.sql.exec('DROP TRIGGER fail_signup');
    assert.equal(db.rooms().length, 0);

    assert.equal((await guest()).statusCode, 200);
    now += 60_000;
    for (let i = 0; i < 3; i++) assert.equal((await guest()).statusCode, 200);
    assert.equal((await netease()).statusCode, 200);
    assert.equal((await guest()).statusCode, 429);
    assert.equal((await netease()).statusCode, 429);
    assert.equal(db.rooms().length, 5);
    const other = await signup(
      app,
      '/api/guest',
      {},
      { remoteAddress: '192.0.2.1' },
    );
    assert.equal(other.statusCode, 200);
    now += 59 * 60_000;
    assert.equal((await guest()).statusCode, 200);
    assert.equal((await guest()).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('a pending Netease import reserves a slot and failure lets the same IP retry with a fresh token', async () => {
  let calls = 0;
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music: {
      ...music,
      playlist: async () => {
        start();
        await paused;
        throw new Error('private Netease issue');
      },
    },
    signupSettings: { ...configured, maxPerHour: 1 },
    signupFetch: async () => {
      calls++;
      return Response.json(verified);
    },
  });
  const usedToken = { turnstileToken: 'import token' };
  const freshToken = { turnstileToken: 'new token' };
  const inFlight = signup(app, '/api/guest/from-netease', usedToken);
  try {
    await started;
    assert.equal((await signup(app, '/api/guest', freshToken)).statusCode, 429);
    assert.equal(calls, 1);
    assert.equal(
      (
        await signup(
          app,
          '/api/guest',
          { turnstileToken: 'other token' },
          {
            remoteAddress: '192.0.2.1',
          },
        )
      ).statusCode,
      200,
    );
    finish();
    assert.equal((await inFlight).statusCode, 502);
    assert.equal((await signup(app, '/api/guest', usedToken)).statusCode, 400);
    assert.equal(calls, 2);
    assert.equal((await signup(app, '/api/guest', freshToken)).statusCode, 200);
    assert.equal(db.rooms().length, 2);
  } finally {
    finish();
    await app.close();
  }
});

test('existing nicknames can change through either route after the signup quota is exhausted', async () => {
  let calls = 0;
  const { app, db } = await createServer({
    dbPath: ':memory:',
    music,
    signupSettings: { ...configured, maxPerHour: 1 },
    signupFetch: async () => {
      calls++;
      return Response.json(verified);
    },
  });
  try {
    const existing = db.createUser('Existing');
    const creation = await signup(app, '/api/guest', { turnstileToken: 'new' });
    assert.equal(creation.statusCode, 200);
    assert.equal((await signup(app, '/api/guest')).statusCode, 429);
    const legacy = await signup(
      app,
      '/api/guest',
      { nickname: 'Renamed' },
      { headers: { cookie: `loop_guest=${existing.token}` } },
    );
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().guest.id, existing.guest.id);
    assert.equal(db.guest(existing.token)?.nickname, 'Renamed');

    const cookie = String(creation.headers['set-cookie']).split(';')[0]!;
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/me/nickname',
      headers: { cookie },
      payload: { nickname: 'Renamed too' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.equal(patch.json().guest.id, creation.json().guest.id);
    assert.equal(
      (
        await signup(
          app,
          '/api/guest/from-netease',
          {},
          { headers: { cookie } },
        )
      ).statusCode,
      409,
    );
    assert.equal(calls, 1);
    assert.equal(db.rooms().length, 2);
  } finally {
    await app.close();
  }
});

test('only a loopback socket with tunnel trust enabled can supply a single Cloudflare client IP', async () => {
  for (const trustCloudflareTunnel of [false, true]) {
    const { app } = await createServer({
      dbPath: ':memory:',
      music,
      signupSettings: { ...unconfigured, maxPerHour: 1 },
      trustCloudflareTunnel,
    });
    const post = (remoteAddress: string, header: string | string[]) =>
      signup(
        app,
        '/api/guest',
        {},
        {
          remoteAddress,
          headers: {
            'cf-connecting-ip': header,
            'x-forwarded-for': '198.51.100.99',
          },
        },
      );
    try {
      assert.equal((await post('192.0.2.2', '198.51.100.1')).statusCode, 200);
      assert.equal((await post('192.0.2.2', '198.51.100.2')).statusCode, 429);
      assert.equal((await post('127.0.0.1', '198.51.100.1')).statusCode, 200);
      assert.equal(
        (await post('127.0.0.1', '198.51.100.2')).statusCode,
        trustCloudflareTunnel ? 200 : 429,
      );
      if (trustCloudflareTunnel) {
        assert.equal(
          (await post('::ffff:127.0.0.1', '::ffff:198.51.100.1')).statusCode,
          429,
        );
        assert.equal((await post('::1', '2001:0DB8:0000::1')).statusCode, 200);
        assert.equal((await post('::1', '2001:db8::1')).statusCode, 429);
        assert.equal((await post('127.0.0.1', 'bad')).statusCode, 200);
        for (const value of [
          '198.51.100.3, 198.51.100.4',
          ['198.51.100.3', '198.51.100.4'],
          '198.51.100.3:42',
          'fe80::1234%eth0',
        ])
          assert.equal((await post('127.0.0.1', value)).statusCode, 429);
      }
    } finally {
      await app.close();
    }
  }
});

test('existing search limits use the effective Cloudflare IP without accepting other forwarding headers', async () => {
  const { app } = await createServer({
    dbPath: ':memory:',
    music,
    signupSettings: unconfigured,
    trustCloudflareTunnel: true,
  });
  const search = (ip: string, forwarded: string) =>
    app.inject({
      url: '/api/music/users/search?q=cat',
      headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': forwarded },
    });
  try {
    for (let i = 0; i < 60; i++)
      assert.equal((await search('198.51.100.1', '192.0.2.1')).statusCode, 200);
    assert.equal((await search('198.51.100.1', '192.0.2.2')).statusCode, 429);
    assert.equal((await search('198.51.100.2', '192.0.2.1')).statusCode, 200);
  } finally {
    await app.close();
  }
});

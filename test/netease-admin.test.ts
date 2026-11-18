import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Response, type RequestInit } from 'undici';
import { createServer } from '../src/server/app.js';

const adminKey = 'f7c1a1ca5707e671f36fe898803b91f4e512038e2a0f7af0';
const headers = { 'x-loop-admin-key': adminKey };
const qrKey = 'qrChallenge12345678';
const result = (body: unknown, cookie?: string) =>
  new Response(JSON.stringify(body), {
    headers: cookie ? { 'set-cookie': cookie } : {},
  });

test('admin QR flow requires independent key, protects origin, and never exposes secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-qr-'));
  const file = join(dir, 'netease-cookie');
  const outcomes = [801, 802, 803];
  const calls: string[] = [];
  const server = await createServer({
    dbPath: ':memory:',
    neteaseCookieFile: file,
    adminKey,
    neteaseQrFetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/unikey'))
        return result({ code: 200, data: { unikey: qrKey } });
      return result(
        { code: outcomes.shift() },
        'MUSIC_U=private-token; Path=/; HttpOnly',
      );
    },
  });
  const post = (
    url: string,
    supplied: Record<string, string> = headers,
    extra?: Record<string, string>,
  ) =>
    server.app.inject({
      method: 'POST',
      url,
      headers: { ...supplied, ...extra },
      payload: {},
    });
  try {
    for (const supplied of [
      {} as Record<string, string>,
      { 'x-loop-admin-key': 'wrong' },
    ]) {
      const response = await post('/api/admin/netease/status', supplied);
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const guest = await server.app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: '猫猫' },
    });
    const guestCookie = String(guest.headers['set-cookie']).split(';')[0]!;
    assert.equal(
      (await post('/api/admin/netease/status', {}, { cookie: guestCookie }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post('/api/admin/netease/qr/start', headers, {
          origin: 'https://evil.example',
          host: 'loop.example',
        })
      ).statusCode,
      403,
    );
    assert.deepEqual((await post('/api/admin/netease/status')).json(), {
      configured: false,
    });
    const start = await post('/api/admin/netease/qr/start');
    assert.equal(start.statusCode, 200);
    assert.equal(start.headers['cache-control'], 'no-store');
    const { image, expiresAt } = start.json();
    assert.match(image, /^data:image\/svg\+xml;base64,/);
    assert.ok(expiresAt > Date.now());
    const svg = Buffer.from(image.split(',')[1], 'base64').toString();
    assert.match(svg, /<svg/);
    for (const expected of ['waiting', 'scanned', 'success']) {
      const check = await post('/api/admin/netease/qr/check');
      assert.deepEqual(check.json(), {
        status: expected,
        configured: expected === 'success',
      });
      assert.doesNotMatch(
        check.body,
        /private-token|qrChallenge|MUSIC_U|__csrf/,
      );
    }
    assert.deepEqual((await post('/api/admin/netease/qr/check')).json(), {
      status: 'expired',
      configured: true,
    });
    assert.equal(readFileSync(file, 'utf8'), 'MUSIC_U=private-token');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      calls.map((url) => url.split('/').pop()),
      ['unikey', 'login', 'login', 'login'],
    );
  } finally {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin QR challenge expires, rate limits scans, and rejects success without MUSIC_U', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-qr-'));
  let now = 1000;
  let code = 800;
  const server = await createServer({
    dbPath: ':memory:',
    neteaseCookieFile: join(dir, 'cookie'),
    adminKey,
    neteaseNow: () => now,
    neteaseQrFetch: async (url) =>
      url.endsWith('/unikey')
        ? result({ code: 200, data: { unikey: qrKey } })
        : result(
            { code },
            code === 803 ? '__csrf=csrf-secret; Path=/' : undefined,
          ),
  });
  const post = (url: string) =>
    server.app.inject({ method: 'POST', url, headers, payload: {} });
  try {
    assert.equal(
      (await post('/api/admin/netease/qr/check')).json().status,
      'expired',
    );
    await post('/api/admin/netease/qr/start');
    assert.equal(
      (await post('/api/admin/netease/qr/check')).json().status,
      'expired',
    );
    await post('/api/admin/netease/qr/start');
    code = 803;
    const failure = await post('/api/admin/netease/qr/check');
    assert.equal(failure.statusCode, 502);
    assert.doesNotMatch(failure.body, /csrf-secret|MUSIC_U/);
    assert.equal(
      (await post('/api/admin/netease/status')).json().configured,
      false,
    );
    await post('/api/admin/netease/qr/start');
    assert.equal((await post('/api/admin/netease/qr/start')).statusCode, 429);
    now += 180_001;
    assert.equal(
      (await post('/api/admin/netease/qr/check')).json().status,
      'expired',
    );
    for (let index = 0; index < 26; index++)
      assert.equal((await post('/api/admin/netease/qr/check')).statusCode, 200);
    assert.equal((await post('/api/admin/netease/qr/check')).statusCode, 429);
    for (let index = 0; index < 59; index++) {
      const denied = await server.app.inject({
        method: 'POST',
        url: '/api/admin/netease/status',
        headers: { 'x-loop-admin-key': 'wrong' },
        payload: {},
      });
      assert.equal(denied.statusCode, 403);
    }
    const throttled = await server.app.inject({
      method: 'POST',
      url: '/api/admin/netease/status',
      headers: { 'x-loop-admin-key': 'wrong' },
      payload: {},
    });
    assert.equal(throttled.statusCode, 429);
  } finally {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved QR credential survives restart and updates live music requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-qr-'));
  const file = join(dir, 'cookie');
  const observed: string[] = [];
  const make = () =>
    createServer({
      dbPath: ':memory:',
      neteaseCookieFile: file,
      adminKey,
      neteaseQrFetch: async (url) =>
        url.endsWith('/unikey')
          ? result({ code: 200, data: { unikey: qrKey } })
          : result({ code: 803 }, 'MUSIC_U=live-user; Path=/; HttpOnly'),
      neteaseMusicFetch: async (_url: string, init: RequestInit) => {
        observed.push((init.headers as Record<string, string>).Cookie);
        return result({ code: 200, playlist: [], more: false });
      },
    });
  let server = await make();
  const playlist = () =>
    server.app.inject({ method: 'GET', url: '/api/music/users/123/playlists' });
  const post = (url: string) =>
    server.app.inject({ method: 'POST', url, headers, payload: {} });
  try {
    await post('/api/admin/netease/qr/start');
    assert.equal(
      (await post('/api/admin/netease/qr/check')).json().status,
      'success',
    );
    assert.equal((await playlist()).statusCode, 200);
    assert.match(observed.at(-1)!, /MUSIC_U=live-user/);
    await server.app.close();
    server.db.close();
    server = await make();
    assert.deepEqual((await post('/api/admin/netease/status')).json(), {
      configured: true,
    });
    assert.equal((await playlist()).statusCode, 200);
    assert.match(observed.at(-1)!, /MUSIC_U=live-user/);
  } finally {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

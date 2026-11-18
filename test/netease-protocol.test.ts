import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { Headers, Response, type RequestInit } from 'undici';
import {
  createNeteaseRequest,
  createNeteaseQrRequest,
  NeteaseRequestError,
  encryptWeapi,
} from '../src/server/netease-protocol.js';

function payload(init: RequestInit) {
  const params = new URLSearchParams(String(init.body)).get('params')!;
  const decipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from('e82ckenh8dichen8'),
    null,
  );
  const text = Buffer.concat([
    decipher.update(Buffer.from(params, 'hex')),
    decipher.final(),
  ]).toString();
  return JSON.parse(text.split('-36cd479b6b5-')[1]!);
}
const reply = (body: unknown, cookie?: string) =>
  new Response(JSON.stringify(body), {
    headers: cookie ? { 'set-cookie': cookie } : {},
  });

function setRealIp(context: TestContext, value: string | undefined) {
  const key = 'NETEASE_MUSIC_API_REALIP';
  const previous = process.env[key];
  const set = (ip: string | undefined) => {
    if (ip === undefined) delete process.env[key];
    else process.env[key] = ip;
  };
  context.after(() => set(previous));
  set(value);
}

test('QR key and poll use one desktop EAPI device identity without the music request IP headers', async (context) => {
  setRealIp(context, '203.0.113.20');
  const devices: string[] = [];
  const request = createNeteaseQrRequest(async (url, init) => {
    assert.match(
      url,
      /^https:\/\/interfacepc\.music\.163\.com\/eapi\/login\/qrcode\//,
    );
    const headers = init.headers as Record<string, string>;
    const httpHeaders = new Headers(headers);
    assert.equal(httpHeaders.has('X-Real-IP'), false);
    assert.equal(httpHeaders.has('X-Forwarded-For'), false);
    assert.match(headers['User-Agent']!, /NeteaseMusicDesktop/);
    assert.doesNotMatch(headers['User-Agent']!, /iPhone/);
    assert.match(headers.Cookie, /(?:^|; )os=pc(?:;|$)/);
    assert.equal(
      new URLSearchParams(String(init.body)).has('encSecKey'),
      false,
    );
    const data = payload(init);
    assert.equal(data.type, 3);
    assert.equal(data.e_r, false);
    assert.equal(data.header.os, 'pc');
    assert.match(data.header.deviceId, /^[0-9a-f]{32}$/);
    devices.push(data.header.deviceId);
    if (url.endsWith('/unikey')) {
      assert.equal(data.key, undefined);
      return reply({ code: 200, data: { unikey: 'qr-key' } });
    }
    assert.equal(data.key, 'qr-key');
    return reply({ code: 801 });
  });
  await request('unikey');
  await request('check', 'qr-key');
  assert.equal(devices[0], devices[1]);
});

test('configured IP goes to guest registration, EAPI and WEAPI music requests', async (context) => {
  setRealIp(context, ' 203.0.113.20 ');
  const requests: { url: string; headers: Headers }[] = [];
  const request = createNeteaseRequest('', async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) });
    return reply({ code: 200 }, 'MUSIC_A=test-guest-token; Path=/');
  });
  await request('/api/song/enhance/player/url/v1', {});
  await request('/api/user/playlist', {});

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'https://music.163.com/weapi/register/anonimous',
      'https://interface.music.163.com/eapi/song/enhance/player/url/v1',
      'https://music.163.com/weapi/user/playlist',
    ],
  );
  for (const { headers } of requests) {
    assert.equal(headers.get('X-Real-IP'), '203.0.113.20');
    assert.equal(headers.get('X-Forwarded-For'), '203.0.113.20');
  }
});

test('music request IP configuration is optional and accepts IPv6', async (context) => {
  for (const [name, input, expected] of [
    ['unset', undefined, null],
    ['blank', '  ', null],
    ['IPv6', '2001:db8::20', '2001:db8::20'],
  ] as const) {
    await context.test(name, async (subtest) => {
      setRealIp(subtest, input);
      let headers = new Headers();
      const request = createNeteaseRequest(
        'MUSIC_A=test',
        async (_url, init) => {
          headers = new Headers(init.headers);
          return reply({ code: 200 });
        },
      );
      await request('/api/v3/song/detail', {});
      assert.equal(headers.get('X-Real-IP'), expected);
      assert.equal(headers.get('X-Forwarded-For'), expected);
    });
  }
});

test('invalid music request IP fails during setup without echoing the configured value', (context) => {
  setRealIp(context, '203.0.113.20, private-value');
  assert.throws(() => createNeteaseRequest(), {
    message: 'NETEASE_MUSIC_API_REALIP must be a valid IPv4 or IPv6 address',
  });
});

test('anonymous requests register once, share identity and keep one device for playback', async () => {
  let registrations = 0;
  let registeredDevice = '';
  let requests = 0;
  const request = createNeteaseRequest('', async (url, init) => {
    if (url.endsWith('/register/anonimous')) {
      registrations++;
      assert.equal(url, 'https://music.163.com/weapi/register/anonimous');
      const headers = init.headers as Record<string, string>;
      registeredDevice = /deviceId=([^;]+)/.exec(headers.Cookie)![1]!;
      assert.doesNotMatch(headers.Cookie, /MUSIC_A=/);
      assert.match(
        new URLSearchParams(String(init.body)).get('encSecKey')!,
        /^[0-9a-f]{256}$/,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      return reply({ code: 200 }, 'MUSIC_A=test-guest-token; Path=/; HttpOnly');
    }
    const data = payload(init);
    requests++;
    assert.equal(data.header.MUSIC_A, 'test-guest-token');
    assert.equal(data.header.deviceId, registeredDevice);
    assert.match(
      (init.headers as Record<string, string>).Cookie,
      /MUSIC_A=test-guest-token/,
    );
    return reply({ code: 200, data: [] });
  });
  await Promise.all([
    request('/api/cloudsearch/pc', { s: '猫' }),
    request('/api/v3/song/detail', { c: '[{"id":"1"}]' }),
  ]);
  await request('/api/song/enhance/player/url/v1', {
    ids: '[1]',
    level: 'standard',
  });
  assert.equal(registrations, 1);
  assert.equal(requests, 3);
});

test('configured user or guest credentials bypass anonymous registration', async () => {
  for (const cookie of ['MUSIC_U=test-user', 'MUSIC_A=test-guest']) {
    const request = createNeteaseRequest(cookie, async (url, init) => {
      assert.ok(!url.endsWith('/register/anonimous'));
      const data = payload(init);
      const [key, value] = cookie.split('=');
      assert.equal(data.header[key!], value);
      return reply({ code: 200 });
    });
    await request('/api/v3/song/detail', {});
  }
});

test('failed registration allows public requests, backs off, then recovers', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let registrations = 0;
  const tokens: unknown[] = [];
  const request = createNeteaseRequest('', async (url, init) => {
    if (url.endsWith('/register/anonimous')) {
      if (++registrations === 1) throw new Error('private MUSIC_A=secret');
      return reply({ code: 200 }, 'MUSIC_A=recovered; Path=/');
    }
    tokens.push(payload(init).header.MUSIC_A);
    return reply({ code: 200 });
  });
  await request('/api/v3/song/detail', {});
  await request('/api/v3/song/detail', {});
  assert.equal(registrations, 1);
  context.mock.timers.tick(60_000);
  await request('/api/v3/song/detail', {});
  assert.equal(registrations, 2);
  assert.deepEqual(tokens, [undefined, undefined, 'recovered']);
});

test('a missing guest cookie falls back to public requests, whose errors stay sanitized', async () => {
  const request = createNeteaseRequest('', async (url) => {
    if (url.endsWith('/register/anonimous')) return reply({ code: 200 });
    throw new Error('private MUSIC_A=secret');
  });
  await assert.rejects(request('/api/v3/song/detail', {}), (error) => {
    assert.ok(error instanceof NeteaseRequestError);
    assert.equal(error.kind, 'network');
    assert.doesNotMatch(error.message, /private|secret|MUSIC_A/);
    return true;
  });
});

test('anonymous WEAPI payload contains the original data after both AES layers', () => {
  const secret = '0123456789abcdef';
  const data = { username: 'guest-device-proof', csrf_token: '' };
  const encrypted = encryptWeapi(data, secret);
  const decrypt = (text: string, key: string) => {
    const cipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(key),
      Buffer.from('0102030405060708'),
    );
    return Buffer.concat([
      cipher.update(Buffer.from(text, 'base64')),
      cipher.final(),
    ]).toString();
  };
  assert.deepEqual(
    JSON.parse(decrypt(decrypt(encrypted.params, secret), '0CoJUm6Qyw8W8jud')),
    data,
  );
  assert.match(encrypted.encSecKey, /^[0-9a-f]{256}$/);
});

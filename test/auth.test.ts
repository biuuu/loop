import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server/app.js';
import { hashToken } from '../src/server/db.js';
import type { EmailMessage } from '../src/server/mail.js';

const secret = 'test-only-auth-hmac-secret-at-least-32-characters';
const getCookie = (response: { headers: Record<string, unknown> }) =>
  (response.headers['set-cookie'] as string).split(';')[0]!;
async function setup(dbPath = ':memory:') {
  let now = Date.now();
  const messages: EmailMessage[] = [];
  const server = await createServer({
    dbPath,
    authSecret: secret,
    authNow: () => now,
    sendMail: async (message) => {
      messages.push(message);
    },
  });
  const guest = async (nickname = 'Guest') => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname },
    });
    return { cookie: getCookie(response), guest: response.json().guest };
  };
  const request = async (
    email: string,
    purpose: 'login' | 'bind' = 'login',
    cookie?: string,
  ) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      headers: cookie ? { cookie } : {},
      payload: { email, purpose },
    });
  const verify = async (challengeId: string, code: string, cookie?: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      headers: cookie ? { cookie } : {},
      payload: { challengeId, code },
    });
  const login = async (email: string) => {
    const response = await request(email);
    assert.equal(response.statusCode, 200, response.body);
    const result = await verify(
      response.json().challengeId,
      messages.at(-1)!.code,
    );
    assert.equal(result.statusCode, 200, result.body);
    return { cookie: getCookie(result), guest: result.json().guest };
  };
  return {
    ...server,
    messages,
    guest,
    request,
    verify,
    login,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('temporary identities can create one isolated room each without configured mail', async () => {
  const { app, db, registry } = await createServer({ dbPath: ':memory:' });
  try {
    assert.deepEqual((await app.inject('/api/me')).json(), {
      guest: null,
      auth: { emailEnabled: false },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'Same' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'Same' },
    });
    assert.notEqual(first.json().guest.id, second.json().guest.id);
    assert.equal(first.json().guest.registered, false);
    assert.equal(first.json().createdRoom.ownerId, first.json().guest.id);
    assert.equal(second.json().createdRoom.ownerId, second.json().guest.id);
    const create = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { cookie },
        payload: { name: 'Room', environmentId: 'cozy' },
      });
    assert.equal((await create(getCookie(first))).statusCode, 409);
    // Deleting the automatic room restores the existing manual creation flow.
    db.deleteRoom(first.json().createdRoom.id);
    db.deleteRoom(second.json().createdRoom.id);
    const created = await create(getCookie(first));
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().room.ownerId, first.json().guest.id);
    assert.equal((await create(getCookie(first))).statusCode, 409);
    const otherRoom = await create(getCookie(second));
    assert.equal(otherRoom.statusCode, 200);
    assert.notEqual(otherRoom.json().room.id, created.json().room.id);
    assert.equal((await create('')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/email/request',
          payload: { email: 'user@example.com', purpose: 'login' },
        })
      ).statusCode,
      503,
    );
    assert.equal((await app.inject('/api/rooms')).json().total, 2);
    assert.equal(registry.runtimeCount(), 0);
  } finally {
    await app.close();
  }
});

test('binding preserves profile and queue, rotates sessions and retires legacy cookies; verified identities retain the one-room limit', async () => {
  const f = await setup();
  try {
    const before = await f.guest('Original');
    const token = before.cookie.slice('loop_guest='.length);
    // Simulate the still-valid cookie of a pre-session installation.
    f.db.sql
      .prepare('UPDATE guests SET token_hash=? WHERE id=?')
      .run(hashToken('legacy-token'), before.guest.id);
    f.db.updateAppearance(before.guest.id, {
      coat: 'pure_black',
      pattern: 'tabby',
    });
    f.db.add(before.guest.id, {
      id: '1',
      title: 'Keep',
      artist: 'A',
      album: '',
      cover: '',
      durationMs: 1000,
    });
    const request = await f.request(
      '  Person+Tag@Example.COM  ',
      'bind',
      before.cookie,
    );
    assert.equal(request.statusCode, 200, request.body);
    const message = f.messages.at(-1)!;
    assert.equal(message.to, 'person+tag@example.com');
    assert.match(message.code, /^\d{6}$/);
    const row = f.db.sql
      .prepare('SELECT code_hmac FROM email_challenges WHERE id=?')
      .get(request.json().challengeId) as { code_hmac: string };
    assert.notEqual(row.code_hmac, message.code);
    assert.equal(row.code_hmac.length, 64);
    const verified = await f.verify(
      request.json().challengeId,
      message.code,
      before.cookie,
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const cookie = getCookie(verified);
    assert.notEqual(cookie, before.cookie);
    assert.equal(verified.json().guest.id, before.guest.id);
    assert.equal(verified.json().guest.registered, true);
    assert.equal(verified.json().guest.email, message.to);
    assert.deepEqual(verified.json().guest.appearance, {
      coat: 'pure_black',
      pattern: 'tabby',
    });
    assert.equal(f.db.firstTrack(before.guest.id)!.title, 'Keep');
    assert.equal(f.db.guest(token), null);
    assert.equal(f.db.guest('legacy-token'), null);
    // Exercise concurrent manual creation after the original room is deleted.
    f.db.deleteRoom(
      f.db.rooms().find((room) => room.ownerId === before.guest.id)!.id,
    );
    const create = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { cookie },
        payload: { name: 'My room', environmentId: 'cozy' },
      });
    const created = await Promise.all([create(), create()]);
    assert.deepEqual(
      created.map((response) => response.statusCode).sort(),
      [200, 409],
    );
    assert.equal(
      (await f.verify(request.json().challengeId, message.code, before.cookie))
        .statusCode,
      400,
    );
  } finally {
    await f.app.close();
  }
});

test('email login uses its bound identity, never merges guest data, and logout-all revokes all device sessions', async () => {
  const f = await setup();
  const revoked: Array<[string, string | undefined]> = [];
  const priorRevoke = f.auth.onRevoke;
  f.auth.onRevoke = (userId, tokenHash) => {
    revoked.push([userId, tokenHash]);
    priorRevoke(userId, tokenHash);
  };
  try {
    const registered = await f.login('owner@example.com');
    const temporary = await f.guest('Temporary');
    f.advance(60_001);
    const request = await f.request(
      'owner@example.com',
      'login',
      temporary.cookie,
    );
    const verified = await f.verify(
      request.json().challengeId,
      f.messages.at(-1)!.code,
      temporary.cookie,
    );
    assert.equal(verified.json().guest.id, registered.guest.id);
    assert.notEqual(verified.json().guest.id, temporary.guest.id);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: temporary.cookie },
        })
      ).json().guest,
      null,
    );
    assert.deepEqual(revoked, [
      [
        temporary.guest.id,
        hashToken(temporary.cookie.slice('loop_guest='.length)),
      ],
    ]);
    assert.equal(f.db.guestById(temporary.guest.id).nickname, 'Temporary');
    const secondCookie = getCookie(verified);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: registered.cookie },
        })
      ).json().guest.id,
      registered.guest.id,
    );
    await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: secondCookie },
    });
    for (const cookie of [registered.cookie, secondCookie])
      assert.equal(
        (await f.app.inject({ url: '/api/me', headers: { cookie } })).json()
          .guest,
        null,
      );
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: temporary.cookie },
        })
      ).json().guest,
      null,
    );
  } finally {
    await f.app.close();
  }
});

test('wrong-code budget persists, resend invalidates old challenges, codes expire and concurrent verification is single use', async () => {
  const f = await setup();
  try {
    let request = await f.request('codes@example.com');
    const first = request.json().challengeId,
      firstCode = f.messages.at(-1)!.code;
    assert.equal((await f.request('codes@example.com')).statusCode, 429);
    const wrong = firstCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++)
      assert.equal((await f.verify(first, wrong)).statusCode, 400);
    assert.equal(
      (
        f.db.sql
          .prepare('SELECT attempts FROM email_challenges WHERE id=?')
          .get(first) as { attempts: number }
      ).attempts,
      5,
    );
    assert.equal((await f.verify(first, firstCode)).statusCode, 400);
    f.advance(60_001);
    request = await f.request('codes@example.com');
    const second = request.json().challengeId,
      secondCode = f.messages.at(-1)!.code;
    f.advance(60_001);
    request = await f.request('codes@example.com');
    assert.equal((await f.verify(second, secondCode)).statusCode, 400);
    const third = request.json().challengeId,
      thirdCode = f.messages.at(-1)!.code;
    f.advance(5 * 60_000);
    assert.equal((await f.verify(third, thirdCode)).statusCode, 400);
    request = await f.request('codes@example.com');
    const fourth = request.json().challengeId,
      fourthCode = f.messages.at(-1)!.code;
    const results = await Promise.all([
      f.verify(fourth, fourthCode),
      f.verify(fourth, fourthCode),
    ]);
    assert.deepEqual(
      results.map((response) => response.statusCode).sort(),
      [200, 400],
    );
  } finally {
    await f.app.close();
  }
});

test('binding is tied to its originating user and session; existing email cannot be stolen or merged', async () => {
  const f = await setup();
  try {
    const registered = await f.login('existing@example.com');
    const first = await f.guest('A'),
      second = await f.guest('B');
    let request = await f.request('new@example.com', 'bind', first.cookie);
    const id = request.json().challengeId,
      code = f.messages.at(-1)!.code;
    assert.equal((await f.verify(id, code, second.cookie)).statusCode, 403);
    assert.equal((await f.verify(id, code)).statusCode, 403);
    const alternate = 'another-session-token';
    f.db.sql
      .prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
      .run(
        hashToken(alternate),
        first.guest.id,
        'temporary',
        Date.now(),
        Date.now() + 60_000,
      );
    assert.equal(
      (await f.verify(id, code, `loop_guest=${alternate}`)).statusCode,
      403,
    );
    assert.equal((await f.verify(id, code, first.cookie)).statusCode, 200);
    f.advance(60_001);
    request = await f.request('existing@example.com', 'bind', second.cookie);
    assert.equal(
      (
        await f.verify(
          request.json().challengeId,
          f.messages.at(-1)!.code,
          second.cookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(f.auth.registered(second.guest.id), false);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: registered.cookie },
        })
      ).json().guest.id,
      registered.guest.id,
    );
  } finally {
    await f.app.close();
  }
});

test('temporary session expiry and logout cannot revive the retired legacy channel; revoke callback distinguishes devices', async () => {
  const f = await setup();
  try {
    const first = await f.guest();
    const token = first.cookie.slice('loop_guest='.length);
    f.db.sql
      .prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .run(Date.now() - 1, hashToken(token));
    assert.equal(f.db.guest(token), null);
    const second = await f.guest();
    const revoked: Array<[string, string | undefined]> = [];
    f.auth.onRevoke = (userId, tokenHash) => revoked.push([userId, tokenHash]);
    await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: second.cookie },
    });
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: second.cookie },
        })
      ).json().guest,
      null,
    );
    assert.deepEqual(revoked, [
      [second.guest.id, hashToken(second.cookie.slice('loop_guest='.length))],
    ]);
  } finally {
    await f.app.close();
  }
});

test('email request IP throttling and origin enforcement reject abuse without sending secrets', async () => {
  const f = await setup();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/email/request',
          headers: { origin: 'https://evil.example' },
          payload: { email: 'evil@example.com', purpose: 'login' },
        })
      ).statusCode,
      403,
    );
    assert.equal(f.messages.length, 0);
    for (let i = 0; i < 20; i++)
      assert.equal((await f.request(`a${i}@example.com`)).statusCode, 200);
    assert.equal((await f.request('blocked@example.com')).statusCode, 429);
    assert.equal(f.messages.length, 20);
  } finally {
    await f.app.close();
  }
});

test('SMTP failure is explicit and its challenge cannot be redeemed', async () => {
  const { app, db } = await createServer({
    dbPath: ':memory:',
    authSecret: secret,
    sendMail: async () => {
      throw new Error('private SMTP credential');
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      payload: { email: 'a@example.com', purpose: 'login' },
    });
    assert.equal(response.statusCode, 502);
    assert.doesNotMatch(response.body, /private SMTP/);
    assert.equal(
      (
        db.sql.prepare('SELECT consumed FROM email_challenges').get() as {
          consumed: number;
        }
      ).consumed,
      1,
    );
  } finally {
    await app.close();
  }
});

test('verified sessions, queues, appearance, ownership and bans survive reopening; realtime room state does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-auth-persist-')),
    path = join(root, 'test.sqlite');
  const f = await setup(path);
  let cookie = '',
    roomId = '',
    userId = '';
  try {
    const user = await f.login('persistent@example.com');
    cookie = user.cookie;
    userId = user.guest.id;
    f.db.updateAppearance(userId, { coat: 'gray', pattern: 'socks' });
    f.db.add(userId, {
      id: '1',
      title: 'Persistent',
      artist: 'A',
      album: '',
      cover: '',
      durationMs: 1000,
    });
    f.db.deleteRoom(f.db.rooms().find((room) => room.ownerId === userId)!.id);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { cookie },
      payload: { name: 'Persistent', environmentId: 'cozy' },
    });
    assert.equal(created.statusCode, 200, created.body);
    roomId = created.json().room.id;
    const other = await f.guest('Other');
    f.db.ban(roomId, other.guest.id);
  } finally {
    await f.app.close();
  }
  const reopened = await setup(path);
  try {
    const me = (
      await reopened.app.inject({ url: '/api/me', headers: { cookie } })
    ).json().guest;
    assert.equal(me.id, userId);
    assert.equal(me.email, 'persistent@example.com');
    assert.deepEqual(me.appearance, { coat: 'gray', pattern: 'socks' });
    assert.equal(reopened.db.firstTrack(userId)!.title, 'Persistent');
    assert.equal(reopened.db.room(roomId)!.ownerId, userId);
    assert.equal(reopened.db.bans(roomId).length, 1);
    assert.equal(reopened.registry.runtimeCount(), 0);
    assert.deepEqual(reopened.db.sql.pragma('foreign_key_check'), []);
  } finally {
    await reopened.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

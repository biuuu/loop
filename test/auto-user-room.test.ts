import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { ENVIRONMENTS } from '../src/shared/environments.js';
import type { Guest, RoomInfo } from '../src/shared/contracts.js';
import type { EmailMessage } from '../src/server/mail.js';

const cookieOf = (response: { headers: Record<string, unknown> }) =>
  (response.headers['set-cookie'] as string).split(';')[0]!;
const secret = 'auto-user-room-test-secret-at-least-32-characters';
const owned = (db: Store, userId: string) =>
  db.rooms().filter((room) => room.ownerId === userId);
function assertDefault(room: RoomInfo, guest: Guest) {
  assert.equal(room.ownerId, guest.id);
  assert.equal(room.ownerNickname, guest.nickname);
  assert.equal(room.name, `${guest.nickname}的房间`);
  assert.equal(room.stageCapacity, 5);
  assert.equal(room.joinPolicy, 'open');
  assert.ok(ENVIRONMENTS.some(({ id }) => id === room.environmentId));
  assert.ok(Number.isSafeInteger(room.number) && room.number > 0);
}
async function emailServer() {
  const messages: EmailMessage[] = [];
  let now = Date.now();
  const server = await createServer({
    dbPath: ':memory:',
    authSecret: secret,
    authNow: () => now,
    sendMail: async (message) => {
      messages.push(message);
    },
  });
  const requestCode = async (
    email: string,
    cookie?: string,
    purpose = 'login',
  ) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      headers: cookie ? { cookie } : {},
      payload: { email, purpose },
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      challengeId: response.json().challengeId,
      code: messages.at(-1)!.code,
    };
  };
  const verify = (
    payload: { challengeId: string; code: string },
    cookie?: string,
  ) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      headers: cookie ? { cookie } : {},
      payload,
    });
  return {
    ...server,
    requestCode,
    verify,
    advance: () => {
      now += 60_001;
    },
  };
}

test('new nickname identities atomically receive separate persistent numbered rooms and restored sessions do not recreate them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-auto-room-'));
  const dbPath = join(root, 'test.sqlite');
  const first = await createServer({ dbPath });
  const saved: Array<{ guest: Guest; createdRoom: RoomInfo; cookie: string }> =
    [];
  try {
    for (let i = 0; i < 2; i++) {
      const response = await first.app.inject({
        method: 'POST',
        url: '/api/guest',
        payload: { nickname: '同名猫' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const { guest, createdRoom } = response.json();
      assertDefault(createdRoom, guest);
      assert.deepEqual(first.db.room(createdRoom.id), createdRoom);
      saved.push({ guest, createdRoom, cookie: cookieOf(response) });
    }
    assert.notEqual(saved[0]!.guest.id, saved[1]!.guest.id);
    assert.notEqual(saved[0]!.createdRoom.id, saved[1]!.createdRoom.id);
    assert.notEqual(saved[0]!.createdRoom.number, saved[1]!.createdRoom.number);
    assert.equal(first.registry.runtimeCount(), 0);
  } finally {
    await first.app.close();
  }
  const reopened = await createServer({ dbPath });
  try {
    for (const { guest, createdRoom, cookie } of saved) {
      const restored = await reopened.app.inject({
        url: '/api/me',
        headers: { cookie },
      });
      assert.equal(restored.json().guest.id, guest.id);
      assert.equal(restored.json().createdRoom, undefined);
      assert.deepEqual(
        reopened.db.roomByNumber(createdRoom.number),
        createdRoom,
      );
      const renamed = await reopened.app.inject({
        method: 'POST',
        url: '/api/guest',
        headers: { cookie },
        payload: { nickname: '改名猫' },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(renamed.json().createdRoom, undefined);
      assert.equal(renamed.headers['set-cookie'], undefined);
      assert.deepEqual(owned(reopened.db, guest.id), [
        { ...createdRoom, ownerNickname: '改名猫' },
      ]);
    }
    assert.equal(reopened.db.rooms().length, 2);
  } finally {
    await reopened.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy roomless identities and deleted rooms stay roomless through restore and rename; manual creation remains available', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:' });
  try {
    const legacy = db.createGuest('Old');
    assert.deepEqual(db.rooms(), []);
    const fresh = db.createUser('Deleted');
    db.deleteRoom(fresh.createdRoom.id);
    for (const identity of [legacy, fresh]) {
      const headers = { cookie: `loop_guest=${identity.token}` };
      assert.equal(
        (await app.inject({ url: '/api/me', headers })).json().guest.id,
        identity.guest.id,
      );
      const rename = await app.inject({
        method: 'POST',
        url: '/api/guest',
        headers,
        payload: { nickname: 'Changed' },
      });
      assert.equal(rename.statusCode, 200, rename.body);
      assert.equal(rename.json().createdRoom, undefined);
      assert.deepEqual(owned(db, identity.guest.id), []);
      const manual = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { name: 'Manual' },
      });
      assert.equal(manual.statusCode, 200, manual.body);
      assert.equal(manual.json().room.ownerId, identity.guest.id);
      assert.ok(manual.json().room.number > fresh.createdRoom.number);
    }
  } finally {
    await app.close();
  }
});

test('failed automatic room-number allocation rolls back identity, session, room and number before issuing a cookie', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:' });
  try {
    db.sql.exec(
      "CREATE TRIGGER fail_auto_room BEFORE INSERT ON room_numbers BEGIN SELECT RAISE(ABORT, 'test allocation failure'); END",
    );
    const failed = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'Retry' },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers['set-cookie'], undefined);
    for (const table of ['guests', 'sessions', 'rooms', 'room_numbers'])
      assert.equal(
        (
          db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
        0,
      );
    db.sql.exec('DROP TRIGGER fail_auto_room');
    const retry = await app.inject({
      method: 'POST',
      url: '/api/guest',
      payload: { nickname: 'Retry' },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().createdRoom.number, 1);
    assertDefault(retry.json().createdRoom, retry.json().guest);
  } finally {
    await app.close();
  }
});

test('only a first email login creates a room; guest data and ownership remain separate and subsequent login never backfills', async () => {
  const f = await emailServer();
  try {
    const temporary = f.db.createUser('Temporary');
    const cookie = `loop_guest=${temporary.token}`;
    const code = await f.requestCode('first@example.com', cookie);
    const first = await f.verify(code, cookie);
    assert.equal(first.statusCode, 200, first.body);
    const { guest, createdRoom } = first.json();
    assertDefault(createdRoom, guest);
    assert.notEqual(guest.id, temporary.guest.id);
    assert.notEqual(createdRoom.id, temporary.createdRoom.id);
    assert.deepEqual(owned(f.db, temporary.guest.id), [temporary.createdRoom]);
    assert.equal(f.db.guest(temporary.token), null);
    const loggedInCookie = cookieOf(first);
    f.advance();
    let again = await f.verify(await f.requestCode('first@example.com'));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().guest.id, guest.id);
    assert.equal(again.json().createdRoom, undefined);
    assert.deepEqual(owned(f.db, guest.id), [createdRoom]);
    f.db.deleteRoom(createdRoom.id);
    f.advance();
    again = await f.verify(await f.requestCode('first@example.com'));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().createdRoom, undefined);
    assert.deepEqual(owned(f.db, guest.id), []);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/me',
          headers: { cookie: loggedInCookie },
        })
      ).json().guest.id,
      guest.id,
    );
    assert.deepEqual(owned(f.db, guest.id), []);
  } finally {
    await f.app.close();
  }
});

test('binding a roomless legacy identity never creates a room or changes its identity', async () => {
  const f = await emailServer();
  try {
    const old = f.db.createGuest('Legacy');
    const cookie = `loop_guest=${old.token}`;
    const result = await f.verify(
      await f.requestCode('bind@example.com', cookie, 'bind'),
      cookie,
    );
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().guest.id, old.guest.id);
    assert.deepEqual(result.json().guest.appearance, old.guest.appearance);
    assert.equal(result.json().createdRoom, undefined);
    assert.deepEqual(f.db.rooms(), []);
  } finally {
    await f.app.close();
  }
});

test('email session failure after creating the automatic room rolls back all new state and preserves the redeemable challenge', async () => {
  const f = await emailServer();
  try {
    const existing = f.db.createUser('Existing');
    const cookie = `loop_guest=${existing.token}`;
    const code = await f.requestCode('retry@example.com', cookie);
    f.db.sql.exec(
      "CREATE TRIGGER fail_email_session BEFORE INSERT ON sessions WHEN NEW.auth_level='email' BEGIN SELECT RAISE(ABORT, 'test session failure'); END",
    );
    const failed = await f.verify(code, cookie);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.deepEqual(f.db.guest(existing.token), existing.guest);
    assert.deepEqual(f.db.rooms(), [existing.createdRoom]);
    for (const table of ['guests', 'sessions', 'rooms', 'room_numbers'])
      assert.equal(
        (
          f.db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
        1,
      );
    assert.equal(
      (
        f.db.sql.prepare('SELECT COUNT(*) AS n FROM auth_identities').get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.deepEqual(
      f.db.sql
        .prepare('SELECT consumed,attempts FROM email_challenges WHERE id=?')
        .get(code.challengeId),
      { consumed: 0, attempts: 0 },
    );
    f.db.sql.exec('DROP TRIGGER fail_email_session');
    const retry = await f.verify(code, cookie);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(
      retry.json().createdRoom.number,
      existing.createdRoom.number + 1,
    );
    assertDefault(retry.json().createdRoom, retry.json().guest);
  } finally {
    await f.app.close();
  }
});

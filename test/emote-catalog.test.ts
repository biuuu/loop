import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/db.js';
import {
  EmoteCatalog,
  EmoteConflictError,
} from '../src/server/emote-catalog.js';
import { createServer } from '../src/server/app.js';
import { Room } from '../src/server/room.js';
import type { MusicService } from '../src/shared/contracts.js';

const adminKey = 'ad802337f21143d1a69008c022562f75';
const adminHeaders = { 'x-loop-admin-key': adminKey };

test('fresh catalog omits the broken preset and persists edits after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-emotes-'));
  const path = join(dir, 'loop.sqlite');
  try {
    let db = new Store(path);
    let catalog = new EmoteCatalog(db);
    const initial = catalog.get();
    assert.equal(initial.revision, 1);
    assert.equal(initial.enabled, true);
    assert.deepEqual(
      initial.groups.map((group) => group.id),
      ['nahida', 'ys', 'imsc', 'ac1', 'ac2'],
    );
    assert.equal(
      initial.groups.reduce((sum, group) => sum + group.items.length, 0),
      190,
    );
    assert.equal(initial.groups[2]!.items.length, 48);
    assert.equal(
      initial.groups[2]!.items.some((item) => item.id === 'imsc-1'),
      false,
    );
    assert.ok(
      initial.groups.every((group) =>
        group.items.every((item) => item.url.startsWith('https://')),
      ),
    );
    assert.ok(
      initial.groups
        .flatMap((group) => group.items)
        .every((item) => !item.url.includes('.nga.178.com/')),
    );
    const saved = catalog.save({
      revision: initial.revision,
      enabled: false,
      groups: [
        { label: '新增', items: [{ url: 'https://example.com/a.png' }] },
      ],
    });
    assert.equal(saved.revision, 2);
    assert.match(saved.groups[0]!.id, /^g_/);
    assert.match(saved.groups[0]!.items[0]!.id, /^e_/);
    assert.equal(catalog.allows(saved.groups[0]!.items[0]!.id), false);
    db.close();
    db = new Store(path);
    catalog = new EmoteCatalog(db);
    assert.deepEqual(catalog.get(), saved);
    assert.throws(
      () => catalog.save({ ...saved, revision: 0 }),
      EmoteConflictError,
    );
    assert.deepEqual(catalog.get(), saved);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version 11 retains an administrator replacement for the removed preset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-emote-replacement-'));
  const path = join(dir, 'loop.sqlite');
  let db: Store | undefined;
  try {
    db = new Store(path);
    const edited = new EmoteCatalog(db).get();
    edited.revision = 0;
    edited.groups[2]!.items.unshift({
      id: 'imsc-1',
      url: 'https://example.com/replacement.png',
    });
    db.sql
      .prepare('UPDATE emote_catalog SET revision=?,groups_json=? WHERE id=1')
      .run(edited.revision, JSON.stringify(edited.groups));
    db.close();
    db = undefined;
    db = new Store(path);
    assert.deepEqual(new EmoteCatalog(db).get(), edited);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog validates URLs, bounds, duplicate IDs, and removed items', () => {
  const db = new Store(':memory:');
  try {
    const catalog = new EmoteCatalog(db);
    const initial = catalog.get();
    const first = initial.groups[0]!.items[0]!;
    for (const url of [
      'http://example.com/a.png',
      'javascript:alert(1)',
      'https://user:secret@example.com/a.png',
    ])
      assert.throws(() =>
        catalog.save({
          revision: initial.revision,
          enabled: true,
          groups: [{ label: 'x', items: [{ url }] }],
        }),
      );
    assert.throws(() =>
      catalog.save({
        revision: initial.revision,
        enabled: true,
        groups: [
          {
            label: 'x',
            items: [
              { id: first.id, url: first.url },
              { id: first.id, url: first.url },
            ],
          },
        ],
      }),
    );
    assert.throws(() =>
      catalog.save({
        revision: initial.revision,
        enabled: true,
        groups: [{ id: 'forged', label: 'x', items: [] }],
      }),
    );
    assert.throws(() =>
      catalog.save({
        revision: initial.revision,
        enabled: true,
        groups: Array.from({ length: 21 }, () => ({ label: 'x', items: [] })),
      }),
    );
    const saved = catalog.save({
      revision: initial.revision,
      enabled: true,
      groups: [
        {
          id: initial.groups[0]!.id,
          label: 'x',
          items: [{ id: first.id, url: first.url }],
        },
      ],
    });
    assert.equal(catalog.allows(first.id), true);
    assert.equal(catalog.allows(initial.groups[1]!.items[0]!.id), false);
    assert.equal(saved.groups[0]!.items[0]!.id, first.id);
  } finally {
    db.close();
  }
});

test('live rooms use the current catalog for send permission without snapshots', () => {
  const db = new Store(':memory:');
  const catalog = new EmoteCatalog(db);
  const music = {
    search: async () => [],
    detail: async () => {
      throw new Error('unused');
    },
    resolve: async () => {
      throw new Error('unused');
    },
  } satisfies MusicService;
  const room = new Room(db, music, {}, catalog);
  try {
    const a = db.createGuest('A').guest;
    const b = db.createGuest('B').guest;
    room.connect(a, { id: 'a', replaced() {} });
    room.connect(b, { id: 'b', replaced() {} });
    const events: { userId: string; id: string }[] = [];
    let snapshots = 0;
    room.onEmote = ({ userId, id }) => events.push({ userId, id });
    room.onChange = () => snapshots++;
    const before = catalog.get();
    const oldId = before.groups[0]!.items[0]!.id;
    room.emote(a.id, { id: oldId });
    const saved = catalog.save({
      revision: before.revision,
      enabled: true,
      groups: [
        { label: 'New', items: [{ url: 'https://example.com/new.gif' }] },
      ],
    });
    assert.throws(() => room.emote(b.id, { id: oldId }), /表情不可用/);
    room.emote(b.id, { id: saved.groups[0]!.items[0]!.id });
    const disabled = catalog.save({ ...saved, enabled: false });
    assert.throws(
      () => room.emote(a.id, { id: disabled.groups[0]!.items[0]!.id }),
      /表情不可用/,
    );
    assert.equal(snapshots, 0);
    assert.deepEqual(events, [
      { userId: a.id, id: oldId },
      { userId: b.id, id: saved.groups[0]!.items[0]!.id },
    ]);
  } finally {
    room.close();
    db.close();
  }
});

test('admin catalog routes require key, reject stale saves, and publish revision only', async (context) => {
  const server = await createServer({
    dbPath: ':memory:',
    adminKey,
    singleRoom: true,
  });
  try {
    const publicResponse = await server.app.inject({
      method: 'GET',
      url: '/api/emotes',
    });
    assert.equal(publicResponse.statusCode, 200);
    assert.equal(publicResponse.json().groups.length, 5);
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/admin/emotes/catalog',
          payload: {},
        })
      ).statusCode,
      403,
    );
    const read = await server.app.inject({
      method: 'POST',
      url: '/api/admin/emotes/catalog',
      headers: adminHeaders,
      payload: {},
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), publicResponse.json());
    const emit = context.mock.method(server.io, 'emit');
    const put = (payload: unknown) =>
      server.app.inject({
        method: 'PUT',
        url: '/api/admin/emotes/catalog',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const response = await put({
      revision: publicResponse.json().revision,
      enabled: true,
      groups: [
        { label: 'New', items: [{ url: 'https://example.com/a.webp' }] },
      ],
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().revision, 2);
    assert.deepEqual(
      emit.mock.calls.map((call) => call.arguments),
      [['emotes:updated', { revision: 2 }]],
    );
    assert.equal(
      (await put({ revision: 0, enabled: true, groups: [] })).statusCode,
      409,
    );
    assert.equal(
      (
        await put({
          revision: 2,
          enabled: true,
          groups: [
            { label: 'bad', items: [{ url: 'http://example.com/a.png' }] },
          ],
        })
      ).statusCode,
      400,
    );
    assert.equal(emit.mock.callCount(), 1);
  } finally {
    await server.app.close();
  }
});

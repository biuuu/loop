import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import {
  CALICO_APPEARANCE,
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
  SEAL_POINT_APPEARANCE,
} from '../src/shared/appearance.js';
import type { Guest } from '../src/shared/contracts.js';

const RED_POINT_APPEARANCE = { coat: 'white', pattern: 'red_point' } as const;
const SILVER_SHADED_APPEARANCE = {
  coat: 'white',
  pattern: 'silver_shaded',
} as const;
const REMAINING_PRESETS_SINCE_23 = [
  'calico',
  'cow',
  'orange_white',
  'tortoiseshell',
  'seal_point',
  'tabby_white',
] as const;

for (const [
  previous,
  savedAppearance,
  supportedPresets,
  migratedAppearance = savedAppearance,
] of [
  [19, { coat: 'pure_black', pattern: 'tabby' }, []],
  [20, CALICO_APPEARANCE, ['calico']],
  [
    21,
    { coat: 'black', pattern: 'tortoiseshell' },
    ['calico', 'cow', 'orange_white', 'tortoiseshell'],
  ],
  [
    22,
    SEAL_POINT_APPEARANCE,
    ['calico', 'cow', 'orange_white', 'tortoiseshell', 'seal_point'],
  ],
  [
    23,
    RED_POINT_APPEARANCE,
    REMAINING_PRESETS_SINCE_23,
    { coat: 'white', pattern: 'solid' },
  ],
  [
    24,
    SILVER_SHADED_APPEARANCE,
    REMAINING_PRESETS_SINCE_23,
    { coat: 'white', pattern: 'solid' },
  ],
] as const) {
  test(`upgrading from migration ${previous} preserves guest and room data and enforces the fixed presets`, (context) => {
    const root = mkdtempSync(join(tmpdir(), 'loop-cat-presets-'));
    const dbPath = join(root, 'test.sqlite');
    const migrations = join(root, 'migrations');
    let db: Store | undefined;
    // Select from the end of the new-account pool to check each schema's presets.
    let pickFromEnd = 1;
    const pickLast = context.mock.method(
      crypto,
      'randomInt',
      (max: number) => max - pickFromEnd,
    );
    syncBuiltinESMExports();
    try {
      mkdirSync(migrations);
      for (const name of readdirSync('migrations').filter(
        (name) => name.endsWith('.sql') && Number(name.slice(0, 3)) <= previous,
      ))
        copyFileSync(join('migrations', name), join(migrations, name));
      db = new Store(dbPath, migrations);
      assert.equal(db.sql.pragma('user_version', { simple: true }), previous);
      const owner = db.createUser('Owner');
      assert.equal(
        owner.guest.appearance?.pattern,
        supportedPresets.at(-1) ?? 'tabby',
      );
      const other = db.createGuest('Other');
      const update = 'UPDATE guests SET coat=?, pattern=? WHERE id=?';
      const updateOld = db.sql.prepare(update);
      updateOld.run(
        savedAppearance.coat,
        savedAppearance.pattern,
        owner.guest.id,
      );
      assert.deepEqual(db.guest(owner.token)?.appearance, savedAppearance);
      db.add(owner.guest.id, {
        id: '1',
        title: 'Saved track',
        artist: 'Artist',
        album: '',
        cover: '',
        durationMs: 60_000,
      });
      db.ban(owner.createdRoom.id, other.guest.id);
      db.sql
        .prepare('INSERT INTO auth_identities VALUES (?,?,?,?)')
        .run(owner.guest.id, 'email', 'owner@example.com', Date.now());
      for (const { appearance, label } of CAT_APPEARANCE_PRESETS) {
        if (
          supportedPresets.some((pattern) => pattern === appearance.pattern)
        ) {
          const cat = db.createGuest(label);
          db.updateAppearance(cat.guest.id, appearance);
          continue;
        }
        assert.throws(
          () =>
            updateOld.run(appearance.coat, appearance.pattern, owner.guest.id),
          /CHECK/,
        );
      }
      const tables = [
        'guests',
        'sessions',
        'auth_identities',
        'playlist',
        'rooms',
        'room_numbers',
        'room_bans',
      ];
      const readRows = (store: Store) =>
        Object.fromEntries(
          tables.map((table) => [
            table,
            store.sql
              .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
              .all() as Record<string, unknown>[],
          ]),
        );
      const expected = readRows(db);
      const storedOwner = expected.guests?.find(
        (row) => row.id === owner.guest.id,
      );
      assert.ok(storedOwner);
      Object.assign(storedOwner, migratedAppearance);
      db.close();
      db = undefined;

      db = new Store(dbPath);
      assert.equal(db.sql.pragma('user_version', { simple: true }), 27);
      assert.equal(db.sql.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
      assert.deepEqual(readRows(db), expected);
      assert.deepEqual(db.guest(owner.token)?.appearance, migratedAppearance);
      assert.deepEqual(db.guest(other.token), other.guest);
      for (const [index, appearance] of [
        { coat: 'pure_white', pattern: 'tabby' },
        { coat: 'pure_white', pattern: 'socks' },
      ].entries()) {
        pickFromEnd = index + 1;
        assert.deepEqual(
          db.createGuest('Random cat').guest.appearance,
          appearance,
        );
      }
      pickFromEnd = 1;
      const updateNew = db.sql.prepare(update);
      for (const { coat, pattern } of [
        RED_POINT_APPEARANCE,
        SILVER_SHADED_APPEARANCE,
      ])
        assert.throws(
          () => updateNew.run(coat, pattern, owner.guest.id),
          /CHECK/,
        );
      const presetGuests: { token: string; guest: Guest }[] = [];
      for (const { appearance, label } of CAT_APPEARANCE_PRESETS) {
        const { guest, token } = db.createGuest(label);
        db.unlockAppearance(guest.id, appearance.pattern);
        assert.deepEqual(db.updateAppearance(guest.id, appearance), {
          ...guest,
          appearance,
        });
        for (const { id: coat } of CAT_COATS) {
          if (coat === appearance.coat) continue;
          assert.throws(
            () => updateNew.run(coat, appearance.pattern, guest.id),
            /CHECK/,
          );
        }
        presetGuests.push({ token, guest: { ...guest, appearance } });
      }
      db.close();
      db = undefined;

      db = new Store(dbPath);
      for (const { token, guest } of presetGuests)
        assert.deepEqual(db.guest(token), guest);
      assert.deepEqual(db.guest(owner.token)?.appearance, migratedAppearance);
      assert.deepEqual(db.guest(other.token), other.guest);
    } finally {
      pickLast.mock.restore();
      syncBuiltinESMExports();
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

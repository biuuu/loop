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
import { AppearanceLockedError, Store } from '../src/server/db.js';
import {
  BLACK_CAT_APPEARANCE,
  CALICO_APPEARANCE,
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
  SEAL_POINT_APPEARANCE,
  type CatPresetPattern,
} from '../src/shared/appearance.js';
import type { Guest } from '../src/shared/contracts.js';
import {
  COAT_UNLOCK_COST,
  DAILY_DJ_THRESHOLD_MS,
} from '../src/shared/points.js';

const RED_POINT_APPEARANCE = { coat: 'white', pattern: 'red_point' } as const;
const SILVER_SHADED_APPEARANCE = {
  coat: 'white',
  pattern: 'silver_shaded',
} as const;
const REMAINING_PRESETS_SINCE_23 = [
  'calico',
  'cow',
  'orange_white',
  'seal_point',
  'tabby_white',
] as const;

function historicalMigrations(root: string, version: number) {
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  for (const name of readdirSync('migrations').filter(
    (name) => name.endsWith('.sql') && Number(name.slice(0, 3)) <= version,
  ))
    copyFileSync(join('migrations', name), join(migrations, name));
  return migrations;
}

for (const [
  previous,
  savedAppearance,
  supportedPresets,
  migratedAppearance = savedAppearance,
] of [
  [19, { coat: 'pure_black', pattern: 'tabby' }, [], BLACK_CAT_APPEARANCE],
  [20, CALICO_APPEARANCE, ['calico']],
  [
    21,
    { coat: 'black', pattern: 'tortoiseshell' },
    ['calico', 'cow', 'orange_white'],
    { coat: 'black', pattern: 'solid' },
  ],
  [22, SEAL_POINT_APPEARANCE, ['calico', 'cow', 'orange_white', 'seal_point']],
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
      db = new Store(dbPath, historicalMigrations(root, previous));
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
      for (const guest of expected.guests!) guest.accessories_json = null;
      const storedOwner = expected.guests?.find(
        (row) => row.id === owner.guest.id,
      );
      assert.ok(storedOwner);
      Object.assign(storedOwner, migratedAppearance);
      db.close();
      db = undefined;

      db = new Store(dbPath);
      assert.equal(db.sql.pragma('user_version', { simple: true }), 29);
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

test('migration 28 preserves points and sessions while transferring old black and tortoiseshell appearances', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-black-cat-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'test.sqlite');
  const before = new Store(path, historicalMigrations(root, 27));
  const now = Date.parse('2026-11-26T10:00:00+08:00');
  const darkGray = { coat: 'black', pattern: 'solid' } as const;
  const readLedger = (db: Store) =>
    db.sql.prepare('SELECT * FROM points_ledger ORDER BY id').all();
  const readDjTime = (db: Store) =>
    db.sql.prepare('SELECT * FROM daily_dj_time ORDER BY guest_id, date').all();
  let owner: ReturnType<Store['createUser']>;
  let accounts: {
    guest: Guest;
    token: string;
    unlockedPresets: CatPresetPattern[];
  }[];
  let ledger: unknown[];
  let djTime: unknown[];

  try {
    assert.equal(before.sql.pragma('user_version', { simple: true }), 27);
    owner = before.createUser('Pure black solid');
    const socks = before.createGuest('Pure black socks');
    const tabby = before.createGuest('Pure black tabby');
    const tortoiseshell = before.createGuest('Tortoiseshell owner');
    const trial = before.createGuest('Tortoiseshell trial');
    const calico = before.createGuest('Calico owner');
    const update = before.sql.prepare(
      'UPDATE guests SET coat=?, pattern=? WHERE id=?',
    );
    for (const [{ guest }, pattern] of [
      [owner, 'solid'],
      [socks, 'socks'],
      [tabby, 'tabby'],
    ] as const)
      update.run('pure_black', pattern, guest.id);
    for (const { guest } of [tortoiseshell, trial])
      update.run('black', 'tortoiseshell', guest.id);
    for (const { guest } of [owner, tortoiseshell]) {
      before.sql
        .prepare('INSERT INTO coat_unlocks VALUES (?, ?)')
        .run(guest.id, 'tortoiseshell');
      before.sql
        .prepare(
          'INSERT INTO points_ledger (guest_id, source, reference, delta) VALUES (?, ?, ?, ?)',
        )
        .run(guest.id, 'coat_unlock', 'tortoiseshell', -COAT_UNLOCK_COST);
    }
    before.unlockAppearance(calico.guest.id, 'calico');
    before.updateAppearance(calico.guest.id, CALICO_APPEARANCE);
    before.recordDjPlayback(
      owner.guest.id,
      now,
      now + DAILY_DJ_THRESHOLD_MS + 1,
    );
    before.recordDjPlayback(tortoiseshell.guest.id, now, now + 60_000);
    ledger = readLedger(before);
    djTime = readDjTime(before);
    accounts = [
      ...[owner, socks, tabby].map(({ token, guest }) => ({
        guest: { ...guest, appearance: BLACK_CAT_APPEARANCE },
        token,
        unlockedPresets: ['black_cat' as const],
      })),
      {
        ...tortoiseshell,
        guest: { ...tortoiseshell.guest, appearance: darkGray },
        unlockedPresets: ['black_cat'],
      },
      {
        ...trial,
        guest: { ...trial.guest, appearance: darkGray },
        unlockedPresets: [],
      },
      {
        ...calico,
        guest: { ...calico.guest, appearance: CALICO_APPEARANCE },
        unlockedPresets: ['calico'],
      },
    ];
  } finally {
    before.close();
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new Store(path);
    try {
      assert.equal(db.sql.pragma('user_version', { simple: true }), 29);
      assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
      assert.deepEqual(db.room(owner.createdRoom.id), owner.createdRoom);
      assert.deepEqual(readLedger(db), ledger);
      assert.deepEqual(readDjTime(db), djTime);
      for (const { guest, token, unlockedPresets } of accounts) {
        assert.deepEqual(db.guest(token), guest);
        const points = db.points(guest.id, now);
        assert.deepEqual(points.unlockedPresets, unlockedPresets);
        if (unlockedPresets.includes('black_cat')) {
          const retry = db.unlockAppearance(guest.id, 'black_cat');
          assert.equal(retry.balance, points.balance);
          assert.equal(retry.revision, points.revision);
        } else {
          assert.throws(
            () => db.updateAppearance(guest.id, BLACK_CAT_APPEARANCE),
            AppearanceLockedError,
          );
        }
      }
      const update = db.sql.prepare(
        'UPDATE guests SET coat=?, pattern=? WHERE id=?',
      );
      for (const [coat, pattern] of [
        ['pure_black', 'solid'],
        ['black', 'tortoiseshell'],
        ['orange', 'black_cat'],
      ])
        assert.throws(() => update.run(coat, pattern, owner.guest.id), /CHECK/);
      assert.throws(
        () =>
          db.sql
            .prepare('INSERT INTO coat_unlocks VALUES (?, ?)')
            .run(owner.guest.id, 'tortoiseshell'),
        /CHECK/,
      );
    } finally {
      db.close();
    }
  }
});

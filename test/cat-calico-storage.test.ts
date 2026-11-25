import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import {
  CALICO_APPEARANCE,
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
} from '../src/shared/appearance.js';
import type { Guest } from '../src/shared/contracts.js';

for (const previous of [19, 20]) {
  test(`upgrading from migration ${previous} preserves guest and room data and enforces the fixed presets`, () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-cat-presets-'));
    const dbPath = join(root, 'test.sqlite');
    const migrations = join(root, 'migrations');
    let db: Store | undefined;
    try {
      mkdirSync(migrations);
      for (const name of readdirSync('migrations').filter(
        (name) => name.endsWith('.sql') && Number(name.slice(0, 3)) <= previous,
      ))
        copyFileSync(join('migrations', name), join(migrations, name));
      db = new Store(dbPath, migrations);
      assert.equal(db.sql.pragma('user_version', { simple: true }), previous);
      const owner = db.createUser('Owner');
      const other = db.createGuest('Other');
      const savedAppearance =
        previous === 20
          ? CALICO_APPEARANCE
          : ({ coat: 'pure_black', pattern: 'tabby' } as const);
      db.updateAppearance(owner.guest.id, savedAppearance);
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
      const update = 'UPDATE guests SET coat=?, pattern=? WHERE id=?';
      const updateOld = db.sql.prepare(update);
      for (const { appearance } of CAT_APPEARANCE_PRESETS) {
        if (previous === 20 && appearance.pattern === 'calico') continue;
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
        tables.map((table) =>
          store.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      const before = readRows(db);
      db.close();
      db = undefined;

      db = new Store(dbPath);
      assert.equal(db.sql.pragma('user_version', { simple: true }), 21);
      assert.equal(db.sql.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
      assert.deepEqual(readRows(db), before);
      assert.deepEqual(db.guest(owner.token)?.appearance, savedAppearance);
      assert.deepEqual(db.guest(other.token), other.guest);
      const updateNew = db.sql.prepare(update);
      const presetGuests: { token: string; guest: Guest }[] = [];
      for (const { appearance, label } of CAT_APPEARANCE_PRESETS) {
        const { guest, token } = db.createGuest(label);
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
      assert.deepEqual(db.guest(owner.token)?.appearance, savedAppearance);
      assert.deepEqual(db.guest(other.token), other.guest);
    } finally {
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

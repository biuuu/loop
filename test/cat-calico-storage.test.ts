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
import { CALICO_APPEARANCE } from '../src/shared/appearance.js';

test('migration 20 preserves guest and room data and enforces the fixed calico preset', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-cat-calico-'));
  const dbPath = join(root, 'test.sqlite');
  const migrations = join(root, 'migrations');
  let db: Store | undefined;
  try {
    mkdirSync(migrations);
    for (const name of readdirSync('migrations').filter((name) =>
      /^01[1-9]-.*\.sql$/.test(name),
    ))
      copyFileSync(join('migrations', name), join(migrations, name));
    db = new Store(dbPath, migrations);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 19);
    const owner = db.createUser('Owner');
    const other = db.createGuest('Other');
    const savedAppearance = { coat: 'pure_black', pattern: 'tabby' } as const;
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
    const saveCalico = db.sql.prepare(
      "UPDATE guests SET coat='white', pattern='calico' WHERE id=?",
    );
    assert.throws(() => saveCalico.run(owner.guest.id), /CHECK/);
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
    assert.equal(db.sql.pragma('user_version', { simple: true }), 20);
    assert.equal(db.sql.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.deepEqual(readRows(db), before);
    assert.deepEqual(db.guest(owner.token)?.appearance, savedAppearance);
    assert.deepEqual(db.guest(other.token), other.guest);
    db.updateAppearance(owner.guest.id, CALICO_APPEARANCE);
    const changeCoat = db.sql.prepare('UPDATE guests SET coat=? WHERE id=?');
    assert.throws(() => changeCoat.run('pure_white', owner.guest.id), /CHECK/);
    db.close();
    db = undefined;

    db = new Store(dbPath);
    assert.deepEqual(db.guest(owner.token)?.appearance, CALICO_APPEARANCE);
    assert.deepEqual(db.guest(other.token), other.guest);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AppearanceLockedError,
  InsufficientPointsError,
  Store,
} from '../src/server/db.js';
import {
  CALICO_APPEARANCE,
  CAT_APPEARANCE_PRESETS,
  RAGDOLL_APPEARANCE,
  catAppearancePreset,
} from '../src/shared/appearance.js';
import {
  COAT_UNLOCK_COST,
  DAILY_DJ_REWARD,
  DAILY_DJ_THRESHOLD_MS,
  INITIAL_POINTS,
} from '../src/shared/points.js';

const firstDay = Date.parse('2026-11-25T12:00:00+08:00');
const midnight = Date.parse('2026-11-26T00:00:00+08:00');
const rewardAt = DAILY_DJ_THRESHOLD_MS + 1;
const freeAppearance = { coat: 'pure_black', pattern: 'tabby' } as const;

function historicalMigrations(root: string, version: number) {
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  for (const name of readdirSync('migrations')) {
    if (Number(name.slice(0, 3)) <= version)
      copyFileSync(join('migrations', name), join(migrations, name));
  }
  return migrations;
}

test('points migration grants every existing account once and preserves only their equipped special coat', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-points-migration-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'database.sqlite');
  const before = new Store(path, historicalMigrations(root, 25));
  const special = before.createUser('Special');
  const basic = before.createGuest('Basic');
  try {
    before.updateAppearance(special.guest.id, CALICO_APPEARANCE);
    before.updateAppearance(basic.guest.id, freeAppearance);
  } finally {
    before.close();
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new Store(path);
    try {
      assert.deepEqual(db.guest(special.token)?.appearance, CALICO_APPEARANCE);
      assert.deepEqual(db.guest(basic.token)?.appearance, freeAppearance);
      assert.deepEqual(db.room(special.createdRoom.id), special.createdRoom);
      const specialPoints = db.points(special.guest.id, firstDay);
      assert.equal(specialPoints.balance, INITIAL_POINTS);
      assert.deepEqual(specialPoints.unlockedPresets, ['calico']);
      assert.deepEqual(specialPoints.daily, {
        date: '2026-11-25',
        playedMs: 0,
        awarded: false,
      });
      assert.deepEqual(
        db.unlockAppearance(special.guest.id, 'calico').unlockedPresets,
        ['calico'],
      );
      db.updateAppearance(special.guest.id, freeAppearance);
      db.updateAppearance(special.guest.id, CALICO_APPEARANCE);
      const basicPoints = db.points(basic.guest.id, firstDay);
      assert.equal(basicPoints.balance, INITIAL_POINTS);
      assert.deepEqual(basicPoints.unlockedPresets, []);
      assert.throws(
        () => db.updateAppearance(basic.guest.id, CALICO_APPEARANCE),
        AppearanceLockedError,
      );
      assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  }
});

test('migration 27 preserves existing profiles, coat unlocks, points and DJ progress', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-ragdoll-migration-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'database.sqlite');
  const before = new Store(path, historicalMigrations(root, 26));
  const readRows = (db: Store) =>
    [
      ['guests', 'id'],
      ['coat_unlocks', 'guest_id, pattern'],
      ['points_ledger', 'id'],
      ['daily_dj_time', 'guest_id, date'],
    ].map(([table, order]) =>
      db.sql.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
    );
  let savedRows: ReturnType<typeof readRows>;
  let savedProfile: ReturnType<Store['guest']>;
  let owner: ReturnType<Store['createUser']>;
  let buyer: ReturnType<Store['createGuest']>;
  try {
    assert.equal(before.sql.pragma('user_version', { simple: true }), 26);
    owner = before.createUser('Owner');
    buyer = before.createGuest('Buyer');
    const ownerId = owner.guest.id;
    before.unlockAppearance(ownerId, 'calico');
    before.updateAppearance(ownerId, CALICO_APPEARANCE);
    before.recordDjPlayback(ownerId, firstDay, firstDay + rewardAt);
    before.recordDjPlayback(ownerId, midnight, midnight + 60_000);
    savedProfile = before.guest(owner.token);
    savedRows = readRows(before);
  } finally {
    before.close();
  }

  const db = new Store(path);
  try {
    assert.equal(db.sql.pragma('user_version', { simple: true }), 27);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    assert.deepEqual(readRows(db), savedRows);
    assert.deepEqual(db.guest(owner.token), savedProfile);
    assert.deepEqual(db.guest(buyer.token), buyer.guest);
    assert.deepEqual(db.room(owner.createdRoom.id), owner.createdRoom);
    assert.equal(
      db.recordDjPlayback(owner.guest.id, midnight, midnight + rewardAt),
      DAILY_DJ_REWARD,
    );
    assert.equal(db.points(owner.guest.id, midnight).daily.playedMs, rewardAt);

    const id = buyer.guest.id;
    assert.throws(
      () => db.updateAppearance(id, RAGDOLL_APPEARANCE),
      AppearanceLockedError,
    );
    assert.equal(db.unlockAppearance(id, 'ragdoll').balance, 0);
    db.updateAppearance(id, RAGDOLL_APPEARANCE);
  } finally {
    db.close();
  }

  const restarted = new Store(path);
  try {
    assert.deepEqual(
      restarted.guest(buyer.token)?.appearance,
      RAGDOLL_APPEARANCE,
    );
    const points = restarted.points(buyer.guest.id);
    assert.equal(points.balance, 0);
    assert.deepEqual(points.unlockedPresets, ['ragdoll']);
  } finally {
    restarted.close();
  }
});

test('a purchase permanently unlocks one coat for its guest and retries leave points unchanged', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-points-purchase-'));
  const path = join(root, 'database.sqlite');
  const db = new Store(path);
  const secondConnection = new Store(path);
  context.after(() => {
    db.close();
    secondConnection.close();
    rmSync(root, { recursive: true, force: true });
  });
  const a = db.createUser('A').guest;
  const b = db.createGuest('B').guest;
  for (const guest of [a, b]) {
    assert.ok(guest.appearance);
    assert.equal(catAppearancePreset(guest.appearance.pattern), undefined);
    assert.deepEqual(db.points(guest.id).unlockedPresets, []);
    for (const { appearance } of CAT_APPEARANCE_PRESETS)
      assert.throws(
        () => db.updateAppearance(guest.id, appearance),
        AppearanceLockedError,
      );
  }
  const initial = db.points(a.id);
  assert.equal(initial.balance, INITIAL_POINTS);
  const purchase = db.unlockAppearance(a.id, 'calico');
  assert.equal(purchase.balance, INITIAL_POINTS - COAT_UNLOCK_COST);
  assert.ok(purchase.revision > initial.revision);
  assert.deepEqual(purchase.unlockedPresets, ['calico']);
  assert.deepEqual(db.guestById(a.id).appearance, a.appearance);
  const retry = secondConnection.unlockAppearance(a.id, 'calico');
  assert.equal(retry.balance, purchase.balance);
  assert.equal(retry.revision, purchase.revision);
  assert.throws(
    () => secondConnection.unlockAppearance(a.id, 'cow'),
    InsufficientPointsError,
  );
  assert.throws(
    () => db.updateAppearance(b.id, CALICO_APPEARANCE),
    AppearanceLockedError,
  );
  assert.equal(db.points(b.id).balance, INITIAL_POINTS);
  db.updateAppearance(a.id, CALICO_APPEARANCE);
  db.updateAppearance(a.id, freeAppearance);
  assert.deepEqual(
    secondConnection.updateAppearance(a.id, CALICO_APPEARANCE).appearance,
    CALICO_APPEARANCE,
  );
  assert.deepEqual(secondConnection.points(a.id, firstDay).unlockedPresets, [
    'calico',
  ]);
});

test('chronological DJ settlements add elapsed time once and award strictly above three minutes', (context) => {
  const db = new Store(':memory:');
  context.after(() => db.close());
  const {
    guest: { id },
  } = db.createGuest('DJ');
  const initial = db.points(id, firstDay);
  assert.equal(db.recordDjPlayback(id, firstDay, firstDay + 60_000), 0);
  assert.equal(db.recordDjPlayback(id, firstDay, firstDay + 60_000), 0);
  assert.equal(db.points(id, firstDay).daily.playedMs, 60_000);
  assert.equal(
    db.recordDjPlayback(id, firstDay + 59_000, firstDay + 70_000),
    0,
  );
  assert.equal(db.points(id, firstDay).daily.playedMs, 70_000);

  const secondTrack = firstDay + 90_000;
  const exactlyThreeMinutes = secondTrack + DAILY_DJ_THRESHOLD_MS - 70_000;
  assert.equal(db.recordDjPlayback(id, secondTrack, exactlyThreeMinutes), 0);
  const atThreshold = db.points(id, exactlyThreeMinutes);
  assert.equal(atThreshold.balance, INITIAL_POINTS);
  assert.equal(atThreshold.revision, initial.revision);
  assert.equal(atThreshold.daily.playedMs, DAILY_DJ_THRESHOLD_MS);
  assert.equal(atThreshold.daily.awarded, false);
  assert.equal(
    db.recordDjPlayback(id, exactlyThreeMinutes, exactlyThreeMinutes + 1),
    DAILY_DJ_REWARD,
  );
  assert.equal(
    db.recordDjPlayback(id, secondTrack, exactlyThreeMinutes + 1_000),
    0,
  );
  const earned = db.points(id, exactlyThreeMinutes);
  assert.equal(earned.balance, INITIAL_POINTS + DAILY_DJ_REWARD);
  assert.ok(earned.revision > initial.revision);
  assert.equal(earned.daily.playedMs, rewardAt);
  assert.equal(earned.daily.awarded, true);
});

test('DJ settlements split at Beijing midnight and persist progress and awards across reopening', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-points-midnight-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'database.sqlite');
  let db = new Store(path);
  try {
    const {
      guest: { id },
    } = db.createGuest('DJ');
    const start = midnight - 120_000;
    const nextDayPlayed = 80_000;
    assert.equal(db.recordDjPlayback(id, start - 60_001, start), 0);
    assert.equal(
      db.recordDjPlayback(id, start, midnight + nextDayPlayed),
      DAILY_DJ_REWARD,
    );
    assert.deepEqual(db.points(id, midnight - 1).daily, {
      date: '2026-11-25',
      playedMs: rewardAt,
      awarded: true,
    });
    assert.deepEqual(db.points(id, midnight).daily, {
      date: '2026-11-26',
      playedMs: nextDayPlayed,
      awarded: false,
    });
    db.close();
    db = new Store(path);
    assert.equal(db.recordDjPlayback(id, start, midnight + nextDayPlayed), 0);
    assert.equal(db.points(id, midnight).daily.playedMs, nextDayPlayed);
    const secondDayEnd = midnight + rewardAt;
    assert.equal(
      db.recordDjPlayback(id, midnight + nextDayPlayed, secondDayEnd),
      DAILY_DJ_REWARD,
    );
    const state = db.points(id, secondDayEnd);
    assert.equal(state.balance, INITIAL_POINTS + 2 * DAILY_DJ_REWARD);
    assert.equal(state.daily.playedMs, rewardAt);
    assert.equal(state.daily.awarded, true);
  } finally {
    if (db.sql.open) db.close();
  }
});

test('a failure writing either half of a points change leaves it safe to retry', (context) => {
  const db = new Store(':memory:');
  context.after(() => db.close());
  const {
    guest: { id },
  } = db.createGuest('DJ');
  const initial = db.points(id, firstDay);
  db.sql.exec(`CREATE TRIGGER reject_unlock BEFORE INSERT ON coat_unlocks BEGIN
    SELECT RAISE(ABORT,'forced unlock failure');
  END`);
  assert.throws(
    () => db.unlockAppearance(id, 'calico'),
    /forced unlock failure/,
  );
  assert.deepEqual(db.points(id, firstDay), initial);
  db.sql.exec('DROP TRIGGER reject_unlock');
  assert.equal(
    db.unlockAppearance(id, 'calico').balance,
    INITIAL_POINTS - COAT_UNLOCK_COST,
  );

  const purchased = db.points(id, firstDay);
  db.sql.exec(`CREATE TRIGGER reject_reward BEFORE INSERT ON points_ledger
    WHEN NEW.source = 'daily_dj' BEGIN
    SELECT RAISE(ABORT,'forced reward failure');
  END`);
  assert.throws(
    () => db.recordDjPlayback(id, firstDay, firstDay + rewardAt),
    /forced reward failure/,
  );
  assert.deepEqual(db.points(id, firstDay), purchased);
  db.sql.exec('DROP TRIGGER reject_reward');
  assert.equal(
    db.recordDjPlayback(id, firstDay, firstDay + rewardAt),
    DAILY_DJ_REWARD,
  );
  assert.equal(
    db.points(id, firstDay).balance,
    purchased.balance + DAILY_DJ_REWARD,
  );
});

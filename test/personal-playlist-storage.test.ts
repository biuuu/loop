import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/db.js';
import { PLAYLIST_LIMIT, type Track } from '../src/shared/contracts.js';

const song = (id: string): Track => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const ids = (tracks: Track[]) => tracks.map((track) => track.id);

test('upgrading version 13 and 14 preserves playlist order and the saved selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loop-personal-playlists-'));
  const path = join(directory, 'test.sqlite');
  const oldMigrations = join(directory, 'migrations');
  mkdirSync(oldMigrations);
  for (const name of [
    '011-baseline.sql',
    '012-room-last-played.sql',
    '013-guest-nickname-cooldown.sql',
  ])
    copyFileSync(join('migrations', name), join(oldMigrations, name));
  let db = new Store(path, oldMigrations);
  try {
    const { guest, token } = db.createGuest('Playlist owner');
    const insert = db.sql.prepare('INSERT INTO playlist VALUES (?,?,?,?)');
    insert.run(guest.id, '1', 7, JSON.stringify(song('1')));
    insert.run(guest.id, '2', 4, JSON.stringify(song('2')));
    db.sql
      .prepare('UPDATE guests SET playlist_revision=12 WHERE id=?')
      .run(guest.id);
    db.close();

    const slotMigration = '014-personal-playlists.sql';
    copyFileSync(
      join('migrations', slotMigration),
      join(oldMigrations, slotMigration),
    );
    db = new Store(path, oldMigrations);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 14);
    db.sql
      .prepare(
        'UPDATE guests SET playlist_count=2,playlist_slot=2,playlist_revision=14 WHERE id=?',
      )
      .run(guest.id);
    db.sql
      .prepare(
        'INSERT INTO playlist (guest_id,track_id,position,track_json,slot) VALUES (?,?,?,?,?)',
      )
      .run(guest.id, '1', 0, JSON.stringify(song('1')), 2);
    db.close();

    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 19);
    assert.deepEqual(db.guest(token), guest);
    assert.deepEqual(db.playlist(guest.id), {
      tracks: [song('1')],
      revision: 14,
      slot: 2,
      count: 3,
    });
    assert.deepEqual(db.tracks(guest.id, 3), []);
    assert.deepEqual(db.selectPlaylist(guest.id, 1), {
      tracks: [song('2'), song('1')],
      revision: 15,
      slot: 1,
      count: 3,
    });
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
    db.close();

    db = new Store(path);
    assert.equal(db.playlistSlot(guest.id), 1);
    assert.deepEqual(db.tracks(guest.id, 2), [song('1')]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('slots only belong to their account and share one monotonic revision', () => {
  const db = new Store(':memory:');
  try {
    const owner = db.createGuest('First').guest.id;
    const other = db.createGuest('Second').guest.id;
    assert.deepEqual(db.playlist(owner), {
      tracks: [],
      revision: 0,
      slot: 1,
      count: 3,
    });
    for (const slot of [1, 2, 3]) assert.deepEqual(db.tracks(owner, slot), []);
    db.add(owner, song('1'));
    db.add(other, song('1'));
    for (const slot of [0, 1.5, 4]) {
      assert.throws(() => db.selectPlaylist(owner, slot), /歌单不存在/);
      assert.throws(() => db.add(owner, song('2'), slot), /歌单不存在/);
    }
    assert.throws(() => db.playlistSlot('missing'), /游客不存在/);
    assert.equal(db.selectPlaylist(owner, 2).slot, 2);
    db.add(owner, song('1'));
    db.add(owner, song('2'));
    assert.equal(db.selectPlaylist(owner, 3).slot, 3);
    assert.deepEqual(db.tracks(other, 2), []);
    assert.deepEqual(db.tracks(other, 3), []);

    const selected = db.selectPlaylist(owner, 2);
    assert.equal(selected.revision, 6);
    assert.deepEqual(db.selectPlaylist(owner, 2), selected);
    assert.deepEqual(ids(selected.tracks), ['1', '2']);
    db.add(owner, song('3'), 1);
    db.moveTrack(owner, '3', undefined, 'first', 1);
    assert.deepEqual(ids(db.tracks(owner, 1)), ['3', '1']);
    db.order(owner, ['1', '3'], 1);
    db.remove(owner, '1', 1);
    assert.deepEqual(ids(db.tracks(owner, 1)), ['3']);
    assert.deepEqual(db.playlistOrder(owner), {
      ids: ['1', '2'],
      slot: 2,
      revision: 10,
    });
    assert.deepEqual(db.playlist(other), {
      tracks: [song('1')],
      revision: 1,
      slot: 1,
      count: 3,
    });
  } finally {
    db.close();
  }
});

test('each slot can hold 100 tracks and import still targets the original slot after a switch', () => {
  const db = new Store(':memory:');
  try {
    const owner = db.createGuest('Playlist owner').guest.id;
    const originalSlot = db.playlistSlot(owner);
    db.selectPlaylist(owner, 2);
    const tracks = Array.from({ length: 102 }, (_, index) =>
      song(String(index + 1)),
    );
    const entries = tracks.map((track, index) => ({
      id: track.id,
      position: index + 1,
      track,
    }));
    const result = db.importTracks(owner, entries, 1, 'replace', originalSlot);
    assert.equal(PLAYLIST_LIMIT, 100);
    assert.equal(result.imported, PLAYLIST_LIMIT);
    assert.equal(result.overflow, 2);
    assert.equal(result.slot, 2);
    assert.deepEqual(result.tracks, []);
    assert.deepEqual(db.tracks(owner, 1), tracks.slice(0, 100));
    assert.throws(() => db.add(owner, song('101'), 1), /最多 100 首/);
    assert.equal(db.playlist(owner).revision, result.revision);
    for (const track of tracks.slice(0, 100)) db.add(owner, track);
    const full = db.playlist(owner);
    db.add(owner, song('1'));
    assert.throws(() => db.add(owner, song('101')), /最多 100 首/);
    assert.deepEqual(db.playlist(owner), full);
    assert.deepEqual(db.tracks(owner, 1), db.tracks(owner, 2));
  } finally {
    db.close();
  }
});

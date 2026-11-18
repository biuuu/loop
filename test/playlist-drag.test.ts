import assert from 'node:assert/strict';
import test from 'node:test';
import {
  keyboardPlaylistDrop,
  meaningfulPlaylistDrop,
  playlistDropAt,
  playlistSequenceMatches,
} from '../src/client/playlist-drag';

test('pointer insertion chooses row halves and list boundaries using current geometry', () => {
  const rows = [
    { id: 'a', top: 100, bottom: 160 },
    { id: 'b', top: 160, bottom: 220 },
    { id: 'c', top: 220, bottom: 280 },
  ];
  assert.deepEqual(playlistDropAt(rows, 20), {
    targetId: 'a',
    placement: 'before',
  });
  assert.deepEqual(playlistDropAt(rows, 175), {
    targetId: 'b',
    placement: 'before',
  });
  assert.deepEqual(playlistDropAt(rows, 200), {
    targetId: 'b',
    placement: 'after',
  });
  assert.deepEqual(playlistDropAt(rows, 500), {
    targetId: 'c',
    placement: 'after',
  });
  // The same pointer reaches the next row after scrolling by one row.
  assert.deepEqual(
    playlistDropAt(
      rows.map((row) => ({
        ...row,
        top: row.top - 60,
        bottom: row.bottom - 60,
      })),
      175,
    ),
    { targetId: 'c', placement: 'before' },
  );
  assert.equal(playlistDropAt([], 0), null);
  assert.equal(playlistDropAt(rows, Number.NaN), null);
});

test('release ignores unchanged positions and missing IDs, preserving target ID intent', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.equal(
    meaningfulPlaylistDrop(ids, 'b', { targetId: 'a', placement: 'after' }),
    null,
  );
  assert.equal(
    meaningfulPlaylistDrop(ids, 'b', { targetId: 'c', placement: 'before' }),
    null,
  );
  assert.equal(
    meaningfulPlaylistDrop(ids, 'b', { targetId: 'b', placement: 'after' }),
    null,
  );
  assert.equal(
    meaningfulPlaylistDrop(ids, 'missing', {
      targetId: 'a',
      placement: 'before',
    }),
    null,
  );
  assert.equal(
    meaningfulPlaylistDrop(ids, 'b', {
      targetId: 'missing',
      placement: 'after',
    }),
    null,
  );
  assert.deepEqual(
    meaningfulPlaylistDrop(ids, 'a', { targetId: 'd', placement: 'after' }),
    { targetId: 'd', placement: 'after' },
  );
  assert.deepEqual(
    meaningfulPlaylistDrop(ids, 'd', { targetId: 'a', placement: 'before' }),
    { targetId: 'a', placement: 'before' },
  );
});

test('keyboard destination produces the same relative move as pointer insertion', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(keyboardPlaylistDrop(ids, 'c', 0), {
    targetId: 'a',
    placement: 'before',
  });
  assert.deepEqual(keyboardPlaylistDrop(ids, 'b', 3), {
    targetId: 'd',
    placement: 'after',
  });
  assert.equal(keyboardPlaylistDrop(ids, 'b', 1), null);
  assert.equal(keyboardPlaylistDrop(ids, 'a', -1), null);
  assert.equal(keyboardPlaylistDrop(ids, 'a', 4), null);
  assert.equal(keyboardPlaylistDrop(ids, 'a', 1.5), null);
  assert.equal(keyboardPlaylistDrop(ids, 'missing', 0), null);
});

test('queue rotation, add, remove and reordered identities invalidate a gesture', () => {
  const start = ['a', 'b', 'c'];
  assert.equal(playlistSequenceMatches(start, [...start]), true);
  assert.equal(playlistSequenceMatches(start, ['b', 'c', 'a']), false);
  assert.equal(playlistSequenceMatches(start, ['a', 'b', 'c', 'd']), false);
  assert.equal(playlistSequenceMatches(start, ['a', 'c']), false);
  assert.equal(playlistSequenceMatches(start, ['a', 'c', 'b']), false);
});

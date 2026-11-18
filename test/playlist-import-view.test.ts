import assert from 'node:assert/strict';
import test from 'node:test';
import { playlistImportPreview } from '../src/client/playlist-import';

test('import preview rejects invalid starts without offering a source range', () => {
  for (const value of [
    '',
    ' ',
    'abc',
    NaN,
    Infinity,
    0,
    -1,
    1.5,
    '2.5',
    101,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const preview = playlistImportPreview(value, 100, 0);
    assert.equal(preview.valid, false, String(value));
    assert.equal(preview.canImport, false, String(value));
    assert.equal(preview.end, null, String(value));
  }
  assert.equal(playlistImportPreview(1, 0, 0).valid, false);
});

test('import preview keeps original one-based source positions and an exact fifty-entry window', () => {
  assert.deepEqual(playlistImportPreview(1, 100, 0), {
    valid: true,
    start: 1,
    end: 50,
    remaining: 50,
    canImport: true,
  });
  assert.equal(playlistImportPreview(51, 100, 0).end, 100);
  assert.equal(playlistImportPreview(' 80 ', 100, 0).end, 100);
  assert.equal(playlistImportPreview(100, 100, 0).end, 100);
  assert.equal(playlistImportPreview(1, 1, 0).end, 1);
  assert.equal(playlistImportPreview(1, 50, 0).end, 50);
});

test('remaining personal capacity limits confirmation without changing the source window or truncating an old queue', () => {
  const preview = playlistImportPreview(10, 100, 49);
  assert.equal(preview.remaining, 1);
  assert.equal(preview.end, 59);
  assert.equal(preview.canImport, true);
  for (const count of [50, 51, 125]) {
    const full = playlistImportPreview(10, 100, count);
    assert.equal(full.remaining, 0);
    assert.equal(full.valid, true);
    assert.equal(full.canImport, false);
    assert.equal(full.end, 59);
  }
});

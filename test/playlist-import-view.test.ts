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

test('import preview keeps original one-based source positions and a 100-entry window', () => {
  assert.deepEqual(playlistImportPreview(1, 150, 0), {
    valid: true,
    start: 1,
    end: 100,
    remaining: 100,
    canImport: true,
  });
  assert.equal(playlistImportPreview(51, 150, 0).end, 150);
  assert.equal(playlistImportPreview(' 80 ', 150, 0).end, 150);
  assert.equal(playlistImportPreview(150, 150, 0).end, 150);
  assert.equal(playlistImportPreview(1, 1, 0).end, 1);
  assert.equal(playlistImportPreview(1, 50, 0).end, 50);
});

test('remaining personal capacity limits confirmation without changing the source window or truncating an old queue', () => {
  const preview = playlistImportPreview(10, 150, 99);
  assert.equal(preview.remaining, 1);
  assert.equal(preview.end, 109);
  assert.equal(preview.canImport, true);
  for (const count of [100, 101, 125]) {
    const full = playlistImportPreview(10, 150, count);
    assert.equal(full.remaining, 0);
    assert.equal(full.valid, true);
    assert.equal(full.canImport, false);
    assert.equal(full.end, 109);
  }
});

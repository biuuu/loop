import assert from 'node:assert/strict';
import test from 'node:test';
import { neteaseCover } from '../src/client/netease-cover.ts';

test('Netease covers request a square thumbnail while preserving other query parameters', () => {
  const original = 'https://p4.music.126.net/a/cover.jpg?foo=bar&param=50y50';
  const result = new URL(neteaseCover(original, 128));
  assert.equal(result.searchParams.get('param'), '128y128');
  assert.equal(result.searchParams.get('foo'), 'bar');
  assert.equal(result.hostname, 'p4.music.126.net');
});

test('other hosts and invalid sizes keep their original image addresses', () => {
  const other = 'https://example.com/cover.jpg?param=50y50';
  const spoofed = 'https://music.126.net.example.com/cover.jpg';
  assert.equal(neteaseCover(other, 128), other);
  assert.equal(neteaseCover(spoofed, 128), spoofed);
  assert.equal(
    neteaseCover('https://p4.music.126.net/a.jpg', 0),
    'https://p4.music.126.net/a.jpg',
  );
});

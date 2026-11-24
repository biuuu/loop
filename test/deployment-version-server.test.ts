import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createServer } from '../src/server/app.js';

test('the build version is available without a session and is never cached', async (t) => {
  for (const buildId of ['release-123', undefined]) {
    const { app } = await createServer({ dbPath: ':memory:', buildId });
    t.after(() => app.close());

    const response = await app.inject('/api/version');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { version: buildId ?? null });
  }
});

test(
  'production serves an uncached app shell and keeps the static asset cache policy',
  { skip: !existsSync('dist/client/index.html') },
  async (t) => {
    const { app } = await createServer({ dbPath: ':memory:' });
    t.after(() => app.close());

    const root = await app.inject('/');
    assert.match(root.body, /id="app"/);
    for (const url of [
      '/',
      '/index.html?direct=1',
      '/123',
      '/rooms/d9428888-122b-4c72-b137-b9ad6e5c12a0',
      '/admin/netease',
      '/admin/emotes',
    ]) {
      const response = url === '/' ? root : await app.inject(url);
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers['cache-control'], 'no-store', url);
      assert.equal(response.body, root.body, url);
    }

    const script = root.body.match(/<script[^>]+src="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(script);
    const asset = await app.inject(script);
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=0');
    assert.equal((await app.inject('/api/missing')).statusCode, 404);
  },
);

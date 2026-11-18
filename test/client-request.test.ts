import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/client/room';

test('playlist deletion sends no JSON content type without a body', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string | undefined; headers: Headers }[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push({ method: init?.method, headers: new Headers(init?.headers) });
    return Response.json({ tracks: [] });
  };
  try {
    await request('/api/playlist/123', { method: 'DELETE' });
    await request('/api/playlist');
    await request('/api/playlist', {
      method: 'POST',
      body: JSON.stringify({ id: '123' }),
    });
    assert.equal(calls[0]!.headers.has('content-type'), false);
    assert.equal(calls[1]!.headers.has('content-type'), false);
    assert.equal(calls[2]!.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neteaseMusic } from '../src/server/music.js';
import { NeteaseRequestError } from '../src/server/netease-protocol.js';

test(
  'optional live Netease search and direct playback URL resolution',
  { skip: process.env.LOOP_LIVE_MUSIC !== '1', timeout: 30_000 },
  async (context) => {
    let tracks;
    try {
      tracks = await neteaseMusic.search('陈绮贞 旅行的意义');
    } catch (error) {
      if (error instanceof NeteaseRequestError)
        context.diagnostic(
          `Upstream failure kind=${error.kind}, code=${error.code ?? 'unknown'} (no credentials or raw responses logged).`,
        );
      throw error;
    }
    assert.ok(tracks.length > 0, 'Expected actual upstream search results');
    let resolved = false;
    for (const track of tracks.slice(0, 3)) {
      try {
        const resource = await neteaseMusic.resolve(track);
        assert.equal(new URL(resource.url).protocol, 'https:');
        assert.ok(resource.durationMs > 0);
        context.diagnostic(
          `Resolved track ${track.id}, duration ${resource.durationMs}ms, preview=${!!resource.isTrial}; CDN direct playback remains a separate check.`,
        );
        resolved = true;
        break;
      } catch {
        /* Some titles require a different site credential. */
      }
    }
    assert.ok(
      resolved,
      'None of the first three real results supplied a playable URL',
    );
    // These reported tracks may legitimately have no URL. Record their current
    // availability separately; the assertion above checks that the source works.
    for (const id of ['536570516', '1901371647']) {
      try {
        const track = await neteaseMusic.detail(id);
        const resource = await neteaseMusic.resolve(track);
        context.diagnostic(
          `Reported track ${id}: playable, ${resource.durationMs}ms, preview=${!!resource.isTrial}.`,
        );
      } catch (error) {
        context.diagnostic(
          `Reported track ${id}: no playable result (${error instanceof Error ? error.name : 'unknown'}).`,
        );
      }
    }
  },
);

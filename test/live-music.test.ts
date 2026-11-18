import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { trackIdSchema } from '../src/shared/contracts.js';
import { neteaseMusic } from '../src/server/music.js';
import { NeteaseCredentialStore } from '../src/server/netease-admin.js';
import {
  createNeteaseRequest,
  NeteaseRequestError,
} from '../src/server/netease-protocol.js';

const requestedTrackId = process.env.LOOP_LIVE_MUSIC_TRACK_ID;

async function comparePlaybackProfiles(context: TestContext, trackId: string) {
  assert.ok(
    trackIdSchema.safeParse(trackId).success,
    'LOOP_LIVE_MUSIC_TRACK_ID must contain 1–20 digits',
  );
  let credentials;
  try {
    credentials = new NeteaseCredentialStore();
  } catch {
    assert.fail('Could not read the site Netease credentials');
  }
  const hasCredential = /(?:^|;)\s*MUSIC_[UA]\s*=\s*[^;\s]/.test(
    credentials.get(),
  );
  const identities = [
    {
      label: hasCredential ? 'configured' : 'anonymous',
      request: createNeteaseRequest(() => credentials.get()),
    },
  ];
  if (hasCredential)
    identities.push({ label: 'anonymous', request: createNeteaseRequest('') });

  const profiles = [
    { level: 'standard', encodeType: 'mp3' },
    { level: 'exhigh', encodeType: 'flac' },
  ];
  const comparisons = await Promise.all(
    identities.flatMap(({ label, request }) =>
      profiles.map(async ({ level, encodeType }) => {
        const profile = `identity=${label} profile=${level}/${encodeType}`;
        try {
          const body = (await request('/api/song/enhance/player/url/v1', {
            ids: `[${trackId}]`,
            level,
            encodeType,
          })) as {
            data?: Array<{
              code?: unknown;
              url?: unknown;
              freeTrialInfo?: unknown;
            }>;
          };
          const song = body.data?.[0];
          const code = song?.code;
          const hasUrl = typeof song?.url === 'string' && !!song.url;
          const preview = song?.freeTrialInfo != null;
          return {
            diagnostic: `${profile} songCode=${typeof code === 'number' ? code : 'unknown'} hasUrl=${hasUrl} preview=${preview}`,
            usable: hasUrl && (code == null || code === 200),
          };
        } catch (error) {
          const kind =
            error instanceof NeteaseRequestError ? error.kind : 'unknown';
          const code =
            error instanceof NeteaseRequestError ? error.code : undefined;
          const safeCode =
            typeof code === 'number' ||
            (typeof code === 'string' && /^[\w-]{1,64}$/.test(code))
              ? code
              : 'unknown';
          return {
            diagnostic: `${profile} kind=${kind} code=${safeCode}`,
            usable: false,
          };
        }
      }),
    ),
  );
  for (const { diagnostic } of comparisons) context.diagnostic(diagnostic);
  assert.ok(
    comparisons[0]?.usable,
    'The site standard/mp3 request did not supply an accepted playback URL',
  );
}

test(
  requestedTrackId === undefined
    ? 'optional live Netease search and direct playback URL resolution'
    : 'optional live Netease single-track playback profile comparison',
  { skip: process.env.LOOP_LIVE_MUSIC !== '1', timeout: 30_000 },
  async (context) => {
    if (requestedTrackId !== undefined) {
      await comparePlaybackProfiles(context, requestedTrackId);
      return;
    }
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

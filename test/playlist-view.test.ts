import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlaylistReceiver,
  playlistView,
  swapPlaylistTracks,
} from '../src/client/playlist-view';
import type { Playback, PlaylistState, Track } from '../src/shared/contracts';

function track(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: '',
    cover: '',
    durationMs: 1000,
  };
}
function playing(id = '1', djId = 'a'): Playback {
  return {
    roundId: 'round',
    track: track(id),
    djId,
    url: '/audio',
    startedAt: 0,
    durationMs: 1000,
  };
}

test('only the current DJ sees a pinned playback track alongside the complete queue', () => {
  const tracks = ['2', '3', '1'].map(track);
  const own = playlistView(tracks, 'a', playing());
  assert.equal(own.pinned?.id, '1');
  assert.deepEqual(
    own.queue.map(({ track, queueIndex }) => [track.id, queueIndex]),
    [
      ['2', 0],
      ['3', 1],
      ['1', 2],
    ],
  );
  for (const guestId of ['b', undefined]) {
    const other = playlistView(tracks, guestId, playing());
    assert.equal(other.pinned, null);
    assert.deepEqual(
      other.queue.map(({ track }) => track.id),
      ['2', '3', '1'],
    );
  }
  assert.equal(playlistView(tracks, 'a', null).pinned, null);
});

test('the pinned row uses playback metadata and survives removing the playing song from the queue', () => {
  const playback = playing();
  playback.track.title = 'Currently playing metadata';
  const staleMetadata = track('1');
  assert.equal(
    playlistView([staleMetadata], 'a', playback).pinned?.title,
    playback.track.title,
  );
  const removed = playlistView([track('2')], 'a', playback);
  assert.equal(removed.pinned, playback.track);
  assert.deepEqual(
    removed.queue.map(({ track }) => track.id),
    ['2'],
  );
  const empty = playlistView([], 'a', playback);
  assert.equal(empty.pinned, playback.track);
  assert.deepEqual(empty.queue, []);
  const single = playlistView([track('1')], 'a', playback);
  assert.deepEqual(
    single.queue.map(({ track }) => track.id),
    ['1'],
  );
});

test('queue entries including the playing song remain reorderable without inserting the pin', () => {
  for (const ids of [
    ['1', '2', '3'],
    ['2', '1', '3'],
    ['2', '3', '1'],
  ]) {
    const tracks = ids.map(track);
    const view = playlistView(tracks, 'a', playing());
    const [first, second] = view.queue;
    const swapped = swapPlaylistTracks(
      tracks,
      first!.track.id,
      second!.track.id,
    )!;
    assert.equal(swapped[first!.queueIndex], second!.track.id);
    assert.equal(swapped[second!.queueIndex], first!.track.id);
    assert.deepEqual(
      tracks.map((track) => track.id),
      ids,
    );
    assert.equal(new Set(swapped).size, tracks.length);
  }
  assert.equal(swapPlaylistTracks([track('1')], '1', '1'), null);
  assert.equal(swapPlaylistTracks([track('1')], '1', 'missing'), null);
  assert.deepEqual(swapPlaylistTracks([track('1'), track('2')], '1', '2'), [
    '2',
    '1',
  ]);
});

test('newer socket rotation defeats stale HTTP, while newer HTTP defeats delayed socket states', async () => {
  let current: PlaylistState | undefined;
  const receiver = createPlaylistReceiver((state) => {
    current = state;
  });
  receiver.setIdentity('a');
  const context = receiver.context();
  const response = Promise.resolve({
    tracks: ['1', '2', '3'].map(track),
    revision: 10,
  });
  receiver.receive(
    { tracks: ['2', '3', '1'].map(track), revision: 11 },
    context,
  );
  assert.equal(receiver.receive(await response, context), false);
  assert.deepEqual(
    current?.tracks.map((track) => track.id),
    ['2', '3', '1'],
  );
  assert.equal(
    receiver.receive({ tracks: [track('4')], revision: 12 }, context),
    true,
  );
  assert.equal(
    receiver.receive({ tracks: [track('2')], revision: 11 }, context),
    false,
  );
  assert.deepEqual(
    current?.tracks.map((track) => track.id),
    ['4'],
  );
  assert.equal(
    receiver.receive({ tracks: [track('4')], revision: 12 }, context),
    true,
  );
});

test('connection epochs reject old HTTP and socket states but preserve the current identity revision', () => {
  const accepted: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => accepted.push(state));
  receiver.setIdentity('a');
  const old = receiver.context();
  receiver.receive({ tracks: [track('1')], revision: 20 }, old);
  receiver.renewConnection();
  assert.equal(
    receiver.receive({ tracks: [track('2')], revision: 21 }, old),
    false,
  );
  assert.equal(receiver.setIdentity('a'), false);
  const current = receiver.context();
  assert.equal(
    receiver.receive({ tracks: [track('3')], revision: 19 }, current),
    false,
  );
  assert.equal(
    receiver.receive({ tracks: [track('4')], revision: 21 }, current),
    true,
  );
  assert.equal(accepted.length, 2);
});

test('identity changes reset revision and reject earlier guests, including a later return to that identity', () => {
  const accepted: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => accepted.push(state));
  assert.equal(
    receiver.receive({ tracks: [], revision: 1 }, receiver.context()),
    false,
  );
  receiver.setIdentity('a');
  const firstA = receiver.context();
  receiver.receive({ tracks: [track('1')], revision: 100 }, firstA);
  receiver.setIdentity('b');
  assert.equal(
    receiver.receive({ tracks: [track('2')], revision: 200 }, firstA),
    false,
  );
  assert.equal(
    receiver.receive({ tracks: [track('3')], revision: 1 }, receiver.context()),
    true,
  );
  receiver.setIdentity('a');
  assert.equal(
    receiver.receive({ tracks: [track('2')], revision: 300 }, firstA),
    false,
  );
  assert.equal(
    receiver.receive({ tracks: [track('4')], revision: 2 }, receiver.context()),
    true,
  );
  assert.deepEqual(
    accepted.map((state) => state.tracks[0]?.id),
    ['1', '3', '4'],
  );
});

test('playlist states without a valid revision cannot override the authoritative queue', () => {
  const accepted: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => accepted.push(state));
  receiver.setIdentity('a');
  const context = receiver.context();
  for (const revision of [
    undefined,
    -1,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      receiver.receive({ tracks: [], revision } as PlaylistState, context),
      false,
    );
  }
  assert.equal(receiver.receive({ tracks: [], revision: 0 }, context), true);
  assert.equal(accepted.length, 1);
});

test('ID orders reuse metadata, skip rotations and drop removed entries without fetching', () => {
  const states: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => states.push(state));
  receiver.setIdentity('a');
  const context = receiver.context();
  const tracks = ['1', '2', '3', '4'].map(track);
  receiver.receive({ tracks, revision: 5 }, context);
  assert.equal(
    receiver.receiveOrder({ ids: ['3', '1', '2'], revision: 8 }, context),
    'applied',
  );
  assert.deepEqual(states.at(-1)!.tracks, [tracks[2], tracks[0], tracks[1]]);
  assert.equal(states.at(-1)!.tracks[0], tracks[2]);
  assert.equal(receiver.needsReload(context), false);
  assert.equal(receiver.receive({ tracks, revision: 7 }, context), false);
  assert.equal(
    receiver.receive({ tracks: [track('5')], revision: 9 }, context),
    true,
  );
  assert.equal(
    receiver.receiveOrder({ ids: ['2', '3', '1'], revision: 8 }, context),
    'ignored',
  );
  assert.equal(states.at(-1)!.tracks[0]!.id, '5');
});

test('unknown order IDs advance the HTTP revision floor until complete metadata arrives', () => {
  const states: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => states.push(state));
  receiver.setIdentity('a');
  const context = receiver.context();
  receiver.receive({ tracks: [track('1')], revision: 1 }, context);
  assert.equal(
    receiver.receiveOrder({ ids: ['2', '1'], revision: 3 }, context),
    'reload',
  );
  assert.equal(receiver.needsReload(context), true);
  assert.equal(states.length, 1);
  assert.equal(
    receiver.receive({ tracks: ['1', '2'].map(track), revision: 2 }, context),
    false,
  );
  assert.equal(
    receiver.receiveOrder({ ids: ['1'], revision: 2 }, context),
    'ignored',
  );
  assert.equal(
    receiver.receiveOrder({ ids: ['1', '3', '2'], revision: 4 }, context),
    'reload',
  );
  assert.equal(
    receiver.receive({ tracks: ['2', '1'].map(track), revision: 3 }, context),
    false,
  );
  assert.equal(receiver.needsReload(context), true);
  assert.equal(
    receiver.receive(
      { tracks: ['1', '3', '2'].map(track), revision: 4 },
      context,
    ),
    true,
  );
  assert.equal(receiver.needsReload(context), false);
  assert.equal(states.length, 2);
});

test('uninitialized order recovery is scoped to identity and connection epochs', () => {
  const states: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => states.push(state));
  assert.equal(receiver.needsReload(receiver.context()), false);
  receiver.setIdentity('a');
  const first = receiver.context();
  assert.equal(
    receiver.receiveOrder({ ids: ['1'], revision: 10 }, first),
    'reload',
  );
  assert.equal(receiver.needsReload(first), true);
  receiver.renewConnection();
  const reconnected = receiver.context();
  assert.equal(receiver.needsReload(first), false);
  assert.equal(
    receiver.receiveOrder({ ids: [], revision: 11 }, first),
    'ignored',
  );
  assert.equal(
    receiver.receive({ tracks: [track('1')], revision: 9 }, reconnected),
    false,
  );
  receiver.receive({ tracks: [track('1')], revision: 10 }, reconnected);
  receiver.renewConnection();
  assert.equal(
    receiver.receiveOrder({ ids: ['1'], revision: 11 }, receiver.context()),
    'applied',
  );
  receiver.setIdentity('b');
  const second = receiver.context();
  assert.equal(
    receiver.receiveOrder({ ids: ['1'], revision: 1 }, second),
    'reload',
  );
  assert.equal(
    receiver.receive({ tracks: [track('1')], revision: 12 }, reconnected),
    false,
  );
  assert.equal(receiver.needsReload(second), true);
  receiver.receive({ tracks: [], revision: 1 }, second);
  assert.equal(receiver.needsReload(second), false);
});

test('malformed ID orders are ignored without raising the required revision', () => {
  const states: PlaylistState[] = [];
  const receiver = createPlaylistReceiver((state) => states.push(state));
  receiver.setIdentity('a');
  const context = receiver.context();
  receiver.receive({ tracks: [track('1')], revision: 1 }, context);
  for (const ids of [['1', '1'], [1], null, '1']) {
    assert.equal(
      receiver.receiveOrder({ ids, revision: 99 } as never, context),
      'ignored',
    );
  }
  for (const revision of [
    -1,
    NaN,
    Infinity,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      receiver.receiveOrder({ ids: ['1'], revision }, context),
      'ignored',
    );
  }
  assert.equal(receiver.needsReload(context), false);
  assert.equal(receiver.receive({ tracks: [], revision: 2 }, context), true);
  assert.deepEqual(states.at(-1)!.tracks, []);
});

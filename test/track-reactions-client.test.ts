import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { Socket } from 'socket.io-client';
import { useRoom } from '../src/client/room';
import { TRACK_VOTE_EFFECT_MS } from '../src/client/track-reaction-effects';
import type {
  Ack,
  Participant,
  RoomSnapshot,
  ServerEvents,
  TrackReactionKind,
} from '../src/shared/contracts';

function participant(id: string, seat: number | null): Participant {
  return {
    id,
    nickname: id,
    seat,
    connected: true,
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    movingSince: 0,
    durationMs: 0,
  };
}

function snapshot(roundId = 'first', revision = 1): RoomSnapshot {
  const track = {
    id: 'track',
    title: 'Track',
    artist: '',
    album: '',
    cover: '',
    durationMs: 50_000,
  };
  return {
    roomId: 'room',
    revision,
    serverTime: Date.now(),
    resolving: false,
    notice: null,
    capacity: 30,
    stageCapacity: 5,
    stage: ['dj'],
    users: [
      participant('dj', 0),
      participant('a', null),
      participant('b', null),
    ],
    playback: {
      roundId,
      track,
      djId: 'dj',
      url: 'https://example.com/audio',
      startedAt: 0,
      durationMs: 50_000,
    },
  };
}

async function fixture(context: TestContext, identity = 'a') {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  let transport!: Socket;
  const sent: {
    payload: { kind: TrackReactionKind; roundId: string };
    ack: (error: Error | null, result?: Ack) => void;
  }[] = [];
  context.mock.method(Socket.prototype, 'connect', function (this: Socket) {
    transport = this;
    this.connected = true;
    for (const listener of this.listeners('connect')) listener();
    return this;
  });
  context.mock.method(Socket.prototype, 'disconnect', function (this: Socket) {
    this.connected = false;
    return this;
  });
  context.mock.method(
    Socket.prototype,
    'emit',
    function (this: Socket, name: string, ...args: unknown[]) {
      if (name === 'playback:react') {
        const [payload, ack] = args as [
          (typeof sent)[number]['payload'],
          (typeof sent)[number]['ack'],
        ];
        sent.push({ payload, ack });
      }
      return this;
    },
  );
  context.mock.method(globalThis, 'fetch', async (path: string) => {
    if (path === '/api/me')
      return Response.json({ guest: { id: identity, nickname: identity } });
    if (path === '/api/playlist')
      return Response.json({ slot: 1, count: 3, tracks: [], revision: 0 });
    return Response.json({ enabled: true, groups: [], revision: 1 });
  });
  await room.initialize();
  await room.connect('room');
  function receive<Name extends keyof ServerEvents>(
    name: Name,
    event: Parameters<ServerEvents[Name]>[0],
  ) {
    for (const listener of transport.listeners(name)) listener(event);
  }
  function disconnect() {
    transport.connected = false;
    for (const listener of transport.listeners('disconnect'))
      listener('io server disconnect');
  }
  return { room, sent, receive, disconnect };
}

test('track reactions are confirmed once, scoped to the room and round, and filled from reconnect snapshots', async (context) => {
  const { room, receive, sent, disconnect } = await fixture(context);
  const state = snapshot();
  receive('room:snapshot', state);
  const displayedRoom = room.snapshot;

  room.reactToTrack('like');
  room.reactToTrack('like');
  assert.equal(room.reactionPending, true);
  assert.deepEqual(
    sent.map(({ payload }) => payload),
    [{ roundId: 'first', kind: 'like' }],
  );
  assert.equal(room.likedTrack, false);
  const ownLike = {
    roomId: 'room',
    roundId: 'first',
    kind: 'like',
    userId: 'a',
  } as const;
  receive('playback:reaction', { ...ownLike, roomId: 'other' });
  receive('playback:reaction', { ...ownLike, roundId: 'other' });
  receive('playback:reaction', { ...ownLike, userId: 'other' });
  assert.equal(room.latestReaction, null);
  receive('playback:reaction', ownLike);
  assert.equal(room.snapshot, displayedRoom);
  assert.equal(room.reactionPending, false);
  assert.equal(room.likedTrack, true);
  sent[0]!.ack(new Error('late timeout'));
  assert.equal(room.error, '');

  const like = room.latestReaction;
  receive('playback:reaction', { ...ownLike });
  assert.equal(
    room.latestReaction,
    like,
    'a duplicate never replays the sound',
  );
  receive('playback:reaction', { ...ownLike, userId: 'b' });
  receive('room:snapshot', state);
  assert.deepEqual([...room.trackLikers], ['a', 'b']);

  disconnect();
  assert.equal(room.latestReaction, null);
  assert.equal(room.trackLikers.size, 0);
  room.reactToTrack('vote');
  assert.equal(sent.length, 1);
  await room.connect('room');
  receive('room:snapshot', {
    ...state,
    reactions: { roundId: 'first', likes: ['a', 'b'], votes: ['a'] },
  });
  assert.equal(room.likedTrack, true);
  assert.deepEqual([...room.trackLikers], ['a', 'b']);
  assert.equal(room.votedTrack, true);
  assert.equal(room.latestReaction, null);
  receive('playback:updated', snapshot('first', 2));
  assert.deepEqual([...room.trackLikers], ['a', 'b']);
  receive('playback:updated', snapshot('second', 3));
  assert.equal(room.trackLikers.size, 0);
});

test('DJ can vote but cannot like their own song, and active bubbles update without replaying after rotation', async (context) => {
  const { room, receive, sent } = await fixture(context, 'dj');
  receive('room:snapshot', snapshot());
  room.reactToTrack('like');
  assert.equal(sent.length, 0);
  const vote = {
    roomId: 'room',
    roundId: 'first',
    kind: 'vote',
    userId: 'a',
    votes: 1,
    total: 3,
  } as const;
  receive('playback:reaction', vote);
  assert.equal(room.voteFor('a')?.votes, 1);
  room.reactToTrack('vote');
  assert.deepEqual(sent[0]?.payload, { kind: 'vote', roundId: 'first' });
  receive('playback:reaction', { ...vote, userId: 'dj', votes: 2 });
  assert.equal(room.votedTrack, true);
  assert.equal(room.voteFor('a')?.votes, 2);
  receive('playback:updated', snapshot('second', 2));
  assert.equal(room.votedTrack, false);
  const bubble = room.voteFor('dj')!;
  assert.equal(bubble.votes, 2);
  receive('playback:reaction', { ...vote, userId: 'b' });
  assert.equal(room.voteFor('b'), undefined);
  assert.equal(
    room.voteFor('dj', bubble.receivedAt + TRACK_VOTE_EFFECT_MS),
    undefined,
  );

  const points = {
    balance: 6,
    revision: 2,
    unlockedPresets: [],
    daily: { date: '2026-11-27', playedMs: 0, awarded: false },
  };
  receive('points:awarded', { points, awarded: 1, source: 'like' });
  assert.equal(room.points?.balance, 6);
  assert.equal(room.pointsReward, '收到点赞，获得 1 积分');
});

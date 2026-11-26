import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { io as connect, type Socket } from 'socket.io-client';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { Room } from '../src/server/room.js';
import type {
  ClientEvents,
  Guest,
  MusicService,
  ServerEvents,
  Track,
  TrackReaction,
} from '../src/shared/contracts.js';
import { DAILY_DJ_THRESHOLD_MS } from '../src/shared/points.js';

const track: Track = {
  id: '1',
  title: 'Reactions fixture',
  artist: '',
  album: '',
  cover: '',
  durationMs: 600_000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://audio.invalid/song.mp3',
    durationMs: track.durationMs,
  }),
};

function enter(room: Room, guest: Guest, connectionId = guest.id) {
  room.connect(guest, { id: connectionId, replaced() {} });
}

async function fixture(context: TestContext) {
  const db = new Store(':memory:');
  const room = new Room(db, music);
  context.after(() => {
    room.close();
    db.close();
  });
  const dj = db.createGuest('DJ').guest;
  const nextDj = db.createGuest('Next DJ').guest;
  const listener = db.createGuest('Listener').guest;
  const other = db.createGuest('Other listener').guest;
  for (const guest of [dj, nextDj, listener, other]) enter(room, guest);
  for (const guest of [dj, nextDj]) {
    db.add(guest.id, track);
    await room.join(guest.id, guest.id);
  }
  const roundId = room.snapshot().playback!.roundId;
  const reactions: TrackReaction[] = [];
  room.onTrackReaction = (event) => {
    assert.equal(room.snapshot().playback?.roundId, event.roundId);
    reactions.push(event);
  };
  return { db, room, dj, nextDj, listener, other, roundId, reactions };
}

test('accepts only current members and rounds, recording each reaction once without state broadcasts', async (context) => {
  const { db, room, dj, listener, other, roundId, reactions } =
    await fixture(context);
  const snapshots = context.mock.method(room, 'onChange');
  const playback = context.mock.method(room, 'onPlaybackChange');
  const award = context.mock.method(room, 'onPointsAwarded');
  const like = { roundId, kind: 'like' } as const;
  await assert.rejects(room.react(dj.id, like, dj.id), /不能给自己点赞/);
  await assert.rejects(room.react('outsider', like, 'outsider'), /重新连接/);
  await assert.rejects(room.react(listener.id, like, 'stale'), /重新连接/);
  await assert.rejects(
    room.react(other.id, { ...like, roundId: randomUUID() }, other.id),
    /歌曲已切换/,
  );
  await assert.rejects(
    room.react(other.id, { ...like, kind: 'skip' }, other.id),
  );
  await assert.rejects(
    room.react(other.id, { ...like, userId: dj.id }, other.id),
  );
  assert.equal(db.points(dj.id).balance, 5);

  await Promise.all([
    room.react(listener.id, like, listener.id),
    room.react(listener.id, like, listener.id),
    room.react(other.id, like, other.id),
  ]);
  const vote = { roundId, kind: 'vote' } as const;
  await room.react(listener.id, vote, listener.id);
  await room.react(listener.id, vote, listener.id);
  assert.deepEqual(reactions, [
    { ...like, userId: listener.id },
    { ...like, userId: other.id },
    { ...vote, userId: listener.id, votes: 1, total: 4 },
  ]);
  assert.deepEqual(room.snapshot().reactions, {
    roundId,
    likes: [listener.id, other.id],
    votes: [listener.id],
  });
  assert.deepEqual(
    award.mock.calls.map((call) => call.arguments),
    [
      [listener.id, 1, 'like_sent'],
      [dj.id, 1, 'like'],
      [other.id, 1, 'like_sent'],
    ],
  );
  assert.equal(db.points(dj.id).balance, 6);
  assert.equal(db.points(listener.id).balance, 6);
  assert.equal(snapshots.mock.callCount(), 0);
  assert.equal(playback.mock.callCount(), 0);
});

test('giving and receiving share one daily reward for each account', async (context) => {
  const { db, room, dj, nextDj, listener, other, roundId } =
    await fixture(context);
  db.add(listener.id, track);
  await room.join(listener.id, listener.id);
  await room.react(listener.id, { roundId, kind: 'like' }, listener.id);
  await room.skip(dj.id, { roundId }, dj.id);
  const nextRoundId = room.snapshot().playback!.roundId;
  await room.react(dj.id, { roundId: nextRoundId, kind: 'like' }, dj.id);
  assert.equal(db.points(dj.id).balance, 6);
  assert.equal(db.points(nextDj.id).balance, 6);

  await room.skip(nextDj.id, { roundId: nextRoundId }, nextDj.id);
  const listenerRoundId = room.snapshot().playback!.roundId;
  await room.react(
    other.id,
    { roundId: listenerRoundId, kind: 'like' },
    other.id,
  );
  assert.equal(db.points(listener.id).balance, 6);
  assert.equal(db.points(other.id).balance, 6);
});

test('a failure awarding the receiver also rolls back the giver and leaves the like retryable', async (context) => {
  const { db, room, dj, listener, roundId, reactions } = await fixture(context);
  db.sql.exec(`CREATE TRIGGER reject_like BEFORE INSERT ON points_ledger
    WHEN NEW.source = 'daily_like' AND NEW.guest_id = (SELECT id FROM guests WHERE nickname = 'DJ')
    BEGIN SELECT RAISE(ABORT,'forced like failure'); END`);
  const like = { roundId, kind: 'like' } as const;
  await assert.rejects(
    room.react(listener.id, like, listener.id),
    /forced like failure/,
  );
  assert.equal(db.points(listener.id).balance, 5);
  assert.equal(db.points(dj.id).balance, 5);
  assert.equal(room.snapshot().reactions, undefined);
  assert.equal(reactions.length, 0);

  db.sql.exec('DROP TRIGGER reject_like');
  await room.react(listener.id, like, listener.id);
  assert.equal(db.points(listener.id).balance, 6);
  assert.equal(db.points(dj.id).balance, 6);
  assert.deepEqual(reactions, [{ ...like, userId: listener.id }]);
});

test('a strict online majority includes the DJ and clears reactions on normal rotation', async (context) => {
  const { room, dj, nextDj, listener, other, roundId, reactions } =
    await fixture(context);
  const vote = { roundId, kind: 'vote' } as const;
  await room.react(listener.id, vote, listener.id);
  room.disconnect(listener.id, listener.id);
  await assert.rejects(room.react(listener.id, vote, listener.id), /重新连接/);
  await room.react(other.id, vote, other.id);
  assert.deepEqual(reactions.at(-1), {
    ...vote,
    userId: other.id,
    votes: 1,
    total: 3,
  });
  enter(room, listener, 'new listener socket');
  await assert.rejects(room.react(listener.id, vote, listener.id), /重新连接/);
  await room.react(listener.id, vote, 'new listener socket');
  assert.equal(reactions.length, 2);
  assert.equal(room.snapshot().playback?.roundId, roundId);

  const rotation = room.react(dj.id, vote, dj.id);
  const staleVote = room.react(nextDj.id, vote, nextDj.id);
  await Promise.all([rotation, assert.rejects(staleVote, /歌曲已切换/)]);
  assert.deepEqual(reactions.at(-1), {
    ...vote,
    userId: dj.id,
    votes: 3,
    total: 4,
  });
  const state = room.snapshot();
  assert.equal(state.playback?.djId, nextDj.id);
  assert.deepEqual(state.stage, [nextDj.id, dj.id]);
  assert.notEqual(state.playback?.roundId, roundId);
  assert.equal(state.reactions, undefined);
  await room.react(
    listener.id,
    { ...vote, roundId: state.playback!.roundId },
    'new listener socket',
  );
  assert.deepEqual(room.snapshot().reactions?.votes, [listener.id]);
});

test('membership changes can reach a majority without casting another vote', async (context) => {
  const { room, dj, nextDj, listener, other, roundId, reactions } =
    await fixture(context);
  const vote = { roundId, kind: 'vote' } as const;
  await room.react(listener.id, vote, listener.id);
  await room.react(other.id, vote, other.id);
  room.disconnect(listener.id, listener.id);
  await room.removeMember(nextDj.id);
  await immediate();
  assert.equal(room.snapshot().playback?.roundId, roundId);

  enter(room, listener, 'reconnected');
  await immediate();
  assert.equal(room.snapshot().playback?.djId, dj.id);
  assert.notEqual(room.snapshot().playback?.roundId, roundId);
  assert.equal(room.snapshot().reactions, undefined);
  assert.equal(reactions.length, 2);
});

test('the like reward survives restart and resets at Beijing midnight independently of playback time', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'loop-track-reactions-'));
  const path = join(root, 'loop.sqlite');
  const midnight = Date.UTC(2026, 10, 26, 16);
  let now = midnight - 1;
  context.mock.method(Date, 'now', () => now);
  let db = new Store(path);
  const dj = db.createGuest('DJ').guest;
  const listener = db.createGuest('Listener').guest;
  const roomId = db.createRoom(dj.id, 'Reaction room', 'cozy').id;
  let room = new Room(db, music, { roomId });
  context.after(() => {
    room.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.add(dj.id, track);
  enter(room, dj);
  enter(room, listener);
  await room.join(dj.id, dj.id);
  const like = {
    roundId: room.snapshot().playback!.roundId,
    kind: 'like',
  } as const;
  await room.react(listener.id, like, listener.id);
  assert.equal(db.points(dj.id).balance, 6);
  assert.equal(db.points(listener.id).balance, 6);
  assert.equal(db.points(dj.id).daily.playedMs, 0);
  assert.equal(
    db.recordDjPlayback(dj.id, now - DAILY_DJ_THRESHOLD_MS - 1, now),
    1,
  );
  assert.equal(db.points(dj.id).balance, 7);
  const saved = db.roomCheckpoints(now)[0]!.checkpoint;
  room.close();
  db.close();

  db = new Store(path);
  room = new Room(db, music, { roomId });
  room.restoreCheckpoint(saved);
  assert.equal(room.snapshot().reactions, undefined);
  for (const guest of [dj, listener]) enter(room, guest);
  await room.react(listener.id, like, listener.id);
  assert.equal(db.points(dj.id).balance, 7);
  assert.equal(db.points(listener.id).balance, 6);
  now = midnight;
  await room.skip(dj.id, { roundId: like.roundId }, dj.id);
  await room.react(
    listener.id,
    { ...like, roundId: room.snapshot().playback!.roundId },
    listener.id,
  );
  assert.equal(db.points(dj.id).balance, 8);
  assert.equal(db.points(listener.id).balance, 7);
  assert.deepEqual(db.points(dj.id).daily, {
    date: '2026-11-27',
    playedMs: 0,
    awarded: false,
  });
});

test('Socket.IO scopes reactions to the current room and sends each like reward privately', async (context) => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  context.after(() => app.close());
  let url: string;
  try {
    url = await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    context.skip('Sandbox forbids TCP listeners');
    return;
  }
  const dj = db.createGuest('DJ');
  const listener = db.createGuest('Listener');
  const outsider = db.createGuest('Outsider');
  const room = db.createRoom(dj.guest.id, 'Reaction room', 'cozy');
  const other = db.createRoom(outsider.guest.id, 'Other room', 'cozy');
  db.add(dj.guest.id, track);
  async function open(token: string, roomId: string) {
    const socket: Socket<ServerEvents, ClientEvents> = connect(url, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      auth: { roomId },
      extraHeaders: { cookie: `loop_guest=${token}` },
    });
    context.after(() => {
      socket.disconnect();
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.connect();
    await ready;
    await socket.timeout(1000).emitWithAck('room:sync');
    return socket;
  }
  const own = await open(dj.token, room.id);
  const viewer = await open(listener.token, room.id);
  const elsewhere = await open(outsider.token, other.id);
  assert.equal(
    (await own.timeout(1000).emitWithAck('stage:join', {})).ok,
    true,
  );
  const { playback } = await viewer.timeout(1000).emitWithAck('room:sync');
  const like = { roundId: playback!.roundId, kind: 'like' } as const;
  const snapshots = context.mock.fn();
  const roomEvents = context.mock.fn();
  const outsiderEvents = context.mock.fn();
  const receiverAwards = context.mock.fn();
  const giverAwards = context.mock.fn();
  const outsiderAwards = context.mock.fn();
  viewer.on('room:snapshot', snapshots);
  viewer.on('playback:updated', snapshots);
  viewer.on('playback:reaction', roomEvents);
  viewer.on('points:awarded', giverAwards);
  elsewhere.on('playback:reaction', outsiderEvents);
  elsewhere.on('points:awarded', outsiderAwards);
  own.on('points:awarded', receiverAwards);

  assert.equal(
    (await elsewhere.timeout(1000).emitWithAck('playback:react', like)).ok,
    false,
  );
  assert.equal(
    (await viewer.timeout(1000).emitWithAck('playback:react', like)).ok,
    true,
  );
  assert.equal(
    (await viewer.timeout(1000).emitWithAck('playback:react', like)).ok,
    true,
  );
  const synced = await viewer.timeout(1000).emitWithAck('room:sync');
  await own.timeout(1000).emitWithAck('room:sync');
  await elsewhere.timeout(1000).emitWithAck('room:sync');
  assert.equal(snapshots.mock.callCount(), 0);
  assert.equal(outsiderEvents.mock.callCount(), 0);
  assert.equal(outsiderAwards.mock.callCount(), 0);
  assert.deepEqual(
    roomEvents.mock.calls.map((call) => call.arguments),
    [[{ ...like, roomId: room.id, userId: listener.guest.id }]],
  );
  assert.deepEqual(
    receiverAwards.mock.calls.map((call) => call.arguments),
    [[{ source: 'like', awarded: 1, points: db.points(dj.guest.id) }]],
  );
  assert.deepEqual(
    giverAwards.mock.calls.map((call) => call.arguments),
    [
      [
        {
          source: 'like_sent',
          awarded: 1,
          points: db.points(listener.guest.id),
        },
      ],
    ],
  );
  assert.deepEqual(synced.reactions, {
    roundId: like.roundId,
    likes: [listener.guest.id],
    votes: [],
  });
});

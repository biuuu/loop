import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/server/db';
import { Room } from '../src/server/room';
import {
  SCENE,
  stageSeatXs,
  type MusicService,
  type Track,
} from '../src/shared/contracts';
const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: 60000,
  }),
};
for (let capacity = 1; capacity <= 6; capacity++)
  test(`stage ${capacity} fills seats in queue order and rejects joining when full`, async () => {
    const db = new Store(':memory:');
    const room = new Room(db, music, { stageCapacity: capacity });
    try {
      const users = Array.from(
        { length: capacity + 1 },
        (_, i) => db.createGuest(`Cat${i}`).guest,
      );
      users.forEach((user) => {
        db.add(user.id, track);
        room.connect(user, { id: user.id, replaced() {} });
      });
      for (let i = 0; i < capacity; i++) await room.join(users[i]!.id);
      const snapshot = room.snapshot();
      assert.equal(snapshot.stageCapacity, capacity);
      assert.deepEqual(
        snapshot.stage,
        users.slice(0, capacity).map(({ id }) => id),
      );
      for (const [seat, user] of snapshot.users.slice(0, capacity).entries()) {
        assert.equal(user.seat, seat);
        assert.equal(user.x, stageSeatXs(capacity)[seat]);
      }
      await assert.rejects(room.join(users[capacity]!.id), /舞台已满/);
    } finally {
      room.close();
      db.close();
    }
  });
test('capacity changes reject over-occupied shrink and keep playback and seat order', async () => {
  const db = new Store(':memory:');
  const room = new Room(db, music, { stageCapacity: 6 });
  try {
    const a = db.createGuest('A').guest,
      b = db.createGuest('B').guest;
    for (const user of [a, b]) {
      db.add(user.id, track);
      room.connect(user, { id: user.id, replaced() {} });
    }
    await room.join(a.id);
    await room.join(b.id);
    const before = room.snapshot(),
      queue = db.playlist(a.id);
    assert.throws(() => room.configureStage(1), /下台/);
    assert.deepEqual(room.snapshot().users, before.users);
    assert.equal(room.snapshot().revision, before.revision);
    room.configureStage(2);
    const after = room.snapshot();
    assert.deepEqual(after.stage, before.stage);
    assert.deepEqual(after.playback, before.playback);
    assert.deepEqual(db.playlist(a.id), queue);
    assert.deepEqual(
      after.users.map((user) => user.seat),
      [0, 1],
    );
    for (const user of after.users)
      assert.equal(user.x, stageSeatXs(2)[user.seat!]);
    room.configureStage(6);
    assert.equal(room.snapshot().stageCapacity, 6);
    assert.deepEqual(room.snapshot().playback, before.playback);
  } finally {
    room.close();
    db.close();
  }
});
test('resizing during pending resolution retains DJ eligibility and starts/rotates exactly once', async () => {
  const db = new Store(':memory:');
  let finish!: (value: { url: string; durationMs: number }) => void;
  let started = false;
  const room = new Room(db, {
    ...music,
    resolve: () => {
      started = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const user = db.createGuest('A').guest;
    room.connect(user, { id: user.id, replaced() {} });
    db.add(user.id, track);
    db.add(user.id, { ...track, id: '2' });
    const joining = room.join(user.id);
    while (!started) await immediate();
    room.configureStage(1);
    assert.equal(room.snapshot().users[0]!.x, SCENE.width / 2);
    assert.equal(room.snapshot().users[0]!.seat, 0);
    finish({ url: 'https://example.com/song.mp3', durationMs: 60000 });
    await joining;
    assert.equal(room.snapshot().playback!.djId, user.id);
    assert.deepEqual(
      db.tracks(user.id).map((track) => track.id),
      ['2', '1'],
    );
  } finally {
    room.close();
    db.close();
  }
});

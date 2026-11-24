import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { Store } from '../src/server/db';
import { createServer } from '../src/server/app';
import { useRoom } from '../src/client/room';
import type { Track, MusicService } from '../src/shared/contracts';

const track = (id: string): Track => ({
  id,
  title: id,
  artist: '',
  album: '',
  cover: '',
  durationMs: 60000,
});
const music: MusicService = {
  search: async () => [],
  detail: async (id) => track(id),
  resolve: async () => ({
    url: 'https://example.com/audio',
    durationMs: 60000,
  }),
};
const ids = (tracks: Track[]) => tracks.map((track) => track.id);

test('moving a queue entry inserts it without swapping or changing unrelated entries and no-ops retain revision', () => {
  const db = new Store(':memory:');
  try {
    const user = db.createGuest('cat').guest;
    for (const id of ['1', '2', '3', '4', '5']) db.add(user.id, track(id));
    const revision = db.playlist(user.id).revision;
    assert.deepEqual(ids(db.moveTrack(user.id, '5', '2', 'before')), [
      '1',
      '5',
      '2',
      '3',
      '4',
    ]);
    assert.deepEqual(ids(db.moveTrack(user.id, '1', '3', 'after')), [
      '5',
      '2',
      '3',
      '1',
      '4',
    ]);
    assert.deepEqual(ids(db.moveTrack(user.id, '4', '5', 'before')), [
      '4',
      '5',
      '2',
      '3',
      '1',
    ]);
    assert.equal(db.playlist(user.id).revision, revision + 3);
    db.moveTrack(user.id, '4', '5', 'before');
    db.moveTrack(user.id, '4', '4', 'after');
    assert.equal(db.playlist(user.id).revision, revision + 3);
    const before = db.playlist(user.id);
    assert.throws(() => db.moveTrack(user.id, '9', '1', 'before'), /已不在/);
    assert.throws(() => db.moveTrack(user.id, '1', '9', 'after'), /已不在/);
    assert.deepEqual(db.playlist(user.id), before);
  } finally {
    db.close();
  }
});

test('move API applies intent to the latest queue after rotation/addition and isolates identities', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B');
    for (const id of ['1', '2', '3', '4']) db.add(a.guest.id, track(id));
    db.add(b.guest.id, track('2'));
    const other = db.playlist(b.guest.id);
    // The user picked a target before playback rotated and another song arrived.
    db.rotateTrack(a.guest.id, '1');
    db.add(a.guest.id, track('5'));
    const move = (payload: Record<string, unknown>, token = a.token) =>
      app.inject({
        method: 'PUT',
        url: '/api/playlist/move',
        headers: { cookie: `loop_guest=${token}` },
        payload,
      });
    const response = await move({
      id: '4',
      targetId: '2',
      placement: 'before',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ids(response.json().tracks), ['4', '2', '3', '1', '5']);
    assert.deepEqual(db.playlist(b.guest.id), other);
    const top = await move({ id: '5', placement: 'first' });
    assert.equal(top.statusCode, 200);
    assert.deepEqual(ids(top.json().tracks), ['5', '4', '2', '3', '1']);
    assert.equal(
      (await move({ id: '4', placement: 'before' })).statusCode,
      400,
    );
    for (const payload of [
      { id: '4', targetId: '2', placement: 'up' },
      { id: '4', targetId: 'bad', placement: 'before' },
      { id: '4', targetId: '2', placement: 'before', userId: b.guest.id },
    ])
      assert.equal((await move(payload)).statusCode, 400);
    assert.equal(
      (await move({ id: '4', targetId: '2', placement: 'before' }, b.token))
        .statusCode,
      400,
    );
    assert.equal(
      (await move({ id: '4', targetId: '2', placement: 'before' }, ''))
        .statusCode,
      401,
    );
    db.remove(a.guest.id, '2');
    const before = db.playlist(a.guest.id);
    assert.equal(
      (await move({ id: '4', targetId: '2', placement: 'after' })).statusCode,
      400,
    );
    assert.deepEqual(db.playlist(a.guest.id), before);
  } finally {
    await app.close();
  }
});

test('client move preserves the queue on failure and ignores a response after identity changes', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  let resolve!: (response: Response) => void;
  let payload: unknown;
  let guest = { id: 'a', nickname: 'A' };
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input === '/api/me') return Response.json({ guest });
      if (input === '/api/guest') {
        guest = { id: 'b', nickname: 'B' };
        return Response.json({ guest });
      }
      if (input === '/api/playlist')
        return Response.json({
          slot: 1,
          count: 1,
          tracks: (guest.id === 'a' ? ['1', '2', '3'] : ['9']).map(track),
          revision: 1,
        });
      assert.equal(input, '/api/playlist/move?slot=1');
      payload = JSON.parse(String(init?.body));
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  );
  await room.initialize();
  const successful = room.moveTrack('3', '1', 'before');
  resolve(
    Response.json({
      slot: 1,
      count: 1,
      tracks: ['3', '1', '2'].map(track),
      revision: 2,
    }),
  );
  await successful;
  assert.deepEqual(ids(room.playlist), ['3', '1', '2']);
  const toTop = room.moveTrackToTop('2');
  assert.deepEqual(payload, { id: '2', placement: 'first' });
  resolve(
    Response.json({
      slot: 1,
      count: 1,
      tracks: ['2', '3', '1'].map(track),
      revision: 3,
    }),
  );
  await toTop;
  assert.deepEqual(ids(room.playlist), ['2', '3', '1']);
  const before = room.playlist;
  const failed = room.moveTrack('3', '1', 'before');
  assert.deepEqual(payload, { id: '3', targetId: '1', placement: 'before' });
  resolve(Response.json({ error: 'failed' }, { status: 400 }));
  await assert.rejects(failed, /failed/);
  assert.equal(room.playlist, before);
  const pending = room.moveTrack('3', '1', 'before');
  await room.enter('B');
  resolve(
    Response.json({
      slot: 1,
      count: 1,
      tracks: ['3', '1', '2'].map(track),
      revision: 100,
    }),
  );
  await pending;
  assert.deepEqual(ids(room.playlist), ['9']);
});

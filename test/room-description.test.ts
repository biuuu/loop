import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import {
  DEFAULT_STAGE_TIME_LIMIT_MINUTES,
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  ROOM_DESCRIPTION_LIMIT,
  type MusicService,
  type RoomDetails,
  type RoomSnapshot,
  type Track,
} from '../src/shared/contracts.js';

const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
};
const music: MusicService = {
  search: async () => [],
  detail: async () => track,
  resolve: async () => ({
    url: 'https://example.com/song.mp3',
    durationMs: track.durationMs,
  }),
};
const headers = (token: string) => ({ cookie: `loop_guest=${token}` });

test('version 16 adds empty descriptions to existing rooms and saves edits across reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-room-description-'));
  const path = join(root, 'rooms.sqlite');
  const previous = join(root, 'migrations');
  let db: Store | undefined;
  try {
    mkdirSync(previous);
    for (const name of readdirSync('migrations').filter((name) =>
      /^01[1-5]-.*\.sql$/.test(name),
    ))
      copyFileSync(join('migrations', name), join(previous, name));
    db = new Store(path, previous);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 15);
    const { createdRoom } = db.createUser('Owner');

    db.close();
    db = undefined;
    db = new Store(path);
    assert.equal(db.sql.pragma('user_version', { simple: true }), 28);
    assert.deepEqual(db.roomDetails(createdRoom.id), {
      ...createdRoom,
      description: '',
      stageTimeLimitMinutes: DEFAULT_STAGE_TIME_LIMIT_MINUTES,
      trackTimeLimitMinutes: DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    });
    const description = '欢迎来听歌。\n请随意选歌。';
    assert.equal(
      db.updateRoom(createdRoom.id, createdRoom.revision, {
        name: createdRoom.name,
        environmentId: createdRoom.environmentId,
        joinPolicy: createdRoom.joinPolicy,
        description,
      }),
      true,
    );
    db.close();
    db = undefined;
    db = new Store(path);
    assert.equal(db.roomDetails(createdRoom.id)?.description, description);
    assert.equal(db.roomDetails(createdRoom.id)?.revision, 2);
    assert.deepEqual(db.sql.pragma('foreign_key_check'), []);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('room settings require ownership and use revisioned plain-text description updates', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  try {
    const owner = db.createUser('Owner');
    const other = db.createUser('Other');
    const room = owner.createdRoom;
    const roomUrl = `/api/rooms/${room.id}`;
    const settingsUrl = `${roomUrl}/settings`;
    const settings = () =>
      app.inject({ url: settingsUrl, headers: headers(owner.token) });
    const patch = (payload: Record<string, unknown>, token = owner.token) =>
      app.inject({
        method: 'PATCH',
        url: roomUrl,
        headers: headers(token),
        payload,
      });

    const initial = await settings();
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.deepEqual(initial.json().room, {
      ...room,
      description: '',
      stageTimeLimitMinutes: DEFAULT_STAGE_TIME_LIMIT_MINUTES,
      trackTimeLimitMinutes: DEFAULT_TRACK_TIME_LIMIT_MINUTES,
    });
    assert.equal((await app.inject(settingsUrl)).statusCode, 401);
    assert.equal(
      (await app.inject({ url: settingsUrl, headers: headers(other.token) }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await patch(
          { description: 'Other room', expectedRevision: 1 },
          other.token,
        )
      ).statusCode,
      403,
    );
    for (const description of [
      17,
      null,
      'a'.repeat(ROOM_DESCRIPTION_LIMIT + 1),
    ])
      assert.equal(
        (await patch({ description, expectedRevision: 1 })).statusCode,
        400,
      );

    const description = '<b>欢迎</b>\n自己点歌\n今天见';
    const changed = await patch({
      description: '  <b>欢迎</b>\r\n自己点歌\r今天见  ',
      expectedRevision: 1,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const saved = changed.json<{ room: RoomDetails }>().room;
    assert.equal(saved.description, description);
    assert.equal(saved.revision, 2);
    assert.deepEqual((await settings()).json().room, saved);
    assert.equal(
      (await patch({ description: 'Late edit', expectedRevision: 1 }))
        .statusCode,
      409,
    );
    assert.deepEqual((await settings()).json().room, saved);

    for (const url of [
      '/api/rooms',
      '/api/rooms?owner=me',
      roomUrl,
      `/api/rooms/${room.number}`,
    ]) {
      const response = await app.inject({ url, headers: headers(owner.token) });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      const publicRoom =
        body.room ??
        body.rooms.find((item: RoomDetails) => item.id === room.id);
      assert.ok(publicRoom);
      assert.equal(Object.hasOwn(publicRoom, 'description'), false);
    }

    const renamed = await patch({ name: 'Updated room', expectedRevision: 2 });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().room.description, description);
    const max = '歌'.repeat(ROOM_DESCRIPTION_LIMIT);
    const atLimit = await patch({ description: max, expectedRevision: 3 });
    assert.equal(atLimit.statusCode, 200, atLimit.body);
    assert.equal(atLimit.json().room.description, max);
    const clear = await patch({ description: '', expectedRevision: 4 });
    assert.equal(clear.statusCode, 200, clear.body);
    assert.equal(clear.json().room.description, '');
    assert.equal((await settings()).json().room.description, '');
  } finally {
    await app.close();
  }
});

test('admitted sockets receive description edits and owner nickname changes without interrupting playback', async (context) => {
  const { app, db } = await createServer({ dbPath: ':memory:', music });
  const peers: ReturnType<typeof io>[] = [];
  try {
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      context.skip('Sandbox forbids TCP listeners');
      return;
    }
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const open = async (token: string, roomId: string) => {
      const peer = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
        extraHeaders: headers(token),
        auth: { roomId },
      });
      peers.push(peer);
      const updates: RoomDetails[] = [];
      peer.on('room:updated', (room: RoomDetails) => updates.push(room));
      const snapshot = await new Promise<RoomSnapshot>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('socket timeout')),
          2000,
        );
        peer.once('room:snapshot', (state: RoomSnapshot) => {
          clearTimeout(timer);
          resolve(state);
        });
        peer.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        peer.connect();
      });
      const sync = async (): Promise<RoomSnapshot> =>
        await peer.timeout(1000).emitWithAck('room:sync');
      return { peer, updates, snapshot, sync };
    };
    const owner = db.createUser('Owner');
    const dj = db.createUser('DJ');
    const newcomer = db.createUser('Newcomer');
    const room = owner.createdRoom;
    const target = await open(dj.token, room.id);
    const unrelated = await open(owner.token, dj.createdRoom.id);
    db.add(dj.guest.id, track);
    assert.equal(
      (await target.peer.timeout(1000).emitWithAck('stage:join', {})).ok,
      true,
    );
    const before = await target.sync();
    assert.equal(before.playback?.djId, dj.guest.id);
    const description = '欢迎。\n一起听歌！';
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}`,
      headers: headers(owner.token),
      payload: { description, expectedRevision: room.revision },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const synced = await target.sync();
    await unrelated.sync();
    assert.deepEqual(target.updates, [changed.json().room]);
    assert.deepEqual(unrelated.updates, []);
    assert.equal(synced.room?.description, description);
    assert.deepEqual(synced.playback, before.playback);
    assert.deepEqual(synced.stage, before.stage);
    assert.equal(synced.revision, before.revision);

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/me/nickname',
      headers: headers(owner.token),
      payload: { nickname: 'Host' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const afterRename = await target.sync();
    assert.equal(target.updates.length, 2);
    assert.equal(target.updates[1]?.description, description);
    assert.equal(target.updates[1]?.ownerNickname, 'Host');
    assert.deepEqual(afterRename.playback, before.playback);
    const joined = await open(newcomer.token, room.id);
    assert.equal(joined.snapshot.room?.description, description);
    assert.equal(joined.snapshot.room?.ownerNickname, 'Host');
    assert.deepEqual(joined.snapshot.playback, before.playback);
  } finally {
    peers.forEach((peer) => peer.disconnect());
    await app.close();
  }
});

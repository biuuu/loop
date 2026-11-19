import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { accountEntryRoute, routeFor } from '../src/client/navigation';
import { useRoom } from '../src/client/room';
import { DEFAULT_CAT_APPEARANCE } from '../src/shared/appearance';
import {
  NICKNAME_CHANGE_COOLDOWN_MS,
  type RoomInfo,
} from '../src/shared/contracts';

const home = (ownerId: string, number: number): RoomInfo => ({
  id: `room-${ownerId}`,
  number,
  ownerId,
  ownerNickname: ownerId,
  name: `${ownerId}的房间`,
  environmentId: 'seaside',
  stageCapacity: 6,
  joinPolicy: 'open',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});

test('new identities enter their home from the directory but preserve explicit numeric or legacy room destinations', () => {
  const ownRoom = home('cat', 12);
  assert.deepEqual(accountEntryRoute(routeFor('/'), ownRoom), {
    kind: 'room',
    roomId: '12',
  });
  for (const path of ['/7', '/rooms/legacy-room', '/rooms/__test__']) {
    const target = routeFor(path);
    assert.deepEqual(accountEntryRoute(target, ownRoom), target);
  }
  assert.deepEqual(accountEntryRoute(routeFor('/')), { kind: 'directory' });
  assert.deepEqual(accountEntryRoute(routeFor('/7')), {
    kind: 'room',
    roomId: '7',
  });
  assert.deepEqual(accountEntryRoute(routeFor('/admin/netease'), ownRoom), {
    kind: 'admin-netease',
  });
});

test('nickname entry exposes only the new room response after applying the created identity and playlist', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  const createdRoom = home('cat', 12);
  let creations = 0;
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (input === '/api/guest')
      return Response.json({
        guest: { id: 'cat', nickname: 'cat' },
        ...(creations++ === 0 ? { createdRoom } : {}),
      });
    assert.equal(input, '/api/playlist');
    return Response.json({ tracks: [], revision: 0 });
  });
  assert.deepEqual(await room.enter('cat'), createdRoom);
  assert.equal(room.guest!.id, 'cat');
  assert.deepEqual(room.playlist, []);
  assert.equal(
    room.roomId,
    null,
    'the app chooses the entry destination, not the account store',
  );
  assert.equal(
    await room.enter('renamed'),
    undefined,
    'the legacy nickname entry for an existing identity returns no new room',
  );
});

test('Netease entry sends the selected user and playlist, then loads the imported queue before returning home', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  const createdRoom = home('netease-cat', 19);
  const selectedTrack = {
    id: '123',
    name: '一首歌',
    artist: '歌手',
    duration: 180000,
  };
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input === '/api/guest/from-netease') {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), {
          userId: '88',
          playlistId: '99',
          nickname: '云朵猫',
          playlistOffset: 20,
        });
        return Response.json({
          guest: { id: 'netease-cat', nickname: '云朵猫' },
          createdRoom,
        });
      }
      assert.equal(input, '/api/playlist');
      return Response.json({ tracks: [selectedTrack], revision: 1 });
    },
  );
  assert.deepEqual(
    await room.enterFromNetease('88', '99', '云朵猫', 20),
    createdRoom,
  );
  assert.equal(room.guest?.nickname, '云朵猫');
  assert.deepEqual(room.playlist, [selectedTrack]);
});

test('a delayed playlist read from an older account cannot return its home as a navigation target', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  let release!: (value: Response) => void;
  let started!: () => void;
  const firstRead = new Promise<void>((done) => {
    started = done;
  });
  let reads = 0;
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input === '/api/guest') {
        const { nickname } = JSON.parse(String(init?.body));
        return Response.json({
          guest: { id: nickname, nickname },
          createdRoom: home(nickname, nickname === 'A' ? 1 : 2),
        });
      }
      assert.equal(input, '/api/playlist');
      if (reads++ === 0)
        return new Promise<Response>((done) => {
          release = done;
          started();
        });
      return Response.json({ tracks: [], revision: 0 });
    },
  );
  const stale = room.enter('A');
  await firstRead;
  assert.deepEqual(await room.enter('B'), home('B', 2));
  release(Response.json({ tracks: [], revision: 50 }));
  assert.equal(await stale, undefined);
  assert.equal(room.guest!.id, 'B');
  assert.equal(room.playlistRevision, 0);
});

test('editing a nickname preserves the current room, playback, identity and playlist', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  const guest = {
    id: 'cat',
    nickname: '猫',
    appearance: DEFAULT_CAT_APPEARANCE,
  };
  const track = {
    id: '1',
    title: '一首歌',
    artist: '',
    album: '',
    cover: '',
    durationMs: 10_000,
  };
  const now = Date.now();
  const availableAt = now + NICKNAME_CHANGE_COOLDOWN_MS;
  context.mock.method(
    globalThis,
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      if (input === '/api/me') return Response.json({ guest });
      if (input === '/api/playlist')
        return Response.json({ tracks: [track], revision: 3 });
      assert.equal(input, '/api/me/nickname');
      assert.equal(init?.method, 'PATCH');
      assert.deepEqual(JSON.parse(String(init?.body)), { nickname: '云朵猫' });
      return Response.json({
        guest: {
          ...guest,
          nickname: '云朵猫',
          nicknameChangeAvailableAt: availableAt,
        },
      });
    },
  );
  await room.initialize();
  room.roomId = 'room-cat';
  room.connection = 'connected';
  room.snapshot = {
    roomId: 'room-cat',
    revision: 12,
    serverTime: now,
    users: [
      {
        ...guest,
        connected: true,
        seat: 0,
        x: 396,
        targetX: 396,
        y: 255,
        targetY: 255,
        movingSince: now,
        durationMs: 0,
      },
    ],
    stage: ['cat'],
    capacity: 30,
    stageCapacity: 5,
    resolving: false,
    notice: null,
    playback: {
      roundId: 'round',
      track,
      djId: 'cat',
      url: 'https://example.test/song.mp3',
      startedAt: now,
      durationMs: track.durationMs,
    },
  };
  const { playlist, roomGeneration, snapshot } = room;
  assert.equal(await room.setNickname('云朵猫'), true);
  assert.deepEqual(room.guest, {
    ...guest,
    nickname: '云朵猫',
    nicknameChangeAvailableAt: availableAt,
  });
  assert.equal(room.roomId, 'room-cat');
  assert.equal(room.roomGeneration, roomGeneration);
  assert.equal(room.connection, 'connected');
  assert.equal(room.snapshot, snapshot);
  assert.equal(room.onStage, true);
  assert.equal(room.playlist, playlist);
  assert.equal(room.playlistRevision, 3);
});

test('a nickname cooldown response updates the private retry time and preserves the current name', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => room.$dispose());
  room.guest = { id: 'cat', nickname: '猫' };
  const availableAt = Date.now() + NICKNAME_CHANGE_COOLDOWN_MS;
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.equal(input, '/api/me/nickname');
    return Response.json(
      {
        error: '两次昵称修改需间隔 7 天',
        nicknameChangeAvailableAt: availableAt,
      },
      { status: 429 },
    );
  });
  await assert.rejects(room.setNickname('云朵猫'), /7 天/);
  assert.deepEqual(room.guest, {
    id: 'cat',
    nickname: '猫',
    nicknameChangeAvailableAt: availableAt,
  });
});

test('a delayed nickname response cannot change a reauthenticated profile with the same ID', async (context) => {
  setActivePinia(createPinia());
  const room = useRoom();
  context.after(() => {
    room.close();
    room.$dispose();
  });
  room.guest = { id: 'cat', nickname: '猫' };
  const activeGuest = { id: 'cat', nickname: '新登录的猫', registered: true };
  let resolveRename!: (response: Response) => void;
  const renameResponse = new Promise<Response>((resolve) => {
    resolveRename = resolve;
  });
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (input === '/api/me/nickname') return renameResponse;
    if (input === '/api/auth/email/verify')
      return Response.json({ guest: activeGuest });
    assert.equal(input, '/api/playlist');
    return Response.json({ tracks: [], revision: 1 });
  });
  const rename = room.setNickname('旧请求的猫');
  await room.authenticate('challenge', '123456');
  resolveRename(
    Response.json({
      guest: {
        id: 'cat',
        nickname: '旧请求的猫',
        nicknameChangeAvailableAt: Date.now() + NICKNAME_CHANGE_COOLDOWN_MS,
      },
    }),
  );
  assert.equal(await rename, false);
  assert.deepEqual(room.guest, activeGuest);
});

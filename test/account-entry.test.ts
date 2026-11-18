import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { accountEntryRoute, routeFor } from '../src/client/navigation';
import { useRoom } from '../src/client/room';
import type { RoomInfo } from '../src/shared/contracts';

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
    'a rename does not cause home-room navigation',
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

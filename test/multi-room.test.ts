import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server, Socket } from 'socket.io';
import { Store } from '../src/server/db.js';
import { RoomRegistry } from '../src/server/room-registry.js';
import { createServer } from '../src/server/app.js';
import type {
  Guest,
  MusicService,
  RoomSnapshot,
  RoomSummary,
  Track,
} from '../src/shared/contracts.js';
const track = (id: string): Track => ({
  id,
  title: `Track ${id}`,
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60_000,
});
const music: MusicService = {
  search: async () => [],
  detail: async (id) => track(id),
  resolve: async (item) => ({
    url: `https://example.com/${item.id}.mp3`,
    durationMs: 60_000,
  }),
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function enterDirectoryRoom(
  registry: RoomRegistry,
  roomId: string,
  guest: Guest,
) {
  const socketId = `socket-${guest.id}`;
  const socket = {
    id: socketId,
    join: () => {},
    leave: () => {},
    emit: () => {},
    disconnect: () => {},
  } as unknown as Socket;
  return {
    room: registry.connect(roomId, guest, socket, `hash-${guest.id}`),
    socketId,
  };
}
async function promptly(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('command waited for unresolved music')),
          100,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function fixture(service = music, grace = 30_000) {
  const db = new Store(':memory:');
  const events: Array<{ channel: string; event: string; payload: any }> = [];
  const io = {
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) => {
        events.push({ channel, event, payload });
      },
    }),
  } as unknown as Server;
  const registry = new RoomRegistry(db, service, io, {
    disconnectGraceMs: grace,
  });
  const ownerA = db.createGuest('OwnerA').guest,
    ownerB = db.createGuest('OwnerB').guest;
  const a = db.createRoom(ownerA.id, 'A', 'cozy'),
    b = db.createRoom(ownerB.id, 'B', 'cozy');
  let index = 0;
  function open(roomId: string, guest: Guest, tokenHash = `hash-${guest.id}`) {
    const emitted: Array<{ event: string; payload: any }> = [];
    const peer = {
      id: `socket-${++index}`,
      connected: true,
      channels: new Set<string>(),
      join(channel: string) {
        this.channels.add(channel);
      },
      leave(channel: string) {
        this.channels.delete(channel);
      },
      emit(event: string, payload: unknown) {
        emitted.push({ event, payload });
      },
      disconnect() {
        this.connected = false;
        registry.disconnect(roomId, guest.id, this.id);
      },
    };
    const socket = peer as unknown as Socket;
    const room = registry.connect(roomId, guest, socket, tokenHash);
    return { socket, peer, room, emitted };
  }
  return {
    db,
    events,
    registry,
    ownerA,
    ownerB,
    a,
    b,
    open,
    close: () => {
      registry.close();
      db.close();
    },
  };
}

test('two rooms isolate membership, simultaneous seats/playback, motion/emotes and private playlist events', async () => {
  const f = fixture();
  try {
    const a = f.open(f.a.id, {
      ...f.ownerA,
      email: 'private@example.com',
      registered: true,
    });
    const b = f.open(f.b.id, f.ownerB);
    for (const user of [f.ownerA, f.ownerB]) {
      f.db.add(user.id, {
        ...track('1'),
        cover: 'https://p1.music.126.net/1.jpg',
      });
      f.db.add(user.id, {
        ...track('2'),
        cover: 'https://p1.music.126.net/2.jpg',
      });
    }
    await a.room.join(f.ownerA.id, a.socket.id, 0);
    await b.room.join(f.ownerB.id, b.socket.id, 0);
    const sa = f.registry.snapshot(f.a.id),
      sb = f.registry.snapshot(f.b.id);
    assert.deepEqual(sa.stage, [f.ownerA.id]);
    assert.deepEqual(sb.stage, [f.ownerB.id]);
    assert.equal(sa.playback!.djId, f.ownerA.id);
    assert.equal(sb.playback!.djId, f.ownerB.id);
    assert.equal(sa.roomId, f.a.id);
    assert.equal(sa.room!.name, 'A');
    assert.equal(sa.users[0]!.email, undefined);
    assert.equal(sa.users[0]!.registered, undefined);
    const guest = f.db.createGuest('Visitor').guest;
    const observer = f.open(f.a.id, guest);
    const before = f.events.length;
    a.room.emote(f.ownerA.id, { id: 'nahida-2' });
    a.room.motion(guest.id, {
      x: 400,
      y: 450,
      targetX: 410,
      targetY: 450,
      facingRight: true,
      clientMoveId: 1,
    });
    const deltas = f.events.slice(before);
    assert.equal(deltas.length, 2);
    for (const event of deltas) {
      assert.equal(event.channel, `room:${f.a.id}`);
      assert.equal(event.payload.roomId, f.a.id);
    }
    assert.deepEqual(
      deltas.map((event) => event.event),
      ['room:emote', 'room:motion'],
    );
    assert.equal(
      a.emitted.filter((event) => event.event === 'playlist:reordered').length,
      1,
    );
    assert.equal(
      b.emitted.filter((event) => event.event === 'playlist:reordered').length,
      1,
    );
    assert.equal(
      observer.emitted.filter((event) => event.event === 'playlist:reordered')
        .length,
      0,
    );
    await assert.rejects(
      a.room.skip(
        guest.id,
        { roundId: sa.playback!.roundId },
        observer.socket.id,
      ),
      /当前/,
    );
    await a.room.skip(
      guest.id,
      { roundId: sa.playback!.roundId },
      observer.socket.id,
      true,
    );
    assert.equal(b.room.snapshot().playback!.roundId, sb.playback!.roundId);
    assert.deepEqual(
      f.registry
        .summaries()
        .map((room) => [
          room.name,
          room.online,
          room.trackTitle,
          room.trackCover,
        ]),
      [
        ['A', 2, 'Track 2', 'https://p1.music.126.net/2.jpg'],
        ['B', 1, 'Track 1', 'https://p1.music.126.net/1.jpg'],
      ],
    );
    assert.ok(
      f.events
        .filter((event) => event.event === 'room:snapshot')
        .every((event) =>
          (event.payload as RoomSnapshot).users.every(
            (user) => user.email === undefined,
          ),
        ),
    );
  } finally {
    f.close();
  }
});

test('closed, full and banned destinations fail admission before invalidating the old room', () => {
  const f = fixture();
  try {
    const origin = f.open(f.a.id, f.ownerA),
      destination = f.open(f.b.id, f.ownerB);
    f.db.updateRoom(f.b.id, 1, {
      name: 'B',
      environmentId: 'cozy',
      joinPolicy: 'closed',
    });
    assert.throws(() => f.open(f.b.id, f.ownerA), /暂停/);
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, origin.socket.id));
    f.db.updateRoom(f.b.id, 2, {
      name: 'B',
      environmentId: 'cozy',
      joinPolicy: 'open',
    });
    for (let i = 1; i < 30; i++)
      f.open(f.b.id, f.db.createGuest(`G${i}`).guest);
    assert.equal(
      f.registry.summaries().find((room) => room.id === f.b.id)!.full,
      true,
    );
    assert.throws(() => f.open(f.b.id, f.ownerA), /已满/);
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, origin.socket.id));
    f.registry.ban(f.b.id, f.ownerB.id, f.ownerA.id);
    assert.throws(() => f.open(f.b.id, f.ownerA), /禁止/);
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, origin.socket.id));
    // The existing owner may reconnect even while capacity is occupied and entry is paused.
    f.db.updateRoom(f.b.id, 3, {
      name: 'B',
      environmentId: 'cozy',
      joinPolicy: 'closed',
    });
    const replacement = f.open(f.b.id, f.ownerB);
    assert.equal(destination.peer.connected, false);
    assert.ok(f.registry.isCurrent(f.b.id, f.ownerB.id, replacement.socket.id));
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, origin.socket.id));
  } finally {
    f.close();
  }
});

test('same-room replacement and A to B to A retain exactly one valid session; old disconnect and leave cannot remove it', async () => {
  const f = fixture();
  try {
    const first = f.open(f.a.id, f.ownerA);
    f.db.add(f.ownerA.id, track('1'));
    await first.room.join(f.ownerA.id, first.socket.id, 0);
    const second = f.open(f.a.id, f.ownerA);
    assert.equal(first.peer.connected, false);
    assert.equal(
      first.emitted.filter((event) => event.event === 'room:replaced').length,
      1,
    );
    assert.equal(second.room.snapshot().users[0]!.seat, 0);
    f.registry.disconnect(f.a.id, f.ownerA.id, first.socket.id);
    assert.equal(second.room.snapshot().users[0]!.connected, true);
    const third = f.open(f.b.id, f.ownerA);
    assert.equal(second.peer.connected, false);
    assert.equal(f.registry.runtimeCount(), 1);
    const fourth = f.open(f.a.id, f.ownerA);
    assert.equal(third.peer.connected, false);
    assert.equal(fourth.room.snapshot().users[0]!.seat, null);
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, fourth.socket.id));
    f.registry.disconnect(f.a.id, f.ownerA.id, second.socket.id);
    assert.throws(
      () => f.registry.leave(f.a.id, f.ownerA.id, second.socket.id),
      /替换/,
    );
    assert.equal(fourth.room.snapshot().users[0]!.connected, true);
    f.registry.leave(f.a.id, f.ownerA.id, fourth.socket.id);
    assert.equal(f.registry.runtimeCount(), 0);
    assert.ok(f.db.room(f.a.id));
    await tick();
    assert.equal(fourth.peer.connected, false);
  } finally {
    f.close();
  }
});

test('owner moderation is checked server-side, bans are local and owner cannot ban or kick self', async () => {
  const f = fixture();
  try {
    const owner = f.open(f.a.id, f.ownerA),
      otherOwner = f.open(f.b.id, f.ownerB);
    const guest = f.db.createGuest('Visitor').guest,
      visitor = f.open(f.a.id, guest);
    f.db.add(guest.id, track('1'));
    await visitor.room.join(guest.id, visitor.socket.id, 0);
    assert.throws(
      () => f.registry.forceLeave(f.a.id, guest.id, f.ownerA.id),
      /房主/,
    );
    assert.throws(() => f.registry.kick(f.a.id, guest.id, f.ownerA.id), /房主/);
    assert.throws(() => f.registry.ban(f.a.id, guest.id, f.ownerA.id), /房主/);
    assert.throws(
      () => f.registry.kick(f.a.id, f.ownerA.id, f.ownerA.id),
      /自己/,
    );
    assert.throws(
      () => f.registry.ban(f.a.id, f.ownerA.id, f.ownerA.id),
      /自己/,
    );
    await f.registry.forceLeave(f.a.id, f.ownerA.id, guest.id);
    assert.equal(
      owner.room.snapshot().users.find((user) => user.id === guest.id)!.seat,
      null,
    );
    f.registry.kick(f.a.id, f.ownerA.id, guest.id);
    assert.equal(visitor.peer.connected, false);
    assert.equal(f.db.banned(f.a.id, guest.id), false);
    const reentered = f.open(f.a.id, guest);
    f.registry.ban(f.a.id, f.ownerA.id, guest.id);
    assert.equal(reentered.peer.connected, false);
    assert.equal(f.db.banned(f.a.id, guest.id), true);
    const otherRoom = f.open(f.b.id, guest);
    assert.ok(f.registry.isCurrent(f.b.id, guest.id, otherRoom.socket.id));
    f.db.unban(f.a.id, guest.id);
    assert.equal(owner.peer.connected, true);
    assert.ok(f.db.room(f.a.id));
    assert.equal(f.db.firstTrack(guest.id)!.id, '1');
    assert.equal(otherOwner.peer.connected, true);
    assert.equal(otherRoom.peer.connected, true);
    assert.throws(
      () => f.db.createRoom(f.ownerA.id, 'New', 'cozy'),
      /UNIQUE constraint/,
    );
  } finally {
    f.close();
  }
});

test('switching while upstream resolution is pending finishes promptly; late success cannot play or rotate', async () => {
  let resolve!: (value: { url: string; durationMs: number }) => void;
  const f = fixture({
    ...music,
    resolve: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  try {
    const owner = f.open(f.a.id, f.ownerA),
      guest = f.db.createGuest('Observer').guest;
    f.open(f.a.id, guest);
    f.db.add(f.ownerA.id, track('1'));
    f.db.add(f.ownerA.id, track('2'));
    const join = owner.room.join(f.ownerA.id, owner.socket.id, 0);
    await tick();
    assert.equal(owner.room.snapshot().resolving, true);
    const before = f.db.playlist(f.ownerA.id).revision;
    f.open(f.b.id, f.ownerA);
    await promptly(join);
    assert.equal(owner.room.snapshot().playback, null);
    resolve({ url: 'https://example.com/late.mp3', durationMs: 60_000 });
    await tick();
    await tick();
    assert.equal(owner.room.snapshot().playback, null);
    assert.equal(
      f.db.roomsForDirectory().find(({ id }) => id === f.a.id)?.lastPlayedAt,
      null,
    );
    assert.equal(f.db.playlist(f.ownerA.id).revision, before);
    assert.deepEqual(f.db.playlistOrder(f.ownerA.id).ids, ['1', '2']);
    assert.equal(
      owner.emitted.filter((event) => event.event === 'playlist:reordered')
        .length,
      0,
    );
  } finally {
    f.close();
  }
});

test('disconnect grace preserves seats and existing closed-room reconnect; expiry frees runtime but keeps persistent room', async () => {
  const f = fixture(music, 15);
  try {
    const first = f.open(f.a.id, f.ownerA);
    f.db.add(f.ownerA.id, track('1'));
    await first.room.join(f.ownerA.id, first.socket.id, 0);
    f.db.updateRoom(f.a.id, 1, {
      name: 'A',
      environmentId: 'cozy',
      joinPolicy: 'closed',
    });
    first.peer.disconnect();
    assert.equal(first.room.snapshot().users[0]!.connected, false);
    assert.equal(
      f.registry.summaries().find((room) => room.id === f.a.id)!.online,
      0,
    );
    const second = f.open(f.a.id, f.ownerA);
    assert.equal(second.room.snapshot().users[0]!.seat, 0);
    second.peer.disconnect();
    await delay(25);
    assert.equal(f.registry.runtimeCount(), 0);
    assert.ok(f.db.room(f.a.id));
    const third = f.open(f.a.id, f.ownerA);
    assert.equal(third.room.snapshot().users[0]!.seat, null);
    assert.equal(third.room.snapshot().playback, null);
  } finally {
    f.close();
  }
});

test('room HTTP edits enforce owner, revision, allowlisted environment, bans and public directory privacy', async () => {
  const { app, db } = await createServer({ dbPath: ':memory:' });
  try {
    const a = db.createGuest('A'),
      b = db.createGuest('B'),
      visitor = db.createGuest('Visitor');
    db.sql
      .prepare('INSERT INTO auth_identities VALUES (?,?,?,?)')
      .run(a.guest.id, 'email', 'private@example.com', Date.now());
    const headers = { cookie: `loop_guest=${a.token}` },
      other = { cookie: `loop_guest=${b.token}` };
    let response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers,
      payload: { name: 'A', environmentId: 'cozy' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const room = response.json().room;
    for (const method of ['PATCH', 'DELETE'] as const) {
      response = await app.inject({
        method,
        url: `/api/rooms/${room.id}`,
        headers: other,
        ...(method === 'PATCH'
          ? { payload: { name: 'Stolen', expectedRevision: 1 } }
          : {}),
      });
      assert.equal(
        response.statusCode,
        method === 'DELETE' ? 404 : 403,
        response.body,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/rooms/${room.id}`,
          headers,
          payload: {
            environmentId: 'https://evil.example/scene',
            expectedRevision: 1,
          },
        })
      ).statusCode,
      400,
    );
    response = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room.id}`,
      headers,
      payload: { name: 'Renamed', joinPolicy: 'closed', expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().room.revision, 2);
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/rooms/${room.id}`,
          headers,
          payload: { name: 'Stale', expectedRevision: 1 },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ url: `/api/rooms/${room.id}/bans`, headers: other }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/rooms/${room.id}/bans`,
          headers: other,
          payload: { userId: visitor.guest.id },
        })
      ).statusCode,
      403,
    );
    response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/bans`,
      headers,
      payload: { userId: visitor.guest.id },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().bans[0].userId, visitor.guest.id);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/rooms/${room.id}/bans/${visitor.guest.id}`,
          headers: other,
        })
      ).statusCode,
      403,
    );
    response = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room.id}/bans/${visitor.guest.id}`,
      headers,
    });
    assert.deepEqual(response.json().bans, []);
    const directory = await app.inject('/api/rooms?offset=0&limit=24');
    assert.equal(directory.json().total, 1);
    assert.equal(directory.json().rooms[0].name, 'Renamed');
    assert.doesNotMatch(
      directory.body,
      /private@example|email|token|playlist|users/,
    );
    assert.deepEqual(
      (await app.inject('/api/rooms?offset=1&limit=24')).json(),
      { rooms: [], total: 1 },
    );
    assert.equal((await app.inject('/api/rooms?limit=1000')).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/rooms/${room.id}`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal((await app.inject(`/api/rooms/${room.id}`)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('public directory filters live room state before pagination and combines it with ownership', async () => {
  const { app, db, registry } = await createServer({
    dbPath: ':memory:',
    music,
  });
  try {
    const listener = db.createGuest('Listener'),
      dj = db.createGuest('DJ'),
      visitor = db.createGuest('Visitor'),
      emptyOwner = db.createGuest('EmptyOwner'),
      otherOwner = db.createGuest('OtherOwner');
    const occupied = db.createRoom(listener.guest.id, 'Occupied', 'cozy'),
      playing = db.createRoom(dj.guest.id, 'Playing', 'cozy'),
      empty = db.createRoom(emptyOwner.guest.id, 'Empty', 'cozy'),
      otherEmpty = db.createRoom(otherOwner.guest.id, 'OtherEmpty', 'cozy');
    enterDirectoryRoom(registry, occupied.id, listener.guest);
    enterDirectoryRoom(registry, occupied.id, visitor.guest);
    const { room, socketId } = enterDirectoryRoom(
      registry,
      playing.id,
      dj.guest,
    );
    const directory = async (query = '', token?: string) => {
      const response = await app.inject({
        url: `/api/rooms${query ? `?${query}` : ''}`,
        headers: token ? { cookie: `loop_guest=${token}` } : undefined,
      });
      assert.equal(response.statusCode, 200, response.body);
      const { rooms, total } = response.json<{
        rooms: RoomSummary[];
        total: number;
      }>();
      return { ids: rooms.map(({ id }) => id), total };
    };

    assert.deepEqual(await directory('filter=playing'), { ids: [], total: 0 });
    db.add(dj.guest.id, track('1'));
    await room.join(dj.guest.id, socketId);

    const all = await directory();
    assert.equal(all.total, 4);
    assert.deepEqual(all.ids.slice(0, 2), [playing.id, occupied.id]);
    const emptyIds = all.ids.slice(2);
    assert.deepEqual(new Set(emptyIds), new Set([empty.id, otherEmpty.id]));
    assert.deepEqual(await directory('filter=all'), all);
    assert.deepEqual(await directory('limit=1'), {
      ids: [playing.id],
      total: 4,
    });
    assert.deepEqual(await directory('filter=playing&limit=1'), {
      ids: [playing.id],
      total: 1,
    });
    assert.deepEqual(await directory('filter=occupied'), {
      ids: [playing.id, occupied.id],
      total: 2,
    });
    assert.deepEqual(await directory('filter=empty&limit=1'), {
      ids: emptyIds.slice(0, 1),
      total: 2,
    });
    assert.deepEqual(await directory('filter=empty&limit=1&offset=1'), {
      ids: emptyIds.slice(1),
      total: 2,
    });
    assert.deepEqual(await directory('owner=me&filter=playing', dj.token), {
      ids: [playing.id],
      total: 1,
    });
    assert.deepEqual(await directory('owner=me&filter=empty', dj.token), {
      ids: [],
      total: 0,
    });
    assert.equal(
      (await app.inject('/api/rooms?owner=me&filter=empty')).statusCode,
      401,
    );
    for (const filter of ['unknown', '', 'playing&filter=occupied'])
      assert.equal(
        (await app.inject(`/api/rooms?filter=${filter}`)).statusCode,
        400,
      );

    await room.leave(dj.guest.id, socketId);
    assert.deepEqual(await directory('filter=playing'), { ids: [], total: 0 });
    assert.deepEqual(await directory('owner=me&filter=occupied', dj.token), {
      ids: [playing.id],
      total: 1,
    });
    registry.leave(playing.id, dj.guest.id, socketId);
    assert.deepEqual(await directory('owner=me&filter=empty', dj.token), {
      ids: [playing.id],
      total: 1,
    });
  } finally {
    await app.close();
  }
});

test('directory pages keep recent playback order after rooms empty and ignore failed or pending playback', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let finishInvalid!: (result: { url: string; durationMs: number }) => void;
  const { app, db, registry } = await createServer({
    dbPath: ':memory:',
    music: {
      ...music,
      resolve: (item) =>
        item.id === 'invalid'
          ? new Promise((done) => {
              finishInvalid = done;
            })
          : music.resolve(item),
    },
  });
  try {
    const makeRoom = (name: string) => {
      context.mock.timers.tick(1);
      const { guest } = db.createGuest(name);
      return { guest, id: db.createRoom(guest.id, name, 'cozy').id };
    };
    const active = makeRoom('Active');
    const newer = makeRoom('Newer');
    const older = makeRoom('Older');
    const invalid = makeRoom('Invalid');
    const emptyIds = Array.from(
      { length: 8 },
      (_, i) => makeRoom(`Empty${i}`).id,
    );
    enterDirectoryRoom(registry, active.id, active.guest);
    enterDirectoryRoom(registry, active.id, db.createGuest('Listener').guest);
    const olderSession = enterDirectoryRoom(registry, older.id, older.guest);
    const newerSession = enterDirectoryRoom(registry, newer.id, newer.guest);
    const invalidSession = enterDirectoryRoom(
      registry,
      invalid.id,
      invalid.guest,
    );
    const lastPlayed = (roomId: string) =>
      db.roomsForDirectory().find(({ id }) => id === roomId)?.lastPlayedAt;

    const cover = 'https://example.com/older.jpg';
    db.add(older.guest.id, { ...track('older'), cover });
    await olderSession.room.join(older.guest.id, olderSession.socketId);
    context.mock.timers.tick(100);
    db.add(newer.guest.id, track('newer'));
    await newerSession.room.join(newer.guest.id, newerSession.socketId);
    assert.equal(newerSession.room.snapshot().playback?.startedAt, Date.now());
    assert.equal(lastPlayed(newer.id), Date.now());
    registry.leave(newer.id, newer.guest.id, newerSession.socketId);

    const list = async (query = '') => {
      const response = await app.inject(`/api/rooms${query}`);
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json<{ rooms: RoomSummary[]; total: number }>();
      assert.ok(result.rooms.every((room) => !('lastPlayedAt' in room)));
      return result;
    };
    const expectedIds = [
      newer.id,
      older.id,
      active.id,
      invalid.id,
      ...emptyIds,
    ];
    const first = await list();
    assert.equal(first.total, 12);
    assert.deepEqual(
      first.rooms.map(({ id }) => id),
      expectedIds.slice(0, 9),
    );
    assert.equal(first.rooms[0]!.online, 0);
    assert.equal(first.rooms[0]!.trackTitle, undefined);
    assert.equal(first.rooms[0]!.trackCover, undefined);
    const second = await list('?offset=9');
    assert.equal(second.total, 12);
    assert.deepEqual(
      second.rooms.map(({ id }) => id),
      expectedIds.slice(9),
    );
    const playing = await list('?filter=playing&limit=1');
    assert.equal(playing.total, 1);
    assert.equal(playing.rooms[0]!.id, older.id);
    assert.equal(playing.rooms[0]!.trackCover, cover);
    const empty = await list('?filter=empty&limit=2');
    assert.equal(empty.total, 9);
    assert.deepEqual(
      empty.rooms.map(({ id }) => id),
      [newer.id, emptyIds[0]],
    );

    context.mock.timers.tick(100);
    db.add(invalid.guest.id, track('invalid'));
    const join = invalidSession.room.join(
      invalid.guest.id,
      invalidSession.socketId,
    );
    await tick();
    assert.equal(invalidSession.room.snapshot().resolving, true);
    assert.equal(lastPlayed(invalid.id), null);
    assert.deepEqual(await list(), first);
    finishInvalid({ url: 'ftp://example.com/invalid', durationMs: 60_000 });
    await join;
    assert.equal(invalidSession.room.snapshot().playback, null);
    assert.equal(lastPlayed(invalid.id), null);
    assert.deepEqual(await list(), first);
  } finally {
    await app.close();
  }
});

test('owners can inspect and moderate a full room from the lobby; owner filter finds rooms outside the first page', async () => {
  const { app, db, registry } = await createServer({ dbPath: ':memory:' });
  try {
    const owner = db.createGuest('Owner'),
      other = db.createGuest('Other');
    const owned = db.createRoom(owner.guest.id, 'Owned', 'cozy');
    for (let i = 0; i < 25; i++) {
      const user = db.createGuest(`Owner${i}`);
      db.createRoom(user.guest.id, `Room${i}`, 'cozy');
    }
    const headers = { cookie: `loop_guest=${owner.token}` },
      otherHeaders = { cookie: `loop_guest=${other.token}` };
    assert.equal((await app.inject('/api/rooms?owner=me')).statusCode, 401);
    const own = (
      await app.inject({ url: '/api/rooms?owner=me', headers })
    ).json();
    assert.equal(own.total, 1);
    assert.equal(own.rooms[0].id, owned.id);
    assert.equal(
      (
        await app.inject({
          url: `/api/rooms/${owned.id}/members`,
          headers: otherHeaders,
        })
      ).statusCode,
      403,
    );
    assert.deepEqual(
      (
        await app.inject({ url: `/api/rooms/${owned.id}/members`, headers })
      ).json(),
      { users: [] },
    );
    const peers: Array<{ id: string; disconnected: boolean }> = [];
    const enter = (guest: Guest) => {
      const peer = {
        id: `member-${peers.length}`,
        disconnected: false,
        join: () => {},
        leave: () => {},
        emit: () => {},
        disconnect() {
          this.disconnected = true;
          registry.disconnect(owned.id, guest.id, this.id);
        },
      };
      peers.push(peer);
      return registry.connect(
        owned.id,
        guest,
        peer as unknown as Socket,
        'hash',
      );
    };
    // The owner is not inside this completely occupied room.
    let target: Guest | undefined;
    for (let i = 0; i < 30; i++) {
      const guest = db.createGuest(`Member${i}`).guest;
      enter(guest);
      target = guest;
    }
    assert.throws(() => registry.admit(owned.id, owner.guest.id), /已满/);
    const members = (
      await app.inject({ url: `/api/rooms/${owned.id}/members`, headers })
    ).json().users;
    assert.equal(members.length, 30);
    for (const action of ['kick', 'leave-stage'])
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/rooms/${owned.id}/members/${target!.id}/${action}`,
            headers: otherHeaders,
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/rooms/${owned.id}/members/${target!.id}/leave-stage`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/rooms/${owned.id}/members/${target!.id}/kick`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(peers.at(-1)!.disconnected, true);
    assert.equal(registry.members(owned.id, owner.guest.id).length, 29);
    assert.doesNotThrow(() => registry.admit(owned.id, owner.guest.id));
  } finally {
    await app.close();
  }
});

test('one member grace expiry removes its registry session while other members keep the room active', async () => {
  const f = fixture(music, 15);
  try {
    const owner = f.open(f.a.id, f.ownerA);
    const guest = f.db.createGuest('Visitor').guest;
    const visitor = f.open(f.a.id, guest);
    visitor.peer.disconnect();
    await delay(25);
    assert.equal(f.registry.runtimeCount(), 1);
    assert.deepEqual(
      owner.room.snapshot().users.map((user) => user.id),
      [f.ownerA.id],
    );
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, owner.socket.id));
    const published = f.events.length;
    // A stale active entry would cause revoke to remove a nonexistent member and
    // publish another snapshot. Expired sessions must already be forgotten.
    f.registry.revoke(guest.id);
    assert.equal(f.events.length, published);
    assert.equal(
      visitor.emitted.filter((event) => event.event === 'room:removed').length,
      0,
    );
    assert.ok(f.registry.isCurrent(f.a.id, f.ownerA.id, owner.socket.id));
  } finally {
    f.close();
  }
});

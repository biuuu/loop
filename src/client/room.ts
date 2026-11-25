import { useTimedMessage } from './timed-message';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { createMovementScheduler } from './movement-scheduler';
import { createLocalMovement } from './local-movement';
import { createRoomEmotes } from './room-emotes';
import { emoteCatalog, emoteUrl, loadEmoteCatalog } from './emote-catalog';
import { createPlaylistReceiver, swapPlaylistTracks } from './playlist-view';
import type { Direction } from './keyboard-movement';
import type { CatAppearance } from '../shared/appearance';
import { stageSeatXs } from '../shared/contracts';
import type {
  AccountProfile,
  Track,
  PlaylistState,
  PlaylistImportResult,
  RoomSnapshot,
  ServerEvents,
  ClientEvents,
  Ack,
  EmoteId,
  ClientMotion,
  Participant,
  PlaybackState,
  RoomInfo,
  StageJoin,
} from '../shared/contracts';

export function applyPlaybackUpdate(
  current: RoomSnapshot,
  state: PlaybackState,
): RoomSnapshot {
  let { stage, users } = current;
  const order = state.stage;
  // A rotation may reorder the same DJs. Only a full snapshot can change membership.
  if (
    Array.isArray(order) &&
    order.length === stage.length &&
    order.length <= current.stageCapacity &&
    new Set(order).size === order.length &&
    order.every((id) => stage.includes(id)) &&
    order.some((id, index) => id !== stage[index])
  ) {
    const positions = stageSeatXs(current.stageCapacity);
    users = users.map((user) => {
      const seat = order.indexOf(user.id);
      if (seat < 0 || user.seat === seat) return user;
      const x = positions[seat]!;
      return { ...user, seat, x, targetX: x };
    });
    stage = order;
  }
  return {
    ...current,
    stage,
    users,
    revision: state.revision,
    serverTime: state.serverTime,
    playback: state.playback,
    resolving: state.resolving,
    notice: state.notice,
  };
}

class NicknameChangeCooldownError extends Error {
  constructor(
    message: string,
    readonly availableAt: number,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data.error || '请求失败，请稍后重试';
    if (
      response.status === 429 &&
      Number.isSafeInteger(data.nicknameChangeAvailableAt)
    )
      throw new NicknameChangeCooldownError(
        message,
        data.nicknameChangeAvailableAt,
      );
    throw new Error(message);
  }
  return data as T;
}
export const useRoom = defineStore('room', () => {
  const guest = ref<AccountProfile | null>(null);
  const playlistState = ref<PlaylistState | null>(null);
  const playlist = computed(() => playlistState.value?.tracks ?? []);
  const playlistRevision = computed(() => playlistState.value?.revision ?? -1);
  const playlistSlot = computed(() => playlistState.value?.slot);
  const playlistReceiver = createPlaylistReceiver((state) => {
    playlistState.value = state;
  });
  const snapshot = ref<RoomSnapshot | null>(null);
  const connection = ref('idle');
  const roomId = ref<string | null>(null);
  const roomInfo = ref<RoomInfo | null>(null);
  const emailEnabled = ref(false);
  const entering = ref(false);
  let candidate: Socket<ServerEvents, ClientEvents> | null = null;
  let entryGeneration = 0;
  const roomGeneration = ref(0);
  let cancelEntry: (() => void) | null = null;
  const stagePending = ref(false);
  const error = useTimedMessage();
  const offset = ref(0);
  let socket: Socket<ServerEvents, ClientEvents> | null = null;
  let clockSamples: { time: number; rtt: number; offset: number }[] = [];
  let identityRequest = 0;
  let authRequest = 0;
  const localEmotes = createRoomEmotes();
  let emoteGeneration = 0;
  let pendingSync: object | null = null;
  let pendingPlaylistReload: object | null = null;
  function resetTransientState() {
    pendingSync = null;
    pendingPlaylistReload = null;
    stagePending.value = false;
    emoteGeneration++;
    localEmotes.clear();
  }
  function emoteFor(userId: string, now = Date.now()) {
    return localEmotes.get(userId, now);
  }
  function setGuest(value: AccountProfile | null) {
    if (playlistReceiver.setIdentity(value?.id ?? null)) {
      resetTransientState();
      playlistState.value = null;
      snapshot.value = null;
    }
    guest.value = value;
  }
  function applyPlaylist(
    state: PlaylistState,
    context: ReturnType<typeof playlistReceiver.context>,
  ) {
    playlistReceiver.receive(state, context);
  }
  const me = computed(() =>
    snapshot.value?.users.find((user) => user.id === guest.value?.id),
  );
  const onStage = computed(() => me.value?.seat != null);
  const canSeek = computed(
    () =>
      connection.value === 'connected' &&
      !!guest.value &&
      snapshot.value?.playback?.djId === guest.value.id,
  );
  let movementGeneration = 0;
  const localMovement = createLocalMovement();
  function movementContext() {
    return socket?.connected &&
      connection.value === 'connected' &&
      guest.value &&
      me.value?.connected &&
      !onStage.value &&
      !stagePending.value
      ? `${movementGeneration}:${socket.id}:${guest.value.id}`
      : undefined;
  }
  const movement = createMovementScheduler<ClientMotion>({
    context: movementContext,
    now: () => Date.now() + offset.value,
    send: (report) => {
      const context = movementContext();
      socket?.emit('room:motion', report, (result) => {
        if (result.ok || context !== movementContext()) return;
        if (localMovement.reject(report.clientMoveId)) {
          movement.cancel();
          ack(result);
        }
      });
    },
  });
  function cancelMovement() {
    movement.cancel();
  }
  function invalidateMovement() {
    movementGeneration++;
    cancelMovement();
    localMovement.reset();
  }
  function flushMovement() {
    movement.flush();
  }
  function renderParticipant(user: Participant, now: number): Participant {
    return user.id === guest.value?.id &&
      user.seat === null &&
      user.connected &&
      connection.value === 'connected'
      ? localMovement.view(user, now)
      : user;
  }
  function reportMovement() {
    movement.schedule(() => localMovement.report(Date.now() + offset.value));
  }
  function matchesRoom(state: { roomId?: string }) {
    return !state.roomId || state.roomId === roomId.value;
  }
  function receive(state: RoomSnapshot) {
    if (!matchesRoom(state)) return;
    // Metadata has its own revision: a delayed room:sync may predate a live
    // environment edit even when its movement/playback snapshot is still valid.
    if (
      state.room &&
      (!roomInfo.value || state.room.revision >= roomInfo.value.revision)
    )
      roomInfo.value = state.room;
    if (!snapshot.value || state.revision >= snapshot.value.revision) {
      snapshot.value = state;
      localEmotes.retain(
        state.users.filter((user) => user.connected).map((user) => user.id),
      );
      const own = state.users.find((user) => user.id === guest.value?.id);
      if (!own?.connected || own.seat !== null) invalidateMovement();
      if (guest.value && own)
        guest.value = {
          ...guest.value,
          nickname: own.nickname,
          appearance: own.appearance ?? guest.value.appearance,
        };
    }
  }
  function sync() {
    if (!socket?.connected || pendingSync) return;
    const pending = {};
    pendingSync = pending;
    const active = socket;
    const generation = emoteGeneration;
    const identity = identityRequest;
    const start = Date.now();
    socket
      .timeout(8000)
      .emit('room:sync', (err: Error | null, state: RoomSnapshot) => {
        if (pendingSync !== pending) return;
        pendingSync = null;
        if (
          socket !== active ||
          !active.connected ||
          connection.value !== 'connected' ||
          generation !== emoteGeneration ||
          identity !== identityRequest ||
          err ||
          !state ||
          !matchesRoom(state)
        )
          return;
        const end = Date.now();
        // A busy rendering frame can delay one ack. Use the quickest recent
        // round trip so that a slow sample cannot move everybody's playhead.
        clockSamples = clockSamples
          .filter((sample) => end - sample.time < 30_000)
          .slice(-4);
        clockSamples.push({
          time: end,
          rtt: end - start,
          offset: state.serverTime - (start + end) / 2,
        });
        offset.value = clockSamples.reduce((best, sample) =>
          sample.rtt < best.rtt ? sample : best,
        ).offset;
        receive(state);
      });
  }
  function cancelPendingEntry() {
    entryGeneration++;
    cancelEntry?.();
    cancelEntry = null;
    candidate = null;
    entering.value = false;
    if (!socket) connection.value = 'idle';
  }
  function connect(targetRoomId?: string): Promise<boolean> {
    const target = targetRoomId ?? roomId.value ?? undefined;
    const generation = ++entryGeneration;
    cancelEntry?.();
    const next = io({
      autoConnect: false,
      auth: target ? { roomId: target } : {},
    });
    candidate = next;
    entering.value = true;
    if (!socket) connection.value = 'connecting';
    const active = next;
    const identity = identityRequest;
    const guestId = guest.value?.id;
    const isActive = () =>
      socket === active &&
      identity === identityRequest &&
      guestId === guest.value?.id;
    let settle!: (value: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    let admitted = false;
    const entryTimer = setTimeout(() => {
      if (candidate !== active || generation !== entryGeneration) return;
      candidate = null;
      entering.value = false;
      active.disconnect();
      if (!socket) connection.value = 'disconnected';
      error.value = '进入房间超时，请重试';
      cancelEntry = null;
      settle(false);
    }, 10000);
    cancelEntry = () => {
      clearTimeout(entryTimer);
      active.removeAllListeners();
      active.disconnect();
      if (candidate === active) {
        candidate = null;
        entering.value = false;
      }
      settle(false);
    };
    let playlistContext = playlistReceiver.context();
    active.on('connect', () => {
      if (!admitted) {
        if (
          candidate !== active ||
          generation !== entryGeneration ||
          identity !== identityRequest ||
          guestId !== guest.value?.id
        ) {
          clearTimeout(entryTimer);
          active.disconnect();
          settle(false);
          return;
        }
        admitted = true;
        clearTimeout(entryTimer);
        cancelEntry = null;
        snapshot.value = null;
        roomGeneration.value++;
        const previous = socket;
        socket = active;
        candidate = null;
        entering.value = false;
        previous?.removeAllListeners();
        previous?.disconnect();
        roomId.value = target ?? null;
        roomInfo.value = null;
        error.value = '';
      }
      if (!isActive()) return;
      void loadEmoteCatalog(true).catch(() => {});
      resetTransientState();
      playlistReceiver.renewConnection();
      playlistContext = playlistReceiver.context();
      invalidateMovement();
      clockSamples = [];
      offset.value = 0;
      connection.value = 'connected';
      snapshot.value = null;
      sync();
      settle(true);
    });
    active.on('disconnect', () => {
      if (!isActive()) return;
      resetTransientState();
      playlistReceiver.renewConnection();
      invalidateMovement();
      stagePending.value = false;
      if (connection.value !== 'replaced') connection.value = 'disconnected';
    });
    active.on('connect_error', (err) => {
      if (!admitted && candidate === active && generation === entryGeneration) {
        cancelEntry?.();
        cancelEntry = null;
        if (!socket) connection.value = 'disconnected';
        error.value = err.message || '无法进入房间';
        settle(false);
        return;
      }
      if (!isActive()) return;
      resetTransientState();
      invalidateMovement();
      connection.value = 'disconnected';
      error.value = err.message || '连接失败';
    });
    active.on('room:snapshot', (state) => {
      if (isActive() && active.connected && connection.value === 'connected')
        receive(state);
    });
    active.on('room:motion', (state) => {
      if (
        !isActive() ||
        !matchesRoom(state) ||
        !active.connected ||
        connection.value !== 'connected' ||
        !snapshot.value ||
        state.revision < snapshot.value.revision
      )
        return;
      const index = snapshot.value.users.findIndex(
        (user) =>
          user.id === state.userId && user.connected && user.seat === null,
      );
      if (index < 0) return;
      const users = [...snapshot.value.users];
      const user = {
        ...users[index]!,
        x: state.x,
        y: state.y,
        targetX: state.targetX,
        targetY: state.targetY,
        movingSince: state.movingSince,
        durationMs: state.durationMs,
        facingRight: state.facingRight,
      };
      // Legacy move/stop commands have no prediction marker. Do not retain one
      // from an earlier report, or it could acknowledge unrelated local input.
      delete user.clientMoveId;
      if (state.clientMoveId !== undefined)
        user.clientMoveId = state.clientMoveId;
      users[index] = user;
      snapshot.value = {
        ...snapshot.value,
        users,
        revision: state.revision,
        serverTime: state.serverTime,
      };
    });
    active.on('playback:updated', (state) => {
      if (
        !isActive() ||
        !matchesRoom(state) ||
        !active.connected ||
        connection.value !== 'connected' ||
        !snapshot.value ||
        state.revision < snapshot.value.revision
      )
        return;
      snapshot.value = applyPlaybackUpdate(snapshot.value, state);
    });
    active.on('room:emote', (event) => {
      if (
        !matchesRoom(event) ||
        !isActive() ||
        !active.connected ||
        connection.value !== 'connected' ||
        !guest.value ||
        !me.value?.connected ||
        !snapshot.value?.users.some(
          (user) => user.id === event?.userId && user.connected,
        )
      )
        return;
      localEmotes.receive(event, Date.now(), emoteUrl(event.id));
    });
    active.on('emotes:updated', (event) => {
      if (isActive() && event.revision !== emoteCatalog.value?.revision)
        void loadEmoteCatalog(true).catch(() => {});
    });
    active.on('playlist:updated', (state) => {
      if (isActive()) applyPlaylist(state, playlistContext);
    });
    active.on('playlist:reordered', (order) => {
      if (!isActive() || !active.connected || connection.value !== 'connected')
        return;
      const context = playlistContext;
      if (playlistReceiver.receiveOrder(order, context) !== 'reload') return;
      if (pendingPlaylistReload) return;
      const pending = {};
      pendingPlaylistReload = pending;
      const isCurrent = () =>
        pendingPlaylistReload === pending &&
        isActive() &&
        active.connected &&
        connection.value === 'connected' &&
        context.identity === playlistReceiver.context().identity &&
        context.connection === playlistReceiver.context().connection;
      void (async () => {
        try {
          let previousRevision = -1;
          while (isCurrent() && playlistReceiver.needsReload(context)) {
            const state = await request<PlaylistState>('/api/playlist');
            if (!isCurrent()) return;
            if (
              !Number.isSafeInteger(state.revision) ||
              state.revision < 0 ||
              state.revision <= previousRevision
            )
              throw new Error('歌单同步失败，请稍后重试');
            previousRevision = state.revision;
            applyPlaylist(state, context);
          }
        } catch (cause) {
          if (isCurrent())
            error.value =
              cause instanceof Error
                ? cause.message
                : '歌单同步失败，请稍后重试';
        } finally {
          if (pendingPlaylistReload === pending) pendingPlaylistReload = null;
        }
      })();
    });
    active.on('room:updated', (info) => {
      if (
        isActive() &&
        info.id === roomId.value &&
        (!roomInfo.value || info.revision >= roomInfo.value.revision)
      )
        roomInfo.value = info;
    });
    active.on('room:removed', (event) => {
      if (!isActive() || !matchesRoom(event)) return;
      close();
      error.value =
        event.reason === 'deleted'
          ? '房间已被删除'
          : event.reason === 'banned'
            ? '你已被房主封禁，无法进入此房间'
            : event.reason || '你已被移出房间';
    });
    active.on('room:replaced', () => {
      if (!isActive() || candidate) return;
      resetTransientState();
      invalidateMovement();
      connection.value = 'replaced';
      socket?.disconnect();
      snapshot.value = null;
    });
    active.connect();
    return result;
  }
  function ack(result: Ack) {
    if (!result.ok) error.value = result.error || '操作失败';
  }
  function move(x: number, y: number) {
    if (!movementContext() || !me.value) return;
    localMovement.move(me.value, { x, y }, Date.now() + offset.value);
    reportMovement();
  }
  function moveDirection(direction: Direction) {
    if (!movementContext() || !me.value) return;
    localMovement.direction(me.value, direction, Date.now() + offset.value);
    reportMovement();
  }
  function stopMovement() {
    if (!movementContext() || !me.value) return;
    localMovement.stop(me.value, Date.now() + offset.value);
    reportMovement();
    movement.flush();
  }
  function emote(id: EmoteId) {
    if (
      !socket?.connected ||
      connection.value !== 'connected' ||
      !guest.value ||
      !me.value?.connected
    )
      return;
    const active = socket;
    const identity = identityRequest;
    const guestId = guest.value.id;
    const generation = emoteGeneration;
    active.emit('room:emote', { id }, (result) => {
      if (
        socket === active &&
        active.connected &&
        connection.value === 'connected' &&
        identity === identityRequest &&
        guest.value?.id === guestId &&
        generation === emoteGeneration
      )
        ack(result);
    });
  }
  function stageAction(event: 'stage:join' | 'stage:leave'): Promise<boolean> {
    if (!socket?.connected || stagePending.value) return Promise.resolve(false);
    const own = me.value;
    const stoppedForJoin =
      event === 'stage:join' && own != null && !!movementContext();
    const join: StageJoin = {};
    if (stoppedForJoin) {
      // Include the local stop in the join so the server remembers the floor position.
      const now = Date.now() + offset.value;
      localMovement.stop(own, now);
      const { x, y } = localMovement.view(own, now);
      join.from = { x, y };
    }
    if (event === 'stage:leave') flushMovement();
    movementGeneration++;
    cancelMovement();
    const active = socket;
    const generation = emoteGeneration;
    const identity = identityRequest;
    const guestId = guest.value?.id;
    const stoppedGeneration = movementGeneration;
    stagePending.value = true;
    return new Promise((resolve) => {
      let settled = false;
      const finished = (err: Error | null, result: Ack) => {
        if (settled) return;
        settled = true;
        if (
          socket !== active ||
          !active.connected ||
          connection.value !== 'connected' ||
          generation !== emoteGeneration ||
          identity !== identityRequest ||
          guestId !== guest.value?.id
        ) {
          resolve(false);
          return;
        }
        stagePending.value = false;
        if (
          (err || !result?.ok) &&
          stoppedForJoin &&
          stoppedGeneration === movementGeneration &&
          movementContext()
        ) {
          // A rejected/timed-out join leaves this cat on the floor. Publish its
          // stopped segment once so other clients do not keep it walking.
          reportMovement();
          flushMovement();
        }
        if (err) error.value = '操作尚未确认，请等待房间状态更新';
        else ack(result);
        resolve(!err && !!result?.ok);
      };
      if (event === 'stage:join')
        active.timeout(75000).emit(event, join, finished);
      else active.timeout(75000).emit(event, {}, finished);
    });
  }
  function joinStage() {
    if (onStage.value) return Promise.resolve(false);
    return stageAction('stage:join');
  }
  function leaveStage() {
    if (!onStage.value) return Promise.resolve(false);
    return stageAction('stage:leave');
  }
  function skip() {
    const active = socket;
    const generation = emoteGeneration;
    if (snapshot.value?.playback)
      active?.emit(
        'playback:skip',
        { roundId: snapshot.value.playback.roundId },
        (result) => {
          if (socket === active && generation === emoteGeneration) ack(result);
        },
      );
  }
  function reportPlaybackFailure(roundId: string) {
    if (
      !socket?.connected ||
      !canSeek.value ||
      snapshot.value?.playback?.roundId !== roundId
    )
      return false;
    socket.emit('playback:failed', { roundId });
    return true;
  }
  async function seek(roundId: string, positionMs: number) {
    const active = socket;
    const playback = snapshot.value?.playback;
    if (
      !active?.connected ||
      !canSeek.value ||
      playback?.roundId !== roundId ||
      !Number.isFinite(positionMs)
    )
      return;
    const target = Math.min(positionMs, playback.durationMs);
    if (target <= Math.max(0, Date.now() + offset.value - playback.startedAt))
      return;
    const generation = emoteGeneration;
    await new Promise<void>((resolve) => {
      active
        .timeout(5000)
        .emit(
          'playback:seek',
          { roundId, positionMs: target },
          (err, result) => {
            if (
              socket === active &&
              active.connected &&
              canSeek.value &&
              generation === emoteGeneration &&
              snapshot.value?.playback?.roundId === roundId
            ) {
              if (err) error.value = '进度调整尚未确认，请等待房间状态更新';
              else ack(result);
            }
            resolve();
          },
        );
    });
  }
  async function loadPlaylist() {
    const context = playlistReceiver.context();
    applyPlaylist(await request<PlaylistState>('/api/playlist'), context);
  }
  function playlistPath(path = '/api/playlist') {
    const slot = playlistSlot.value;
    return slot === undefined ? path : `${path}?slot=${slot}`;
  }
  async function selectPlaylist(slot: number) {
    if (slot === playlistSlot.value) return;
    const context = playlistReceiver.context();
    applyPlaylist(
      await request<PlaylistState>('/api/playlists/active', {
        method: 'PUT',
        body: JSON.stringify({ slot }),
      }),
      context,
    );
  }
  async function initialize() {
    resetTransientState();
    invalidateMovement();
    const version = ++authRequest;
    const data = await request<{
      guest: AccountProfile | null;
      auth?: { emailEnabled: boolean };
    }>('/api/me');
    const value = data.guest;
    if (version !== authRequest) return;
    emailEnabled.value = !!data.auth?.emailEnabled;
    setGuest(value);
    if (guest.value) await loadPlaylist();
  }
  async function enter(nickname: string) {
    const version = ++authRequest;
    const data = await request<{
      guest: AccountProfile;
      createdRoom?: RoomInfo;
    }>('/api/guest', {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    });
    if (version !== authRequest) return;
    close();
    setGuest(data.guest);
    await loadPlaylist();
    if (version === authRequest && guest.value?.id === data.guest.id)
      return data.createdRoom;
  }
  async function enterFromNetease(
    userId: string,
    playlistId: string,
    nickname: string,
    playlistOffset: number,
  ) {
    const version = ++authRequest;
    const data = await request<{
      guest: AccountProfile;
      createdRoom: RoomInfo;
    }>('/api/guest/from-netease', {
      method: 'POST',
      body: JSON.stringify({ userId, playlistId, nickname, playlistOffset }),
    });
    if (version !== authRequest) return;
    close();
    setGuest(data.guest);
    await loadPlaylist();
    if (version === authRequest && guest.value?.id === data.guest.id)
      return data.createdRoom;
  }
  async function add(id: string) {
    const context = playlistReceiver.context();
    applyPlaylist(
      await request<PlaylistState>(playlistPath(), {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
      context,
    );
  }
  async function importPlaylist(
    playlistId: string,
    start: number,
    mode: 'replace' | 'append',
  ) {
    const context = playlistReceiver.context();
    const result = await request<PlaylistImportResult>(
      playlistPath('/api/playlist/import'),
      {
        method: 'POST',
        body: JSON.stringify({ playlistId, start, mode }),
      },
    );
    applyPlaylist(result, context);
    return result;
  }
  async function setAppearance(appearance: CatAppearance) {
    const version = authRequest;
    const data = await request<{ guest: AccountProfile }>(
      '/api/me/appearance',
      {
        method: 'PATCH',
        body: JSON.stringify(appearance),
      },
    );
    if (version === authRequest && guest.value?.id === data.guest.id)
      guest.value = { ...guest.value, appearance: data.guest.appearance };
  }
  async function setNickname(nickname: string): Promise<boolean> {
    const version = authRequest;
    const guestId = guest.value?.id;
    if (!guestId) return false;
    try {
      const data = await request<{ guest: AccountProfile }>(
        '/api/me/nickname',
        {
          method: 'PATCH',
          body: JSON.stringify({ nickname }),
        },
      );
      if (
        version !== authRequest ||
        guest.value?.id !== guestId ||
        data.guest.id !== guestId
      )
        return false;
      guest.value = {
        ...guest.value,
        nickname: data.guest.nickname,
        nicknameChangeAvailableAt: data.guest.nicknameChangeAvailableAt,
      };
      return true;
    } catch (cause) {
      if (version !== authRequest || guest.value?.id !== guestId) return false;
      if (cause instanceof NicknameChangeCooldownError)
        guest.value = {
          ...guest.value,
          nicknameChangeAvailableAt: cause.availableAt,
        };
      throw cause;
    }
  }
  async function remove(id: string) {
    const context = playlistReceiver.context();
    applyPlaylist(
      await request<PlaylistState>(playlistPath(`/api/playlist/${id}`), {
        method: 'DELETE',
      }),
      context,
    );
  }
  async function reorder(index: number, direction: number) {
    const other = index + direction;
    const first = playlist.value[index];
    const second = playlist.value[other];
    if (!first || !second) return;
    await reorderTracks(first.id, second.id);
  }
  async function reorderTracks(firstId: string, secondId: string) {
    const ids = swapPlaylistTracks(playlist.value, firstId, secondId);
    if (!ids) return;
    const context = playlistReceiver.context();
    applyPlaylist(
      await request<PlaylistState>(playlistPath('/api/playlist/order'), {
        method: 'PUT',
        body: JSON.stringify({ ids }),
      }),
      context,
    );
  }
  async function moveTrack(
    id: string,
    targetId: string | undefined,
    placement: 'before' | 'after' | 'first',
  ) {
    if (placement !== 'first' && id === targetId) return;
    const context = playlistReceiver.context();
    applyPlaylist(
      await request<PlaylistState>(playlistPath('/api/playlist/move'), {
        method: 'PUT',
        body: JSON.stringify({ id, targetId, placement }),
      }),
      context,
    );
  }
  async function moveTrackToTop(id: string) {
    await moveTrack(id, undefined, 'first');
  }
  async function authenticate(challengeId: string, code: string) {
    const version = ++authRequest;
    const data = await request<{ guest: AccountProfile }>(
      '/api/auth/email/verify',
      {
        method: 'POST',
        body: JSON.stringify({ challengeId, code }),
      },
    );
    if (version !== authRequest) return;
    close();
    setGuest(data.guest);
    error.value = '';
    await loadPlaylist();
  }
  async function logout(all = false) {
    authRequest++;
    await request(all ? '/api/auth/logout-all' : '/api/auth/logout', {
      method: 'POST',
    });
    close();
    setGuest(null);
  }
  function moderate(
    event: 'stage:remove' | 'member:kick',
    userId: string,
  ): Promise<boolean> {
    const active = socket;
    const generation = emoteGeneration;
    if (!active?.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      active
        .timeout(8000)
        .emit(event, { userId }, (err: Error | null, result: Ack) => {
          if (socket !== active || generation !== emoteGeneration)
            return resolve(false);
          if (err) error.value = '操作超时，请重试';
          else ack(result);
          resolve(!err && !!result?.ok);
        });
    });
  }
  async function leave() {
    const active = socket;
    socket = null;
    active?.removeAllListeners();
    // Stop audio and local controls immediately, even if a leave ack is lost.
    snapshot.value = null;
    roomInfo.value = null;
    roomId.value = null;
    roomGeneration.value++;
    resetTransientState();
    invalidateMovement();
    playlistReceiver.renewConnection();
    entryGeneration++;
    cancelEntry?.();
    cancelEntry = null;
    candidate = null;
    entering.value = false;
    offset.value = 0;
    clockSamples = [];
    connection.value = 'idle';
    if (active?.connected) {
      await new Promise<void>((resolve) =>
        active.timeout(3000).emit('room:leave', () => resolve()),
      );
    }
    active?.disconnect();
  }
  function close() {
    entryGeneration++;
    cancelEntry?.();
    cancelEntry = null;
    candidate = null;
    snapshot.value = null;
    roomGeneration.value++;
    entering.value = false;
    roomId.value = null;
    roomInfo.value = null;
    offset.value = 0;
    clockSamples = [];
    connection.value = 'idle';
    resetTransientState();
    invalidateMovement();
    identityRequest++;
    playlistReceiver.renewConnection();
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
  }
  return {
    guest,
    roomId,
    roomGeneration,
    roomInfo,
    emailEnabled,
    entering,
    authenticate,
    logout,
    moderate,
    leave,
    playlist,
    playlistRevision,
    playlistSlot,
    snapshot,
    connection,
    stagePending,
    error,
    offset,
    me,
    onStage,
    canSeek,
    initialize,
    enter,
    enterFromNetease,
    setAppearance,
    setNickname,
    connect,
    cancelPendingEntry,
    sync,
    move,
    moveDirection,
    stopMovement,
    cancelMovement,
    flushMovement,
    renderParticipant,
    emoteFor,
    emote,
    joinStage,
    leaveStage,
    skip,
    reportPlaybackFailure,
    seek,
    selectPlaylist,
    add,
    importPlaylist,
    remove,
    reorder,
    reorderTracks,
    moveTrack,
    moveTrackToTop,
    close,
  };
});

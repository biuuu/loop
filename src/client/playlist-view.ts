import {
  PLAYLIST_COUNT_LIMIT,
  type Playback,
  type PlaylistOrder,
  type PlaylistState,
  type Track,
} from '../shared/contracts';

export function playlistView(
  tracks: readonly Track[],
  guestId: string | undefined,
  playback: Playback | null | undefined,
) {
  const pinned = guestId && playback?.djId === guestId ? playback.track : null;
  return {
    pinned,
    queue: tracks.map((track, queueIndex) => ({ track, queueIndex })),
  };
}

// Swap actual queue entries by ID; the display-only pin is never inserted.
export function swapPlaylistTracks(
  tracks: readonly Track[],
  firstId: string,
  secondId: string,
): string[] | null {
  const first = tracks.findIndex((track) => track.id === firstId);
  const second = tracks.findIndex((track) => track.id === secondId);
  if (first < 0 || second < 0 || first === second) return null;
  const ids = tracks.map((track) => track.id);
  [ids[first], ids[second]] = [ids[second]!, ids[first]!];
  return ids;
}

interface PlaylistContext {
  identity: number;
  connection: number;
}

export function createPlaylistReceiver(
  accepted: (state: PlaylistState) => void,
) {
  let guestId: string | null = null;
  let identity = 0;
  let connection = 0;
  let revision = -1;
  let cached: PlaylistState | null = null;
  const isCurrent = (context: PlaylistContext) =>
    !!guestId &&
    context.identity === identity &&
    context.connection === connection;
  const acceptsRevision = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value >= revision;
  const validSlot = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= PLAYLIST_COUNT_LIMIT;
  return {
    setIdentity(id: string | null) {
      if (guestId === id) return false;
      guestId = id;
      identity++;
      revision = -1;
      cached = null;
      return true;
    },
    renewConnection() {
      connection++;
    },
    context(): PlaylistContext {
      return { identity, connection };
    },
    receive(state: PlaylistState, context: PlaylistContext) {
      if (
        !isCurrent(context) ||
        !acceptsRevision(state.revision) ||
        !validSlot(state.slot) ||
        !validSlot(state.count) ||
        state.slot > state.count
      )
        return false;
      revision = state.revision;
      cached = state;
      accepted(state);
      return true;
    },
    receiveOrder(
      order: PlaylistOrder,
      context: PlaylistContext,
    ): 'applied' | 'ignored' | 'reload' {
      if (
        !isCurrent(context) ||
        !acceptsRevision(order.revision) ||
        !validSlot(order.slot) ||
        !Array.isArray(order.ids) ||
        !order.ids.every((id) => typeof id === 'string') ||
        new Set(order.ids).size !== order.ids.length
      )
        return 'ignored';
      if (cached?.revision === order.revision && cached.slot !== order.slot)
        return 'ignored';
      // An order may arrive before the full state for an edit or switch. Keep
      // the last visible playlist until its active slot and metadata are known.
      revision = order.revision;
      if (!cached || cached.slot !== order.slot) return 'reload';
      const known = new Map(cached.tracks.map((track) => [track.id, track]));
      if (order.ids.some((id) => !known.has(id))) return 'reload';
      cached = {
        ...cached,
        tracks: order.ids.map((id) => known.get(id)!),
        revision: order.revision,
      };
      accepted(cached);
      return 'applied';
    },
    needsReload(context: PlaylistContext) {
      return isCurrent(context) && (!cached || cached.revision < revision);
    },
  };
}

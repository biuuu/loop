export interface PlaylistDrop {
  targetId: string;
  placement: 'before' | 'after';
}

export interface PlaylistRowBounds {
  id: string;
  top: number;
  bottom: number;
}

/** Resolve a pointer against the current, scrolled row geometry. */
export function playlistDropAt(
  rows: readonly PlaylistRowBounds[],
  clientY: number,
): PlaylistDrop | null {
  if (!rows.length || !Number.isFinite(clientY)) return null;
  const row = rows.find((row) => clientY < row.bottom) ?? rows[rows.length - 1];
  return {
    targetId: row.id,
    placement: clientY < (row.top + row.bottom) / 2 ? 'before' : 'after',
  };
}

/** Reject disappeared IDs and moves that would leave the queue unchanged. */
export function meaningfulPlaylistDrop(
  ids: readonly string[],
  sourceId: string,
  drop: PlaylistDrop | null,
): PlaylistDrop | null {
  if (!drop) return null;
  const from = ids.indexOf(sourceId);
  const target = ids.indexOf(drop.targetId);
  if (from < 0 || target < 0 || from === target) return null;
  const destination = target + (drop.placement === 'after' ? 1 : 0);
  if (destination === from || destination === from + 1) return null;
  return drop;
}

export function keyboardPlaylistDrop(
  ids: readonly string[],
  sourceId: string,
  destination: number,
): PlaylistDrop | null {
  const from = ids.indexOf(sourceId);
  if (from < 0 || !Number.isInteger(destination)) return null;
  const targetId = ids[destination];
  if (targetId === undefined) return null;
  return meaningfulPlaylistDrop(ids, sourceId, {
    targetId,
    placement: destination < from ? 'before' : 'after',
  });
}

export function playlistSequenceMatches(
  before: readonly string[],
  current: readonly string[],
): boolean {
  return (
    before.length === current.length &&
    before.every((id, i) => id === current[i])
  );
}

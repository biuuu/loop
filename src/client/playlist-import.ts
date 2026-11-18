import { PLAYLIST_LIMIT } from '../shared/contracts';

export function playlistImportPreview(
  value: number | string,
  total: number,
  currentCount: number,
) {
  const start = typeof value === 'number' ? value : Number(value.trim());
  const valid = Number.isSafeInteger(start) && start >= 1 && start <= total;
  const remaining = Math.max(0, PLAYLIST_LIMIT - currentCount);
  return {
    valid,
    start,
    end: valid ? Math.min(total, start + PLAYLIST_LIMIT - 1) : null,
    remaining,
    canImport: valid && remaining > 0,
  };
}

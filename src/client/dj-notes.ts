import type { Playback } from '../shared/contracts';

type NotePlayback = Pick<
  Playback,
  'djId' | 'roundId' | 'startedAt' | 'durationMs'
>;

export const DJ_NOTE_COUNT = 4;
export const DJ_NOTE_LIFETIME_MS = 2400;
export const DJ_NOTE_STAGGER_MS = DJ_NOTE_LIFETIME_MS / DJ_NOTE_COUNT;
export const MUSIC_NOTE_COLORS = [0xb29458, 0x72938a, 0xb7806b] as const;

// Follow the shared song timeline, independent of local audio/autoplay state.
export function activeDjPlayback<T extends NotePlayback>(
  userId: string,
  playback: T | null | undefined,
  now: number,
): T | null {
  if (
    !playback ||
    playback.djId !== userId ||
    !Number.isFinite(now) ||
    !Number.isFinite(playback.startedAt) ||
    !Number.isFinite(playback.durationMs) ||
    playback.durationMs <= 0
  )
    return null;
  const elapsed = now - playback.startedAt;
  return elapsed >= 0 && elapsed < playback.durationMs ? playback : null;
}

export interface DjNotePose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  alpha: number;
}

export function likeNoteFrame(
  seed: number,
  elapsedMs: number,
  reducedMotion = false,
) {
  const cycle =
    !reducedMotion && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.floor(elapsedMs / DJ_NOTE_LIFETIME_MS)
      : 0;
  const index = (seed + cycle) % MUSIC_NOTE_COLORS.length;
  // Offset the stagger so every selected glyph fills one complete cycle.
  const pose = reducedMotion
    ? djNotePose(0, elapsedMs, true)
    : djNotePose(index, elapsedMs + index * DJ_NOTE_STAGGER_MS);
  return { index, pose };
}

export function djNotePose(
  index: number,
  elapsedMs: number,
  reducedMotion = false,
): DjNotePose {
  const hidden = { x: 0, y: -42, scale: 0.35, rotation: 0, alpha: 0 };
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= DJ_NOTE_COUNT ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  )
    return hidden;
  if (reducedMotion)
    return index === 0
      ? { x: 30, y: -60, scale: 0.41, rotation: -0.1, alpha: 0.38 }
      : hidden;

  const age = elapsedMs - index * DJ_NOTE_STAGGER_MS;
  if (age < 0) return hidden;
  const progress = (age % DJ_NOTE_LIFETIME_MS) / DJ_NOTE_LIFETIME_MS;
  // Pick a stable direction per birth, rather than sweeping left to right.
  // Hashing the pool slot and cycle avoids per-frame random jitter.
  const cycle = Math.floor(age / DJ_NOTE_LIFETIME_MS);
  let seed =
    Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(cycle + 1, 0x85ebca6b);
  seed = Math.imul(seed ^ (seed >>> 16), 0x7feb352d);
  seed = Math.imul(seed ^ (seed >>> 15), 0x846ca68b);
  const random = ((seed ^ (seed >>> 16)) >>> 0) / 0x100000000;
  const angle = -Math.PI * 0.7 + random * Math.PI * 0.4;
  const sway = Math.sin(progress * Math.PI * 3 + index) * 3;
  // Give each note a small outward burst, then let it coast and wobble.
  const travel = 1 - Math.pow(1 - progress, 1.6);
  // A shallow ellipse keeps full glyphs clear of names below and emotes above.
  return {
    x: Math.cos(angle) * (18 + travel * 50) - Math.sin(angle) * sway,
    y: -42 + Math.sin(angle) * (8 + travel * 24) + Math.cos(angle) * sway * 0.5,
    scale: (0.75 + progress * 0.3 + Math.sin(progress * Math.PI) * 0.12) * 0.5,
    rotation: Math.sin(progress * Math.PI * 3 + index) * 0.28,
    alpha: 0.8 * Math.min(1, progress / 0.08, (1 - progress) / 0.3),
  };
}

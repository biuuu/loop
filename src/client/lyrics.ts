import type { Playback } from '../shared/contracts';

export interface TimedLyric {
  timeMs: number;
  text: string;
}
export interface LyricLine extends TimedLyric {
  translation: string;
}
export interface LyricWheelRow extends LyricLine {
  index: number;
  top: number;
  contentHeight: number;
  extent: number;
  center: number;
}

/** Fixed block geometry makes the original and its translation one wheel item. */
export function lyricWheelLayout(lines: readonly LyricLine[]): LyricWheelRow[] {
  let top = 0;
  return lines.map((line, index) => {
    const contentHeight = 22 + (line.translation ? 16 : 0);
    const extent = contentHeight + (line.translation ? 8 : 6);
    const row = {
      ...line,
      index,
      top,
      contentHeight,
      extent,
      center: top + contentHeight / 2,
    };
    top += extent;
    return row;
  });
}

/** A small render window shares one rigid-track offset, including the prelude. */
export function lyricWheelFrame(
  rows: readonly LyricWheelRow[],
  activeIndex: number,
) {
  const current = Math.max(-1, Math.min(activeIndex, rows.length - 1));
  const focus =
    current >= 0
      ? rows[current]!.center
      : rows.length
        ? rows[0]!.center - rows[0]!.extent
        : 66;
  return {
    offset: 66 - focus,
    rows: rows.slice(Math.max(0, current - 3), current + 4),
  };
}

/** Keep timed blank lines: they explicitly clear the previous words. */
export function parseLrc(source: string): TimedLyric[] {
  const grouped = new Map<number, string[]>();
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let remaining = raw.trim();
    const times: number[] = [];
    let match: RegExpMatchArray | null;
    while (
      (match = remaining.match(/^\[(\d{1,6}):([0-5]\d)(?:[.:](\d{1,3}))?\]/))
    ) {
      times.push(
        Number(match[1]) * 60_000 +
          Number(match[2]) * 1000 +
          Number((match[3] ?? '').padEnd(3, '0')),
      );
      remaining = remaining.slice(match[0].length).trimStart();
    }
    // Metadata and malformed timestamp lines do not become visible lyrics.
    if (!times.length || /^\[[^\]]*\]/.test(remaining)) continue;
    const text = remaining.trim();
    for (const time of times) {
      const parts = grouped.get(time) ?? [];
      if (!text) grouped.set(time, []);
      else {
        if (!parts.includes(text)) parts.push(text);
        grouped.set(time, parts);
      }
    }
  }
  return [...grouped]
    .sort(([a], [b]) => a - b)
    .map(([timeMs, parts]) => ({ timeMs, text: parts.join('\n') }));
}

/** Last timestamp at or before the room clock, including the final entry. */
export function currentLyricIndex(
  lines: readonly TimedLyric[],
  timeMs: number,
): number {
  if (!Number.isFinite(timeMs)) return -1;
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.timeMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function lyricSelection(lines: readonly TimedLyric[], timeMs: number) {
  const current = currentLyricIndex(lines, timeMs);
  return {
    current,
    next: current + 1 < lines.length ? current + 1 : -1,
  };
}

/** Each translation belongs to one closest original, never both neighbors. */
export function combineLyrics(
  original: string,
  translation: string,
): LyricLine[] {
  const lines = parseLrc(original).map((line) => ({
    ...line,
    translation: '',
  }));
  const translations = new Map<number, string[]>();
  for (const translated of parseLrc(translation)) {
    if (!translated.text || !lines.length) continue;
    const before = currentLyricIndex(lines, translated.timeMs);
    let nearest = -1;
    let distance = Infinity;
    for (const index of [before, before + 1]) {
      if (index < 0 || index >= lines.length) continue;
      const difference = Math.abs(lines[index]!.timeMs - translated.timeMs);
      if (difference < distance) {
        nearest = index;
        distance = difference;
      }
    }
    if (nearest < 0 || distance > 200 || !lines[nearest]!.text) continue;
    const parts = translations.get(nearest) ?? [];
    for (const text of translated.text.split('\n'))
      if (!parts.includes(text)) parts.push(text);
    translations.set(nearest, parts);
  }
  for (const [index, parts] of translations)
    lines[index]!.translation = parts.join('\n');
  return lines;
}

/** Preview offsets refer to the full song; null explicitly forbids syncing. */
export function lyricTime(
  playback: Pick<Playback, 'startedAt' | 'lyricOffsetMs'>,
  nowServer: number,
): number | null {
  if (
    playback.lyricOffsetMs === null ||
    !Number.isFinite(nowServer) ||
    !Number.isFinite(playback.startedAt)
  )
    return null;
  const offset = playback.lyricOffsetMs ?? 0;
  if (!Number.isFinite(offset) || offset < 0) return null;
  return Math.max(0, nowServer - playback.startedAt) + offset;
}

import { readFileSync } from 'node:fs';
import { HttpError } from './auth.js';

const DEFAULT_WORDS_FILE = 'data/sensitive-words.txt';
export type TextFilter = (value: string) => boolean;

function normalize(value: string) {
  return value
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFKC')
    .toLowerCase();
}

export function createTextFilter(source: string): TextFilter {
  const words = new Set<string>();
  const phrases = new Set<string>();
  for (const line of source.split(/\r\n?|\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const term = normalize(entry).trim();
    if (!term) continue;
    if (/^[a-z0-9]+$/.test(term)) words.add(term);
    else phrases.add(term);
  }
  return (value) => {
    const text = normalize(value);
    if (words.size && text.match(/[a-z0-9]+/g)?.some((word) => words.has(word)))
      return true;
    for (const phrase of phrases) if (text.includes(phrase)) return true;
    return false;
  };
}

export function loadTextFilter(
  path = process.env.LOOP_SENSITIVE_WORDS_FILE?.trim() || undefined,
): TextFilter | undefined {
  try {
    return createTextFilter(readFileSync(path ?? DEFAULT_WORDS_FILE, 'utf8'));
  } catch (error) {
    if (
      path === undefined &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
}

export function assertTextAllowed(
  filter: TextFilter | undefined,
  field: '昵称' | '房间名' | '房间简介',
  value: string,
) {
  if (filter?.(value))
    throw new HttpError(400, `${field}包含无法使用的内容，请修改后重试`);
}

const CAT_SLEEP_AFTER_MS = 120_000;
const CAT_SLEEP_SPREAD_MS = 30_000;

// Stable per-cat timing, independent of connection or render order.
export function identityHash(id: string, salt: string) {
  let hash = 2166136261;
  for (const character of `${salt}:${id}`)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function catSleepDelay(id: string) {
  return (
    CAT_SLEEP_AFTER_MS + (identityHash(id, 'sleep') % (CAT_SLEEP_SPREAD_MS + 1))
  );
}

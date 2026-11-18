import {
  EMOTE_DURATION_MS,
  type EmoteId,
  type RoomEmote,
} from '../shared/contracts';

export interface LocalEmote {
  id: EmoteId;
  url?: string;
  receivedAt: number;
  expiresAt: number;
}

// Each browser starts its own display clock when a transient event arrives.
// No timers or snapshot state can erase a newer event for the same cat.
export function createRoomEmotes() {
  const emotes = new Map<string, LocalEmote>();
  return {
    receive(event: RoomEmote, now: number, url?: string): void {
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(now + EMOTE_DURATION_MS) ||
        !event ||
        typeof event.userId !== 'string' ||
        !event.userId.trim() ||
        typeof event.id !== 'string' ||
        !event.id.trim()
      )
        return;
      emotes.set(event.userId, {
        id: event.id,
        ...(url ? { url } : {}),
        receivedAt: now,
        expiresAt: now + EMOTE_DURATION_MS,
      });
    },
    get(userId: string, now: number): LocalEmote | undefined {
      if (!Number.isFinite(now)) return;
      const emote = emotes.get(userId);
      if (emote && now >= emote.expiresAt) {
        emotes.delete(userId);
        return;
      }
      if (emote && now < emote.receivedAt) return;
      return emote;
    },
    retain(userIds: Iterable<string>): void {
      const retained = new Set(userIds);
      for (const id of emotes.keys()) {
        if (!retained.has(id)) emotes.delete(id);
      }
    },
    clear(): void {
      emotes.clear();
    },
  };
}

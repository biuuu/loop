import type { TrackReaction, TrackReactionKind } from '../shared/contracts';

export const TRACK_LIKE_EFFECT_MS = 1500;
export const TRACK_VOTE_EFFECT_MS = 3500;

type LocalReaction = TrackReaction & { receivedAt: number; expiresAt: number };

export function createTrackReactionEffects() {
  const effects = {
    like: new Map<string, LocalReaction>(),
    vote: new Map<string, LocalReaction>(),
  };
  return {
    receive(event: TrackReaction, now: number) {
      const duration =
        event.kind === 'like' ? TRACK_LIKE_EFFECT_MS : TRACK_VOTE_EFFECT_MS;
      effects[event.kind].set(event.userId, {
        ...event,
        receivedAt: now,
        expiresAt: now + duration,
      });
    },
    updateVoteCounts(roundId: string, votes: number, total: number) {
      for (const effect of effects.vote.values()) {
        if (effect.kind !== 'vote' || effect.roundId !== roundId) continue;
        effect.votes = votes;
        effect.total = total;
      }
    },
    get<Kind extends TrackReactionKind>(
      userId: string,
      kind: Kind,
      now: number,
    ) {
      const entries = effects[kind];
      const effect = entries.get(userId);
      if (effect && now >= effect.expiresAt) {
        entries.delete(userId);
        return;
      }
      if (effect && now >= effect.receivedAt)
        return effect as Extract<LocalReaction, { kind: Kind }>;
    },
    retain(users: ReadonlySet<string>) {
      for (const entries of Object.values(effects))
        for (const userId of entries.keys())
          if (!users.has(userId)) entries.delete(userId);
    },
    clear() {
      effects.like.clear();
      effects.vote.clear();
    },
  };
}

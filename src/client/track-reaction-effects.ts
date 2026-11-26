import type { TrackReaction } from '../shared/contracts';

export const TRACK_VOTE_EFFECT_MS = 3500;

type Vote = Extract<TrackReaction, { kind: 'vote' }>;
type LocalVote = Vote & { receivedAt: number; expiresAt: number };

export function createTrackVoteEffects() {
  const votes = new Map<string, LocalVote>();
  return {
    receive(event: Vote, now: number) {
      votes.set(event.userId, {
        ...event,
        receivedAt: now,
        expiresAt: now + TRACK_VOTE_EFFECT_MS,
      });
    },
    updateVoteCounts(roundId: string, count: number, total: number) {
      for (const effect of votes.values()) {
        if (effect.roundId !== roundId) continue;
        effect.votes = count;
        effect.total = total;
      }
    },
    get(userId: string, now: number) {
      const effect = votes.get(userId);
      if (effect && now >= effect.expiresAt) {
        votes.delete(userId);
        return;
      }
      if (effect && now >= effect.receivedAt) return effect;
    },
    retain(users: ReadonlySet<string>) {
      for (const userId of votes.keys())
        if (!users.has(userId)) votes.delete(userId);
    },
    clear() {
      votes.clear();
    },
  };
}

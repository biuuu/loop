import { z } from 'zod';
import {
  ROOM_CAPACITY,
  STAGE_CAPACITY,
  stageJoinSchema,
} from '../shared/contracts.js';

export const ROOM_CHECKPOINT_INTERVAL_MS = 30_000;
export const ROOM_CHECKPOINT_MAX_AGE_MS = 120_000;

const participantId = z.string().min(1).max(128);
const timestamp = z.number().nonnegative();
const member = stageJoinSchema.shape.from.unwrap().extend({
  id: participantId,
  facingRight: z.boolean(),
  sleepAt: timestamp.optional(),
  reconnectUntil: timestamp.optional(),
  stageJoinedAt: timestamp.optional(),
});
const playback = z.object({
  roundId: z.string().uuid(),
  track: z.object({
    id: z.string().min(1),
    title: z.string(),
    artist: z.string(),
    album: z.string(),
    cover: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  djId: participantId,
  url: z
    .string()
    .refine(
      (value) =>
        URL.canParse(value) &&
        ['http:', 'https:'].includes(new URL(value).protocol),
    ),
  startedAt: timestamp,
  durationMs: z.number().positive(),
  isTrial: z.literal(true).optional(),
  lyricOffsetMs: z.number().nonnegative().nullable().optional(),
});
const stateSchema = z
  .object({
    members: z.array(member).min(1).max(ROOM_CAPACITY),
    stage: z.array(participantId).max(STAGE_CAPACITY),
    playback: playback.nullable(),
  })
  .refine(({ members, stage, playback }) => {
    const ids = new Set(members.map(({ id }) => id));
    return (
      ids.size === members.length &&
      new Set(stage).size === stage.length &&
      stage.every((id) => ids.has(id)) &&
      (!playback || playback.djId === stage[0])
    );
  });

export type RoomCheckpoint = z.infer<typeof stateSchema> & { savedAt: number };

export function readRoomCheckpoint(
  savedAt: number,
  json: string,
): RoomCheckpoint | null {
  if (!Number.isSafeInteger(savedAt) || savedAt < 0) return null;
  try {
    const result = stateSchema.safeParse(JSON.parse(json));
    return result.success ? { ...result.data, savedAt } : null;
  } catch {
    return null;
  }
}

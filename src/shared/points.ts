import type { CatPresetPattern } from './appearance';

export const INITIAL_POINTS = 5;
export const COAT_UNLOCK_COST = 5;
export const DAILY_DJ_REWARD = 1;
export const DAILY_DJ_THRESHOLD_MS = 180_000;

export interface PointsState {
  balance: number;
  unlockedPresets: CatPresetPattern[];
  freeSpecialCoats?: true;
  daily: { date: string; playedMs: number; awarded: boolean };
  revision: number;
}

export interface PointsAwarded {
  points: PointsState;
  awarded: number;
}

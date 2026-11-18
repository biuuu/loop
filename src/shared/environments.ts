import { z } from 'zod';

export const environmentIdSchema = z.enum([
  'cozy',
  'greenhouse',
  'seaside',
  'rooftop',
]);
export type EnvironmentId = z.infer<typeof environmentIdSchema>;
export const DEFAULT_ENVIRONMENT: EnvironmentId = 'cozy';

export const ENVIRONMENTS = [
  {
    id: 'cozy',
    name: '暖木客厅',
    description: '圆窗、绿植与柔软地毯，熟悉的午后角落。',
    colors: ['#f1ecdc', '#dfc6a2', '#c4c7a6'],
  },
  {
    id: 'greenhouse',
    name: '玻璃花房',
    description: '透过玻璃屋顶的天光，围着花草听歌。',
    colors: ['#e3ede5', '#c5d1b2', '#829c78'],
  },
  {
    id: 'seaside',
    name: '落日海岸',
    description: '暖粉色的天空、海浪与木栈台，留住日落。',
    colors: ['#f4d9c5', '#9abec0', '#dfc8a3'],
  },
  {
    id: 'rooftop',
    name: '月夜露台',
    description: '城市天际线与暖色串灯，夜晚也有小小舞台。',
    colors: ['#303d56', '#69758a', '#e5c58c'],
  },
] as const satisfies ReadonlyArray<{
  id: EnvironmentId;
  name: string;
  description: string;
  colors: readonly [string, string, string];
}>;

// Older room snapshots have no environment; an unrecognized future ID also
// remains usable instead of preventing the whole room from rendering.
export function environmentPreset(value: unknown) {
  return ENVIRONMENTS.find((preset) => preset.id === value) ?? ENVIRONMENTS[0];
}

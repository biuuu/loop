import { z } from 'zod';

export const CAT_COATS = [
  { id: 'orange', label: '橘猫', color: '#fb8c00' },
  { id: 'gray', label: '灰猫', color: '#929ba5' },
  { id: 'cream', label: '奶油猫', color: '#e6c99c' },
  { id: 'black', label: '深灰猫', color: '#50515a' },
  { id: 'white', label: '米白猫', color: '#f1eee5' },
  { id: 'pure_black', label: '纯黑猫', color: '#000000' },
  { id: 'pure_white', label: '纯白猫', color: '#ffffff' },
] as const;

export const CAT_PATTERNS = [
  { id: 'solid', label: '原色' },
  { id: 'socks', label: '白胸白爪' },
  { id: 'tabby', label: '虎斑' },
] as const;

export const CALICO_APPEARANCE = { coat: 'white', pattern: 'calico' } as const;
export const SEAL_POINT_APPEARANCE = {
  coat: 'cream',
  pattern: 'seal_point',
} as const;

export const CAT_APPEARANCE_PRESETS = [
  {
    appearance: CALICO_APPEARANCE,
    label: '三花',
    swatch:
      'conic-gradient(#f1eee5 0 120deg, #d98947 120deg 235deg, #554b4e 235deg)',
  },
  {
    appearance: { coat: 'white', pattern: 'cow' },
    label: '奶牛猫',
    swatch: 'linear-gradient(125deg, #38353b 44%, #f1eee5 44%)',
  },
  {
    appearance: { coat: 'white', pattern: 'orange_white' },
    label: '橘白',
    swatch: 'linear-gradient(125deg, #eda251 52%, #f1eee5 52%)',
  },
  {
    appearance: { coat: 'black', pattern: 'tortoiseshell' },
    label: '玳瑁',
    swatch: 'linear-gradient(125deg, #a97a54 37%, #50515a 37%)',
  },
  {
    appearance: SEAL_POINT_APPEARANCE,
    label: '海豹色',
    swatch: 'linear-gradient(125deg, #785644 24%, #ad8361 44%, #f2e2c9 44%)',
  },
  {
    appearance: { coat: 'gray', pattern: 'tabby_white' },
    label: '狸花白',
    swatch: 'linear-gradient(125deg, #665142 24%, #aa9983 52%, #fff6e8 52%)',
  },
  {
    appearance: { coat: 'white', pattern: 'silver_shaded' },
    label: '银渐层',
    swatch: 'linear-gradient(125deg, #aeb5c2, #f7f5ef 65%)',
  },
  {
    appearance: { coat: 'white', pattern: 'red_point' },
    label: '红重点',
    swatch: 'linear-gradient(125deg, #bf8554 24%, #d4a680 44%, #f8ead5 44%)',
  },
] as const;

export type CatPresetPattern =
  (typeof CAT_APPEARANCE_PRESETS)[number]['appearance']['pattern'];

export function catAppearancePreset(pattern: string) {
  return CAT_APPEARANCE_PRESETS.find(
    (preset) => preset.appearance.pattern === pattern,
  );
}

export const catAppearanceSchema = z
  .object({
    coat: z.enum(CAT_COATS.map(({ id }) => id)),
    pattern: z.enum([
      ...CAT_PATTERNS.map(({ id }) => id),
      ...CAT_APPEARANCE_PRESETS.map(({ appearance }) => appearance.pattern),
    ]),
  })
  .strict()
  .refine(({ coat, pattern }) => {
    const preset = catAppearancePreset(pattern);
    return !preset || preset.appearance.coat === coat;
  });

export type CatAppearance = z.infer<typeof catAppearanceSchema>;
export const DEFAULT_CAT_APPEARANCE: CatAppearance = {
  coat: 'orange',
  pattern: 'solid',
};

export function catAppearanceKey(appearance: CatAppearance) {
  return `${appearance.coat}:${appearance.pattern}`;
}

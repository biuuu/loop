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

export const catAppearanceSchema = z
  .object({
    coat: z.enum([
      'orange',
      'gray',
      'cream',
      'black',
      'white',
      'pure_black',
      'pure_white',
    ]),
    pattern: z.enum(['solid', 'socks', 'tabby', CALICO_APPEARANCE.pattern]),
  })
  .strict()
  .refine(
    ({ coat, pattern }) =>
      pattern !== CALICO_APPEARANCE.pattern || coat === CALICO_APPEARANCE.coat,
  );

export type CatAppearance = z.infer<typeof catAppearanceSchema>;
export const DEFAULT_CAT_APPEARANCE: CatAppearance = {
  coat: 'orange',
  pattern: 'solid',
};

export function catAppearanceKey(appearance: CatAppearance) {
  return `${appearance.coat}:${appearance.pattern}`;
}

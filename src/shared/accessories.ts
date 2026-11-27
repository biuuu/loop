import { z } from 'zod';

export const ACCESSORY_UNLOCK_COST = 5;
export const CAT_ACCESSORY_SLOTS = ['head', 'chest', 'tail'] as const;

export const CAT_ACCESSORY_SAMPLES = [
  { id: 'beret', label: '小贝雷帽', slot: 'head' },
  { id: 'daisy', label: '小雏菊', slot: 'head' },
  { id: 'sprout', label: '双叶芽', slot: 'head' },
  { id: 'headphones', label: '迷你耳机', slot: 'head' },
  { id: 'bell', label: '胸前铃铛', slot: 'chest' },
  { id: 'bow', label: '短蝴蝶结', slot: 'chest' },
  { id: 'scarf', label: '小领巾', slot: 'chest' },
  { id: 'star-pin', label: '星形胸针', slot: 'chest' },
  { id: 'ribbon', label: '尾巴丝带', slot: 'tail' },
  { id: 'streamer', label: '短飘带', slot: 'tail' },
  { id: 'tail-ring', label: '珠扣尾环', slot: 'tail' },
  { id: 'tail-flower', label: '尾尖花结', slot: 'tail' },
] as const;

export const CAT_ACCESSORY_COLORS = {
  bow: [
    { id: 'default', label: '雾蓝', swatch: '#517f9f' },
    { id: 'rose', label: '豆沙粉', swatch: '#b46d84' },
    { id: 'sage', label: '鼠尾草绿', swatch: '#67865f' },
  ],
  scarf: [
    { id: 'default', label: '陶红', swatch: '#ba7560' },
    { id: 'blue', label: '海盐蓝', swatch: '#5d8da6' },
    { id: 'sage', label: '鼠尾草绿', swatch: '#7b966a' },
  ],
} as const;

export type CatAccessorySlot = (typeof CAT_ACCESSORY_SLOTS)[number];
export const catAccessoryIdSchema = z.enum(
  CAT_ACCESSORY_SAMPLES.map(({ id }) => id),
);
export type CatAccessoryId = z.infer<typeof catAccessoryIdSchema>;

const accessoryChoiceSchema = z
  .object({
    id: catAccessoryIdSchema,
    color: z.enum(['default', 'rose', 'blue', 'sage']).optional(),
  })
  .strict();
export type CatAccessoryChoice = z.infer<typeof accessoryChoiceSchema>;
export type CatAccessoryColor = NonNullable<CatAccessoryChoice['color']>;

export const catAccessoriesSchema = z
  .object({
    head: accessoryChoiceSchema.optional(),
    chest: accessoryChoiceSchema.optional(),
    tail: accessoryChoiceSchema.optional(),
  })
  .strict()
  .superRefine((choices, context) => {
    for (const slot of CAT_ACCESSORY_SLOTS) {
      const choice = choices[slot];
      if (!choice) continue;
      const { id, color } = choice;
      if (
        !CAT_ACCESSORY_SAMPLES.some(
          (item) => item.id === id && item.slot === slot,
        )
      )
        context.addIssue({
          code: 'custom',
          path: [slot, 'id'],
          message: '饰品不能戴在这个部位',
        });
      if (
        color &&
        color !== 'default' &&
        !(
          (id === 'bow' || id === 'scarf') &&
          CAT_ACCESSORY_COLORS[id].some((option) => option.id === color)
        )
      )
        context.addIssue({
          code: 'custom',
          path: [slot, 'color'],
          message: '此饰品没有这个配色',
        });
    }
  });
export type CatAccessories = z.infer<typeof catAccessoriesSchema>;

export function equippedAccessoryChoices(accessories?: CatAccessories) {
  return Object.values(accessories ?? {}).filter(
    (choice) => choice !== undefined,
  );
}

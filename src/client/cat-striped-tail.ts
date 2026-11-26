import type { MaskPatch } from './cat-patterns';
import { CAT_SEAL_POINT_PATCHES } from './cat-seal-point';
import { CAT_ANIMATIONS, type CatAnimation } from './cat-sprite';

export const CAT_TAIL_BANDS = { light: 1, dark: 2 } as const;
const { light, dark } = CAT_TAIL_BANDS;

type TailStripe = (column: number, row: number) => boolean;

// Partition the existing tail pixels into stripes. The bands follow each pose's
// tail shape, including the horizontal flick and the curl on the floor.
function stripedTail(patches: readonly MaskPatch[], isLight: TailStripe) {
  return patches
    .filter(({ part }) => part === 'tail')
    .flatMap((tail) =>
      [dark, light].flatMap((marking) => {
        const rows = tail.rows.map((row, y) =>
          row.replace(/#/g, (_, x: number) =>
            isLight(tail.x + x, tail.y + y) === (marking === light) ? '#' : '.',
          ),
        );
        return rows.some((row) => row.includes('#'))
          ? [{ ...tail, marking, rows }]
          : [];
      }),
    );
}

const raisedStripe: TailStripe = (_, y) => y === 40 || y === 41 || y === 43;
const angledStripe: TailStripe = (_, y) => y === 41 || y === 42 || y === 44;
const lowStripe: TailStripe = (x, y) => y === 43 || (y === 45 && x >= 40);
const flatStripe: TailStripe = (x) =>
  (x >= 41 && x <= 42) || (x >= 45 && x <= 46);
const IDLE_STRIPES = [
  raisedStripe,
  angledStripe,
  lowStripe,
  flatStripe,
  lowStripe,
  angledStripe,
];
const SLEEP_TAIL = stripedTail(
  CAT_SEAL_POINT_PATCHES.sleepHigh,
  (_, y) => y === 45 || y === 47 || y === 48,
);
export const CAT_STRIPED_TAIL_PATCHES: Readonly<
  Record<CatAnimation, readonly (readonly MaskPatch[])[]>
> = {
  idle: CAT_SEAL_POINT_PATCHES.idle.map((regions, frame) =>
    stripedTail(regions, IDLE_STRIPES[frame % IDLE_STRIPES.length]!),
  ),
  side: CAT_SEAL_POINT_PATCHES.side.map((regions, frame) => {
    const dy = frame === 1 || frame === 4 ? -1 : 0;
    return stripedTail(regions, (_, y) => y === 42 + dy || y === 44 + dy);
  }),
  up: CAT_SEAL_POINT_PATCHES.up.map((regions) =>
    stripedTail(regions, (_, y) => y === 40 || y === 41 || y === 44),
  ),
  down: CAT_SEAL_POINT_PATCHES.down.map((regions, frame) => {
    const dy = frame === 1 ? -1 : 0;
    return stripedTail(regions, (_, y) => [27, 28, 30, 31].includes(y - dy));
  }),
  sleep: Array.from({ length: CAT_ANIMATIONS.sleep.frames }, () => SLEEP_TAIL),
};

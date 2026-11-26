import {
  type CatAppearance,
  type CatPresetPattern,
} from '../shared/appearance';
import { CAT_ANIMATIONS, CAT_CELL_SIZE, type CatAnimation } from './cat-sprite';
import { CAT_CALICO_MARKINGS, getPatternMask } from './cat-patterns';

export const CAT_PACKED_ROWS: Record<CatAnimation, number> = {
  idle: 0,
  side: 1,
  up: 2,
  down: 3,
  sleep: 4,
};
export const CAT_APPEARANCE_WIDTH = CAT_ANIMATIONS.sleep.frames * CAT_CELL_SIZE;
export const CAT_APPEARANCE_HEIGHT = 5 * CAT_CELL_SIZE;
const ORIGINAL = {
  main: 0xfb8c00,
  shadow: 0xef6c00,
  light: 0xffdeb1,
  ink: 0x482a00,
};
const PALETTES = {
  orange: { ...ORIGINAL, stripe: 0xc85c00 },
  gray: {
    main: 0x929ba5,
    shadow: 0x717b88,
    light: 0xd5d9dc,
    stripe: 0x515c6b,
    ink: ORIGINAL.ink,
  },
  cream: {
    main: 0xe6c99c,
    shadow: 0xc7a679,
    light: 0xfff0d5,
    stripe: 0x9f7b52,
    ink: ORIGINAL.ink,
  },
  black: {
    main: 0x50515a,
    shadow: 0x393a45,
    light: 0xa3a2a6,
    stripe: 0x252631,
    ink: ORIGINAL.ink,
  },
  white: {
    main: 0xf1eee5,
    shadow: 0xd3cfc3,
    light: 0xfffaf2,
    stripe: 0xa8a297,
    ink: ORIGINAL.ink,
  },
  pure_black: {
    main: 0x000000,
    shadow: 0x101010,
    light: 0x353535,
    stripe: 0x292929,
    ink: 0x242424,
  },
  pure_white: {
    main: 0xffffff,
    shadow: 0xe9e9e9,
    light: 0xffffff,
    stripe: 0xbcbcbc,
    ink: 0x5b5b5b,
  },
} satisfies Record<
  CatAppearance['coat'],
  { main: number; shadow: number; light: number; stripe: number; ink: number }
>;
type SpotPalette = Readonly<
  Partial<Record<number, { main: number; shadow: number; light?: number }>>
>;
const SPOT_PALETTES = {
  socks: { 1: { main: 0xfff7e9, shadow: 0xe8dbc8 } },
  calico: {
    [CAT_CALICO_MARKINGS.orange]: { main: 0xd98947, shadow: 0xb96b36 },
    [CAT_CALICO_MARKINGS.dark]: { main: 0x554b4e, shadow: 0x41383c },
  },
  cow: { 2: { main: 0x38353b, shadow: 0x29262c } },
  orange_white: { 1: { main: 0xeda251, shadow: 0xd57836 } },
  tortoiseshell: { 1: { main: 0xa97a54, shadow: 0x8e6144 } },
  seal_point: {
    1: { main: 0xad8361, shadow: 0x946a50 },
    2: { main: 0x785644, shadow: 0x654637, light: 0x9b7055 },
  },
} satisfies Record<CatPresetPattern | 'socks', SpotPalette>;
const SEAL_POINT_COAT = { ...PALETTES.cream, main: 0xf2e2c9, shadow: 0xdcc3a6 };

// Separate the connected silhouette from enclosed facial details using the
// untouched frame. Eight-way connections keep diagonal one-pixel contours intact.
function outerInkPixels(
  pixels: Uint8ClampedArray,
  column: number,
  row: number,
) {
  const outer = new Uint8Array(CAT_CELL_SIZE * CAT_CELL_SIZE);
  const visited = new Uint8Array(outer.length);
  const offsetAt = (x: number, y: number) =>
    ((row * CAT_CELL_SIZE + y) * CAT_APPEARANCE_WIDTH +
      column * CAT_CELL_SIZE +
      x) *
    4;
  const isInk = (offset: number) =>
    pixels[offset + 3] !== 0 &&
    ((pixels[offset]! << 16) |
      (pixels[offset + 1]! << 8) |
      pixels[offset + 2]!) ===
      ORIGINAL.ink;
  for (let start = 0; start < visited.length; start++) {
    if (
      visited[start] ||
      !isInk(offsetAt(start % CAT_CELL_SIZE, Math.floor(start / CAT_CELL_SIZE)))
    )
      continue;
    const component = [start];
    visited[start] = 1;
    let touchesOutside = false;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const pixel = component[cursor]!;
      const x = pixel % CAT_CELL_SIZE;
      const y = Math.floor(pixel / CAT_CELL_SIZE);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= CAT_CELL_SIZE || ny < 0 || ny >= CAT_CELL_SIZE) {
            touchesOutside = true;
            continue;
          }
          const offset = offsetAt(nx, ny);
          if (pixels[offset + 3] === 0) touchesOutside = true;
          const neighbor = ny * CAT_CELL_SIZE + nx;
          if (!visited[neighbor] && isInk(offset)) {
            visited[neighbor] = 1;
            component.push(neighbor);
          }
        }
      }
    }
    if (touchesOutside) for (const pixel of component) outer[pixel] = 1;
  }
  return outer;
}

/** Recolor a packed sheet while retaining alpha and every eye/outline pixel's position. */
export function recolorCatPixels(
  pixels: Uint8ClampedArray,
  appearance: CatAppearance,
) {
  if (pixels.length !== CAT_APPEARANCE_WIDTH * CAT_APPEARANCE_HEIGHT * 4)
    throw new Error('Unexpected cat appearance sheet size');
  const result = new Uint8ClampedArray(pixels);
  if (appearance.coat === 'orange' && appearance.pattern === 'solid')
    return result;
  const palette =
    appearance.pattern === 'seal_point'
      ? SEAL_POINT_COAT
      : PALETTES[appearance.coat];
  const spots: SpotPalette | undefined =
    appearance.pattern === 'solid'
      ? undefined
      : appearance.pattern === 'tabby'
        ? { 1: { main: palette.stripe, shadow: palette.stripe } }
        : SPOT_PALETTES[appearance.pattern];
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    const sequence = CAT_ANIMATIONS[animation];
    const row = CAT_PACKED_ROWS[animation];
    for (let column = 0; column < sequence.frames; column++) {
      const mask =
        appearance.pattern === 'solid'
          ? undefined
          : getPatternMask(appearance.pattern, animation, column);
      const outerInk =
        appearance.coat === 'pure_black'
          ? outerInkPixels(pixels, column, row)
          : undefined;
      for (let y = 0; y < CAT_CELL_SIZE; y++) {
        for (let x = 0; x < CAT_CELL_SIZE; x++) {
          const offset =
            ((row * CAT_CELL_SIZE + y) * CAT_APPEARANCE_WIDTH +
              column * CAT_CELL_SIZE +
              x) *
            4;
          if (pixels[offset + 3] === 0) continue;
          const color =
            (pixels[offset]! << 16) |
            (pixels[offset + 1]! << 8) |
            pixels[offset + 2]!;
          const patch = spots?.[mask?.[y * CAT_CELL_SIZE + x] ?? 0];
          const replacement =
            color === ORIGINAL.main
              ? (patch?.main ?? palette.main)
              : color === ORIGINAL.shadow
                ? (patch?.shadow ?? palette.shadow)
                : color === ORIGINAL.light
                  ? (patch?.light ?? palette.light)
                  : color === ORIGINAL.ink
                    ? outerInk?.[y * CAT_CELL_SIZE + x]
                      ? 0x030303
                      : palette.ink
                    : color;
          result[offset] = replacement >>> 16;
          result[offset + 1] = (replacement >>> 8) & 255;
          result[offset + 2] = replacement & 255;
        }
      }
    }
  }
  return result;
}

/** Pack only the animation rows used by the room; original art stays untouched. */
export function createAppearanceSheet(
  image: CanvasImageSource,
  appearance: CatAppearance,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CAT_APPEARANCE_WIDTH;
  canvas.height = CAT_APPEARANCE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cat appearance canvas is unavailable');
  context.imageSmoothingEnabled = false;
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    const sequence = CAT_ANIMATIONS[animation];
    context.drawImage(
      image,
      0,
      sequence.row * CAT_CELL_SIZE,
      sequence.frames * CAT_CELL_SIZE,
      CAT_CELL_SIZE,
      0,
      CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE,
      sequence.frames * CAT_CELL_SIZE,
      CAT_CELL_SIZE,
    );
  }
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  data.data.set(recolorCatPixels(data.data, appearance));
  context.putImageData(data, 0, 0);
  return canvas;
}

import { SCENE, stageSeatXs } from '../shared/contracts';

export interface Point {
  x: number;
  y: number;
}
export interface Camera extends Point {
  scale: number;
}
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export const DEFAULT_ZOOM = 1;
export const MAX_ZOOM = 1.25;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
function boundedOffset(
  offset: number,
  viewport: number,
  world: number,
  scale: number,
) {
  const remaining = viewport - world * scale;
  return remaining >= 0 ? remaining / 2 : clamp(offset, remaining, 0);
}

/** Relative to the cover scale: the minimum fits the complete room. */
export function minZoom(width: number, height: number) {
  const horizontal = width / SCENE.width;
  const vertical = height / SCENE.height;
  return Math.min(horizontal, vertical) / Math.max(horizontal, vertical);
}

export function clampZoom(zoom: number, width: number, height: number) {
  return Number.isFinite(zoom)
    ? clamp(zoom, minZoom(width, height), MAX_ZOOM)
    : DEFAULT_ZOOM;
}

/** Center smaller axes; aim at an optional focus and clamp covered room edges. */
export function sceneCamera(
  width: number,
  height: number,
  zoom: number,
  focus?: Point,
): Camera {
  const scale =
    Math.max(width / SCENE.width, height / SCENE.height) *
    clampZoom(zoom, width, height);
  const target = focus ?? { x: SCENE.width / 2, y: SCENE.height / 2 };
  const offset = (viewport: number, world: number, focus: number) =>
    boundedOffset(viewport / 2 - focus * scale, viewport, world, scale);
  return {
    scale,
    x: offset(width, SCENE.width, target.x),
    y: offset(height, SCENE.height, target.y),
  };
}

/** Follow from the inner box while walking; a stopped cat only needs to stay visible. */
export function audienceCamera(
  width: number,
  height: number,
  zoom: number,
  cat: Point,
  current: Camera,
  safe: Bounds,
  stoppedCatBounds?: Bounds,
): Camera {
  const base = sceneCamera(width, height, zoom);
  const previous = current.scale === base.scale ? current : base;
  if (stoppedCatBounds)
    return keepCatInView(previous, width, height, cat, stoppedCatBounds, safe);
  const axis = (
    offset: number,
    viewport: number,
    world: number,
    focus: number,
    safeMin: number,
    safeMax: number,
    insetFraction: number,
  ) => {
    const inset = (safeMax - safeMin) * insetFraction;
    const min = safeMin + inset;
    const max = safeMax - inset;
    const projected = focus * base.scale + offset;
    if (projected < min) offset += min - projected;
    else if (projected > max) offset += max - projected;
    return boundedOffset(offset, viewport, world, base.scale);
  };
  return {
    scale: base.scale,
    x: axis(previous.x, width, SCENE.width, cat.x, safe.left, safe.right, 0.32),
    y: axis(
      previous.y,
      height,
      SCENE.height,
      cat.y,
      safe.top,
      safe.bottom,
      0.3,
    ),
  };
}

/** Keep the stage composition until the entire local cat leaves its safe area. */
export function stageCamera(
  width: number,
  height: number,
  zoom: number,
  cat: Point,
  catBounds: Bounds,
  safe: Bounds,
  composition: Point = { x: SCENE.width / 2, y: SCENE.height / 2 },
): Camera {
  const base = sceneCamera(width, height, zoom, composition);
  return keepCatInView(base, width, height, cat, catBounds, safe);
}

function keepCatInView(
  base: Camera,
  width: number,
  height: number,
  cat: Point,
  catBounds: Bounds,
  safe: Bounds,
): Camera {
  const axis = (
    offset: number,
    viewport: number,
    world: number,
    focus: number,
    boundMin: number,
    boundMax: number,
    safeMin: number,
    safeMax: number,
  ) => {
    const projectedMin = (focus + boundMin) * base.scale + offset;
    const projectedMax = (focus + boundMax) * base.scale + offset;
    const safeSize = safeMax - safeMin;
    if (projectedMax - projectedMin > safeSize) {
      offset += (safeMin + safeMax - projectedMin - projectedMax) / 2;
    } else if (projectedMin < safeMin) {
      offset += safeMin - projectedMin;
    } else if (projectedMax > safeMax) {
      offset += safeMax - projectedMax;
    }
    // Contained axes retain their centered gutters; covered axes never show
    // unpainted room outside the scene, even if the safe inset is impossible.
    return boundedOffset(offset, viewport, world, base.scale);
  };
  return {
    scale: base.scale,
    x: axis(
      base.x,
      width,
      SCENE.width,
      cat.x,
      catBounds.left,
      catBounds.right,
      safe.left,
      safe.right,
    ),
    y: axis(
      base.y,
      height,
      SCENE.height,
      cat.y,
      catBounds.top,
      catBounds.bottom,
      safe.top,
      safe.bottom,
    ),
  };
}

/** Time-based easing keeps the same feel at different display refresh rates. */
export function easeCamera(
  current: Camera,
  target: Camera,
  deltaMs: number,
  reducedMotion = false,
): Camera {
  if (reducedMotion || current.scale !== target.scale) return target;
  const blend = 1 - Math.exp(-Math.max(0, deltaMs) / 180);
  const approach = (from: number, to: number) =>
    Math.abs(from - to) < 0.25 ? to : from + (to - from) * blend;
  return {
    scale: target.scale,
    x: approach(current.x, target.x),
    y: approach(current.y, target.y),
  };
}

/** Reproject the old view center after resize/zoom before easing to its goal. */
export function reframeCamera(
  current: Camera,
  oldWidth: number,
  oldHeight: number,
  width: number,
  height: number,
  zoom: number,
): Camera {
  return sceneCamera(width, height, zoom, {
    x: (oldWidth / 2 - current.x) / current.scale,
    y: (oldHeight / 2 - current.y) / current.scale,
  });
}
export function worldToScreen(point: Point, camera: Camera): Point {
  return {
    x: point.x * camera.scale + camera.x,
    y: point.y * camera.scale + camera.y,
  };
}
/** Move only a sprite's drawn origin onto the renderer's pixel grid. */
export function spritePixelOffset(
  point: Point,
  camera: Camera,
  resolution: number,
): Point {
  const pixelsPerUnit = camera.scale * resolution;
  const offset = (world: number, pan: number) => {
    const pixel = (world * camera.scale + pan) * resolution;
    return (Math.round(pixel) - pixel) / pixelsPerUnit;
  };
  return { x: offset(point.x, camera.x), y: offset(point.y, camera.y) };
}
export function screenToWorld(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.x) / camera.scale,
    y: (point.y - camera.y) / camera.scale,
  };
}
export function stageSeatAt(point: Point, capacity?: number): number | null {
  const xs = stageSeatXs(capacity);
  if (
    point.x < xs[0]! - 81 ||
    point.x > xs.at(-1)! + 81 ||
    point.y < 200 ||
    point.y > 321
  )
    return null;
  let nearest = 0;
  for (let seat = 1; seat < xs.length; seat++)
    if (Math.abs(point.x - xs[seat]!) < Math.abs(point.x - xs[nearest]!))
      nearest = seat;
  return nearest;
}
export function floorTarget(point: Point): Point | null {
  if (
    point.y < SCENE.walk.top ||
    point.y > SCENE.walk.bottom ||
    point.x < 0 ||
    point.x > SCENE.width
  )
    return null;
  return { x: clamp(point.x, SCENE.walk.left, SCENE.walk.right), y: point.y };
}

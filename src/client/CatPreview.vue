<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { Assets, type Texture } from 'pixi.js';
import {
  CAT_COATS,
  CAT_PATTERNS,
  catAppearancePreset,
  type CatAppearance,
} from '../shared/appearance';
import { CAT_PACKED_ROWS, createAppearanceSheet } from './cat-appearance';
import { drawCatBeret } from './cat-beret';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  CAT_FRAME_MS,
  CAT_IDLE_UP_COLUMN,
  SLEEP_LOOP_FRAMES,
  type CatAnimation,
} from './cat-sprite';

const props = defineProps<{
  appearance: CatAppearance;
  portrait?: boolean;
  beretPose?: { animation: CatAnimation; flipX: boolean };
}>();
const canvas = ref<HTMLCanvasElement>();
const sheet = shallowRef<HTMLCanvasElement>();
const unavailable = ref(false);
const label = computed(() => {
  const preset = catAppearancePreset(props.appearance.pattern);
  const coat =
    preset?.label ??
    `${CAT_COATS.find((coat) => coat.id === props.appearance.coat)?.label}，${CAT_PATTERNS.find((pattern) => pattern.id === props.appearance.pattern)?.label}`;
  return props.beretPose ? `${coat}，戴贝雷帽` : coat;
});
watch(
  [canvas, () => props.appearance.coat, () => props.appearance.pattern],
  async ([target], _, onCleanup) => {
    if (!target) return;
    let canceled = false;
    onCleanup(() => {
      canceled = true;
    });
    const appearance = { ...props.appearance };
    try {
      const image = await Assets.load<Texture>('/Cat/Cat.png');
      if (canceled) return;
      sheet.value = createAppearanceSheet(
        image.source.resource as CanvasImageSource,
        appearance,
      );
    } catch {
      if (!canceled) {
        sheet.value = undefined;
        unavailable.value = true;
      }
    }
  },
  { flush: 'post', immediate: true },
);
watch(
  [canvas, sheet, () => props.portrait, () => props.beretPose],
  ([target, appearance, portrait, beretPose], _, onCleanup) => {
    if (!target || !appearance) return;
    const context = target.getContext('2d');
    unavailable.value = !context;
    if (!context) return;
    context.imageSmoothingEnabled = false;
    const pose = portrait ? undefined : beretPose;
    const animation = pose?.animation ?? 'idle';
    const offsetY = CAT_ANIMATIONS.idle.footY - CAT_ANIMATIONS[animation].footY;
    // The header portrait samples the idle head directly.
    const crop = portrait
      ? { x: 22, y: 28, size: 16 }
      : { x: 0, y: 0, size: CAT_CELL_SIZE };
    const draw = (column: number) => {
      context.clearRect(0, 0, CAT_CELL_SIZE, CAT_CELL_SIZE);
      context.save();
      context.translate(pose?.flipX ? CAT_CELL_SIZE : 0, offsetY);
      if (pose?.flipX) context.scale(-1, 1);
      context.drawImage(
        appearance,
        column * CAT_CELL_SIZE + crop.x,
        CAT_PACKED_ROWS[animation] * CAT_CELL_SIZE + crop.y,
        crop.size,
        crop.size,
        0,
        0,
        CAT_CELL_SIZE,
        CAT_CELL_SIZE,
      );
      if (pose) drawCatBeret(context, animation, column);
      context.restore();
    };
    draw(pose ? 0 : CAT_IDLE_UP_COLUMN);
    if (!pose || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    const frames =
      animation === 'sleep'
        ? SLEEP_LOOP_FRAMES
        : CAT_ANIMATIONS[animation].frames;
    let column = 0;
    const timer = window.setInterval(() => {
      column = (column + 1) % frames;
      draw(column);
    }, CAT_FRAME_MS);
    onCleanup(() => window.clearInterval(timer));
  },
  { flush: 'post', immediate: true },
);
</script>

<template>
  <div class="cat-preview">
    <canvas
      ref="canvas"
      width="64"
      height="64"
      role="img"
      :aria-label="label"
    />
    <span v-if="unavailable" class="preview-unavailable">预览暂不可用</span>
  </div>
</template>

<style scoped>
.cat-preview {
  display: grid;
  place-items: center;
}
.cat-preview canvas {
  width: 192px;
  height: 192px;
  max-width: 100%;
  image-rendering: pixelated;
}
.preview-unavailable {
  font-size: 0.85rem;
}
</style>

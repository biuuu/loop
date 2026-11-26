<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Assets, type Texture } from 'pixi.js';
import {
  CAT_COATS,
  CAT_PATTERNS,
  catAppearancePreset,
} from '../shared/appearance';
import {
  createAppearanceSheet,
  CAT_PACKED_ROWS,
  type CatRenderAppearance,
} from './cat-appearance';
import { SEAL_POINT_SAMPLE } from './cat-seal-point-sample';
import { CAT_CELL_SIZE, CAT_IDLE_UP_COLUMN } from './cat-sprite';

const props = defineProps<{
  appearance: CatRenderAppearance;
  portrait?: boolean;
  sleeping?: boolean;
}>();
const canvas = ref<HTMLCanvasElement>();
const unavailable = ref(false);
const isSample = computed(
  () => props.appearance.pattern === SEAL_POINT_SAMPLE.pattern,
);
// Keep existing avatars on the tighter head crop. Crop the full sample poses
// too, so the transparent padding does not consume the comparison tiles.
const crop = computed(() =>
  props.portrait
    ? { x: 22, y: 28, size: 16 }
    : props.sleeping
      ? { x: 24, y: 31, size: 24 }
      : isSample.value
        ? { x: 22, y: 27, size: 24 }
        : { x: 0, y: 0, size: CAT_CELL_SIZE },
);
const canvasSize = computed(() =>
  isSample.value ? crop.value.size : CAT_CELL_SIZE,
);
const label = computed(() => {
  if (isSample.value) return '海豹重点色样品';
  const preset = catAppearancePreset(props.appearance.pattern);
  if (preset) return preset.label;
  return `${CAT_COATS.find((coat) => coat.id === props.appearance.coat)?.label}，${CAT_PATTERNS.find((pattern) => pattern.id === props.appearance.pattern)?.label}`;
});
let disposed = false;
let revision = 0;
watch(
  [
    canvas,
    () => props.appearance.coat,
    () => props.appearance.pattern,
    () => props.portrait,
    () => props.sleeping,
  ],
  async () => {
    const current = ++revision;
    if (!canvas.value) return;
    const appearance = { ...props.appearance };
    try {
      const image = await Assets.load<Texture>('/Cat/Cat.png');
      if (disposed || current !== revision || !canvas.value) return;
      const sheet = createAppearanceSheet(
        image.source.resource as CanvasImageSource,
        appearance,
      );
      const context = canvas.value.getContext('2d');
      if (!context) throw new Error('Cat preview canvas is unavailable');
      context.imageSmoothingEnabled = false;
      const { x, y, size } = crop.value;
      const target = canvasSize.value;
      const row = props.sleeping ? CAT_PACKED_ROWS.sleep : CAT_PACKED_ROWS.idle;
      const column = props.sleeping ? 0 : CAT_IDLE_UP_COLUMN;
      context.clearRect(0, 0, target, target);
      context.drawImage(
        sheet,
        column * CAT_CELL_SIZE + x,
        row * CAT_CELL_SIZE + y,
        size,
        size,
        0,
        0,
        target,
        target,
      );
      unavailable.value = false;
    } catch {
      if (!disposed && current === revision) unavailable.value = true;
    }
  },
  { flush: 'post', immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  revision++;
});
</script>

<template>
  <div class="cat-preview" :class="{ 'is-sample': isSample }">
    <canvas
      ref="canvas"
      :width="canvasSize"
      :height="canvasSize"
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
.cat-preview.is-sample canvas {
  width: 96px;
  height: auto;
}
.preview-unavailable {
  font-size: 0.85rem;
}
</style>

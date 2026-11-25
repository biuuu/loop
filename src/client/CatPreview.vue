<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Assets, type Texture } from 'pixi.js';
import {
  CALICO_APPEARANCE,
  CAT_COATS,
  CAT_PATTERNS,
  type CatAppearance,
} from '../shared/appearance';
import { createAppearanceSheet } from './cat-appearance';
import { CAT_CELL_SIZE, CAT_IDLE_UP_COLUMN } from './cat-sprite';

const props = defineProps<{ appearance: CatAppearance; portrait?: boolean }>();
const canvas = ref<HTMLCanvasElement>();
const unavailable = ref(false);
const label = computed(() =>
  props.appearance.pattern === CALICO_APPEARANCE.pattern
    ? '三花猫'
    : `${CAT_COATS.find((coat) => coat.id === props.appearance.coat)?.label}，${CAT_PATTERNS.find((pattern) => pattern.id === props.appearance.pattern)?.label}`,
);
let disposed = false;
let revision = 0;
watch(
  [
    canvas,
    () => props.appearance.coat,
    () => props.appearance.pattern,
    () => props.portrait,
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
      context.clearRect(0, 0, CAT_CELL_SIZE, CAT_CELL_SIZE);
      // The idle cell has generous transparent margins. A header portrait
      // samples its head directly so the tiny avatar remains recognizable.
      const crop = props.portrait
        ? { x: 22, y: 28, size: 16 }
        : { x: 0, y: 0, size: CAT_CELL_SIZE };
      context.drawImage(
        sheet,
        CAT_IDLE_UP_COLUMN * CAT_CELL_SIZE + crop.x,
        crop.y,
        crop.size,
        crop.size,
        0,
        0,
        CAT_CELL_SIZE,
        CAT_CELL_SIZE,
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

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import type { SongLyrics } from '../shared/contracts';
import { SCENE } from '../shared/contracts';
import type { Camera } from './scene-camera';
import { request, useRoom } from './room';
import {
  combineLyrics,
  currentLyricIndex,
  lyricTime,
  lyricWheelLayout,
  lyricWheelFrame,
} from './lyrics';

const props = defineProps<{ camera: Camera }>();
const room = useRoom();
const playback = computed(() => room.snapshot?.playback);
const data = shallowRef<SongLyrics | null>(null);
const loading = ref(false);
const failed = ref(false);
const now = ref(Date.now());
const lines = computed(() =>
  data.value ? combineLyrics(data.value.original, data.value.translation) : [],
);
const hasLyrics = computed(() => lines.value.some((line) => line.text));
const time = computed(() =>
  playback.value ? lyricTime(playback.value, now.value + room.offset) : null,
);
const activeIndex = computed(() =>
  time.value === null ? -1 : currentLyricIndex(lines.value, time.value),
);
const layout = computed(() => lyricWheelLayout(lines.value));
const wheel = computed(() => lyricWheelFrame(layout.value, activeIndex.value));
const animate = ref(false);
watch(
  [
    activeIndex,
    () => playback.value?.track.id,
    () => playback.value?.roundId,
    data,
  ],
  ([index, id, round, lyrics], previous) => {
    animate.value = !!(
      lyrics &&
      lyrics === previous?.[3] &&
      id === previous?.[1] &&
      round === previous?.[2] &&
      previous?.[0] !== undefined &&
      index === previous[0] + 1
    );
  },
  { immediate: true },
);
const position = computed(() => ({
  left: `${props.camera.x + (SCENE.width / 2) * props.camera.scale}px`,
  top: `${props.camera.y + 61 * props.camera.scale}px`,
  transform: `translateX(-50%) scale(${props.camera.scale})`,
}));
const status = computed(() => {
  if (time.value === null) return '试听片段暂无同步歌词';
  if (loading.value) return '正在读取歌词…';
  if (failed.value) return '歌词暂时不可用';
  return '暂无歌词';
});
let controller: AbortController | undefined;
let revision = 0;
let disposed = false;
watch(
  [
    () => room.guest?.id,
    () => playback.value?.track.id,
    () => playback.value?.roundId,
  ],
  async ([identity, id], previous) => {
    const version = ++revision;
    controller?.abort();
    controller = undefined;
    now.value = Date.now();
    loading.value = false;
    failed.value = false;
    if (!identity || !id) {
      data.value = null;
      return;
    }
    // A repeated round of the same song can reuse already received lyrics.
    if (identity === previous?.[0] && data.value?.trackId === id) return;
    data.value = null;
    loading.value = true;
    const active = new AbortController();
    controller = active;
    try {
      const result = await request<SongLyrics>(
        `/api/lyrics/${encodeURIComponent(id)}`,
        {
          signal: active.signal,
        },
      );
      if (disposed || version !== revision || active.signal.aborted) return;
      if (
        result.trackId !== id ||
        typeof result.original !== 'string' ||
        typeof result.translation !== 'string'
      )
        throw new Error('Invalid lyrics response');
      data.value = result;
    } catch {
      if (!disposed && version === revision && !active.signal.aborted)
        failed.value = true;
    } finally {
      if (!disposed && version === revision) loading.value = false;
    }
  },
  { immediate: true },
);
function tick() {
  if (!document.hidden && playback.value) now.value = Date.now();
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(tick, 100);
  document.addEventListener('visibilitychange', tick);
});
onBeforeUnmount(() => {
  disposed = true;
  revision++;
  controller?.abort();
  clearInterval(timer);
  document.removeEventListener('visibilitychange', tick);
});
const singleLine = (text: string) => text.replace(/\n/g, ' / ');
</script>

<template>
  <section
    v-if="playback"
    class="world-lyrics"
    :style="position"
    aria-label="房间歌词"
  >
    <p v-if="time === null || !hasLyrics" class="lyrics-status">
      {{ status }}
    </p>
    <div v-else class="lyrics-viewport" :class="{ 'is-animated': animate }">
      <div
        class="lyrics-track"
        :style="{ transform: `translateY(${wheel.offset}px)` }"
      >
        <div
          v-for="line in wheel.rows"
          :key="`${playback.track.id}:${line.timeMs}`"
          class="lyrics-line"
          :class="{
            'is-current': line.index === activeIndex,
            'is-neighbor': Math.abs(line.index - activeIndex) === 1,
          }"
          :style="{ top: `${line.top}px`, height: `${line.contentHeight}px` }"
        >
          <div
            class="lyric-content"
            :style="{ height: `${line.contentHeight}px` }"
          >
            <p class="lyric-original" :title="line.text">
              {{ singleLine(line.text) || '\u00a0' }}
            </p>
            <p
              v-if="line.translation"
              class="lyric-translation"
              :title="line.translation"
            >
              {{ singleLine(line.translation) }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.world-lyrics {
  position: absolute;
  z-index: 1;
  width: 420px;
  height: 135px;
  transform-origin: center top;
  color: var(--lyrics-color, #5c6453);
  text-align: center;
  pointer-events: none;
}
.world-lyrics p {
  margin: 0;
}
.lyrics-status {
  padding-top: 28px;
  font-size: 14px;
  color: var(--lyrics-muted, #89917d);
}
.lyrics-viewport {
  position: relative;
  height: 132px;
  overflow: hidden;
  mask-image: linear-gradient(
    to bottom,
    transparent,
    black 18px,
    black calc(100% - 18px),
    transparent
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent,
    black 18px,
    black calc(100% - 18px),
    transparent
  );
}
.lyrics-track {
  position: relative;
  width: 100%;
}
.lyrics-line {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}
.lyric-content {
  opacity: 0;
  transform: scale(0.86);
  transform-origin: center center;
}
.is-current .lyric-content {
  opacity: 1;
  transform: scale(1);
}
.is-neighbor .lyric-content {
  opacity: 0.48;
}
.lyric-original,
.lyric-translation {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lyric-original {
  font-size: 16px;
  line-height: 22px;
  font-weight: 600;
}
.lyric-translation {
  font-size: 11px;
  line-height: 16px;
  color: var(--lyrics-translation, #7b826f);
}
.is-animated .lyrics-track {
  transition: transform 0.45s ease;
}
.is-animated .lyric-content {
  transition:
    transform 0.45s ease,
    opacity 0.45s ease;
}
@media (prefers-reduced-motion: reduce) {
  .is-animated .lyrics-track,
  .is-animated .lyric-content {
    transition: none;
  }
}
</style>

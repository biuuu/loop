<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { ArrowUpToLine, GripVertical, X } from '@lucide/vue';
import type { Track } from '../shared/contracts';
import {
  keyboardPlaylistDrop,
  meaningfulPlaylistDrop,
  playlistDropAt,
  playlistSequenceMatches,
  type PlaylistDrop,
} from './playlist-drag';

const props = defineProps<{ tracks: Track[]; disabled?: boolean }>();
const emit = defineEmits<{
  move: [id: string, targetId: string, placement: 'before' | 'after'];
  top: [id: string];
  remove: [id: string];
}>();
const list = ref<HTMLOListElement | null>(null);
const instructionsId = useId();
const status = ref('');
const sourceId = ref<string | null>(null);
const drop = ref<PlaylistDrop | null>(null);
const ids = computed(() => props.tracks.map((track) => track.id));
let initialIds: string[] = [];
let mode: 'pointer' | 'keyboard' | null = null;
let pointerId: number | null = null;
let pointerX = 0;
let pointerY = 0;
let destination = 0;
let frame = 0;
let lastFrame = 0;
let dialog: HTMLDialogElement | null = null;

function title(id: string) {
  return props.tracks.find((track) => track.id === id)?.title ?? '歌曲';
}

function clearGesture() {
  const captured = pointerId;
  pointerId = null;
  mode = null;
  sourceId.value = null;
  drop.value = null;
  initialIds = [];
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
  if (captured !== null && list.value?.hasPointerCapture(captured)) {
    list.value.releasePointerCapture(captured);
  }
}

function cancel(message = '已取消排序。') {
  if (!mode) return;
  clearGesture();
  status.value = message;
}

function validGesture() {
  return (
    !props.disabled &&
    playlistSequenceMatches(initialIds, ids.value) &&
    (!dialog || dialog.open)
  );
}

function updatePointerDrop() {
  if (!sourceId.value || !list.value) return;
  const bounds = list.value.getBoundingClientRect();
  if (pointerX < bounds.left || pointerX > bounds.right) {
    drop.value = null;
    return;
  }
  const rows = Array.from(list.value.children).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: (element as HTMLElement).dataset.trackId!,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
  drop.value = meaningfulPlaylistDrop(
    ids.value,
    sourceId.value,
    playlistDropAt(rows, pointerY),
  );
}

function autoScroll(time: number) {
  if (mode !== 'pointer') return;
  if (!validGesture()) {
    cancel('歌单已更新，已取消排序。');
    return;
  }
  const scroller = list.value?.closest<HTMLElement>('.dialog-content');
  if (scroller && list.value) {
    const bounds = scroller.getBoundingClientRect();
    const listBounds = list.value.getBoundingClientRect();
    const top = Math.max(0, bounds.top, listBounds.top);
    const bottom = Math.min(
      window.innerHeight,
      bounds.bottom,
      listBounds.bottom,
    );
    const edge = Math.min(44, (bottom - top) / 2);
    let speed = 0;
    if (edge > 0 && pointerY < top + edge)
      speed = -Math.min(1, (top + edge - pointerY) / edge);
    else if (edge > 0 && pointerY > bottom - edge)
      speed = Math.min(1, (pointerY - bottom + edge) / edge);
    const elapsed = lastFrame ? Math.min(32, time - lastFrame) : 16;
    if (speed && pointerX >= listBounds.left && pointerX <= listBounds.right)
      scroller.scrollTop += (speed * 650 * elapsed) / 1000;
  }
  lastFrame = time;
  updatePointerDrop();
  frame = requestAnimationFrame(autoScroll);
}

function startPointer(event: PointerEvent, id: string) {
  if (props.disabled || !event.isPrimary || event.button !== 0) return;
  cancel();
  event.preventDefault();
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  initialIds = [...ids.value];
  sourceId.value = id;
  mode = 'pointer';
  pointerId = event.pointerId;
  pointerX = event.clientX;
  pointerY = event.clientY;
  try {
    list.value!.setPointerCapture(event.pointerId);
  } catch {
    cancel();
    return;
  }
  status.value = `正在移动《${title(id)}》，松开完成，Escape 取消。`;
  updatePointerDrop();
  frame = requestAnimationFrame(autoScroll);
}

function movePointer(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  event.preventDefault();
  pointerX = event.clientX;
  pointerY = event.clientY;
  updatePointerDrop();
}

function commit() {
  const id = sourceId.value;
  const target =
    id && validGesture()
      ? meaningfulPlaylistDrop(ids.value, id, drop.value)
      : null;
  const name = id ? title(id) : '';
  clearGesture();
  if (id && target) {
    status.value = `已提交《${name}》的排序。`;
    emit('move', id, target.targetId, target.placement);
  } else status.value = '顺序未改变。';
}

function endPointer(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  updatePointerDrop();
  commit();
}

function cancelPointer(event: PointerEvent) {
  if (event.pointerId === pointerId) cancel();
}

function losePointerCapture(event: PointerEvent) {
  if (event.target === list.value) cancelPointer(event);
}

function keyboard(event: KeyboardEvent, id: string) {
  if (props.disabled || mode === 'pointer') return;
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (mode === 'keyboard' && sourceId.value === id) {
      commit();
    } else {
      cancel();
      initialIds = [...ids.value];
      sourceId.value = id;
      mode = 'keyboard';
      destination = ids.value.indexOf(id);
      status.value = `已选中《${title(id)}》，使用上下方向键调整，空格或 Enter 完成，Escape 取消。`;
    }
  } else if (
    mode === 'keyboard' &&
    sourceId.value === id &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault();
    event.stopPropagation();
    destination = Math.max(
      0,
      Math.min(
        ids.value.length - 1,
        destination + (event.key === 'ArrowUp' ? -1 : 1),
      ),
    );
    drop.value = keyboardPlaylistDrop(ids.value, id, destination);
    status.value = `《${title(id)}》将移至第 ${destination + 1} 首，共 ${ids.value.length} 首。`;
    const target = list.value?.children[destination] as HTMLElement | undefined;
    target?.scrollIntoView({ block: 'nearest' });
  } else if (mode === 'keyboard' && event.key === 'Tab') {
    cancel();
  }
}

function escape(event: KeyboardEvent) {
  if (mode && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
}

function toFirst(id: string) {
  cancel();
  const first = ids.value[0];
  if (!props.disabled && first && first !== id) emit('top', id);
}

function remove(id: string) {
  cancel();
  if (!props.disabled) emit('remove', id);
}

function closeDialog() {
  cancel();
}
function blurWindow() {
  cancel();
}

watch(
  ids,
  (current) => {
    if (mode && !playlistSequenceMatches(initialIds, current))
      cancel('歌单已更新，已取消排序。');
  },
  { flush: 'sync' },
);
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) cancel();
  },
  { flush: 'sync' },
);

onMounted(() => {
  dialog = list.value?.closest('dialog') ?? null;
  dialog?.addEventListener('close', closeDialog);
  dialog?.addEventListener('cancel', closeDialog);
  window.addEventListener('keydown', escape, true);
  window.addEventListener('blur', blurWindow);
});
onBeforeUnmount(() => {
  clearGesture();
  dialog?.removeEventListener('close', closeDialog);
  dialog?.removeEventListener('cancel', closeDialog);
  window.removeEventListener('keydown', escape, true);
  window.removeEventListener('blur', blurWindow);
});
</script>

<template>
  <p :id="instructionsId" class="queue-sr-only">
    拖动把手调整顺序；键盘按空格或 Enter 选中，上下方向键调整，再按空格或 Enter
    完成，Escape 取消。
  </p>
  <p class="queue-sr-only" role="status" aria-live="polite" aria-atomic="true">
    {{ status }}
  </p>
  <ol
    ref="list"
    class="track-list playlist-queue"
    aria-label="播放队列"
    @pointermove="movePointer"
    @pointerup="endPointer"
    @pointercancel="cancelPointer"
    @lostpointercapture="losePointerCapture"
  >
    <li
      v-for="(track, index) in tracks"
      :key="track.id"
      :data-track-id="track.id"
      :class="{
        'queue-moving': sourceId === track.id,
        'queue-before':
          drop?.targetId === track.id && drop.placement === 'before',
        'queue-after':
          drop?.targetId === track.id && drop.placement === 'after',
      }"
    >
      <button
        class="queue-grip"
        :disabled="disabled || tracks.length < 2"
        :aria-label="`调整 ${track.title} 的顺序`"
        :aria-describedby="instructionsId"
        title="拖动调整顺序"
        @pointerdown="startPointer($event, track.id)"
        @keydown="keyboard($event, track.id)"
        @blur="mode === 'keyboard' && cancel()"
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span class="track-number">{{ String(index + 1).padStart(2, '0') }}</span>
      <div class="song-copy">
        <strong>{{ track.title }}</strong
        ><small>{{ track.artist }}</small>
      </div>
      <div class="track-actions">
        <button
          :disabled="disabled || index === 0"
          title="移到第一首"
          :aria-label="`移到第一首：${track.title}`"
          @click="toFirst(track.id)"
        >
          <ArrowUpToLine aria-hidden="true" />
        </button>
        <button
          :disabled="disabled"
          :aria-label="`移除 ${track.title}`"
          @click="remove(track.id)"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.playlist-queue li {
  position: relative;
}
.playlist-queue .queue-grip {
  min-width: 28px;
  padding: 4px 2px;
  background: transparent;
  color: var(--muted);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.playlist-queue .queue-grip:active {
  cursor: grabbing;
}
.playlist-queue .queue-grip:disabled {
  cursor: default;
}
.queue-moving .song-copy,
.queue-moving .track-number {
  opacity: 0.4;
}
.queue-before::before,
.queue-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 2px;
  background: #7d9365;
  pointer-events: none;
}
.queue-before::before {
  top: -1px;
}
.queue-after::after {
  bottom: -1px;
}
.queue-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>

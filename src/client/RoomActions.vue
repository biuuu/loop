<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  useId,
  watch,
} from 'vue';
import { ArrowDownRight, Ellipsis, Heart, Vote } from '@lucide/vue';
import type { TrackReactionKind } from '../shared/contracts';
import { useRoom } from './room';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ open: []; leave: [] }>();
const room = useRoom();
const id = useId();
const wrapper = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const opened = ref(false);
const playback = computed(() => room.snapshot?.playback);
const canReact = computed(
  () => !!playback.value && !!room.me?.connected && !room.reactionPending,
);
const canLike = computed(
  () =>
    canReact.value &&
    !room.likedTrack &&
    playback.value?.djId !== room.guest?.id,
);
const canVote = computed(() => canReact.value && !room.votedTrack);

function close(restoreFocus = false) {
  if (!opened.value) return;
  opened.value = false;
  if (restoreFocus) trigger.value?.focus();
}
async function toggle() {
  if (props.disabled) return;
  if (opened.value) return close();
  opened.value = true;
  emit('open');
  await nextTick();
  panel.value
    ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ?.focus();
}
function react(kind: TrackReactionKind) {
  if (props.disabled || !(kind === 'like' ? canLike.value : canVote.value))
    return;
  room.reactToTrack(kind);
  close(true);
}
function leaveStage() {
  if (props.disabled || !room.onStage) return;
  close(true);
  emit('leave');
}
function dismissOutside(event: PointerEvent | FocusEvent) {
  if (event.target instanceof Node && !wrapper.value?.contains(event.target))
    close();
}
function escape(event: KeyboardEvent) {
  if (opened.value && event.key === 'Escape') {
    event.preventDefault();
    close(true);
  }
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside, true);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissOutside, true);
  document.removeEventListener('focusin', dismissOutside, true);
  document.removeEventListener('keydown', escape);
});
</script>

<template>
  <div ref="wrapper" class="room-actions">
    <button
      ref="trigger"
      type="button"
      class="room-action-trigger"
      aria-haspopup="dialog"
      :aria-expanded="opened"
      :aria-controls="id"
      :disabled="disabled"
      @click="toggle"
    >
      <Ellipsis aria-hidden="true" /> 操作
    </button>
    <div
      v-if="opened"
      :id="id"
      ref="panel"
      class="room-action-popover"
      role="dialog"
      aria-label="客厅操作"
      aria-modal="false"
    >
      <button type="button" :disabled="!canLike" @click="react('like')">
        <Heart aria-hidden="true" />{{
          room.likedTrack ? '已点赞' : '点赞歌曲'
        }}
      </button>
      <button type="button" :disabled="!canVote" @click="react('vote')">
        <Vote aria-hidden="true" />{{ room.votedTrack ? '已投票' : '投票切歌' }}
      </button>
      <button v-if="room.onStage" type="button" @click="leaveStage">
        <ArrowDownRight aria-hidden="true" />离开舞台
      </button>
    </div>
  </div>
</template>

<style scoped>
.room-actions {
  position: relative;
  min-width: 0;
}
.room-action-trigger {
  width: 100%;
  height: 100%;
}
.room-action-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 1;
  display: grid;
  gap: 2px;
  width: max-content;
  min-width: 136px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #faf8ef;
  box-shadow: 0 6px 22px #28301c24;
}
.room-action-popover button {
  justify-content: flex-start;
  min-height: 38px;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 13px;
}
.room-action-popover button:hover:not(:disabled),
.room-action-popover button:focus-visible {
  background: #e7e9db;
}
.room-action-popover svg {
  width: 16px;
  height: 16px;
}
</style>

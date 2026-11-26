<script setup lang="ts">
import { Info } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, useId } from 'vue';
import {
  DAILY_DJ_REWARD,
  DAILY_DJ_THRESHOLD_MS,
  DAILY_LIKE_REWARD,
} from '../shared/points';

const id = useId();
const wrapper = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const tooltip = ref<HTMLElement | null>(null);
const open = ref(false);
const above = ref(false);
let hovered = false;

function show() {
  const panel = wrapper.value?.closest('.account-panel, .dialog-content');
  if (wrapper.value && tooltip.value && panel) {
    const anchor = wrapper.value.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const spaceBelow = bounds.bottom - anchor.bottom;
    above.value =
      spaceBelow < tooltip.value.offsetHeight &&
      anchor.top - bounds.top > spaceBelow;
  }
  open.value = true;
}
function enter(event: PointerEvent) {
  if (event.pointerType === 'touch') return;
  hovered = true;
  show();
}
function leave(event: PointerEvent) {
  if (event.pointerType === 'touch') return;
  hovered = false;
  if (!trigger.value?.matches(':focus-visible')) open.value = false;
}
function focus() {
  if (trigger.value?.matches(':focus-visible')) show();
}
function activate(event: MouseEvent) {
  if (event.detail === 0 || !open.value) show();
  else if (!hovered) open.value = false;
}
function dismissOutside(event: PointerEvent) {
  if (event.target instanceof Node && !wrapper.value?.contains(event.target))
    open.value = false;
}
function dismissOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  const dialog = wrapper.value?.closest('dialog');
  if (dialog && !dialog.contains(document.activeElement)) return;
  event.preventDefault();
  open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('keydown', dismissOnEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissOutside, true);
  document.removeEventListener('keydown', dismissOnEscape);
});
</script>

<template>
  <div
    ref="wrapper"
    class="points-rules"
    @pointerenter="enter"
    @pointerleave="leave"
  >
    <button
      ref="trigger"
      class="points-rules-trigger"
      type="button"
      aria-label="积分规则"
      :aria-describedby="id"
      @focus="focus"
      @blur="open = false"
      @click="activate"
    >
      <Info aria-hidden="true" />
    </button>
    <div
      :id="id"
      ref="tooltip"
      class="points-rules-tooltip"
      :class="{ open, above }"
      role="tooltip"
    >
      <div class="points-rules-text">
        每个账号按北京时间每天最多获得
        {{ DAILY_DJ_REWARD + DAILY_LIKE_REWARD }} 积分。
        <ul>
          <li>
            听歌和放歌合计超过 {{ DAILY_DJ_THRESHOLD_MS / 60_000 }} 分钟，得
            {{ DAILY_DJ_REWARD }} 积分。
          </li>
          <li>
            当天首次给歌曲点赞或收到歌曲点赞，得 {{ DAILY_LIKE_REWARD }} 积分。
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.points-rules {
  display: flex;
  flex: none;
  align-self: stretch;
  align-items: center;
  margin-inline-start: auto;
}
.points-rules-trigger {
  width: 32px;
  min-height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--sage);
}
.points-rules-trigger svg {
  width: 16px;
  height: 16px;
}
.points-rules-tooltip {
  position: absolute;
  z-index: 1;
  top: 100%;
  inset-inline-end: 0;
  width: min(100%, 290px);
  padding-top: 4px;
  visibility: hidden;
}
.points-rules-tooltip.open {
  visibility: visible;
}
.points-rules-tooltip.above {
  top: auto;
  bottom: 100%;
  padding: 0 0 4px;
}
.points-rules-text {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fffdf6;
  color: var(--ink);
  box-shadow: 0 5px 16px #333c2d21;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.points-rules-text ul {
  margin: 4px 0 0;
  padding-inline-start: 1.2em;
}
</style>

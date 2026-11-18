<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from 'vue';
import { Smile } from '@lucide/vue';
import { emoteCatalog, loadEmoteCatalog } from './emote-catalog';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ select: [id: string]; open: [] }>();
const panelId = useId();
const wrapper = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const opened = ref(false);
const selectedGroup = ref('');
const failed = ref(new Set<string>());
const loadError = ref('');
const catalog = emoteCatalog;
const groups = computed(() => catalog.value?.groups ?? []);
const group = computed(
  () =>
    groups.value.find((entry) => entry.id === selectedGroup.value) ??
    groups.value[0],
);

function close(restoreFocus = false) {
  if (!opened.value) return;
  opened.value = false;
  if (restoreFocus) trigger.value?.focus();
}
async function toggle() {
  if (props.disabled) return;
  if (opened.value) return close();
  if (!catalog.value) {
    try {
      await loadEmoteCatalog(true);
      loadError.value = '';
    } catch {
      loadError.value = '表情列表暂时不可用，点按钮可重试';
    }
  }
  if (catalog.value?.enabled === false) return;
  opened.value = true;
  emit('open');
  await nextTick();
  panel.value
    ?.querySelector<HTMLButtonElement>('.emote-option:not(:disabled)')
    ?.focus();
}
function select(id: string) {
  if (props.disabled || !catalog.value?.enabled || failed.value.has(id)) return;
  emit('select', id);
  close(true);
}
function failedImage(id: string) {
  failed.value = new Set(failed.value).add(id);
}
function outsidePointer(event: PointerEvent) {
  if (event.target instanceof Node && !wrapper.value?.contains(event.target))
    close();
}
function escape(event: KeyboardEvent) {
  if (opened.value && event.key === 'Escape') {
    event.preventDefault();
    close(true);
  }
}
function focusLeaving(event: FocusEvent) {
  if (
    !(event.relatedTarget instanceof Node) ||
    !wrapper.value?.contains(event.relatedTarget)
  )
    close();
}
watch(
  () => props.disabled || !catalog.value?.enabled,
  (disabled) => {
    if (disabled) close();
  },
);
watch(groups, (current) => {
  if (!current.some((entry) => entry.id === selectedGroup.value))
    selectedGroup.value = current[0]?.id ?? '';
});
watch(
  () => catalog.value?.revision,
  () => {
    failed.value = new Set();
  },
);
onMounted(() => {
  void loadEmoteCatalog().catch(() => {});
  document.addEventListener('pointerdown', outsidePointer, true);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outsidePointer, true);
  document.removeEventListener('keydown', escape);
});
</script>

<template>
  <div
    v-if="catalog?.enabled !== false"
    ref="wrapper"
    class="emote-picker"
    @focusout="focusLeaving"
  >
    <button
      ref="trigger"
      type="button"
      class="emote-trigger"
      aria-label="发送预设表情"
      aria-haspopup="dialog"
      :aria-expanded="opened"
      :aria-controls="panelId"
      :disabled="disabled"
      @click="toggle"
    >
      <Smile aria-hidden="true" /> <span>表情</span>
    </button>
    <div
      v-if="opened"
      :id="panelId"
      ref="panel"
      class="emote-popover"
      role="dialog"
      aria-label="选择表情"
      aria-modal="false"
    >
      <p v-if="loadError" class="emote-empty">{{ loadError }}</p>
      <div v-else class="emote-groups" role="tablist" aria-label="表情分组">
        <button
          v-for="entry in groups"
          :key="entry.id"
          type="button"
          role="tab"
          :aria-selected="group?.id === entry.id"
          :class="{ active: group?.id === entry.id }"
          @click="selectedGroup = entry.id"
        >
          {{ entry.label }}
        </button>
      </div>
      <div v-if="!loadError" class="emote-grid">
        <button
          v-for="(item, index) in group?.items ?? []"
          :key="item.id"
          type="button"
          class="emote-option"
          :title="
            failed.has(item.id)
              ? '图片暂不可用'
              : `${group?.label} ${index + 1}`
          "
          :aria-label="`${group?.label}表情 ${index + 1}`"
          :disabled="disabled || failed.has(item.id)"
          @click="select(item.id)"
        >
          <img
            v-if="!failed.has(item.id)"
            :src="item.url"
            loading="lazy"
            alt=""
            @error="failedImage(item.id)"
          />
          <span v-else class="emote-broken">不可用</span>
        </button>
        <p v-if="!group?.items.length" class="emote-empty">
          这个分组还没有表情
        </p>
      </div>
    </div>
  </div>
</template>

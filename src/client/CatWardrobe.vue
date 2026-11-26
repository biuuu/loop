<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Coins, LockKeyhole, X } from '@lucide/vue';
import {
  CAT_APPEARANCE_PRESETS,
  CAT_COATS,
  CAT_PATTERNS,
  DEFAULT_CAT_APPEARANCE,
  catAppearancePreset,
  type CatAppearance,
  type CatPresetPattern,
} from '../shared/appearance';
import { COAT_UNLOCK_COST, DAILY_DJ_THRESHOLD_MS } from '../shared/points';
import CatPreview from './CatPreview.vue';
import PointsRules from './PointsRules.vue';
import { useRoom } from './room';
import { useTimedMessage } from './timed-message';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const room = useRoom();
const dialog = ref<HTMLDialogElement | null>(null);
const opening = shallowRef<{ returnFocus: HTMLElement | null } | null>(null);
const error = useTimedMessage();
const appearanceTab = ref<'basic' | 'special'>('basic');
const basicAppearance = ref<CatAppearance>({ ...DEFAULT_CAT_APPEARANCE });
const specialAppearance = ref<
  (typeof CAT_APPEARANCE_PRESETS)[number]['appearance']
>(CAT_APPEARANCE_PRESETS[0].appearance);
const appearanceDraft = computed(() =>
  appearanceTab.value === 'basic'
    ? basicAppearance.value
    : specialAppearance.value,
);

function hasPreset(pattern: CatPresetPattern) {
  return (
    room.points?.freeSpecialCoats ||
    room.points?.unlockedPresets.includes(pattern) ||
    (!room.points && room.guest?.appearance?.pattern === pattern)
  );
}
const lockedPreset = computed(() => {
  const { pattern } = specialAppearance.value;
  return appearanceTab.value === 'special' && !hasPreset(pattern)
    ? pattern
    : undefined;
});
const missingPoints = computed(() =>
  room.points ? Math.max(0, COAT_UNLOCK_COST - room.points.balance) : 0,
);
const appearanceAction = shallowRef<{ kind: 'unlock' | 'save' } | null>(null);
const appearanceActionLabel = computed(() => {
  if (appearanceAction.value?.kind === 'unlock') return '正在解锁…';
  if (appearanceAction.value?.kind === 'save') return '正在保存…';
  return lockedPreset.value ? `解锁 · ${COAT_UNLOCK_COST} 积分` : '保存外观';
});
const dailyListeningTime = computed(() =>
  Math.min(room.points?.daily.playedMs ?? 0, DAILY_DJ_THRESHOLD_MS),
);
const pointsLoading = ref(false);
const pointsLoadFailed = ref(false);
const showingSpecial = computed(
  () => !!opening.value && appearanceTab.value === 'special',
);
let pointsRequest: object | null = null;

async function refreshPoints() {
  if (document.hidden || !showingSpecial.value || pointsRequest) return;
  const pending = {};
  pointsRequest = pending;
  pointsLoading.value = true;
  try {
    const loaded = await room.loadPoints();
    if (loaded && pointsRequest === pending) pointsLoadFailed.value = false;
  } catch {
    if (pointsRequest === pending) pointsLoadFailed.value = true;
  } finally {
    if (pointsRequest === pending) {
      pointsRequest = null;
      pointsLoading.value = false;
    }
  }
}
watch(
  showingSpecial,
  (showing, _, onCleanup) => {
    if (!showing) return;
    pointsLoadFailed.value = false;
    void refreshPoints();
    const interval = window.setInterval(refreshPoints, 30_000);
    document.addEventListener('visibilitychange', refreshPoints);
    onCleanup(() => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshPoints);
      pointsRequest = null;
      pointsLoading.value = false;
    });
  },
  { flush: 'sync' },
);

function hideDialog() {
  const focus = opening.value?.returnFocus;
  opening.value = null;
  error.value = '';
  if (dialog.value?.open) dialog.value.close();
  if (focus?.isConnected) focus.focus({ preventScroll: true });
}
function closeWardrobe() {
  hideDialog();
  emit('close');
}
function onDialogClose() {
  if (opening.value && !dialog.value?.open) closeWardrobe();
}
function outsideDialog(event: MouseEvent) {
  const element = dialog.value;
  if (!element || event.target !== element) return;
  const bounds = element.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    closeWardrobe();
}

watch(
  [() => props.open, dialog],
  ([open, element]) => {
    if (!open) {
      hideDialog();
      return;
    }
    if (!element || element.open || !room.guest) return;
    const saved =
      room.guest.appearance ?? room.me?.appearance ?? DEFAULT_CAT_APPEARANCE;
    const preset = catAppearancePreset(saved.pattern);
    basicAppearance.value = {
      coat: saved.coat,
      pattern: preset ? 'solid' : saved.pattern,
    };
    specialAppearance.value =
      preset?.appearance ?? CAT_APPEARANCE_PRESETS[0].appearance;
    appearanceTab.value = preset ? 'special' : 'basic';
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.showModal();
    opening.value = { returnFocus };
  },
  { flush: 'post' },
);
watch(
  [() => room.guest?.id, () => room.roomGeneration],
  () => {
    appearanceAction.value = null;
    if (props.open) closeWardrobe();
  },
  { flush: 'sync' },
);
onBeforeUnmount(hideDialog);

async function applyAppearance() {
  const panel = opening.value;
  if (!panel || !props.open || appearanceAction.value) return;
  const pattern = lockedPreset.value;
  if (pattern && (!room.points || missingPoints.value)) return;
  const currentPanel = () => opening.value === panel && props.open;
  const action = { kind: pattern ? 'unlock' : 'save' } as const;
  appearanceAction.value = action;
  error.value = '';
  try {
    if (pattern) await room.unlockAppearance(pattern);
    else if (
      (await room.setAppearance({ ...appearanceDraft.value })) &&
      currentPanel()
    )
      closeWardrobe();
  } catch (cause) {
    if (currentPanel()) {
      error.value =
        cause instanceof Error
          ? cause.message
          : pattern
            ? '解锁花色失败，请重试'
            : '保存外观失败，请重试';
      if (pattern) void refreshPoints();
    }
  } finally {
    if (appearanceAction.value === action) appearanceAction.value = null;
  }
}
function time(ms: number) {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}
</script>

<template>
  <dialog
    ref="dialog"
    class="room-dialog"
    aria-labelledby="cat-wardrobe-title"
    @cancel.prevent="closeWardrobe"
    @click="outsideDialog"
    @close="onDialogClose"
  >
    <header class="dialog-header">
      <div>
        <span class="eyebrow">MAKE YOURSELF AT HOME</span>
        <h2 id="cat-wardrobe-title">我的小猫</h2>
      </div>
      <button
        class="close-button"
        type="button"
        aria-label="关闭面板"
        autofocus
        @click="closeWardrobe"
      >
        <X aria-hidden="true" />
      </button>
    </header>
    <div v-if="open" class="dialog-content">
      <form
        id="cat-wardrobe-form"
        class="cat-wardrobe"
        @submit.prevent="applyAppearance"
      >
        <div
          class="segmented-tabs wardrobe-tabs"
          role="group"
          aria-label="花色类型"
        >
          <button
            type="button"
            :class="{ selected: appearanceTab === 'basic' }"
            :aria-pressed="appearanceTab === 'basic'"
            :disabled="!!appearanceAction"
            @click="appearanceTab = 'basic'"
          >
            普通花色
          </button>
          <button
            type="button"
            :class="{ selected: appearanceTab === 'special' }"
            :aria-pressed="appearanceTab === 'special'"
            :disabled="!!appearanceAction"
            @click="appearanceTab = 'special'"
          >
            特殊花色
          </button>
        </div>
        <div class="cat-preview-card">
          <CatPreview :appearance="appearanceDraft" />
        </div>
        <p v-if="room.pointsReward" class="wardrobe-reward" role="status">
          {{ room.pointsReward }}
        </p>
        <div
          v-if="appearanceTab === 'special'"
          class="wardrobe-points"
          aria-label="积分"
        >
          <div class="wardrobe-points-heading">
            <strong v-if="room.points">
              <Coins aria-hidden="true" />{{ room.points.balance }} 积分
            </strong>
            <p v-else-if="pointsLoading" role="status">正在加载积分…</p>
            <PointsRules />
          </div>
          <template v-if="room.points">
            <p v-if="room.points.daily.awarded">今日听歌与放歌积分已到账</p>
            <template v-else>
              <p>
                今日听歌与放歌 {{ time(dailyListeningTime) }} /
                {{ time(DAILY_DJ_THRESHOLD_MS) }}
              </p>
              <progress
                :value="dailyListeningTime"
                :max="DAILY_DJ_THRESHOLD_MS"
                aria-label="今日听歌与放歌累计时长"
              />
            </template>
          </template>
          <p v-if="pointsLoadFailed" role="status">
            积分加载失败。
            <button
              class="text-button"
              type="button"
              :disabled="pointsLoading"
              @click="refreshPoints"
            >
              重试
            </button>
          </p>
        </div>
        <fieldset
          v-if="appearanceTab === 'basic'"
          :disabled="!!appearanceAction"
        >
          <legend>毛色</legend>
          <div class="cat-options">
            <label
              v-for="coat in CAT_COATS"
              :key="coat.id"
              class="cat-option"
              :class="{ selected: basicAppearance.coat === coat.id }"
            >
              <input
                v-model="basicAppearance.coat"
                type="radio"
                name="cat-coat"
                :value="coat.id"
              />
              <span
                class="coat-swatch"
                :style="{ backgroundColor: coat.color }"
                aria-hidden="true"
              />
              {{ coat.label }}
            </label>
          </div>
        </fieldset>
        <fieldset
          v-else
          :disabled="!!appearanceAction"
          aria-label="特殊花色预设"
        >
          <div class="cat-options">
            <label
              v-for="preset in CAT_APPEARANCE_PRESETS"
              :key="preset.appearance.pattern"
              class="cat-option"
              :class="{
                selected:
                  specialAppearance.pattern === preset.appearance.pattern,
              }"
            >
              <input
                type="radio"
                name="special-cat-coat"
                :value="preset.appearance.pattern"
                :checked="
                  specialAppearance.pattern === preset.appearance.pattern
                "
                @change="specialAppearance = preset.appearance"
              />
              <span
                class="coat-swatch"
                :style="{ background: preset.swatch }"
                aria-hidden="true"
              />
              {{ preset.label }}
              <span
                v-if="!hasPreset(preset.appearance.pattern)"
                class="cat-option-cost"
              >
                <LockKeyhole aria-hidden="true" />{{ COAT_UNLOCK_COST }}
                积分
              </span>
            </label>
          </div>
        </fieldset>
        <fieldset
          v-if="appearanceTab === 'basic'"
          :disabled="!!appearanceAction"
        >
          <legend>花纹</legend>
          <div class="cat-options">
            <label
              v-for="pattern in CAT_PATTERNS"
              :key="pattern.id"
              class="cat-option"
              :class="{ selected: basicAppearance.pattern === pattern.id }"
            >
              <input
                v-model="basicAppearance.pattern"
                type="radio"
                name="cat-pattern"
                :value="pattern.id"
              />
              {{ pattern.label }}
            </label>
          </div>
        </fieldset>
        <p v-if="!lockedPreset" class="library-hint">
          保存后房间里的大家都能看到，下次回来也会保留。
        </p>
      </form>
    </div>
    <p v-if="error" class="dialog-error" role="alert">
      {{ error }}
      <button class="text-button" type="button" @click="error = ''">
        关闭提示
      </button>
    </p>
    <footer class="wardrobe-footer">
      <p v-if="lockedPreset && missingPoints" class="library-hint">
        解锁还差 {{ missingPoints }} 积分。
      </p>
      <div class="confirm-actions">
        <button type="button" @click="closeWardrobe">取消</button>
        <button
          class="primary"
          type="submit"
          form="cat-wardrobe-form"
          :disabled="
            !!appearanceAction ||
            !!(lockedPreset && (!room.points || missingPoints))
          "
        >
          {{ appearanceActionLabel }}
        </button>
      </div>
    </footer>
  </dialog>
</template>

<style scoped>
.wardrobe-over-account::backdrop {
  backdrop-filter: none;
}
.wardrobe-points-heading {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wardrobe-footer {
  flex: none;
  padding: 12px 26px 16px;
  border-top: 1px solid var(--line);
}
.wardrobe-footer .confirm-actions {
  flex-wrap: wrap;
  margin: 0;
}
.wardrobe-footer .library-hint {
  margin: 0 0 8px;
}
@media (max-width: 650px) {
  .wardrobe-footer {
    padding-inline: 20px;
  }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Coins, LockKeyhole, X } from '@lucide/vue';
import {
  ACCESSORY_UNLOCK_COST,
  CAT_ACCESSORY_COLORS,
  CAT_ACCESSORY_SAMPLES,
  type CatAccessories,
  type CatAccessoryColor,
  type CatAccessoryId,
  type CatAccessorySlot,
} from '../shared/accessories';
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
const wardrobeTab = ref<'basic' | 'special' | 'accessories'>('basic');
const basicAppearance = ref<CatAppearance>({ ...DEFAULT_CAT_APPEARANCE });
const specialAppearance = ref<
  (typeof CAT_APPEARANCE_PRESETS)[number]['appearance']
>(CAT_APPEARANCE_PRESETS[0].appearance);
const savedAppearance = computed(
  () => room.guest?.appearance ?? room.me?.appearance ?? DEFAULT_CAT_APPEARANCE,
);
const savedAccessories = computed(
  () => room.guest?.accessories ?? room.me?.accessories ?? {},
);
const accessoryDraft = shallowRef<CatAccessories>({});
const wardrobeAction = shallowRef<{ kind: 'unlock' | 'save' } | null>(null);
const showingAccessories = computed(() => wardrobeTab.value === 'accessories');
const previewAppearance = computed(() => {
  if (showingAccessories.value) return savedAppearance.value;
  return wardrobeTab.value === 'basic'
    ? basicAppearance.value
    : specialAppearance.value;
});
const previewPoses = [
  { animation: 'idle', flipX: false, label: '待机' },
  { animation: 'side', flipX: false, label: '向左走' },
  { animation: 'side', flipX: true, label: '向右走' },
  { animation: 'up', flipX: false, label: '向上走' },
  { animation: 'down', flipX: false, label: '向下走' },
  { animation: 'sleep', flipX: false, label: '睡觉' },
] as const;
const previewPose = shallowRef<(typeof previewPoses)[number]>(previewPoses[0]);
const accessoryGroups = (
  [
    { slot: 'head', label: '头顶' },
    { slot: 'chest', label: '胸前' },
    { slot: 'tail', label: '尾巴' },
  ] as const
).map(({ slot, label }) => ({
  slot,
  label,
  samples: CAT_ACCESSORY_SAMPLES.filter((sample) => sample.slot === slot),
}));
const preferredAccessory = ref<CatAccessoryId>();
const accessoryColors = computed(() => {
  const id = accessoryDraft.value.chest?.id;
  if (id === 'bow' || id === 'scarf') return CAT_ACCESSORY_COLORS[id];
  return [];
});
function selectAccessory(slot: CatAccessorySlot, id?: CatAccessoryId) {
  if (wardrobeAction.value) return;
  preferredAccessory.value = id;
  if (accessoryDraft.value[slot]?.id === id) return;
  const next = { ...accessoryDraft.value };
  if (!id) {
    delete next[slot];
  } else {
    const saved = savedAccessories.value[slot];
    next[slot] = saved?.id === id ? { ...saved } : { id };
  }
  accessoryDraft.value = next;
}
function selectAccessoryColor(color: CatAccessoryColor) {
  const choice = accessoryDraft.value.chest;
  if (!wardrobeAction.value && choice)
    accessoryDraft.value = {
      ...accessoryDraft.value,
      chest: { ...choice, color },
    };
}
function hasAccessory(id: CatAccessoryId) {
  return (
    room.points?.unlockedAccessories?.includes(id) ||
    Object.values(savedAccessories.value).some((item) => item?.id === id)
  );
}
const lockedAccessory = computed(() => {
  const locked = CAT_ACCESSORY_SAMPLES.filter(
    ({ id, slot }) =>
      accessoryDraft.value[slot]?.id === id && !hasAccessory(id),
  );
  return locked.find(({ id }) => id === preferredAccessory.value) ?? locked[0];
});
const accessoryPreview = computed(() =>
  showingAccessories.value ? previewPose.value : undefined,
);

function hasPreset(pattern: CatPresetPattern) {
  return (
    room.points?.freeSpecialCoats ||
    room.points?.unlockedPresets.includes(pattern) ||
    (!room.points && room.guest?.appearance?.pattern === pattern)
  );
}
const wardrobeLock = computed(() => {
  if (showingAccessories.value) {
    const accessory = lockedAccessory.value;
    return accessory ? { accessory, cost: ACCESSORY_UNLOCK_COST } : undefined;
  }
  const { pattern } = specialAppearance.value;
  return wardrobeTab.value === 'special' && !hasPreset(pattern)
    ? { pattern, cost: COAT_UNLOCK_COST }
    : undefined;
});
const missingPoints = computed(() =>
  room.points && wardrobeLock.value
    ? Math.max(0, wardrobeLock.value.cost - room.points.balance)
    : 0,
);
const wardrobeActionLabel = computed(() => {
  if (wardrobeAction.value?.kind === 'unlock') return '正在解锁…';
  if (wardrobeAction.value?.kind === 'save') return '正在保存…';
  const lock = wardrobeLock.value;
  if (lock?.accessory) return `解锁${lock.accessory.label} · ${lock.cost} 积分`;
  if (lock) return `解锁 · ${lock.cost} 积分`;
  return showingAccessories.value ? '保存饰品' : '保存外观';
});
const dailyListeningTime = computed(() =>
  Math.min(room.points?.daily.playedMs ?? 0, DAILY_DJ_THRESHOLD_MS),
);
const pointsLoading = ref(false);
const pointsLoadFailed = ref(false);
const showingPoints = computed(
  () => !!opening.value && wardrobeTab.value !== 'basic',
);
let pointsRequest: object | null = null;

async function refreshPoints() {
  if (document.hidden || !showingPoints.value || pointsRequest) return;
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
  showingPoints,
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
  previewPose.value = previewPoses[0];
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
    const saved = savedAppearance.value;
    const preset = catAppearancePreset(saved.pattern);
    basicAppearance.value = {
      coat: saved.coat,
      pattern: preset ? 'solid' : saved.pattern,
    };
    specialAppearance.value =
      preset?.appearance ?? CAT_APPEARANCE_PRESETS[0].appearance;
    accessoryDraft.value = { ...savedAccessories.value };
    preferredAccessory.value = undefined;
    wardrobeTab.value = preset ? 'special' : 'basic';
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
    wardrobeAction.value = null;
    if (props.open) closeWardrobe();
  },
  { flush: 'sync' },
);
onBeforeUnmount(hideDialog);

async function applyWardrobe() {
  const panel = opening.value;
  if (!panel || !props.open || wardrobeAction.value) return;
  const lock = wardrobeLock.value;
  if (lock && (!room.points || missingPoints.value)) return;
  const currentPanel = () => opening.value === panel && props.open;
  const action = { kind: lock ? 'unlock' : 'save' } as const;
  const isAccessory = showingAccessories.value;
  wardrobeAction.value = action;
  error.value = '';
  try {
    if (lock?.accessory) {
      await room.unlockAccessory(lock.accessory.id);
    } else if (lock?.pattern) {
      await room.unlockAppearance(lock.pattern);
    } else {
      const saved = isAccessory
        ? await room.setAccessories({ ...accessoryDraft.value })
        : await room.setAppearance({ ...previewAppearance.value });
      if (saved) {
        if (currentPanel()) closeWardrobe();
        else if (isAccessory && opening.value)
          accessoryDraft.value = { ...savedAccessories.value };
      }
    }
  } catch (cause) {
    if (currentPanel()) {
      error.value =
        cause instanceof Error
          ? cause.message
          : lock
            ? '解锁失败，请重试'
            : isAccessory
              ? '保存饰品失败，请重试'
              : '保存外观失败，请重试';
      if (lock) void refreshPoints();
    }
  } finally {
    if (wardrobeAction.value === action) wardrobeAction.value = null;
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
        @submit.prevent="applyWardrobe"
      >
        <div
          class="segmented-tabs wardrobe-tabs"
          role="group"
          aria-label="小猫衣柜"
        >
          <button
            type="button"
            :class="{ selected: wardrobeTab === 'basic' }"
            :aria-pressed="wardrobeTab === 'basic'"
            :disabled="!!wardrobeAction"
            @click="wardrobeTab = 'basic'"
          >
            普通花色
          </button>
          <button
            type="button"
            :class="{ selected: wardrobeTab === 'special' }"
            :aria-pressed="wardrobeTab === 'special'"
            :disabled="!!wardrobeAction"
            @click="wardrobeTab = 'special'"
          >
            特殊花色
          </button>
          <button
            type="button"
            :class="{ selected: showingAccessories }"
            :aria-pressed="showingAccessories"
            :disabled="!!wardrobeAction"
            @click="wardrobeTab = 'accessories'"
          >
            饰品
          </button>
        </div>
        <div class="cat-preview-card">
          <CatPreview
            :appearance="previewAppearance"
            :accessories="
              showingAccessories ? accessoryDraft : savedAccessories
            "
            :accessory-preview="accessoryPreview"
          />
        </div>
        <div
          v-if="showingAccessories"
          class="segmented-tabs accessory-poses"
          role="group"
          aria-label="试戴姿势"
        >
          <button
            v-for="pose in previewPoses"
            :key="pose.label"
            type="button"
            :class="{ selected: previewPose === pose }"
            :aria-pressed="previewPose === pose"
            @click="previewPose = pose"
          >
            {{ pose.label }}
          </button>
        </div>
        <p v-if="room.pointsReward" class="wardrobe-reward" role="status">
          {{ room.pointsReward }}
        </p>
        <div
          v-if="wardrobeTab !== 'basic'"
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
        <template v-if="showingAccessories">
          <template v-for="group in accessoryGroups" :key="group.slot">
            <fieldset class="accessory-options" :disabled="!!wardrobeAction">
              <legend>{{ group.label }}</legend>
              <div class="cat-options">
                <label
                  class="cat-option"
                  :class="{ selected: !accessoryDraft[group.slot] }"
                >
                  <input
                    type="radio"
                    :name="`cat-accessory-${group.slot}`"
                    value=""
                    :checked="!accessoryDraft[group.slot]"
                    @change="selectAccessory(group.slot)"
                  />
                  不佩戴
                </label>
                <label
                  v-for="sample in group.samples"
                  :key="sample.id"
                  class="cat-option"
                  :class="{
                    selected: accessoryDraft[group.slot]?.id === sample.id,
                  }"
                >
                  <input
                    type="radio"
                    :name="`cat-accessory-${group.slot}`"
                    :value="sample.id"
                    :checked="accessoryDraft[group.slot]?.id === sample.id"
                    @click="selectAccessory(group.slot, sample.id)"
                    @change="selectAccessory(group.slot, sample.id)"
                  />
                  {{ sample.label }}
                  <span v-if="!hasAccessory(sample.id)" class="cat-option-cost">
                    <LockKeyhole aria-hidden="true" />{{
                      ACCESSORY_UNLOCK_COST
                    }}
                    积分
                  </span>
                </label>
              </div>
            </fieldset>
            <fieldset
              v-if="group.slot === 'chest' && accessoryColors.length"
              class="accessory-options accessory-colors"
              :disabled="!!wardrobeAction"
            >
              <legend>配色</legend>
              <div class="cat-options">
                <label
                  v-for="color in accessoryColors"
                  :key="color.id"
                  class="cat-option"
                  :class="{
                    selected:
                      (accessoryDraft.chest?.color ?? 'default') === color.id,
                  }"
                >
                  <input
                    type="radio"
                    name="cat-accessory-color"
                    :value="color.id"
                    :checked="
                      (accessoryDraft.chest?.color ?? 'default') === color.id
                    "
                    @change="selectAccessoryColor(color.id)"
                  />
                  <span
                    class="coat-swatch"
                    :style="{ backgroundColor: color.swatch }"
                    aria-hidden="true"
                  />
                  {{ color.label }}
                </label>
              </div>
            </fieldset>
          </template>
        </template>
        <fieldset v-if="wardrobeTab === 'basic'" :disabled="!!wardrobeAction">
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
          v-if="wardrobeTab === 'special'"
          :disabled="!!wardrobeAction"
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
        <fieldset v-if="wardrobeTab === 'basic'" :disabled="!!wardrobeAction">
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
        <p v-if="!wardrobeLock" class="library-hint">
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
      <p v-if="wardrobeLock && missingPoints" class="library-hint">
        解锁还差 {{ missingPoints }} 积分。
      </p>
      <div class="confirm-actions">
        <button type="button" @click="closeWardrobe">取消</button>
        <button
          class="primary"
          type="submit"
          form="cat-wardrobe-form"
          :disabled="
            !!wardrobeAction ||
            !!(wardrobeLock && (!room.points || missingPoints))
          "
        >
          {{ wardrobeActionLabel }}
        </button>
      </div>
    </footer>
  </dialog>
</template>

<style scoped>
.wardrobe-over-account::backdrop {
  backdrop-filter: none;
}
.cat-wardrobe .accessory-options {
  margin-block: 16px;
}
.accessory-options .cat-option {
  padding: 7px 9px;
}
.accessory-colors legend {
  color: var(--muted);
  font-size: 13px;
}
.accessory-colors .coat-swatch {
  width: 16px;
  height: 16px;
}
.accessory-poses {
  width: 100%;
  margin-top: 12px;
  grid-auto-flow: row;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
@media (min-width: 520px) {
  .accessory-poses {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
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

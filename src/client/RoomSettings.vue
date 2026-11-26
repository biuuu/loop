<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { X } from '@lucide/vue';
import { request, useRoom } from './room';
import {
  DEFAULT_STAGE_TIME_LIMIT_MINUTES,
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  MAX_STAGE_TIME_LIMIT_MINUTES,
  ROOM_DESCRIPTION_LIMIT,
  type RoomDetails,
  type RoomInfo,
} from '../shared/contracts';
import EnvironmentPicker from './EnvironmentPicker.vue';
const props = defineProps<{ info?: RoomInfo }>();
const emit = defineEmits<{ close: [] }>();
const room = useRoom();
const dialog = ref<HTMLDialogElement | null>(null);
let returnFocus: HTMLElement | null = null;
onMounted(() => {
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dialog.value?.showModal();
  dialog.value?.querySelector<HTMLElement>('input, button')?.focus();
  void act(loadSettings);
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus();
});
const info = props.info ?? room.roomInfo!;
const name = ref(info.name);
const description = ref(info.description ?? '');
const joinPolicy = ref(info.joinPolicy);
const stageCapacity = ref(info.stageCapacity);
const stageTimeLimit = ref(
  info.stageTimeLimitMinutes ?? DEFAULT_STAGE_TIME_LIMIT_MINUTES,
);
const trackTimeLimit = ref(
  info.trackTimeLimitMinutes ?? DEFAULT_TRACK_TIME_LIMIT_MINUTES,
);
const stageTimePresets = [
  0,
  5,
  15,
  30,
  ...Array.from(
    { length: MAX_STAGE_TIME_LIMIT_MINUTES / 60 },
    (_, index) => (index + 1) * 60,
  ),
];
const trackTimePresets = [
  0,
  3,
  5,
  DEFAULT_TRACK_TIME_LIMIT_MINUTES,
  15,
  20,
  30,
  45,
  60,
];
function timeLimitOptions(presets: number[], selected: number) {
  return presets.includes(selected)
    ? presets
    : [...presets, selected].sort((a, b) => a - b);
}
const stageTimeOptions = computed(() =>
  timeLimitOptions(stageTimePresets, stageTimeLimit.value),
);
const trackTimeOptions = computed(() =>
  timeLimitOptions(trackTimePresets, trackTimeLimit.value),
);
function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
const environmentId = ref(info.environmentId);
const occupiedStageCount = computed(() =>
  room.roomId === info.id && room.connection === 'connected'
    ? (room.snapshot?.stage.length ?? 0)
    : 0,
);
const stageCapacityError = computed(() =>
  stageCapacity.value < occupiedStageCount.value
    ? `台上目前有 ${occupiedStageCount.value} 只猫，请先让部分成员下台，再将舞台缩减为 ${stageCapacity.value} 个位置。`
    : '',
);
const revision = ref(info.revision);
const busy = ref(false);
const loaded = ref(false);
const error = useTimedMessage();
const notice = useTimedMessage();
const base = `/api/rooms/${encodeURIComponent(info.id)}`;
async function act(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await task();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败';
  } finally {
    busy.value = false;
  }
}
function applySettings(settings: RoomDetails) {
  name.value = settings.name;
  description.value = settings.description;
  joinPolicy.value = settings.joinPolicy;
  stageCapacity.value = settings.stageCapacity;
  stageTimeLimit.value =
    settings.stageTimeLimitMinutes ?? DEFAULT_STAGE_TIME_LIMIT_MINUTES;
  trackTimeLimit.value =
    settings.trackTimeLimitMinutes ?? DEFAULT_TRACK_TIME_LIMIT_MINUTES;
  environmentId.value = settings.environmentId;
  revision.value = settings.revision;
}
async function loadSettings() {
  const data = await request<{ room: RoomDetails }>(`${base}/settings`);
  applySettings(data.room);
  loaded.value = true;
}
function save() {
  if (!loaded.value || stageCapacityError.value) return;
  void act(async () => {
    const data = await request<{ room: RoomDetails }>(base, {
      method: 'PATCH',
      body: JSON.stringify({
        name: name.value.trim(),
        description: description.value,
        environmentId: environmentId.value,
        joinPolicy: joinPolicy.value,
        stageCapacity: stageCapacity.value,
        stageTimeLimitMinutes: stageTimeLimit.value,
        trackTimeLimitMinutes: trackTimeLimit.value,
        expectedRevision: revision.value,
      }),
    });
    if (
      room.roomId === info.id &&
      (!room.roomInfo || data.room.revision >= room.roomInfo.revision)
    )
      room.roomInfo = data.room;
    applySettings(data.room);
    notice.value = '房间设置已保存';
  });
}
</script>
<template>
  <dialog
    aria-labelledby="settings-title"
    ref="dialog"
    class="panel-backdrop"
    @click.self="emit('close')"
    @cancel.prevent="emit('close')"
  >
    <form class="settings-panel panel-form" @submit.prevent="save">
      <header class="panel-heading">
        <h2 id="settings-title">房间设置</h2>
        <button type="button" aria-label="关闭房间设置" @click="emit('close')">
          <X />
        </button>
      </header>
      <div class="settings-fields">
        <label>
          房间名称
          <input
            v-model="name"
            minlength="1"
            maxlength="32"
            :disabled="busy"
            required
          />
        </label>
        <div class="description-field">
          <label>
            房间简介
            <textarea
              v-model="description"
              rows="3"
              :maxlength="ROOM_DESCRIPTION_LIMIT"
              :disabled="busy || !loaded"
              aria-describedby="settings-description-hint"
            />
          </label>
          <small id="settings-description-hint">
            <span>仅在房间内可见，可留空。</span>
            <span>{{ description.length }} / {{ ROOM_DESCRIPTION_LIMIT }}</span>
          </small>
        </div>
        <EnvironmentPicker v-model="environmentId" :disabled="busy" />
        <fieldset class="stage-capacity-picker">
          <legend>舞台位置</legend>
          <div class="stage-capacity-options">
            <label v-for="count in 6" :key="count">
              <input
                v-model.number="stageCapacity"
                type="radio"
                name="stage-capacity"
                :value="count"
                :disabled="busy || count < occupiedStageCount"
              />
              <span>{{ count }} 位</span>
            </label>
          </div>
        </fieldset>
        <p class="library-hint">
          可设置 1–6 个位置；缩减前请先让超出人数的成员下台。
        </p>
        <label>
          台上时限
          <select
            v-model.number="stageTimeLimit"
            :disabled="busy || !loaded"
            aria-describedby="stage-time-limit-hint"
          >
            <option
              v-for="minutes in stageTimeOptions"
              :key="minutes"
              :value="minutes"
            >
              {{ minutes === 0 ? '播一首后下台' : durationLabel(minutes) }}
            </option>
          </select>
          <small id="stage-time-limit-hint">
            从上台开始计时，达到时限后，会在自己的歌曲结束时自动下台。
          </small>
        </label>
        <label>
          单曲播放上限
          <select
            v-model.number="trackTimeLimit"
            :disabled="busy || !loaded"
            aria-describedby="track-time-limit-hint"
          >
            <option
              v-for="minutes in trackTimeOptions"
              :key="minutes"
              :value="minutes"
            >
              {{ minutes === 0 ? '不限制' : durationLabel(minutes) }}
            </option>
          </select>
          <small id="track-time-limit-hint">
            当前曲目播到上限后自动切歌。修改从下一首起生效。
          </small>
        </label>
        <label class="toggle-switch">
          <span>暂停新访客进入</span>
          <input
            v-model="joinPolicy"
            type="checkbox"
            role="switch"
            :aria-checked="joinPolicy === 'closed'"
            true-value="closed"
            false-value="open"
            :disabled="busy"
          />
          <span class="switch-track" aria-hidden="true"
            ><span class="switch-thumb"
          /></span>
        </label>
        <p class="library-hint">已有成员及短时重连不受影响，房主仍可进入。</p>
      </div>
      <footer class="settings-footer">
        <p v-if="notice" role="status">{{ notice }}</p>
        <p v-if="stageCapacityError || error" class="form-error" role="alert">
          {{ stageCapacityError || error }}
        </p>
        <button
          v-if="loaded"
          type="submit"
          class="primary"
          :disabled="busy || !!stageCapacityError"
        >
          {{ busy ? '正在保存…' : '保存设置' }}
        </button>
        <button
          v-else
          type="button"
          class="primary"
          :disabled="busy"
          @click="act(loadSettings)"
        >
          {{ busy ? '正在加载…' : '重试加载' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.settings-panel.panel-form {
  --settings-gutter: 28px;
  gap: 0;
  margin: 0;
  overflow: hidden;
  padding: 0;
}
.panel-heading {
  flex: none;
  margin: 0;
  padding: 18px var(--settings-gutter) 10px;
}
.settings-fields {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px var(--settings-gutter) 18px;
}
.settings-fields > * {
  flex-shrink: 0;
}
.settings-footer {
  display: grid;
  flex: none;
  gap: 8px;
  padding: 12px var(--settings-gutter) 16px;
  border-top: 1px solid var(--line);
}
.settings-footer p {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .settings-panel.panel-form {
    --settings-gutter: 20px;
  }
}
.description-field textarea {
  resize: vertical;
}
.description-field small {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}
</style>

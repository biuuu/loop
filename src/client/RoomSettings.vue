<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { X } from '@lucide/vue';
import { request, useRoom } from './room';
import type { RoomInfo } from '../shared/contracts';
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
  void act(reload);
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus();
});
const info = props.info ?? room.roomInfo!;
const name = ref(info.name);
const joinPolicy = ref(info.joinPolicy);
const stageCapacity = ref(info.stageCapacity);
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
function applySettings(settings: RoomInfo) {
  name.value = settings.name;
  joinPolicy.value = settings.joinPolicy;
  stageCapacity.value = settings.stageCapacity;
  environmentId.value = settings.environmentId;
  revision.value = settings.revision;
}
async function reload() {
  const data = await request<{ room: RoomInfo }>(base);
  applySettings(data.room);
}
function save() {
  if (stageCapacityError.value) {
    error.value = stageCapacityError.value;
    return;
  }
  void act(async () => {
    const data = await request<{ room: RoomInfo }>(base, {
      method: 'PATCH',
      body: JSON.stringify({
        name: name.value.trim(),
        environmentId: environmentId.value,
        joinPolicy: joinPolicy.value,
        stageCapacity: stageCapacity.value,
        expectedRevision: revision.value,
      }),
    });
    if (room.roomId === info.id) room.roomInfo = data.room;
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
    <section class="settings-panel" aria-labelledby="settings-title">
      <header class="panel-heading">
        <h2 id="settings-title">房间设置</h2>
        <button aria-label="关闭房间设置" @click="emit('close')"><X /></button>
      </header>
      <form class="panel-form" @submit.prevent="save">
        <label
          >房间名称<input v-model="name" minlength="1" maxlength="32" required
        /></label>
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
        <p v-if="stageCapacityError" class="form-error" role="alert">
          {{ stageCapacityError }}
        </p>
        <p v-else class="library-hint">
          可设置 1–6 个位置；缩减前请先让超出人数的成员下台。
        </p>
        <label class="room-join-switch">
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
        <button
          type="submit"
          class="primary"
          :disabled="busy || !!stageCapacityError"
        >
          保存设置
        </button>
        <button type="button" :disabled="busy" @click="act(reload)">
          刷新设置
        </button>
      </form>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>
  </dialog>
</template>

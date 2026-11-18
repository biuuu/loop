<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { X } from '@lucide/vue';
import { request, useRoom } from './room';
import type { RoomInfo, Participant } from '../shared/contracts';
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
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (returnFocus?.isConnected) returnFocus.focus();
});
const info = props.info ?? room.roomInfo!;
const fetchedMembers = ref<Participant[]>([]);
const inRoom = computed(
  () => room.roomId === info.id && room.connection === 'connected',
);
const members = computed(() =>
  inRoom.value ? (room.snapshot?.users ?? []) : fetchedMembers.value,
);
const name = ref(info.name);
const joinPolicy = ref(info.joinPolicy);
const stageCapacity = ref(info.stageCapacity);
const environmentId = ref(info.environmentId);
const occupiedStageCount = computed(
  () => members.value.filter((user) => user.seat !== null).length,
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
const bans = ref<{ userId: string; nickname?: string }[]>([]);
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
async function loadMembers() {
  if (!inRoom.value)
    fetchedMembers.value = (
      await request<{ users: Participant[] }>(`${base}/members`)
    ).users;
}
async function reload() {
  const data = await request<{ room: RoomInfo }>(base);
  name.value = data.room.name;
  joinPolicy.value = data.room.joinPolicy;
  stageCapacity.value = data.room.stageCapacity;
  environmentId.value = data.room.environmentId;
  revision.value = data.room.revision;
  await Promise.all([loadMembers(), loadBans()]);
}
async function loadBans() {
  bans.value = (
    await request<{ bans: { userId: string; nickname?: string }[] }>(
      `${base}/bans`,
    )
  ).bans;
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
    revision.value = data.room.revision;
    name.value = data.room.name;
    joinPolicy.value = data.room.joinPolicy;
    stageCapacity.value = data.room.stageCapacity;
    environmentId.value = data.room.environmentId;
    notice.value = '房间设置已保存';
  });
}
function moderate(event: 'stage:remove' | 'member:kick', userId: string) {
  if (
    event === 'member:kick' &&
    !window.confirm('将这位成员移出房间？对方之后仍可以重新进入。')
  )
    return;
  void act(async () => {
    if (inRoom.value) {
      if (!(await room.moderate(event, userId)))
        throw new Error(room.error || '操作失败');
    } else {
      await request(
        `${base}/members/${encodeURIComponent(userId)}/${event === 'member:kick' ? 'kick' : 'leave-stage'}`,
        { method: 'POST' },
      );
      await loadMembers();
    }
    notice.value = event === 'stage:remove' ? '已让该成员下台' : '已移出房间';
  });
}
function ban(userId: string) {
  if (
    !window.confirm(
      '封禁这位成员？对方将被移出，并且无法再次进入本房间，直到你解除封禁。',
    )
  )
    return;
  void act(async () => {
    await request(`${base}/bans`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    await Promise.all([loadBans(), loadMembers()]);
    notice.value = '已封禁该成员';
  });
}
function unban(userId: string) {
  void act(async () => {
    await request(`${base}/bans/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    await loadBans();
  });
}
onMounted(() => {
  void act(reload);
});
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
        <button class="primary" :disabled="busy || !!stageCapacityError">
          保存设置
        </button>
      </form>
      <div class="panel-heading">
        <h3>成员管理</h3>
        <button :disabled="busy" @click="act(reload)">刷新资料与成员</button>
      </div>
      <ul class="management-list">
        <li
          v-for="user in members.filter((user) => user.id !== room.guest?.id)"
          :key="user.id"
        >
          <span>{{ user.nickname }}{{ !user.connected ? ' · 暂离' : '' }}</span>
          <div>
            <button
              v-if="user.seat !== null"
              :disabled="busy"
              @click="moderate('stage:remove', user.id)"
            >
              下台</button
            ><button :disabled="busy" @click="moderate('member:kick', user.id)">
              移出</button
            ><button :disabled="busy" @click="ban(user.id)">封禁</button>
          </div>
        </li>
      </ul>
      <h3>本房间封禁</h3>
      <p v-if="!bans.length" class="library-hint">暂无封禁成员。</p>
      <ul class="management-list">
        <li v-for="user in bans" :key="user.userId">
          <span>{{ user.nickname || user.userId }}</span
          ><button :disabled="busy" @click="unban(user.userId)">
            解除封禁
          </button>
        </li>
      </ul>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>
  </dialog>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { request, useRoom } from './room';
import type { RoomInfo } from '../shared/contracts';
import { accountEntryRoute, createNavigation, type Route } from './navigation';
import { watchDeploymentVersion } from './deployment-version';
import RoomView from './RoomView.vue';
import RoomDirectory from './RoomDirectory.vue';
import AccountPanel from './AccountPanel.vue';
import RoomSettings from './RoomSettings.vue';
import CatPreview from './CatPreview.vue';
import AdminNetease from './AdminNetease.vue';
import AdminEmotes from './AdminEmotes.vue';
import { DEFAULT_CAT_APPEARANCE } from '../shared/appearance';
import { ChevronRight, UserRound } from '@lucide/vue';
const room = useRoom();
const booting = ref(true);
const accountOpen = ref(false);
const settingsOpen = ref(false);
const settingsInfo = ref<RoomInfo | null>(null);
const leaveDialog = ref<HTMLDialogElement | null>(null);
let pendingLeave: Promise<boolean> | undefined;
let resolveLeave: ((confirmed: boolean) => void) | undefined;
function settleLeave(confirmed: boolean) {
  if (leaveDialog.value?.open) leaveDialog.value.close();
  const resolve = resolveLeave;
  resolveLeave = undefined;
  pendingLeave = undefined;
  resolve?.(confirmed);
}
function confirmStageExit(): Promise<boolean> {
  if (pendingLeave) return pendingLeave;
  if (!leaveDialog.value) return Promise.resolve(false);
  pendingLeave = new Promise<boolean>((resolve) => {
    resolveLeave = resolve;
  });
  leaveDialog.value.showModal();
  return pendingLeave;
}
function openSettings(info: RoomInfo | null = room.roomInfo) {
  settingsInfo.value = info;
  settingsOpen.value = !!info;
}
const target = ref<Route>({ kind: 'directory' });
let navigation: ReturnType<typeof createNavigation>;
let deploymentVersion: ReturnType<typeof watchDeploymentVersion>;
let navigationGeneration = 0;
let leaving = false;
function currentRoute(): Route {
  return room.roomId
    ? {
        kind: 'room',
        roomId:
          room.roomInfo?.number !== undefined
            ? String(room.roomInfo.number)
            : room.roomId,
      }
    : { kind: 'directory' };
}
async function navigate(route: Route, fromPop = false) {
  const generation = ++navigationGeneration;
  if (
    route.kind === 'room' &&
    (room.roomId === route.roomId ||
      String(room.roomInfo?.number) === route.roomId) &&
    room.connection === 'connected'
  ) {
    settleLeave(false);
    room.cancelPendingEntry();
    target.value = currentRoute();
    navigation.write(target.value, true);
    return;
  }
  if (room.onStage) {
    if (fromPop) navigation.write(currentRoute(), true);
    if (!(await confirmStageExit()) || generation !== navigationGeneration)
      return;
  }
  target.value = route;
  if (route.kind !== 'room') {
    leaving = true;
    await room.leave();
    leaving = false;
    if (generation !== navigationGeneration) return;
    settingsOpen.value = false;
    navigation.write(route, fromPop);
    return;
  }
  if (!room.guest) {
    if (!fromPop) navigation.write(route);
    accountOpen.value = true;
    return;
  }
  let internalId = route.roomId;
  let canonical = route;
  room.cancelPendingEntry();
  try {
    // Resolve public numbers before admission. Socket state continues to use
    // stable internal IDs so room events and ownership never mix namespaces.
    if (route.roomId !== '__test__') {
      const data = await request<{ room: RoomInfo }>(
        `/api/rooms/${encodeURIComponent(route.roomId)}`,
      );
      if (generation !== navigationGeneration) return;
      internalId = data.room.id;
      canonical = { kind: 'room', roomId: String(data.room.number) };
    }
  } catch (cause) {
    if (generation !== navigationGeneration) return;
    room.error = cause instanceof Error ? cause.message : '房间加载失败';
    target.value = currentRoute();
    if (fromPop) navigation.write(target.value, true);
    return;
  }
  const admitted = await room.connect(internalId);
  if (generation !== navigationGeneration) return;
  if (admitted) {
    target.value = canonical;
    navigation.write(canonical, fromPop);
  } else {
    target.value = currentRoute();
    if (fromPop) navigation.write(currentRoute(), true);
  }
}
function enter(id: string) {
  void navigate({ kind: 'room', roomId: id });
}
function accountChanged(createdRoom?: RoomInfo) {
  settingsOpen.value = false;
  if (room.guest) {
    const destination = accountEntryRoute(target.value, createdRoom);
    if (destination.kind === 'room') void navigate(destination);
  } else {
    navigationGeneration++;
    target.value = { kind: 'directory' };
    navigation.write(target.value, true);
  }
}
watch(
  () => room.roomId,
  (value, previous) => {
    if (previous && !value) settleLeave(false);
    if (previous && !value && !leaving) {
      settingsOpen.value = false;
      // An account change may reconnect to its requested address; explicit removal returns home.
      if (!accountOpen.value) {
        target.value = { kind: 'directory' };
        navigation.write(target.value, true);
      }
    }
  },
);
watch(
  () => room.connection,
  (connection, previous) => {
    if (previous === 'disconnected' && connection === 'connected')
      void deploymentVersion?.check();
  },
);
onMounted(async () => {
  navigation = createNavigation(window, (route) => {
    void navigate(route, true);
  });
  target.value = navigation.current();
  deploymentVersion = watchDeploymentVersion(
    typeof __LOOP_BUILD_ID__ === 'undefined' ? undefined : __LOOP_BUILD_ID__,
  );
  try {
    await room.initialize();
    if (target.value.kind === 'room') await navigate(target.value, true);
  } catch (cause) {
    room.error = cause instanceof Error ? cause.message : '无法连接服务';
  } finally {
    booting.value = false;
  }
});
onBeforeUnmount(() => {
  deploymentVersion?.close();
  navigationGeneration++;
  settleLeave(false);
  navigation?.close();
  room.close();
});
</script>
<template>
  <main v-if="booting" class="welcome"><h1>客厅正在醒来…</h1></main>
  <RoomView
    v-else-if="room.roomId"
    :key="room.roomId"
    :panel-open="accountOpen || settingsOpen"
    @leave="navigate({ kind: 'directory' })"
    @settings="openSettings()"
  />
  <AdminNetease
    v-else-if="target.kind === 'admin-netease'"
    @back="navigate({ kind: 'directory' })"
  />
  <AdminEmotes
    v-else-if="target.kind === 'admin-emotes'"
    @back="navigate({ kind: 'directory' })"
  />
  <div v-else class="app-shell">
    <header class="site-header directory-site-header">
      <div class="directory-header-brand">
        <a
          class="brand"
          href="/"
          @click.prevent="navigate({ kind: 'directory' })"
          >LOOP<span class="brand-dot">.</span></a
        >
        <span class="directory-header-caption">一起，把日子听慢一点</span>
      </div>
      <button class="directory-user-button" @click="accountOpen = true">
        <span class="directory-user-avatar" aria-hidden="true">
          <CatPreview
            v-if="room.guest"
            :appearance="room.guest.appearance ?? DEFAULT_CAT_APPEARANCE"
            portrait
          />
          <UserRound v-else />
        </span>
        <span class="directory-user-copy">
          <small>{{ room.guest ? '我的账号' : '欢迎来到 LOOP' }}</small>
          <strong>{{ room.guest?.nickname || '用昵称进入' }}</strong>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
    </header>
    <RoomDirectory
      @enter="enter"
      @account="accountOpen = true"
      @settings="openSettings"
    />
    <div v-if="room.error" class="toast" role="alert">
      <span>{{ room.error }}</span
      ><button @click="room.error = ''">关闭</button>
    </div>
  </div>
  <AccountPanel
    v-if="accountOpen"
    @close="accountOpen = false"
    @changed="accountChanged"
  />
  <RoomSettings
    v-if="settingsOpen && settingsInfo?.ownerId === room.guest?.id"
    :info="settingsInfo ?? undefined"
    @close="settingsOpen = false"
  />
  <dialog
    ref="leaveDialog"
    class="room-dialog confirm-dialog"
    aria-labelledby="leave-dialog-title"
    aria-describedby="leave-dialog-description"
    @cancel.prevent="settleLeave(false)"
    @click="($event) => $event.target === leaveDialog && settleLeave(false)"
  >
    <header class="dialog-header">
      <div>
        <span class="eyebrow">暂别客厅</span>
        <h2 id="leave-dialog-title">返回大厅？</h2>
      </div>
    </header>
    <div class="dialog-content confirmation">
      <p id="leave-dialog-description">
        你还在舞台上。返回大厅会离开当前房间和舞台。
      </p>
      <div class="confirm-actions">
        <button type="button" autofocus @click="settleLeave(false)">
          再听一会
        </button>
        <button type="button" class="primary" @click="settleLeave(true)">
          返回大厅
        </button>
      </div>
    </div>
  </dialog>
</template>

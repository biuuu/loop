<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { ArrowLeft, ListMusic, Shuffle, X } from '@lucide/vue';
import { randomNickname } from './nicknames';
import {
  PLAYLIST_LIMIT,
  nicknameSchema,
  type NeteasePlaylist,
  type NeteaseUser,
  type RoomInfo,
} from '../shared/contracts';
import NeteaseUserSearch from './NeteaseUserSearch.vue';
import { useRoom } from './room';
const emit = defineEmits<{ close: []; changed: [createdRoom?: RoomInfo] }>();
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
const nickname = ref(randomNickname());
const editingNickname = ref(false);
const nicknameDraft = ref('');
const nicknameInput = ref<HTMLInputElement | null>(null);
const nicknameDisplay = ref<HTMLElement | null>(null);
const nicknameEditButton = ref<HTMLButtonElement | null>(null);
const nicknameWaitUntil = ref<number>();
const nicknameTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const entryMode = ref<'nickname' | 'netease'>('nickname');
const selectedSource = ref<{
  user: NeteaseUser;
  playlist: NeteasePlaylist;
  offset: number;
} | null>(null);
const importedNickname = ref('');
const importedNicknameInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = useTimedMessage();
const notice = useTimedMessage();
watch(
  () => room.guest?.nicknameChangeAvailableAt,
  (availableAt, _previous, onCleanup) => {
    const remaining = (availableAt ?? 0) - Date.now();
    nicknameWaitUntil.value = remaining > 0 ? availableAt : undefined;
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      nicknameWaitUntil.value = undefined;
    }, remaining);
    onCleanup(() => clearTimeout(timer));
  },
  { immediate: true },
);
function shuffleNickname() {
  if (busy.value) return;
  nickname.value = randomNickname(nickname.value);
  error.value = '';
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试';
  } finally {
    busy.value = false;
  }
}
function editNickname() {
  if (!room.guest || busy.value || nicknameWaitUntil.value !== undefined)
    return;
  nicknameDraft.value = room.guest.nickname;
  error.value = '';
  notice.value = '';
  editingNickname.value = true;
  void nextTick(() => {
    nicknameInput.value?.focus();
    nicknameInput.value?.select();
  });
}
function cancelNicknameEdit() {
  editingNickname.value = false;
  error.value = '';
  void nextTick(() => {
    if (nicknameEditButton.value?.disabled) nicknameDisplay.value?.focus();
    else nicknameEditButton.value?.focus();
  });
}
function saveNickname() {
  if (nicknameWaitUntil.value !== undefined) return;
  void act(async () => {
    const valid = nicknameSchema.safeParse(nicknameDraft.value);
    if (!valid.success)
      throw new Error(
        nicknameDraft.value.trim()
          ? valid.error.issues[0]?.message || '请输入有效的昵称'
          : '请输入昵称',
      );
    if (!(await room.setNickname(valid.data))) return;
    editingNickname.value = false;
    notice.value = '昵称已保存';
    void nextTick(() => nicknameDisplay.value?.focus());
  });
}
function temporary() {
  void act(async () => {
    const valid = nicknameSchema.safeParse(nickname.value);
    if (!valid.success)
      throw new Error(valid.error.issues[0]?.message || '请输入昵称');
    const createdRoom = await room.enter(valid.data);
    emit('changed', createdRoom);
    emit('close');
  });
}
function selectNeteasePlaylist(
  user: NeteaseUser,
  playlist: NeteasePlaylist,
  offset: number,
) {
  selectedSource.value = { user, playlist, offset };
  importedNickname.value = user.nickname;
  error.value = '';
  void nextTick(() => importedNicknameInput.value?.focus());
}
function createFromNetease() {
  void act(async () => {
    const source = selectedSource.value;
    if (!source) throw new Error('请先选择一份网易云歌单');
    const valid = nicknameSchema.safeParse(importedNickname.value);
    if (!valid.success)
      throw new Error(valid.error.issues[0]?.message || '请调整昵称后重试');
    const createdRoom = await room.enterFromNetease(
      source.user.id,
      source.playlist.id,
      valid.data,
      source.offset,
    );
    emit('changed', createdRoom);
    emit('close');
  });
}
function logout(all = false) {
  void act(async () => {
    await room.logout(all);
    emit('changed');
    emit('close');
  });
}
</script>
<template>
  <dialog
    aria-labelledby="account-title"
    ref="dialog"
    class="panel-backdrop"
    @click.self="emit('close')"
    @cancel.prevent="emit('close')"
  >
    <section
      class="account-panel"
      :class="{
        'account-panel--netease': !room.guest && entryMode === 'netease',
      }"
      aria-labelledby="account-title"
    >
      <header class="panel-heading">
        <h2 id="account-title">{{ room.guest ? '我的账号' : '走进 Loop' }}</h2>
        <button aria-label="关闭账号面板" @click="emit('close')"><X /></button>
      </header>
      <template v-if="room.guest">
        <div class="account-nickname">
          <strong ref="nicknameDisplay" tabindex="-1">{{
            room.guest.nickname
          }}</strong>
          <button
            v-if="!editingNickname"
            ref="nicknameEditButton"
            type="button"
            :disabled="busy || nicknameWaitUntil !== undefined"
            @click="editNickname"
          >
            修改昵称
          </button>
        </div>
        <form
          v-if="editingNickname"
          class="panel-form"
          @submit.prevent="saveNickname"
        >
          <label for="account-nickname">新昵称</label>
          <input
            id="account-nickname"
            ref="nicknameInput"
            v-model="nicknameDraft"
            maxlength="16"
            autocomplete="nickname"
            :readonly="busy"
            required
          />
          <small v-if="nicknameWaitUntil === undefined"
            >两次昵称修改需间隔 7 天。</small
          >
          <div class="account-nickname-actions">
            <button
              type="submit"
              class="primary"
              :disabled="busy || nicknameWaitUntil !== undefined"
            >
              {{ busy ? '正在保存…' : '保存昵称' }}
            </button>
            <button type="button" :disabled="busy" @click="cancelNicknameEdit">
              取消
            </button>
          </div>
        </form>
        <p v-if="nicknameWaitUntil !== undefined" class="library-hint">
          下次可在 {{ nicknameTimeFormat.format(nicknameWaitUntil) }} 修改昵称。
        </p>
        <p class="library-hint">此浏览器会记住当前身份、歌单和房间。</p>
      </template>
      <div
        v-if="!room.guest"
        class="segmented-tabs"
        role="group"
        aria-label="创建身份方式"
      >
        <button
          type="button"
          :class="{ selected: entryMode === 'nickname' }"
          :aria-pressed="entryMode === 'nickname'"
          :disabled="busy"
          @click="
            entryMode = 'nickname';
            error = '';
          "
        >
          自取昵称
        </button>
        <button
          type="button"
          :class="{ selected: entryMode === 'netease' }"
          :aria-pressed="entryMode === 'netease'"
          :disabled="busy"
          @click="
            entryMode = 'netease';
            error = '';
          "
        >
          从网易云导入
        </button>
      </div>
      <form
        v-if="!room.guest && entryMode === 'nickname'"
        class="panel-form"
        @submit.prevent="temporary"
      >
        <label for="temporary-nickname">大家怎么称呼你？</label>
        <div class="nickname-input-row">
          <input
            id="temporary-nickname"
            v-model="nickname"
            maxlength="16"
            autocomplete="nickname"
            :disabled="busy"
            required
            placeholder="给自己取个昵称"
          />
          <button
            type="button"
            :disabled="busy"
            aria-label="生成随机昵称"
            title="换一个随机昵称"
            @click="shuffleNickname"
          >
            <Shuffle aria-hidden="true" />随机
          </button>
        </div>
        <button class="primary" :disabled="busy">
          {{ busy ? '正在进入…' : '以临时身份进入' }}
        </button>
        <small
          >创建身份时会自动拥有一间房。浏览器会记住你和你的歌单；同名昵称不能找回旧身份。</small
        >
      </form>
      <div
        v-if="!room.guest && entryMode === 'netease'"
        class="account-netease"
      >
        <template v-if="selectedSource">
          <button
            type="button"
            class="account-source-back"
            :disabled="busy"
            @click="
              selectedSource = null;
              error = '';
            "
          >
            <ArrowLeft aria-hidden="true" />重新选歌单
          </button>
          <div class="account-source-summary">
            <span class="account-source-icon"
              ><ListMusic aria-hidden="true"
            /></span>
            <span>
              <strong>{{ selectedSource.playlist.name }}</strong>
              <small
                >{{ selectedSource.user.nickname }} ·
                {{ selectedSource.playlist.trackCount }} 首</small
              >
            </span>
          </div>
          <form class="panel-form" @submit.prevent="createFromNetease">
            <label for="netease-nickname">进入 LOOP 时使用的昵称</label>
            <input
              id="netease-nickname"
              ref="importedNicknameInput"
              v-model="importedNickname"
              autocomplete="nickname"
              :disabled="busy"
              required
            />
            <small>
              默认使用网易云昵称。若昵称超过 16
              字或含不支持的符号，请调整后创建；这不会绑定网易云账号。
            </small>
            <button class="primary" :disabled="busy">
              {{ busy ? '正在创建并导入…' : '创建身份并导入歌单' }}
            </button>
            <small>
              将导入所选歌单前 {{ PLAYLIST_LIMIT }}
              首中的可用歌曲，并自动创建你的房间。
            </small>
          </form>
        </template>
        <div v-show="!selectedSource">
          <p class="library-hint">搜索网易云用户，选择一份歌单创建身份。</p>
          <NeteaseUserSearch
            :operation="busy"
            select-playlist
            @selected="selectNeteasePlaylist"
          />
        </div>
      </div>
      <div v-if="room.guest" class="panel-actions">
        <button :disabled="busy" @click="logout()">退出当前身份</button
        ><button
          v-if="room.guest.registered"
          :disabled="busy"
          @click="logout(true)"
        >
          退出所有设备
        </button>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>
  </dialog>
</template>

<style scoped>
.account-panel--netease {
  width: min(100%, 560px);
}
.account-nickname,
.account-nickname-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.account-nickname {
  justify-content: space-between;
}
.account-nickname strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.account-nickname button {
  flex: 0 0 auto;
}
.account-netease {
  margin-top: 20px;
}
.account-netease > .library-hint {
  margin: 0;
}
.account-source-back {
  gap: 6px;
  min-height: 0;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}
.account-source-back svg {
  width: 15px;
  height: 15px;
}
.account-source-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  margin-top: 14px;
  padding: 13px;
  border-radius: 12px;
  background: #f2f4e9;
}
.account-source-icon {
  display: grid;
  flex: 0 0 42px;
  height: 42px;
  place-items: center;
  border-radius: 9px;
  background: #e1e9d6;
  color: #526449;
}
.account-source-summary > span:last-child {
  min-width: 0;
}
.account-source-summary strong,
.account-source-summary small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-source-summary strong {
  font-size: 14px;
}
.account-source-summary small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
}
.nickname-input-row {
  display: flex;
  gap: 8px;
}
.nickname-input-row input {
  flex: 1;
  min-width: 0;
  width: 0;
}
.nickname-input-row button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 10px 12px;
}
</style>

<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { createKeyboardMovement, movementPosition } from './keyboard-movement';
import { playlistView } from './playlist-view';
import { neteaseCover } from './netease-cover';
import RoomScene from './RoomScene.vue';
import RoomMembers from './RoomMembers.vue';
import CatPreview from './CatPreview.vue';
import NeteasePlaylistSearch from './NeteasePlaylistSearch.vue';
import NeteaseUserSearch from './NeteaseUserSearch.vue';
import EmotePicker from './EmotePicker.vue';
import PlaylistQueue from './PlaylistQueue.vue';
import {
  CALICO_APPEARANCE,
  CAT_COATS,
  CAT_PATTERNS,
  DEFAULT_CAT_APPEARANCE,
  type CatAppearance,
} from '../shared/appearance';
import {
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Disc3,
  Info,
  Music2,
  Pin,
  Plus,
  Search,
  Settings2,
  SkipForward,
  Users,
  Volume2,
  VolumeX,
  X,
} from '@lucide/vue';
const directions = [
  { icon: ArrowLeft, label: '左', x: -50, y: 0 },
  { icon: ArrowUp, label: '上', x: 0, y: -40 },
  { icon: ArrowDown, label: '下', x: 0, y: 40 },
  { icon: ArrowRight, label: '右', x: 50, y: 0 },
];
import { request, useRoom } from './room';
import { useAudio } from './audio';
import {
  DEFAULT_STAGE_CAPACITY,
  PLAYLIST_COUNT_LIMIT,
  PLAYLIST_LIMIT,
  SCENE,
  type Track,
} from '../shared/contracts';

const props = defineProps<{ panelOpen?: boolean }>();
const emit = defineEmits<{ leave: []; settings: [] }>();
const room = useRoom();
const systemNotice = useTimedMessage();
watch(
  () => room.snapshot?.notice,
  (notice) => {
    systemNotice.value = notice ?? '';
  },
  { immediate: true },
);
const mobileControlsQuery = window.matchMedia(
  '(max-width: 650px), (hover: none) and (pointer: coarse)',
);
const mobileControls = ref(mobileControlsQuery.matches);
function updateMobileControls(event: MediaQueryListEvent) {
  mobileControls.value = event.matches;
}
const sound = useAudio(() => mobileControls.value);
const { issue, volume, progress, needsGesture } = sound;
const booting = ref(false);
const tab = ref<'playlist' | 'search'>('playlist');
const searchKind = ref<'song' | 'playlist' | 'user'>('song');
const playlistFull = computed(() => room.playlist.length >= PLAYLIST_LIMIT);
const query = ref('');
const results = ref<Track[]>([]);
const searching = ref(false);
const searched = ref(false);
let searchVersion = 0;
const operation = ref(false);
const playback = computed(() => room.snapshot?.playback);
const duration = computed(() => playback.value?.durationMs ?? 0);
const elapsed = computed(() => duration.value * progress.value);
const seekKey = computed(() =>
  room.canSeek ? `${room.roomGeneration}:${playback.value?.roundId}` : '',
);
const seekPreview = ref<number | null>(null);
const pendingSeek = shallowRef<{ position: number } | null>(null);
const shownPosition = computed(() =>
  Math.min(
    duration.value,
    Math.max(
      elapsed.value,
      seekPreview.value ?? 0,
      pendingSeek.value?.position ?? 0,
    ),
  ),
);
const seekValue = computed(() => Math.floor(shownPosition.value));
watch(
  seekKey,
  () => {
    seekPreview.value = null;
    pendingSeek.value = null;
  },
  { flush: 'sync' },
);
const canSkip = computed(() => {
  const guestId = room.guest?.id;
  return !!(
    guestId &&
    playback.value &&
    (playback.value.djId === guestId || room.roomInfo?.ownerId === guestId)
  );
});
const failedCover = ref('');
const stageCapacity = computed(
  () => room.snapshot?.stageCapacity ?? DEFAULT_STAGE_CAPACITY,
);
const stageFull = computed(
  () => (room.snapshot?.stage.length ?? 0) >= stageCapacity.value,
);
const playlistDisplay = computed(() =>
  playlistView(room.playlist, room.guest?.id, playback.value),
);
const dj = computed(() =>
  room.snapshot?.users.find((user) => user.id === playback.value?.djId),
);
const status = computed(
  () =>
    ({
      connecting: '正在连接',
      connected: '房间已连接',
      disconnected: '连接中断 · 正在重连',
      replaced: '已在另一个标签页进入',
    })[room.connection],
);
const roomDescription = computed(() => {
  const info = room.roomInfo;
  return room.connection === 'connected' &&
    room.me?.connected &&
    info?.id === room.roomId &&
    info.ownerId !== room.guest?.id
    ? (info.description ?? '')
    : '';
});
function focusIntroduction(event: PointerEvent) {
  if (
    event.pointerType === 'touch' &&
    event.currentTarget instanceof HTMLElement
  )
    event.currentTarget.focus({ preventScroll: true });
}
type Modal = 'library' | 'members' | 'appearance';
const modal = ref<Modal | null>(null);
const appearanceDraft = ref<CatAppearance>({ ...DEFAULT_CAT_APPEARANCE });
const coatChoice = computed({
  get: () =>
    appearanceDraft.value.pattern === CALICO_APPEARANCE.pattern
      ? CALICO_APPEARANCE.pattern
      : appearanceDraft.value.coat,
  set: (choice: CatAppearance['coat'] | typeof CALICO_APPEARANCE.pattern) => {
    const pattern = appearanceDraft.value.pattern;
    appearanceDraft.value =
      choice === CALICO_APPEARANCE.pattern
        ? { ...CALICO_APPEARANCE }
        : {
            coat: choice,
            pattern: pattern === CALICO_APPEARANCE.pattern ? 'solid' : pattern,
          };
  },
});
const appearanceSaving = ref(false);
const dialog = ref<HTMLDialogElement | null>(null);
let returnFocus: HTMLElement | null = null;
const modalTitle = computed(
  () =>
    ({
      library: '你的音乐角落',
      members: '客厅成员',
      appearance: '我的小猫',
    })[modal.value || 'library'],
);
const interactionDisabled = computed(() =>
  Boolean(props.panelOpen || modal.value || room.stagePending),
);
function closeModal() {
  dialog.value?.close();
  modal.value = null;
  nextTick(() => returnFocus?.focus());
}
async function openModal(value: Modal) {
  resetMovement();
  if (!modal.value)
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  modal.value = value;
  await nextTick();
  if (modal.value === value && !dialog.value?.open) dialog.value?.showModal();
}
function openLibrary(value: 'playlist' | 'search') {
  tab.value = value;
  void openModal('library');
}
function openAppearance() {
  appearanceDraft.value = {
    ...(room.guest?.appearance ??
      room.me?.appearance ??
      DEFAULT_CAT_APPEARANCE),
  };
  room.error = '';
  void openModal('appearance');
}
async function saveAppearance() {
  if (appearanceSaving.value) return;
  appearanceSaving.value = true;
  room.error = '';
  try {
    await room.setAppearance({ ...appearanceDraft.value });
    if (modal.value === 'appearance') closeModal();
  } catch (error) {
    room.error =
      error instanceof Error ? error.message : '保存外观失败，请重试';
  } finally {
    appearanceSaving.value = false;
  }
}
async function requestJoin() {
  if (
    room.stagePending ||
    room.onStage ||
    room.connection !== 'connected' ||
    stageFull.value
  )
    return;
  if (!room.playlist.length) {
    room.error = '先找一首喜欢的歌，加入歌单后再上台。';
    openLibrary('search');
    return;
  }
  await room.joinStage();
}
async function requestLeave() {
  if (!room.onStage || room.stagePending || room.connection !== 'connected')
    return;
  await room.leaveStage();
}
function outsideDialog(event: MouseEvent) {
  if (!dialog.value || event.target !== dialog.value) return;
  const bounds = dialog.value.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    closeModal();
}
async function act(task: () => Promise<unknown>) {
  if (operation.value) return;
  operation.value = true;
  try {
    await task();
  } catch (err) {
    room.error = err instanceof Error ? err.message : '操作失败，请重试';
  } finally {
    operation.value = false;
  }
}
async function search() {
  if (!query.value.trim()) return;
  const version = ++searchVersion;
  searching.value = true;
  searched.value = true;
  room.error = '';
  try {
    const data = await request<{ tracks: Track[] }>(
      `/api/search?q=${encodeURIComponent(query.value.trim())}`,
    );
    if (version === searchVersion) results.value = data.tracks;
  } catch (err) {
    if (version === searchVersion) {
      results.value = [];
      room.error = err instanceof Error ? err.message : '搜索失败';
    }
  } finally {
    if (version === searchVersion) searching.value = false;
  }
}
function time(ms: number) {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}
function activeSeekInput(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  return seekKey.value && input.dataset.seekKey === seekKey.value
    ? input
    : null;
}
function previewSeek(event: Event) {
  const input = activeSeekInput(event);
  if (!input) return;
  seekPreview.value = input.valueAsNumber;
  if (input.valueAsNumber < seekValue.value)
    input.valueAsNumber = seekValue.value;
}
function resetSeekPreview(event: Event) {
  const input = activeSeekInput(event);
  if (!input) return;
  seekPreview.value = null;
  input.valueAsNumber = seekValue.value;
}
async function commitSeek(value: number) {
  const current = playback.value;
  const position = Math.min(value, duration.value);
  if (
    !current ||
    !room.canSeek ||
    position <= Math.max(elapsed.value, pendingSeek.value?.position ?? 0)
  )
    return;
  const request = { position };
  pendingSeek.value = request;
  try {
    await room.seek(current.roundId, position);
  } finally {
    if (pendingSeek.value === request) pendingSeek.value = null;
  }
}
function seekFromRange(event: Event) {
  const input = activeSeekInput(event);
  if (!input) return;
  void commitSeek(input.valueAsNumber);
  resetSeekPreview(event);
}
function seekFromKey(event: KeyboardEvent) {
  if (!activeSeekInput(event)) return;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
    case 'PageDown':
    case 'Home':
      event.preventDefault();
      return;
    case 'ArrowRight':
    case 'ArrowUp':
    case 'PageUp':
    case 'End': {
      event.preventDefault();
      if (event.repeat) return;
      const step = event.key === 'PageUp' ? duration.value / 10 : 5000;
      const position =
        event.key === 'End' ? duration.value : shownPosition.value + step;
      seekPreview.value = null;
      void commitSeek(position);
    }
  }
}
function walk(dx: number, dy: number) {
  const me = room.me;
  if (
    !me ||
    room.onStage ||
    room.stagePending ||
    room.connection !== 'connected'
  )
    return;
  const now = Date.now() + room.offset;
  const { x, y } = movementPosition(room.renderParticipant(me, now), now);
  const targetX = Math.max(SCENE.walk.left, Math.min(SCENE.walk.right, x + dx));
  const targetY = Math.max(SCENE.walk.top, Math.min(SCENE.walk.bottom, y + dy));
  if (targetX !== x || targetY !== y) room.move(targetX, targetY);
}
const keyboard = createKeyboardMovement({
  sendDirection: (direction) => room.moveDirection(direction),
  stop: () => room.stopMovement(),
});
const keyboardEnabled = computed(
  () =>
    !booting.value &&
    !props.panelOpen &&
    !modal.value &&
    !room.stagePending &&
    !room.onStage &&
    room.connection === 'connected' &&
    Boolean(room.me),
);
function resetKeyboard() {
  keyboard.reset(
    Boolean(room.me) && !room.onStage && room.connection === 'connected',
  );
}
function resetMovement() {
  resetKeyboard();
  room.flushMovement();
}
const stopKeyboardWatch = watch(
  keyboardEnabled,
  (allowed) => {
    if (!allowed) resetMovement();
  },
  { flush: 'sync' },
);
function isControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="button"]',
      ),
    )
  );
}
function keyboardMove(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !keyboardEnabled.value ||
    document.hidden ||
    isControl(event.target)
  )
    return;
  if (keyboard.press(event)) event.preventDefault();
}
function keyboardRelease(event: KeyboardEvent) {
  // Release always clears tracked keys, even if focus/modifiers changed.
  keyboard.release(event);
}
function keyboardFocus(event: FocusEvent) {
  if (isControl(event.target)) resetMovement();
}
function keyboardVisibility() {
  if (document.hidden) resetMovement();
}
onMounted(() => {
  mobileControlsQuery.addEventListener('change', updateMobileControls);
  window.addEventListener('keydown', keyboardMove);
  window.addEventListener('keyup', keyboardRelease);
  window.addEventListener('blur', resetMovement);
  window.addEventListener('pointerdown', resetKeyboard, true);
  window.addEventListener('focusin', keyboardFocus, true);
  document.addEventListener('visibilitychange', keyboardVisibility);
});
onBeforeUnmount(() => {
  mobileControlsQuery.removeEventListener('change', updateMobileControls);
  window.removeEventListener('keydown', keyboardMove);
  window.removeEventListener('keyup', keyboardRelease);
  window.removeEventListener('blur', resetMovement);
  window.removeEventListener('pointerdown', resetKeyboard, true);
  window.removeEventListener('focusin', keyboardFocus, true);
  document.removeEventListener('visibilitychange', keyboardVisibility);
  stopKeyboardWatch();
  resetMovement();
});
</script>

<template>
  <div class="app-shell" :class="{ 'in-room': room.guest && !booting }">
    <header class="site-header room-header">
      <a
        class="brand"
        href="/"
        aria-label="返回大厅"
        @click.prevent="emit('leave')"
      >
        <span>LOOP<span class="brand-dot">.</span></span>
      </a>
      <div class="room-label">
        <strong :title="room.roomInfo?.name || '音乐客厅'">{{
          room.roomInfo?.name || '音乐客厅'
        }}</strong
        ><span
          ><i class="live-dot" :class="room.connection" />{{
            room.guest ? status : '一起，把日子听慢一点'
          }}</span
        >
      </div>
      <div class="room-header-actions">
        <div v-if="roomDescription" class="room-introduction">
          <button
            type="button"
            class="room-introduction-trigger"
            aria-label="房间简介"
            aria-describedby="room-description"
            @pointerup="focusIntroduction"
          >
            <Info aria-hidden="true" />
          </button>
          <div class="room-introduction-bubble">
            <p id="room-description" role="tooltip">{{ roomDescription }}</p>
          </div>
        </div>
        <button
          class="room-header-action"
          aria-label="返回大厅"
          title="返回大厅"
          @click="emit('leave')"
        >
          <ArrowLeft aria-hidden="true" /><span>大厅</span>
        </button>
        <button
          v-if="room.roomInfo?.ownerId === room.guest?.id"
          class="room-header-action"
          aria-label="房间设置"
          title="房间设置"
          @click="emit('settings')"
        >
          <Settings2 aria-hidden="true" /><span>设置</span>
        </button>
      </div>
    </header>
    <main v-if="room.guest" class="room-layout" aria-label="共享音乐客厅">
      <RoomScene
        :interaction-disabled="interactionDisabled"
        @request-join="requestJoin"
        @request-leave="requestLeave"
        @request-appearance="openAppearance"
        @self-menu-open="resetMovement"
      />
      <div class="room-notices" aria-live="polite">
        <div v-if="room.connection === 'replaced'" class="connection-banner">
          <strong>你已在另一个标签页进入客厅。</strong
          ><span>此页已暂停连接与播放。</span
          ><button @click="room.connect(room.roomId ?? undefined)">
            回到这个标签页
          </button>
        </div>
        <div
          v-else-if="room.connection !== 'connected'"
          class="connection-banner"
        >
          {{ status }}，你的舞台位置会短暂保留。<button
            @click="room.connect(room.roomId ?? undefined)"
          >
            重新连接
          </button>
        </div>
        <p v-if="systemNotice" class="system-notice">
          {{ systemNotice }}
        </p>
      </div>
      <div class="room-dock">
        <section
          class="now-playing"
          :class="{ 'is-mobile-player': mobileControls }"
          aria-label="正在共享的音乐"
        >
          <div
            class="mini-record"
            :class="{
              'with-cover':
                playback?.track.cover && failedCover !== playback.track.cover,
            }"
            aria-hidden="true"
          >
            <img
              v-if="
                playback?.track.cover && failedCover !== playback.track.cover
              "
              :src="neteaseCover(playback.track.cover, 128)"
              alt=""
              referrerpolicy="no-referrer"
              @error="failedCover = playback?.track.cover ?? ''"
            />
            <Disc3 v-else aria-hidden="true" />
          </div>
          <div class="track-info">
            <div class="track-title">
              <h2>
                {{
                  playback?.track.title ||
                  (room.snapshot?.resolving
                    ? '正在寻找下一首…'
                    : '等一首喜欢的歌')
                }}
              </h2>
              <span v-if="playback?.isTrial" class="trial-label">试听</span>
            </div>
            <p>
              {{ playback ? playback.track.artist : '点舞台空位，分享你的歌单'
              }}<span v-if="dj"> · {{ dj.nickname }} 的回合</span>
            </p>
            <div class="timeline">
              <span>{{ time(shownPosition) }}</span>
              <input
                v-if="seekKey"
                :key="seekKey"
                :data-seek-key="seekKey"
                class="timeline-seek"
                type="range"
                min="0"
                :max="Math.ceil(duration)"
                :value="seekValue"
                aria-label="向前调整歌曲进度"
                :aria-valuetext="`${time(shownPosition)}，总时长 ${time(duration)}`"
                @input="previewSeek"
                @change="seekFromRange"
                @keydown="seekFromKey"
                @pointercancel="resetSeekPreview"
                @blur="resetSeekPreview"
              />
              <div
                v-else
                role="progressbar"
                aria-label="歌曲进度"
                :aria-valuenow="Math.round(progress * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <i :style="{ width: `${progress * 100}%` }" />
              </div>
              <span>{{ time(duration) }}</span>
            </div>
          </div>
          <div
            v-if="!mobileControls || room.onStage || canSkip"
            class="sound-control"
          >
            <div v-if="!mobileControls" class="volume-control">
              <button
                type="button"
                class="text-button volume-toggle"
                :aria-label="volume === 0 ? '恢复音量' : '静音'"
                :title="volume === 0 ? '恢复音量' : '静音'"
                :aria-pressed="volume === 0"
                @click="sound.toggleMute"
              >
                <VolumeX v-if="volume === 0" aria-hidden="true" />
                <Volume2 v-else aria-hidden="true" />
              </button>
              <label
                ><span>音量</span
                ><input
                  v-model.number="volume"
                  type="range"
                  min="0"
                  max="100"
                  aria-label="播放音量"
              /></label>
            </div>
            <button
              v-if="mobileControls && room.onStage"
              class="text-button"
              :disabled="room.stagePending || room.connection !== 'connected'"
              @click="requestLeave"
            >
              <ArrowDownRight aria-hidden="true" /> 离开舞台
            </button>
            <button
              v-if="canSkip"
              class="text-button skip-button"
              aria-label="下一首"
              @click="room.skip"
            >
              下一首 <SkipForward aria-hidden="true" />
            </button>
          </div>
          <div v-if="issue" class="audio-error" role="alert">
            {{ issue }}
            <button
              v-if="!needsGesture"
              class="text-button"
              @click="sound.retry"
            >
              重试
            </button>
          </div>
        </section>
        <nav class="room-toolbar" aria-label="客厅工具">
          <button @click="openLibrary('playlist')">
            <Music2 aria-hidden="true" /> 我的歌单</button
          ><button @click="openModal('members')">
            <Users aria-hidden="true" /> 客厅成员</button
          ><EmotePicker
            :disabled="room.connection !== 'connected' || room.stagePending"
            :icon-only="mobileControls"
            @select="room.emote"
            @open="resetMovement"
          />
          <button
            v-if="room.onStage && !mobileControls"
            :disabled="room.stagePending || room.connection !== 'connected'"
            @click="requestLeave"
          >
            <ArrowDownRight aria-hidden="true" /> 离开舞台
          </button>
        </nav>
      </div>
      <dialog
        ref="dialog"
        class="room-dialog"
        aria-labelledby="dialog-title"
        @cancel.prevent="closeModal"
        @click="outsideDialog"
        @close="modal = null"
      >
        <header class="dialog-header">
          <div>
            <span class="eyebrow">MAKE YOURSELF AT HOME</span>
            <h2 id="dialog-title">{{ modalTitle }}</h2>
          </div>
          <button
            class="close-button"
            aria-label="关闭面板"
            @click="closeModal"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div class="dialog-content">
          <form
            v-if="modal === 'appearance'"
            class="cat-wardrobe"
            @submit.prevent="saveAppearance"
          >
            <div class="cat-preview-card">
              <CatPreview :appearance="appearanceDraft" />
              <p>挑一套喜欢的花色，和大家一起听歌。</p>
            </div>
            <fieldset :disabled="appearanceSaving">
              <legend>毛色</legend>
              <div class="cat-options">
                <label
                  v-for="coat in CAT_COATS"
                  :key="coat.id"
                  class="cat-option"
                  :class="{ selected: coatChoice === coat.id }"
                >
                  <input
                    v-model="coatChoice"
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
                <label
                  class="cat-option"
                  :class="{ selected: coatChoice === 'calico' }"
                >
                  <input
                    v-model="coatChoice"
                    type="radio"
                    name="cat-coat"
                    value="calico"
                  />
                  <span class="coat-swatch calico-swatch" aria-hidden="true" />
                  三花
                </label>
              </div>
            </fieldset>
            <fieldset
              v-if="coatChoice !== 'calico'"
              :disabled="appearanceSaving"
            >
              <legend>花纹</legend>
              <div class="cat-options">
                <label
                  v-for="pattern in CAT_PATTERNS"
                  :key="pattern.id"
                  class="cat-option"
                  :class="{ selected: appearanceDraft.pattern === pattern.id }"
                >
                  <input
                    v-model="appearanceDraft.pattern"
                    type="radio"
                    name="cat-pattern"
                    :value="pattern.id"
                  />
                  {{ pattern.label }}
                </label>
              </div>
            </fieldset>
            <p class="library-hint">
              保存后房间里的大家都能看到，下次回来也会保留。
            </p>
            <div class="confirm-actions">
              <button type="button" @click="closeModal">取消</button>
              <button
                class="primary"
                type="submit"
                :disabled="appearanceSaving"
              >
                {{ appearanceSaving ? '正在保存…' : '保存外观' }}
              </button>
            </div>
          </form>
          <section v-else-if="modal === 'library'" class="library">
            <div class="library-tabs" aria-label="音乐列表">
              <button
                :class="{ selected: tab === 'playlist' }"
                :aria-pressed="tab === 'playlist'"
                @click="tab = 'playlist'"
              >
                我的歌单</button
              ><button
                :class="{ selected: tab === 'search' }"
                :aria-pressed="tab === 'search'"
                @click="tab = 'search'"
              >
                <Search aria-hidden="true" /> 找音乐
              </button>
            </div>
            <template v-if="tab === 'search'">
              <p v-if="room.playlistSlot !== undefined" class="library-hint">
                添加和导入到歌单 {{ room.playlistSlot }}
              </p>
              <div
                class="segmented-tabs music-search-kinds"
                role="group"
                aria-label="搜索类型"
              >
                <button
                  :class="{ selected: searchKind === 'song' }"
                  :aria-pressed="searchKind === 'song'"
                  :disabled="operation"
                  @click="searchKind = 'song'"
                >
                  单曲
                </button>
                <button
                  :class="{ selected: searchKind === 'playlist' }"
                  :aria-pressed="searchKind === 'playlist'"
                  :disabled="operation"
                  @click="searchKind = 'playlist'"
                >
                  歌单
                </button>
                <button
                  :class="{ selected: searchKind === 'user' }"
                  :aria-pressed="searchKind === 'user'"
                  :disabled="operation"
                  @click="searchKind = 'user'"
                >
                  用户
                </button>
              </div>
              <NeteasePlaylistSearch
                v-if="searchKind === 'playlist'"
                :operation="operation"
                @busy="operation = $event"
              />
              <NeteaseUserSearch
                v-else-if="searchKind === 'user'"
                :operation="operation"
                @busy="operation = $event"
              />
              <template v-else>
                <form class="search-form" @submit.prevent="search">
                  <input
                    v-model="query"
                    aria-label="搜索网易云歌曲"
                    placeholder="搜索歌曲、歌手…"
                    maxlength="100"
                  /><button :disabled="searching || !query.trim()">
                    {{ searching ? '…' : '搜索' }}
                  </button>
                </form>
                <p class="library-hint">
                  来自网易云音乐 · 部分歌曲可能无法播放
                </p>
                <p v-if="playlistFull" class="library-hint" role="status">
                  个人歌单已满（{{ room.playlist.length }}/{{
                    PLAYLIST_LIMIT
                  }}），移除歌曲后可继续添加。
                </p>
                <div v-if="searching" class="empty-state">正在翻找唱片…</div>
                <div v-else-if="!results.length" class="empty-state">
                  <span><Search aria-hidden="true" /></span
                  >{{
                    searched
                      ? '没有找到歌曲，换个关键词试试'
                      : '你的下一首心头好，会是什么？'
                  }}
                </div>
                <ul v-else class="track-list">
                  <li v-for="track in results" :key="track.id">
                    <div class="song-copy">
                      <strong>{{ track.title }}</strong
                      ><small>{{ track.artist }}</small>
                    </div>
                    <button
                      :disabled="
                        operation ||
                        playlistFull ||
                        room.playlist.some((t) => t.id === track.id)
                      "
                      :aria-label="`添加 ${track.title}`"
                      @click="act(() => room.add(track.id))"
                    >
                      <Check
                        v-if="room.playlist.some((t) => t.id === track.id)"
                        aria-hidden="true"
                      /><Plus v-else aria-hidden="true" />
                    </button>
                  </li>
                </ul>
              </template>
            </template>
            <template v-else>
              <div
                v-if="room.playlistSlot !== undefined"
                class="segmented-tabs playlist-selector"
                role="group"
                aria-label="播放歌单"
              >
                <button
                  v-for="slot in PLAYLIST_COUNT_LIMIT"
                  :key="slot"
                  type="button"
                  :class="{ selected: room.playlistSlot === slot }"
                  :aria-pressed="room.playlistSlot === slot"
                  :disabled="operation"
                  @click="act(() => room.selectPlaylist(slot))"
                >
                  歌单 {{ slot }}
                </button>
              </div>
              <div v-if="playlistDisplay.pinned" class="playlist-current">
                <ul class="track-list">
                  <li>
                    <div class="song-copy">
                      <strong>{{ playlistDisplay.pinned.title }}</strong>
                      <small>{{ playlistDisplay.pinned.artist }}</small>
                    </div>
                    <span class="playlist-current-heading">
                      <Pin aria-hidden="true" />正在播放
                    </span>
                  </li>
                </ul>
              </div>
              <p class="library-hint">
                轮到你时分享所选歌单的第一首，播放后排到队尾。拖动手柄排序，或点击置顶。
              </p>
              <div v-if="!playlistDisplay.queue.length" class="empty-state">
                <span><Music2 aria-hidden="true" /></span
                ><strong>{{
                  playlistDisplay.pinned
                    ? '再放几首喜欢的歌'
                    : '把喜欢的歌放进来'
                }}</strong>
                <p>
                  {{
                    playlistDisplay.pinned
                      ? '继续找歌，加入接下来的循环队列。'
                      : '一首也好，陪大家听一会儿。'
                  }}
                </p>
                <button class="outline" @click="tab = 'search'">
                  找一首歌 <ArrowRight aria-hidden="true" />
                </button>
              </div>
              <PlaylistQueue
                v-else
                :key="`${room.guest.id}:${room.playlistSlot}`"
                :tracks="room.playlist"
                :disabled="operation"
                @top="(id) => act(() => room.moveTrackToTop(id))"
                @move="
                  (id, targetId, placement) =>
                    act(() => room.moveTrack(id, targetId, placement))
                "
                @remove="(id) => act(() => room.remove(id))"
              />
            </template>
          </section>
          <section v-else-if="modal === 'members'">
            <RoomMembers />
            <h3>移动你的小猫</h3>
            <div class="walk-controls">
              <button
                v-for="direction in directions"
                :key="direction.label"
                :disabled="room.onStage || room.connection !== 'connected'"
                :aria-label="`向${direction.label}移动`"
                @click="walk(direction.x, direction.y)"
              >
                <component :is="direction.icon" aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
        <p v-if="room.error" class="dialog-error" role="alert">
          {{ room.error }}
          <button class="text-button" @click="room.error = ''">关闭提示</button>
        </p>
      </dialog>
    </main>
    <div v-if="room.guest && room.error && !modal" class="toast" role="alert">
      <span>{{ room.error }}</span
      ><button aria-label="关闭提示" @click="room.error = ''">
        <X aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.calico-swatch {
  background: conic-gradient(
    #f1eee5 0 120deg,
    #d98947 120deg 235deg,
    #554b4e 235deg
  );
}
.playlist-selector {
  margin: 15px 0;
}
.room-introduction {
  position: relative;
}
.room-introduction-trigger,
.room-introduction-trigger:hover:not(:disabled) {
  width: 36px;
  min-height: 38px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--sage);
  cursor: help;
}
.room-introduction-trigger svg {
  width: 17px;
  height: 17px;
}
.room-introduction-bubble {
  position: absolute;
  top: 100%;
  left: 50%;
  z-index: 1;
  width: 280px;
  padding-top: 14px;
  transform: translateX(-50%);
  visibility: hidden;
}
.room-introduction-bubble p {
  max-height: min(240px, 55dvh);
  margin: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 10px 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fffdf6;
  color: var(--ink);
  box-shadow: 0 5px 16px #333c2d21;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.room-introduction-trigger:focus-visible + .room-introduction-bubble {
  visibility: visible;
}
@media (hover: hover) {
  .room-introduction:hover .room-introduction-bubble {
    visibility: visible;
  }
}
@media (hover: none) {
  .room-introduction:focus-within .room-introduction-bubble {
    visibility: visible;
  }
}
@media (max-width: 650px) {
  .room-introduction {
    position: static;
  }
  .room-introduction-bubble {
    top: calc(100% - 8px);
    right: 7px;
    left: auto;
    width: min(280px, calc(100% - 14px));
    transform: none;
  }
}
</style>

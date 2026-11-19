<script setup lang="ts">
import { EllipsisVertical } from '@lucide/vue';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from 'vue';
import { DEFAULT_STAGE_CAPACITY, ROOM_CAPACITY } from '../shared/contracts';
import { request, useRoom } from './room';
import { useTimedMessage } from './timed-message';

const memberActions = ['ban', 'member:kick', 'stage:remove'] as const;
type MemberAction = (typeof memberActions)[number];
type Action = MemberAction | 'unban';
type Ban = { userId: string; nickname?: string };
type BanResponse = { bans: Ban[] };

const actionLabels = {
  ban: '封禁',
  'member:kick': '移出房间',
  'stage:remove': '移出舞台',
  unban: '解除封禁',
};
const room = useRoom();
const members = computed(() => {
  const stageCapacity = room.snapshot?.stageCapacity ?? DEFAULT_STAGE_CAPACITY;
  return [...(room.snapshot?.users ?? [])].sort(
    (a, b) => (a.seat ?? stageCapacity) - (b.seat ?? stageCapacity),
  );
});
const ownerRoomId = computed(() => {
  const id = room.roomId;
  return id &&
    room.guest &&
    room.roomInfo?.id === id &&
    room.roomInfo.ownerId === room.guest.id
    ? id
    : null;
});
const bans = ref<Ban[]>([]);
const loadingBans = ref(false);
const loadError = ref('');
const pending = ref<{ action: Action; userId: string } | null>(null);
const feedback = useTimedMessage();
const feedbackFailed = ref(false);
const feedbackForUnban = ref(false);
const summary = ref<HTMLElement | null>(null);
const bansHeading = ref<HTMLElement | null>(null);
const menuId = useId();
const selectedId = ref<string | null>(null);
const selectedMember = computed(() =>
  members.value.find((member) => member.id === selectedId.value),
);
const confirmation = ref<Exclude<MemberAction, 'stage:remove'> | null>(null);
let trigger: HTMLButtonElement | null = null;
let ownershipVersion = 0;

function menuElement() {
  return document.getElementById(menuId);
}

function closeMenu(restoreFocus = false) {
  if (!selectedId.value) return;
  const button = trigger;
  selectedId.value = null;
  confirmation.value = null;
  trigger = null;
  if (restoreFocus) {
    void nextTick(() => {
      if (!selectedId.value)
        (button?.isConnected ? button : summary.value)?.focus();
    });
  }
}

function placeMenu() {
  if (!trigger) return;
  const menu = menuElement();
  if (!menu) return;
  // Keep the fixed menu within the scrollable portion of the room dialog.
  const anchor = trigger.getBoundingClientRect();
  const bounds = trigger.closest('.dialog-content')?.getBoundingClientRect();
  const topEdge = bounds?.top ?? 0;
  const bottomEdge = bounds?.bottom ?? window.innerHeight;
  if (anchor.bottom <= topEdge || anchor.top >= bottomEdge) {
    closeMenu();
    return;
  }
  const gap = 4;
  const inset = 6;
  const above = Math.max(0, anchor.top - topEdge - gap - inset);
  const below = Math.max(0, bottomEdge - anchor.bottom - gap - inset);
  const naturalHeight =
    menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
  const openBelow = below >= naturalHeight || below >= above;
  const height = Math.min(naturalHeight, openBelow ? below : above);
  const left = Math.max(
    (bounds?.left ?? 0) + inset,
    anchor.right - menu.offsetWidth,
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${openBelow ? anchor.bottom + gap : anchor.top - height - gap}px`;
  menu.style.maxHeight = `${height}px`;
  menu.style.visibility = 'visible';
}

function focusMenuButton(selector: string) {
  void nextTick(() => {
    placeMenu();
    if (selectedId.value) {
      const menu = menuElement();
      (menu?.querySelector<HTMLButtonElement>(selector) ?? menu)?.focus({
        preventScroll: true,
      });
    }
  });
}

function toggleMenu(userId: string, event: MouseEvent) {
  if (selectedId.value === userId) return closeMenu(true);
  if (!ownerRoomId.value || pending.value || userId === room.guest?.id) return;
  feedback.value = '';
  trigger = event.currentTarget as HTMLButtonElement;
  selectedId.value = userId;
  confirmation.value = null;
  focusMenuButton('button:not([aria-disabled="true"])');
}

function dismissOutside(event: Event) {
  if (
    trigger &&
    event.target instanceof Node &&
    !trigger.contains(event.target) &&
    !menuElement()?.contains(event.target)
  )
    closeMenu();
}

function escapeMenu(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !selectedId.value) return;
  event.preventDefault();
  closeMenu(true);
}

function bansPath(id: string) {
  return `/api/rooms/${encodeURIComponent(id)}/bans`;
}

async function loadBans() {
  const id = ownerRoomId.value;
  if (!id || loadingBans.value || pending.value) return;
  const version = ownershipVersion;
  loadingBans.value = true;
  loadError.value = '';
  try {
    const data = await request<BanResponse>(bansPath(id));
    if (version === ownershipVersion) bans.value = data.bans;
  } catch (cause) {
    if (version === ownershipVersion) {
      loadError.value = cause instanceof Error ? cause.message : '请稍后重试';
    }
  } finally {
    if (version === ownershipVersion) loadingBans.value = false;
  }
}

function unavailable(action: Action) {
  if (!ownerRoomId.value || pending.value) return true;
  return action === 'ban' || action === 'unban'
    ? loadingBans.value
    : room.connection !== 'connected';
}

function selectAction(action: MemberAction, userId: string) {
  if (unavailable(action)) return;
  if (action === 'stage:remove') return void performAction(action, userId);
  feedback.value = '';
  confirmation.value = action;
  focusMenuButton('.member-confirm-cancel');
}

function cancelConfirmation() {
  const action = confirmation.value;
  confirmation.value = null;
  focusMenuButton(`[data-action="${action}"]`);
}

async function performAction(
  action: Action,
  userId: string,
  event?: MouseEvent,
) {
  const id = ownerRoomId.value;
  if (!id || unavailable(action)) return;
  if (
    action !== 'unban' &&
    (selectedMember.value?.id !== userId || userId === room.guest?.id)
  )
    return;
  if (action === 'stage:remove' && selectedMember.value?.seat == null) return;

  const version = ownershipVersion;
  const unbanButton = event?.currentTarget;
  pending.value = { action, userId };
  feedback.value = '';
  feedbackFailed.value = false;
  feedbackForUnban.value = action === 'unban';
  try {
    let data: BanResponse | undefined;
    if (action === 'ban') {
      data = await request<BanResponse>(bansPath(id), {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
    } else if (action === 'unban') {
      data = await request<BanResponse>(
        `${bansPath(id)}/${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
        },
      );
    } else {
      room.error = '';
      if (!(await room.moderate(action, userId))) {
        if (version === ownershipVersion && !room.error)
          throw new Error('操作未完成，请重试');
        return;
      }
    }
    if (version !== ownershipVersion) return;
    if (data) {
      bans.value = data.bans;
      loadError.value = '';
    }
    feedback.value = `已${actionLabels[action]}`;
    if (action !== 'unban' && selectedId.value === userId) closeMenu(true);
    if (unbanButton && unbanButton === document.activeElement)
      void nextTick(() => {
        if (version === ownershipVersion) bansHeading.value?.focus();
      });
  } catch (cause) {
    if (version === ownershipVersion) {
      const detail = cause instanceof Error ? cause.message : '请稍后重试';
      feedbackFailed.value = true;
      feedback.value = `${actionLabels[action]}失败：${detail}`;
    }
  } finally {
    if (version === ownershipVersion) pending.value = null;
  }
}

watch(
  [ownerRoomId, () => room.guest?.id],
  ([id]) => {
    ownershipVersion++;
    closeMenu();
    bans.value = [];
    loadingBans.value = false;
    loadError.value = '';
    pending.value = null;
    feedback.value = '';
    if (id) void loadBans();
  },
  { immediate: true, flush: 'sync' },
);
watch(
  () => selectedMember.value?.id,
  (id) => {
    if (!id && selectedId.value) closeMenu(true);
  },
);
watch(
  [
    () => members.value.findIndex((member) => member.id === selectedId.value),
    () => selectedMember.value?.seat != null,
    feedback,
    pending,
  ],
  placeMenu,
  { flush: 'post' },
);

onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside, true);
  // A Safari tap can blur the focused control before delivering the button click.
  document.addEventListener('focusin', dismissOutside, true);
  document.addEventListener('keydown', escapeMenu);
  window.addEventListener('scroll', placeMenu, true);
  window.addEventListener('resize', placeMenu);
});
onBeforeUnmount(() => {
  ownershipVersion++;
  document.removeEventListener('pointerdown', dismissOutside, true);
  document.removeEventListener('focusin', dismissOutside, true);
  document.removeEventListener('keydown', escapeMenu);
  window.removeEventListener('scroll', placeMenu, true);
  window.removeEventListener('resize', placeMenu);
});
</script>

<template>
  <p ref="summary" class="members-hint" tabindex="-1">
    {{ members.length }} / {{ room.snapshot?.capacity ?? ROOM_CAPACITY }} 只猫
  </p>
  <p
    v-if="feedback && !feedbackForUnban && !selectedId"
    class="members-feedback"
    :class="{ failed: feedbackFailed }"
    :role="feedbackFailed ? 'alert' : 'status'"
  >
    {{ feedback }}
  </p>
  <ul v-if="members.length" class="room-member-list" aria-label="在房成员">
    <li v-for="member in members" :key="member.id" class="room-member-row">
      <span
        class="member-presence"
        :class="{ away: !member.connected }"
        aria-hidden="true"
      />
      <div class="member-copy">
        <span class="member-name" :title="member.nickname">{{
          member.nickname
        }}</span>
        <small v-if="member.id === room.guest?.id">（你）</small>
      </div>
      <span class="member-status">
        {{
          member.id === room.snapshot?.playback?.djId
            ? '正在播放'
            : member.seat != null
              ? `舞台 ${member.seat + 1}`
              : '听众'
        }}{{ !member.connected ? ' · 暂离' : '' }}
      </span>
      <template v-if="ownerRoomId && member.id !== room.guest?.id">
        <button
          type="button"
          class="member-actions-trigger"
          :aria-label="`管理 ${member.nickname}`"
          :aria-expanded="selectedId === member.id"
          :aria-controls="selectedId === member.id ? menuId : undefined"
          :aria-disabled="!!pending && selectedId !== member.id"
          @click="toggleMenu(member.id, $event)"
        >
          <EllipsisVertical aria-hidden="true" />
        </button>
        <div
          v-if="selectedId === member.id"
          :id="menuId"
          class="member-actions"
          role="group"
          :aria-label="`管理 ${member.nickname}`"
          tabindex="-1"
        >
          <p
            v-if="feedback && feedbackFailed"
            class="members-feedback failed"
            role="alert"
          >
            {{ feedback }}
          </p>
          <p v-if="pending" class="members-hint" role="status">正在处理…</p>
          <template v-if="confirmation">
            <p class="member-confirm-copy">
              {{
                confirmation === 'ban'
                  ? `封禁 ${member.nickname}？对方将被移出房间，解除封禁后才能再次进入。`
                  : `将 ${member.nickname} 移出房间？对方之后可以重新进入。`
              }}
            </p>
            <div class="member-confirm-actions">
              <button
                type="button"
                class="member-confirm-cancel"
                @click="cancelConfirmation"
              >
                取消
              </button>
              <button
                type="button"
                class="member-danger"
                :aria-disabled="unavailable(confirmation)"
                @click="performAction(confirmation, member.id)"
              >
                确认{{ actionLabels[confirmation] }}
              </button>
            </div>
          </template>
          <template v-else>
            <template v-for="action in memberActions" :key="action">
              <button
                v-if="action !== 'stage:remove' || member.seat != null"
                type="button"
                :class="{ 'member-danger': action !== 'stage:remove' }"
                :data-action="action"
                :aria-disabled="unavailable(action)"
                @click="selectAction(action, member.id)"
              >
                {{ actionLabels[action] }}
              </button>
            </template>
          </template>
        </div>
      </template>
    </li>
  </ul>
  <template v-if="ownerRoomId">
    <h3 ref="bansHeading" class="members-bans-heading" tabindex="-1">
      封禁名单
    </h3>
    <p v-if="loadingBans" class="members-hint" role="status">
      正在加载封禁名单…
    </p>
    <div v-else-if="loadError" class="members-load-error">
      <p class="members-feedback failed" role="alert">
        封禁名单加载失败：{{ loadError }}
      </p>
      <button
        type="button"
        class="member-secondary-button"
        :disabled="!!pending"
        @click="loadBans"
      >
        重试
      </button>
    </div>
    <p v-else-if="!bans.length" class="members-hint">暂无封禁成员。</p>
    <p
      v-if="feedback && feedbackForUnban"
      class="members-feedback"
      :class="{ failed: feedbackFailed }"
      :role="feedbackFailed ? 'alert' : 'status'"
    >
      {{ feedback }}
    </p>
    <ul v-if="bans.length" class="room-member-list" aria-label="封禁成员">
      <li v-for="ban in bans" :key="ban.userId" class="room-member-row">
        <span class="member-name" :title="ban.nickname ?? ban.userId">{{
          ban.nickname ?? ban.userId
        }}</span>
        <button
          type="button"
          class="member-secondary-button"
          :aria-label="`解除对 ${ban.nickname ?? ban.userId} 的封禁`"
          :aria-disabled="unavailable('unban')"
          @click="performAction('unban', ban.userId, $event)"
        >
          {{
            pending?.action === 'unban' && pending.userId === ban.userId
              ? '正在解除…'
              : '解除封禁'
          }}
        </button>
      </li>
    </ul>
  </template>
</template>

<style scoped>
.members-hint,
.members-feedback {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.55;
}
.members-hint {
  color: var(--muted);
}
.members-feedback {
  color: var(--sage);
  overflow-wrap: anywhere;
}
.members-feedback.failed,
.member-actions .member-danger {
  color: #943f33;
}
.room-member-list {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.room-member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  min-width: 0;
  padding: 2px 6px 2px 12px;
  border-radius: 9px;
  background: #efeee3;
  font-size: 13px;
}
.member-presence {
  flex: 0 0 7px;
  height: 7px;
  border-radius: 50%;
  background: #718461;
}
.member-presence.away {
  background: #aaa491;
}
.member-copy {
  display: flex;
  align-items: baseline;
  min-width: 0;
}
.member-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-copy small,
.member-status {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
}
.member-status {
  margin-left: auto;
  padding-right: 5px;
}
.member-actions-trigger {
  flex: 0 0 38px;
  min-height: 38px;
  padding: 0;
  border: 0;
  background: transparent;
}
.member-actions-trigger[aria-expanded='true'] {
  background: #e5e9dd;
}
.member-actions-trigger svg {
  width: 17px;
  height: 17px;
}
.member-actions {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2;
  visibility: hidden;
  display: grid;
  gap: 3px;
  width: min(195px, calc(100vw - 40px));
  overflow: auto;
  overscroll-behavior: contain;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: #faf8ef;
  box-shadow: 0 5px 20px #28301c2b;
}
.member-actions button {
  justify-content: flex-start;
  min-height: 36px;
  padding: 6px 9px;
  border-color: transparent;
  background: transparent;
  font-size: 12px;
}
.member-actions button:focus-visible {
  outline-offset: -2px;
}
button[aria-disabled='true'] {
  opacity: 0.45;
  cursor: default;
}
.member-actions p {
  margin: 3px 5px;
}
.member-confirm-copy {
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.member-confirm-actions,
.members-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.member-confirm-actions button,
.member-secondary-button {
  white-space: nowrap;
}
.members-bans-heading {
  margin: 18px 0 8px;
}
.members-load-error p {
  margin: 0;
}
.member-secondary-button {
  flex-shrink: 0;
  margin-left: auto;
  padding: 4px 9px;
  min-height: 34px;
  font-size: 12px;
}
</style>

<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArrowRight,
  ArrowUpRight,
  Music2,
  Plus,
  RefreshCw,
  Settings2,
  Users,
} from '@lucide/vue';
import { request, useRoom } from './room';
import { createDirectoryPoller, directoryRoomAccess } from './room-directory';
import { roomPath } from './navigation';
import {
  DEFAULT_STAGE_CAPACITY,
  ROOM_DIRECTORY_PAGE_SIZE as PAGE_SIZE,
  type RoomDirectoryFilter,
  type RoomInfo,
  type RoomSummary,
} from '../shared/contracts';
import {
  DEFAULT_ENVIRONMENT,
  environmentPreset,
  type EnvironmentId,
} from '../shared/environments';
import EnvironmentPicker from './EnvironmentPicker.vue';
import RoomEnvironmentCover from './RoomEnvironmentCover.vue';
import { neteaseCover } from './netease-cover';
const emit = defineEmits<{
  enter: [id: string];
  account: [];
  settings: [info: RoomInfo];
}>();
const room = useRoom();
const filters = [
  { value: 'all', label: '全部' },
  { value: 'occupied', label: '活跃中' },
  { value: 'empty', label: '空房间' },
] as const satisfies ReadonlyArray<{
  value: RoomDirectoryFilter;
  label: string;
}>;
type DirectoryFilter = (typeof filters)[number]['value'];
const filter = ref<DirectoryFilter>('all');
const rooms = ref<RoomSummary[]>([]);
const total = ref<number | null>(null);
const page = ref(0);
const pageCount = computed(() => Math.ceil((total.value ?? 0) / PAGE_SIZE));
const emptyMessage = computed(() => {
  switch (filter.value) {
    case 'occupied':
      return '暂时没有活跃的房间。';
    case 'empty':
      return '暂时没有空房间。';
    default:
      return room.guest
        ? '还没有音乐客厅。你的房间会出现在这里。'
        : '还没有音乐客厅。取个昵称，先拥有自己的小小空间。';
  }
});
const loading = ref(false);
const error = useTimedMessage();
const name = ref('');
const stageCapacity = ref(DEFAULT_STAGE_CAPACITY);
const environmentId = ref<EnvironmentId>(DEFAULT_ENVIRONMENT);
const creating = ref(false);
const createOpen = ref(false);
const created = ref<RoomInfo | null>(null);
const owned = ref<RoomSummary | null>(null);
const ownRoom = computed(() => owned.value ?? created.value);
const ownSummary = computed(() =>
  owned.value?.id === ownRoom.value?.id ? owned.value : null,
);
function enterCard(event: MouseEvent, item: RoomSummary) {
  if (room.entering || directoryRoomAccess(item, room.guest?.id).blocked) {
    event.preventDefault();
    return;
  }
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  emit('enter', item.id);
}
const failedCovers = ref<Record<string, string>>({});
function visibleCover(item: RoomSummary) {
  const cover = item.trackCover;
  return cover && failedCovers.value[item.id] !== cover
    ? neteaseCover(cover, 256)
    : '';
}
let generation = 0;
let closed = false;
async function refresh(): Promise<void> {
  const version = ++generation;
  loading.value = true;
  try {
    const [data, mine] = await Promise.all([
      request<{ rooms: RoomSummary[]; total: number }>(
        `/api/rooms?offset=${page.value * PAGE_SIZE}&limit=${PAGE_SIZE}&filter=${filter.value}`,
      ),
      room.guest
        ? request<{ rooms: RoomSummary[] }>('/api/rooms?owner=me&limit=1')
        : Promise.resolve({ rooms: [] }),
    ]);
    if (closed || version !== generation) return;
    const lastPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1);
    if (page.value > lastPage) {
      page.value = lastPage;
      return await refresh();
    }
    rooms.value = data.rooms;
    total.value = data.total;
    owned.value = mine.rooms[0] ?? null;
    error.value = '';
  } catch (cause) {
    if (!closed && version === generation)
      error.value = cause instanceof Error ? cause.message : '房间列表加载失败';
  } finally {
    if (version === generation) loading.value = false;
  }
}
const poller = createDirectoryPoller({
  refresh: async () => {
    if (!loading.value) await refresh();
  },
  visible: () => !document.hidden,
});
const activityEvents = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'focus',
] as const;
function changePage(value: number) {
  page.value = value;
  void refresh();
}
function changeFilter(value: DirectoryFilter) {
  if (filter.value === value) return;
  filter.value = value;
  page.value = 0;
  rooms.value = [];
  total.value = null;
  error.value = '';
  void refresh();
}
async function create() {
  if (creating.value || !room.guest) return;
  creating.value = true;
  error.value = '';
  try {
    const data = await request<{ room: RoomInfo }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: name.value.trim(),
        environmentId: environmentId.value,
        stageCapacity: stageCapacity.value,
      }),
    });
    if (closed) return;
    created.value = data.room;
    createOpen.value = false;
    void refresh();
  } catch (cause) {
    if (!closed)
      error.value = cause instanceof Error ? cause.message : '创建失败';
  } finally {
    creating.value = false;
  }
}
function visibility() {
  poller.visibility();
}
watch(
  () => room.guest?.id,
  () => {
    created.value = null;
    owned.value = null;
    createOpen.value = false;
    void refresh();
  },
);
onMounted(() => {
  poller.start();
  document.addEventListener('visibilitychange', visibility);
  for (const event of activityEvents)
    window.addEventListener(event, poller.activity, { passive: true });
});
onBeforeUnmount(() => {
  closed = true;
  generation++;
  poller.close();
  document.removeEventListener('visibilitychange', visibility);
  for (const event of activityEvents)
    window.removeEventListener(event, poller.activity);
});
</script>
<template>
  <main class="directory">
    <section class="directory-hero">
      <div class="directory-intro">
        <span class="eyebrow">A LITTLE SPACE, A SHARED SOUND</span>
        <h1>一起听首歌。</h1>
        <p>走进一间音乐客厅，成为一只猫。轮流做 DJ，也可以安静听一会儿。</p>
        <div v-if="!room.guest" class="directory-account">
          <button class="primary" @click="emit('account')">
            用昵称进入 <ArrowRight />
          </button>
          <small>取个昵称，就有自己的音乐客厅。</small>
        </div>
      </div>
      <div class="directory-hero-art" aria-hidden="true">
        <RoomEnvironmentCover environment-id="cozy" />
      </div>
    </section>
    <section v-if="ownRoom" class="own-room">
      <div class="own-room-cover">
        <RoomEnvironmentCover :environment-id="ownRoom.environmentId" square />
      </div>
      <div class="own-room-copy">
        <span class="eyebrow">我的音乐客厅</span>
        <h2>{{ ownRoom.name }}</h2>
        <p>
          {{ environmentPreset(ownRoom.environmentId).name }} ·
          {{ ownSummary?.online ?? 0 }} 只猫在房间
        </p>
        <p v-if="ownSummary?.trackTitle" class="own-room-track">
          正在播放 {{ ownSummary.trackTitle }}
        </p>
      </div>
      <div class="own-room-actions">
        <span v-if="ownSummary?.full" class="own-room-full">房间已满</span>
        <a
          v-else
          class="button-link primary"
          :href="roomPath(ownRoom.id, ownRoom.number)"
          @click.prevent="emit('enter', ownRoom.id)"
          >回到房间 <ArrowRight /></a
        ><button @click="emit('settings', ownRoom)"><Settings2 /> 管理</button>
      </div>
    </section>
    <section class="directory-toolbar">
      <h2>
        逛逛音乐客厅 <small v-if="total !== null">{{ total }} 间</small>
      </h2>
      <div>
        <button :disabled="loading" aria-label="刷新房间列表" @click="refresh">
          <RefreshCw /></button
        ><button
          v-if="!ownRoom && room.guest"
          @click="createOpen = !createOpen"
        >
          <Plus /> 创建房间
        </button>
      </div>
    </section>
    <form
      v-if="createOpen && room.guest"
      class="create-room-form"
      @submit.prevent="create"
    >
      <label
        >房间名称<input
          v-model="name"
          minlength="1"
          maxlength="32"
          placeholder="给你的音乐客厅取个名字"
          required
      /></label>
      <EnvironmentPicker v-model="environmentId" :disabled="creating" />
      <label
        >舞台位置<select v-model.number="stageCapacity" :disabled="creating">
          <option v-for="count in 6" :key="count" :value="count">
            {{ count }} 个位置
          </option>
        </select></label
      ><button class="primary" :disabled="creating">
        {{ creating ? '正在创建…' : '创建我的房间' }}
      </button>
      <p class="library-hint">每个身份可以拥有一间房；离线后房间仍会保留。</p>
    </form>
    <p v-if="created" class="created-room" role="status">
      房间已创建。保存这个地址，下次可直接回来：<a
        :href="roomPath(created.id, created.number)"
        @click.prevent="emit('enter', created.id)"
        >{{ roomPath(created.id, created.number) }}</a
      >
    </p>
    <div
      class="segmented-tabs directory-filters"
      role="group"
      aria-label="筛选房间"
    >
      <button
        v-for="option in filters"
        :key="option.value"
        type="button"
        :class="{ selected: filter === option.value }"
        :aria-pressed="filter === option.value"
        @click="changeFilter(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="rooms.length" class="room-grid" :aria-busy="loading">
      <a
        v-for="item in rooms"
        :key="item.id"
        class="room-card"
        :class="{
          'room-card-blocked': directoryRoomAccess(item, room.guest?.id)
            .blocked,
          'room-card-busy': room.entering,
          'room-card-playing': !!item.trackTitle,
          'room-card-occupied': !item.trackTitle && item.online > 0,
          'room-card-empty': !item.trackTitle && item.online === 0,
        }"
        :href="
          directoryRoomAccess(item, room.guest?.id).blocked || room.entering
            ? undefined
            : roomPath(item.id, item.number)
        "
        :aria-disabled="
          directoryRoomAccess(item, room.guest?.id).blocked || room.entering
        "
        :tabindex="
          directoryRoomAccess(item, room.guest?.id).blocked || room.entering
            ? -1
            : undefined
        "
        @click="enterCard($event, item)"
      >
        <div class="room-card-main">
          <div class="room-card-cover">
            <img
              v-if="visibleCover(item)"
              class="room-card-song-art"
              :src="visibleCover(item)"
              alt=""
              referrerpolicy="no-referrer"
              @error="failedCovers[item.id] = item.trackCover ?? ''"
            />
            <RoomEnvironmentCover
              v-else
              :environment-id="item.environmentId"
              square
            />
            <span
              v-if="!directoryRoomAccess(item, room.guest?.id).blocked"
              class="room-card-enter-hint"
              aria-hidden="true"
              ><ArrowUpRight
            /></span>
          </div>
          <div class="room-card-identity">
            <h3 :title="item.name">{{ item.name }}</h3>
            <p class="room-card-owner">房主 {{ item.ownerNickname }}</p>
          </div>
        </div>
        <div class="room-card-activity">
          <template v-if="item.trackTitle">
            <Music2 aria-hidden="true" />
            <span class="room-card-activity-label">播放中</span>
            <strong :title="item.trackTitle">{{ item.trackTitle }}</strong>
          </template>
          <span v-else class="room-card-activity-label">
            {{ item.online > 0 ? '有人在线' : '空房间' }}
          </span>
        </div>
        <footer>
          <span class="room-card-population">
            <Users aria-hidden="true" /> {{ item.online }} / {{ item.capacity }}
          </span>
          <span
            class="room-card-status"
            :class="{
              'is-closed': item.joinPolicy === 'closed',
              'is-full': item.full,
            }"
            >{{ directoryRoomAccess(item, room.guest?.id).label }}</span
          >
        </footer>
      </a>
    </div>
    <div v-else-if="!loading && !error" class="directory-empty" role="status">
      <Music2 aria-hidden="true" />
      <p>{{ emptyMessage }}</p>
    </div>
    <div
      v-else-if="loading"
      class="room-grid"
      role="status"
      aria-label="正在寻找音乐客厅"
    >
      <div v-for="slot in 3" :key="slot" class="room-card room-card-skeleton">
        <div class="room-card-main">
          <div class="room-card-cover"></div>
          <div class="room-card-skeleton-copy">
            <div class="skeleton-line"></div>
            <div class="skeleton-line short"></div>
          </div>
        </div>
        <div class="room-card-skeleton-activity"></div>
        <div class="room-card-skeleton-footer"></div>
      </div>
    </div>
    <nav v-if="pageCount > 1" class="directory-pages" aria-label="房间列表分页">
      <button :disabled="page === 0 || loading" @click="changePage(page - 1)">
        上一页</button
      ><span>{{ page + 1 }} / {{ pageCount }}</span
      ><button
        :disabled="page + 1 >= pageCount || loading"
        @click="changePage(page + 1)"
      >
        下一页
      </button>
    </nav>
  </main>
</template>

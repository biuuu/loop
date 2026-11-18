<script setup lang="ts">
import { useTimedMessage } from './timed-message';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ListMusic,
  Plus,
  Search,
} from '@lucide/vue';
import {
  PLAYLIST_LIMIT,
  type NeteasePlaylist,
  type NeteasePlaylistPage,
  type NeteasePlaylistSearch,
} from '../shared/contracts';
import { playlistImportPreview } from './playlist-import';
import { neteaseCover } from './netease-cover';
import { request, useRoom } from './room';

const props = defineProps<{
  operation: boolean;
  initialPlaylist?: NeteasePlaylist;
}>();
const emit = defineEmits<{ busy: [value: boolean]; back: [] }>();
const room = useRoom();
const query = ref('');
const searched = ref(false);
const searching = ref(false);
const searchResult = ref<NeteasePlaylistSearch | null>(null);
const searchOffset = ref(0);
let searchQuery = '';
const selected = ref<NeteasePlaylist | null>(props.initialPlaylist ?? null);
const page = ref<NeteasePlaylistPage | null>(null);
const loading = ref(false);
const error = useTimedMessage();
const summary = useTimedMessage();
const mutating = ref(false);
const importing = ref(false);
const importMode = ref<'replace' | 'append'>('replace');
let searchVersion = 0;
let detailVersion = 0;
let disposed = false;
const full = computed(() => room.playlist.length >= PLAYLIST_LIMIT);
const appendFull = computed(() => importMode.value === 'append' && full.value);
const pending = computed(() => props.operation || mutating.value);
const start = ref<number | string>(1);
const preview = computed(() =>
  playlistImportPreview(
    start.value,
    page.value?.total ?? 0,
    importMode.value === 'replace' ? 0 : room.playlist.length,
  ),
);

async function search(offset = 0, newSearch = false) {
  const term = newSearch ? query.value.trim() : searchQuery;
  if (!term || pending.value) return;
  const version = ++searchVersion;
  searchQuery = term;
  searching.value = true;
  searched.value = true;
  error.value = '';
  try {
    const result = await request<NeteasePlaylistSearch>(
      `/api/music/playlists/search?q=${encodeURIComponent(term)}&offset=${offset}`,
    );
    if (disposed || version !== searchVersion) return;
    searchResult.value = result;
    searchOffset.value = offset;
  } catch (cause) {
    if (disposed || version !== searchVersion) return;
    searchResult.value = null;
    error.value =
      cause instanceof Error ? cause.message : '歌单搜索失败，请重试';
  } finally {
    if (!disposed && version === searchVersion) searching.value = false;
  }
}
async function select(playlist: NeteasePlaylist, offset = 0) {
  if (pending.value) return;
  if (selected.value?.id !== playlist.id) start.value = 1;
  const version = ++detailVersion;
  selected.value = playlist;
  page.value = null;
  loading.value = true;
  error.value = '';
  summary.value = '';
  try {
    const result = await request<NeteasePlaylistPage>(
      `/api/music/playlists/${playlist.id}?offset=${offset}&limit=${PLAYLIST_LIMIT}`,
    );
    if (
      disposed ||
      version !== detailVersion ||
      selected.value?.id !== playlist.id
    )
      return;
    page.value = result;
    selected.value = result.playlist;
  } catch (cause) {
    if (disposed || version !== detailVersion) return;
    error.value =
      cause instanceof Error
        ? cause.message
        : '无法读取歌单，请确认它是公开歌单后重试';
  } finally {
    if (!disposed && version === detailVersion) loading.value = false;
  }
}
function back() {
  if (pending.value) return;
  if (props.initialPlaylist) {
    emit('back');
    return;
  }
  detailVersion++;
  loading.value = false;
  selected.value = null;
  page.value = null;
  error.value = '';
}
onMounted(() => {
  if (props.initialPlaylist) void select(props.initialPlaylist);
});
async function add(id: string) {
  if (pending.value || full.value) return;
  mutating.value = true;
  emit('busy', true);
  error.value = '';
  try {
    await room.add(id);
  } catch (cause) {
    if (!disposed)
      error.value = cause instanceof Error ? cause.message : '添加失败，请重试';
  } finally {
    mutating.value = false;
    if (!disposed) emit('busy', false);
  }
}
async function confirmImport() {
  if (
    !selected.value ||
    !page.value ||
    !preview.value.canImport ||
    pending.value
  )
    return;
  const targetId = selected.value.id;
  const sourceStart = preview.value.start;
  const mode = importMode.value;
  importing.value = true;
  mutating.value = true;
  emit('busy', true);
  error.value = '';
  try {
    const result = await room.importPlaylist(targetId, sourceStart, mode);
    if (disposed) return;
    summary.value =
      mode === 'replace'
        ? `已用 ${result.imported} 首歌曲覆盖歌单；重复 ${result.duplicates} 首，资料不可用 ${result.unavailable} 首，超出容量 ${result.overflow} 首。`
        : `已添加 ${result.imported} 首；重复 ${result.duplicates} 首，资料不可用 ${result.unavailable} 首，超出容量 ${result.overflow} 首。`;
  } catch (cause) {
    if (!disposed)
      error.value = cause instanceof Error ? cause.message : '导入失败，请重试';
  } finally {
    importing.value = false;
    mutating.value = false;
    if (!disposed) emit('busy', false);
  }
}
onBeforeUnmount(() => {
  disposed = true;
  searchVersion++;
  detailVersion++;
  if (mutating.value) emit('busy', false);
});
</script>

<template>
  <div class="netease-playlists">
    <template v-if="!selected">
      <form class="search-form" @submit.prevent="search(0, true)">
        <input
          v-model="query"
          aria-label="搜索网易云歌单"
          placeholder="搜索歌单名称、关键词…"
          maxlength="100"
        />
        <button :disabled="searching || pending || !query.trim()">
          <Search aria-hidden="true" />{{ searching ? '搜索中…' : '搜索' }}
        </button>
      </form>
      <p class="library-hint">
        网易云公开歌单 · 可以逐首添加，也可以从指定位置批量导入
      </p>
      <div v-if="searching" class="empty-state" role="status">
        正在寻找歌单…
      </div>
      <div v-else-if="!searchResult?.playlists.length" class="empty-state">
        <span><ListMusic aria-hidden="true" /></span
        >{{
          searched ? '没有找到歌单，换个关键词试试' : '找一份适合今天的歌单'
        }}
      </div>
      <ul v-else class="netease-playlist-cards">
        <li v-for="playlist in searchResult.playlists" :key="playlist.id">
          <button
            :disabled="pending"
            :aria-label="`查看歌单 ${playlist.name}`"
            @click="select(playlist)"
          >
            <img
              v-if="playlist.cover"
              :src="neteaseCover(playlist.cover, 128)"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <span v-else class="playlist-cover-placeholder"
              ><ListMusic aria-hidden="true"
            /></span>
            <span class="song-copy"
              ><strong>{{ playlist.name }}</strong
              ><small
                >{{ playlist.creator || '网易云音乐' }} ·
                {{ playlist.trackCount }} 首</small
              ></span
            >
            <ArrowRight aria-hidden="true" />
          </button>
        </li>
      </ul>
      <nav
        v-if="searchResult?.playlists.length"
        class="playlist-pagination"
        aria-label="歌单搜索翻页"
      >
        <button
          :disabled="searching || pending || searchOffset === 0"
          @click="search(searchOffset - 20)"
        >
          <ArrowLeft aria-hidden="true" />上一页
        </button>
        <span>第 {{ Math.floor(searchOffset / 20) + 1 }} 页</span>
        <button
          :disabled="searching || pending || !searchResult.more"
          @click="search(searchOffset + 20)"
        >
          下一页<ArrowRight aria-hidden="true" />
        </button>
      </nav>
    </template>
    <template v-else>
      <div class="playlist-detail-toolbar">
        <button :disabled="pending" @click="back">
          <ArrowLeft aria-hidden="true" />返回歌单
        </button>
        <form class="playlist-import-inline" @submit.prevent="confirmImport">
          <select
            id="playlist-import-mode"
            v-model="importMode"
            aria-label="导入方式"
            :disabled="pending || loading"
          >
            <option value="replace">覆盖歌单</option>
            <option value="append">追加队尾</option>
          </select>
          <label for="playlist-import-start"
            >从第
            <input
              id="playlist-import-start"
              v-model="start"
              type="number"
              min="1"
              :max="page?.total"
              step="1"
              required
              :disabled="pending || loading || !page?.total || appendFull"
            />
            首开始
          </label>
          <button
            class="primary"
            type="submit"
            :disabled="pending || loading || !preview.canImport"
          >
            <Download aria-hidden="true" />{{
              importing ? '正在导入…' : '批量导入'
            }}
          </button>
        </form>
      </div>
      <p
        v-if="page?.total && !preview.valid"
        class="playlist-request-error"
        role="alert"
      >
        请输入 1–{{ page.total }} 之间的整数。
      </p>
      <h3 class="playlist-detail-title">{{ selected.name }}</h3>
      <p class="library-hint">
        {{ selected.creator || '网易云音乐' }} ·
        {{ page?.total ?? selected.trackCount }} 首 · 每次最多导入
        {{ PLAYLIST_LIMIT }} 首
      </p>
      <p v-if="full" class="library-hint" role="status">
        个人歌单已满（{{ room.playlist.length }}/{{
          PLAYLIST_LIMIT
        }}），逐首添加需先移除歌曲；批量导入可选择“覆盖当前歌单”。
      </p>
      <p v-if="summary" class="playlist-import-summary" role="status">
        {{ summary }}
      </p>
      <div v-if="loading" class="empty-state" role="status">正在读取歌单…</div>
      <div v-else-if="page && !page.tracks.length" class="empty-state">
        这份歌单还没有歌曲。
      </div>
      <ul v-else-if="page" class="track-list">
        <li v-for="entry in page.tracks" :key="entry.position">
          <span class="track-number">{{ entry.position }}</span>
          <div class="song-copy">
            <strong>{{ entry.track?.title || '歌曲资料不可用' }}</strong
            ><small>{{
              entry.track?.artist || '此位置保留，暂时无法添加'
            }}</small>
          </div>
          <button
            :disabled="
              pending ||
              full ||
              !entry.track ||
              room.playlist.some((track) => track.id === entry.id)
            "
            :aria-label="
              entry.track
                ? `添加 ${entry.track.title}`
                : `第 ${entry.position} 首资料不可用`
            "
            @click="entry.track && add(entry.track.id)"
          >
            <Check
              v-if="room.playlist.some((track) => track.id === entry.id)"
              aria-hidden="true"
            /><Plus v-else aria-hidden="true" />
          </button>
        </li>
      </ul>
      <nav
        v-if="page?.tracks.length"
        class="playlist-pagination"
        aria-label="歌单歌曲翻页"
      >
        <button
          :disabled="pending || loading || page.offset === 0"
          @click="select(selected, Math.max(0, page.offset - PLAYLIST_LIMIT))"
        >
          <ArrowLeft aria-hidden="true" />上一页
        </button>
        <span
          >{{ page.offset + 1 }}–{{
            Math.min(page.offset + PLAYLIST_LIMIT, page.total)
          }}
          / {{ page.total }}</span
        >
        <button
          :disabled="
            pending || loading || page.offset + PLAYLIST_LIMIT >= page.total
          "
          @click="select(selected, page.offset + PLAYLIST_LIMIT)"
        >
          下一页<ArrowRight aria-hidden="true" />
        </button>
      </nav>
    </template>
    <p v-if="error" class="playlist-request-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  ListMusic,
  Search,
  UserRound,
} from '@lucide/vue';
import type {
  NeteasePlaylist,
  NeteaseUser,
  NeteaseUserPlaylistPage,
  NeteaseUserSearch as NeteaseUserSearchResult,
} from '../shared/contracts';
import { neteaseCover } from './netease-cover';
import NeteasePlaylistSearch from './NeteasePlaylistSearch.vue';
import { request, useRoom } from './room';
import { useTimedMessage } from './timed-message';

const props = defineProps<{ operation: boolean; selectPlaylist?: boolean }>();
const emit = defineEmits<{
  busy: [value: boolean];
  selected: [user: NeteaseUser, playlist: NeteasePlaylist, offset: number];
}>();
const room = useRoom();
const query = ref('');
const searched = ref(false);
const searching = ref(false);
const searchResult = ref<NeteaseUserSearchResult | null>(null);
const searchOffset = ref(0);
let searchTerm = '';
const selectedUser = ref<NeteaseUser | null>(null);
const playlistPage = ref<NeteaseUserPlaylistPage | null>(null);
const playlistOffset = ref(0);
const loadingPlaylists = ref(false);
const selectedPlaylist = ref<NeteasePlaylist | null>(null);
const error = useTimedMessage();
let searchVersion = 0;
let playlistVersion = 0;
let disposed = false;
const pending = computed(() => props.operation);

function clear() {
  searchVersion++;
  playlistVersion++;
  query.value = '';
  searched.value = false;
  searching.value = false;
  searchResult.value = null;
  searchOffset.value = 0;
  searchTerm = '';
  selectedUser.value = null;
  playlistPage.value = null;
  playlistOffset.value = 0;
  loadingPlaylists.value = false;
  selectedPlaylist.value = null;
  error.value = '';
}
watch(() => room.guest?.id, clear);

async function search(offset = 0, newSearch = false) {
  const term = newSearch ? query.value.trim() : searchTerm;
  if (!term || pending.value || searching.value) return;
  const version = ++searchVersion;
  searchTerm = term;
  searched.value = true;
  searching.value = true;
  error.value = '';
  try {
    const next = await request<NeteaseUserSearchResult>(
      `/api/music/users/search?q=${encodeURIComponent(term)}&offset=${offset}`,
    );
    if (disposed || version !== searchVersion) return;
    searchResult.value = next;
    searchOffset.value = offset;
  } catch (cause) {
    if (disposed || version !== searchVersion) return;
    searchResult.value = null;
    error.value =
      cause instanceof Error ? cause.message : '网易云用户搜索失败，请重试';
  } finally {
    if (!disposed && version === searchVersion) searching.value = false;
  }
}

async function selectUser(user: NeteaseUser, offset = 0) {
  if (pending.value || loadingPlaylists.value) return;
  const version = ++playlistVersion;
  selectedUser.value = user;
  selectedPlaylist.value = null;
  playlistPage.value = null;
  loadingPlaylists.value = true;
  error.value = '';
  try {
    const next = await request<NeteaseUserPlaylistPage>(
      `/api/music/users/${encodeURIComponent(user.id)}/playlists?offset=${offset}`,
    );
    if (disposed || version !== playlistVersion) return;
    playlistPage.value = next;
    playlistOffset.value = next.offset;
  } catch (cause) {
    if (disposed || version !== playlistVersion) return;
    error.value =
      cause instanceof Error ? cause.message : '无法读取该用户的网易云歌单';
  } finally {
    if (!disposed && version === playlistVersion)
      loadingPlaylists.value = false;
  }
}

function backToUsers() {
  if (pending.value) return;
  playlistVersion++;
  selectedUser.value = null;
  playlistPage.value = null;
  selectedPlaylist.value = null;
  loadingPlaylists.value = false;
  error.value = '';
}

function choosePlaylist(playlist: NeteasePlaylist) {
  if (pending.value || !selectedUser.value) return;
  if (props.selectPlaylist)
    emit('selected', selectedUser.value, playlist, playlistOffset.value);
  else selectedPlaylist.value = playlist;
}

onBeforeUnmount(() => {
  disposed = true;
  searchVersion++;
  playlistVersion++;
});
</script>

<template>
  <div v-if="selectedPlaylist">
    <NeteasePlaylistSearch
      :key="selectedPlaylist.id"
      :operation="operation"
      :initial-playlist="selectedPlaylist"
      @busy="emit('busy', $event)"
      @back="selectedPlaylist = null"
    />
  </div>
  <div v-else-if="selectedUser">
    <div class="playlist-detail-toolbar">
      <button :disabled="pending" @click="backToUsers">
        <ArrowLeft aria-hidden="true" />返回用户
      </button>
      <button
        v-if="!playlistPage && !loadingPlaylists"
        :disabled="pending"
        @click="selectUser(selectedUser)"
      >
        重试
      </button>
    </div>
    <h3 class="playlist-detail-title">{{ selectedUser.nickname }}的歌单</h3>
    <p class="library-hint">
      {{
        selectPlaylist
          ? '来自网易云音乐 · 选择一份歌单创建身份'
          : '来自网易云音乐 · 选择一份歌单查看并导入歌曲'
      }}
    </p>
    <div v-if="loadingPlaylists" class="empty-state" role="status">
      正在读取歌单…
    </div>
    <div
      v-else-if="playlistPage && !playlistPage.playlists.length"
      class="empty-state"
    >
      这位用户没有可浏览的歌单。
    </div>
    <ul v-else-if="playlistPage" class="netease-playlist-cards">
      <li v-for="playlist in playlistPage.playlists" :key="playlist.id">
        <button
          :disabled="pending"
          :aria-label="`${selectPlaylist ? '选择' : '查看'}歌单 ${playlist.name}`"
          @click="choosePlaylist(playlist)"
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
            ><small>{{ playlist.trackCount }} 首</small></span
          >
          <ArrowRight aria-hidden="true" />
        </button>
      </li>
    </ul>
    <nav
      v-if="
        playlistPage && (playlistOffset > 0 || playlistPage.playlists.length)
      "
      class="playlist-pagination"
      aria-label="用户歌单翻页"
    >
      <button
        :disabled="pending || loadingPlaylists || playlistOffset === 0"
        @click="selectUser(selectedUser, Math.max(0, playlistOffset - 20))"
      >
        <ArrowLeft aria-hidden="true" />上一页
      </button>
      <span>第 {{ Math.floor(playlistOffset / 20) + 1 }} 页</span>
      <button
        :disabled="pending || loadingPlaylists || !playlistPage.more"
        @click="selectUser(selectedUser, playlistOffset + 20)"
      >
        下一页<ArrowRight aria-hidden="true" />
      </button>
    </nav>
    <p v-if="error" class="playlist-request-error" role="alert">
      {{ error }}
    </p>
  </div>
  <div v-else>
    <form class="search-form" @submit.prevent="search(0, true)">
      <input
        v-model="query"
        aria-label="搜索网易云用户"
        placeholder="搜索网易云用户名…"
        maxlength="100"
      />
      <button :disabled="searching || pending || !query.trim()">
        <Search aria-hidden="true" />{{ searching ? '搜索中…' : '搜索' }}
      </button>
    </form>
    <p class="library-hint">找到网易云用户后，可以浏览其公开歌单。</p>
    <div v-if="searching" class="empty-state" role="status">正在寻找用户…</div>
    <div v-else-if="!searchResult?.users.length" class="empty-state">
      <span><UserRound aria-hidden="true" /></span
      >{{
        searched ? '没有找到用户，换个关键词试试' : '输入网易云用户名寻找歌单'
      }}
    </div>
    <ul v-else class="netease-playlist-cards">
      <li v-for="user in searchResult.users" :key="user.id">
        <button
          :disabled="pending"
          :aria-label="`查看 ${user.nickname} 的网易云歌单`"
          @click="selectUser(user)"
        >
          <img
            v-if="user.avatar"
            :src="neteaseCover(user.avatar, 128)"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="playlist-cover-placeholder"
            ><UserRound aria-hidden="true"
          /></span>
          <span class="song-copy"
            ><strong>{{ user.nickname }}</strong
            ><small>网易云用户 · ID {{ user.id }}</small></span
          >
          <ArrowRight aria-hidden="true" />
        </button>
      </li>
    </ul>
    <nav
      v-if="searchResult && (searchOffset > 0 || searchResult.users.length)"
      class="playlist-pagination"
      aria-label="网易云用户搜索翻页"
    >
      <button
        :disabled="searching || pending || searchOffset === 0"
        @click="search(Math.max(0, searchOffset - 20))"
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
    <p v-if="error" class="playlist-request-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

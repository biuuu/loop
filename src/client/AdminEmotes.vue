<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  KeyRound,
  Plus,
  Save,
  Trash2,
} from '@lucide/vue';
import { request } from './room';
import type { EmoteCatalog, EmoteGroup } from '../shared/contracts';
import { useTimedMessage } from './timed-message';

defineEmits<{ back: [] }>();
const enteredKey = ref('');
const key = ref('');
const draft = ref<EmoteCatalog | null>(null);
const selected = ref('');
const busy = ref(false);
const error = useTimedMessage();
const notice = useTimedMessage();
const group = computed(() =>
  draft.value?.groups.find((item) => item.id === selected.value),
);
const newId = () => `new:${crypto.randomUUID()}`;

function adminRequest<T>(
  method: 'POST' | 'PUT',
  keyValue: string,
  body?: unknown,
) {
  return request<T>('/api/admin/emotes/catalog', {
    method,
    headers: { 'X-Loop-Admin-Key': keyValue },
    cache: 'no-store',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function unlock() {
  if (busy.value || !enteredKey.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    const verified = enteredKey.value.trim();
    const catalog = await adminRequest<EmoteCatalog>('POST', verified);
    key.value = verified;
    enteredKey.value = '';
    draft.value = catalog;
    selected.value = catalog.groups[0]?.id ?? '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员验证失败';
  } finally {
    busy.value = false;
  }
}
function move<T>(items: T[], index: number, step: number) {
  const next = index + step;
  if (next < 0 || next >= items.length) return;
  [items[index], items[next]] = [items[next]!, items[index]!];
}
function addGroup() {
  if (!draft.value) return;
  const entry: EmoteGroup = { id: newId(), label: '新分组', items: [] };
  draft.value.groups.push(entry);
  selected.value = entry.id;
}
function removeGroup(index: number) {
  if (!draft.value) return;
  draft.value.groups.splice(index, 1);
  selected.value =
    draft.value.groups[Math.min(index, draft.value.groups.length - 1)]?.id ??
    '';
}
function addItem() {
  group.value?.items.push({ id: newId(), url: '' });
}
function cleanId(id: string) {
  return id.startsWith('new:') ? undefined : id;
}
async function save() {
  if (busy.value || !draft.value || !key.value) return;
  const selectedIndex = draft.value.groups.findIndex(
    (entry) => entry.id === selected.value,
  );
  const payload = {
    revision: draft.value.revision,
    enabled: draft.value.enabled,
    groups: draft.value.groups.map((entry) => ({
      id: cleanId(entry.id),
      label: entry.label.trim(),
      items: entry.items.map((item) => ({
        id: cleanId(item.id),
        url: item.url.trim(),
      })),
    })),
  };
  busy.value = true;
  error.value = '';
  try {
    const current = await adminRequest<EmoteCatalog>('PUT', key.value, payload);
    draft.value = current;
    selected.value =
      current.groups[selectedIndex]?.id ?? current.groups[0]?.id ?? '';
    notice.value = '表情配置已保存';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败';
  } finally {
    busy.value = false;
  }
}
async function reload() {
  if (!key.value || busy.value) return;
  busy.value = true;
  try {
    const current = await adminRequest<EmoteCatalog>('POST', key.value);
    draft.value = current;
    selected.value = current.groups[0]?.id ?? '';
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '重新加载失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="emote-admin">
    <header class="emote-admin-header">
      <button @click="$emit('back')">
        <ArrowLeft aria-hidden="true" />返回大厅</button
      ><strong>LOOP<span>.</span></strong>
    </header>
    <section class="emote-admin-card">
      <p class="eyebrow">管理员工具</p>
      <h1>表情管理</h1>
      <p class="intro">
        编辑分组和图片链接，保存后会同步到所有房间。图片从原网站直接加载。
      </p>
      <form v-if="!draft" class="emote-admin-login" @submit.prevent="unlock">
        <label for="emote-admin-key">管理员密钥</label>
        <div class="emote-admin-key">
          <KeyRound aria-hidden="true" /><input
            id="emote-admin-key"
            v-model="enteredKey"
            type="password"
            autocomplete="off"
            :disabled="busy"
            required
          />
        </div>
        <button class="primary" :disabled="busy">
          {{ busy ? '验证中…' : '进入管理页面' }}
        </button>
      </form>
      <div v-else>
        <div class="emote-admin-top">
          <label class="emote-admin-switch"
            ><input v-model="draft.enabled" type="checkbox" /><span
              >开放房间表情</span
            ></label
          ><span>版本 {{ draft.revision }}</span>
        </div>
        <div class="emote-admin-layout">
          <aside class="emote-admin-groups" aria-label="表情分组">
            <div
              v-for="(entry, index) in draft.groups"
              :key="entry.id"
              class="emote-admin-group"
              :class="{ selected: selected === entry.id }"
            >
              <button class="group-name" @click="selected = entry.id">
                {{ entry.label }} <small>{{ entry.items.length }}</small>
              </button>
              <button
                :disabled="index === 0"
                title="上移分组"
                :aria-label="`上移 ${entry.label}`"
                @click="move(draft.groups, index, -1)"
              >
                <ArrowUp />
              </button>
              <button
                :disabled="index === draft.groups.length - 1"
                title="下移分组"
                :aria-label="`下移 ${entry.label}`"
                @click="move(draft.groups, index, 1)"
              >
                <ArrowDown />
              </button>
              <button
                title="删除分组"
                :aria-label="`删除 ${entry.label}`"
                @click="removeGroup(index)"
              >
                <Trash2 />
              </button>
            </div>
            <button class="add" @click="addGroup">
              <Plus aria-hidden="true" />添加分组
            </button>
          </aside>
          <section v-if="group" class="emote-admin-items">
            <label
              >分组名称<input v-model="group.label" maxlength="24"
            /></label>
            <p>图片链接使用 HTTPS；调整顺序或删除后，点击下方保存才会生效。</p>
            <div
              v-for="(item, index) in group.items"
              :key="item.id"
              class="emote-admin-item"
            >
              <span class="emote-admin-index">{{ index + 1 }}</span>
              <img
                v-if="item.url.startsWith('https://')"
                :src="item.url"
                alt=""
                loading="lazy"
              />
              <input
                v-model="item.url"
                type="url"
                placeholder="https://图片地址"
                :aria-label="`表情 ${index + 1} 图片链接`"
              />
              <button
                :disabled="index === 0"
                :aria-label="`上移表情 ${index + 1}`"
                @click="move(group!.items, index, -1)"
              >
                <ArrowUp />
              </button>
              <button
                :disabled="index === group.items.length - 1"
                :aria-label="`下移表情 ${index + 1}`"
                @click="move(group!.items, index, 1)"
              >
                <ArrowDown />
              </button>
              <button
                :aria-label="`删除表情 ${index + 1}`"
                @click="group!.items.splice(index, 1)"
              >
                <Trash2 />
              </button>
            </div>
            <button class="add" @click="addItem">
              <Plus aria-hidden="true" />添加图片链接
            </button>
          </section>
          <p v-else class="emote-admin-empty">添加一个分组开始配置表情。</p>
        </div>
        <footer class="emote-admin-actions">
          <button @click="reload" :disabled="busy">放弃修改并重新加载</button
          ><button class="primary" @click="save" :disabled="busy">
            <Save aria-hidden="true" />{{ busy ? '保存中…' : '保存配置' }}
          </button>
        </footer>
      </div>
      <p v-if="error" role="alert" class="emote-admin-error">{{ error }}</p>
      <p v-if="notice" role="status" class="emote-admin-notice">{{ notice }}</p>
    </section>
  </main>
</template>

<style scoped>
.emote-admin {
  min-height: 100dvh;
  padding: clamp(20px, 4vw, 48px);
  background: #f4f0e5;
  color: #464c40;
}
.emote-admin-header {
  max-width: 1100px;
  margin: 0 auto 30px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.emote-admin-header button {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: #526449;
}
.emote-admin-header svg,
.emote-admin button svg {
  width: 17px;
  height: 17px;
}
.emote-admin-header strong {
  font-size: 24px;
  letter-spacing: 0.07em;
  color: #4b5d42;
}
.emote-admin-header strong span {
  color: #b58b65;
}
.emote-admin-card {
  max-width: 1100px;
  margin: auto;
  padding: clamp(20px, 4vw, 36px);
  border: 1px solid #e8e3d4;
  border-radius: 24px;
  background: #fffdf6;
  box-shadow: 0 18px 60px #47432f13;
}
h1 {
  margin: 6px 0;
}
.intro,
.emote-admin-items p {
  color: #777b6c;
  font-size: 13px;
  line-height: 1.6;
}
.emote-admin-login {
  display: grid;
  gap: 12px;
  max-width: 360px;
  margin-top: 24px;
}
.emote-admin-key {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border: 1px solid #d9ddcf;
  border-radius: 10px;
}
.emote-admin-key input {
  border: 0;
  outline: none;
  flex: 1;
  min-width: 0;
}
.emote-admin button {
  cursor: pointer;
}
.emote-admin button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.emote-admin .primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border: 0;
  border-radius: 10px;
  background: #617458;
  color: #fff;
}
.emote-admin-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 22px 0 15px;
  font-size: 13px;
  color: #777b6c;
}
.emote-admin-switch {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #464c40;
  font-weight: 600;
}
.emote-admin-switch input {
  accent-color: #617458;
  width: 18px;
  height: 18px;
}
.emote-admin-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 20px;
}
.emote-admin-groups {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.emote-admin-group {
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: 10px;
  background: #f6f4ea;
}
.emote-admin-group.selected {
  background: #e8eddf;
}
.emote-admin-group button,
.emote-admin-item button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #65725b;
}
.emote-admin-group .group-name {
  display: block;
  text-align: left;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  width: auto;
  padding: 4px 6px;
  color: #464c40;
}
.emote-admin-group small {
  color: #889180;
}
.emote-admin button:hover:not(:disabled),
.emote-admin button:focus-visible {
  background-color: #e6ebdb;
}
.emote-admin .primary:hover:not(:disabled),
.emote-admin .primary:focus-visible {
  background: #52694b;
}
.emote-admin .add {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  margin-top: 8px;
  border: 1px dashed #b8c5ac;
  border-radius: 9px;
  padding: 8px 10px;
  background: transparent;
  color: #526449;
}
.emote-admin-items {
  min-width: 0;
}
.emote-admin-items > label {
  display: grid;
  gap: 5px;
  max-width: 360px;
  font-size: 13px;
  font-weight: 600;
}
.emote-admin-items input {
  min-width: 0;
  border: 1px solid #d9ddcf;
  border-radius: 8px;
  padding: 8px;
  background: white;
  font: inherit;
}
.emote-admin-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 5px 0;
  padding: 5px;
  border: 1px solid #ece9df;
  border-radius: 10px;
}
.emote-admin-item img {
  flex: 0 0 42px;
  width: 42px;
  height: 42px;
  object-fit: contain;
}
.emote-admin-item input {
  flex: 1;
  font-size: 12px;
}
.emote-admin-index {
  width: 25px;
  text-align: center;
  font-size: 12px;
  color: #889180;
}
.emote-admin-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
.emote-admin-actions > button:first-child {
  border: 1px solid #d9ddcf;
  border-radius: 9px;
  padding: 8px 12px;
  background: transparent;
}
.emote-admin-error {
  color: #a75f4a;
}
.emote-admin-notice {
  color: #526449;
}
@media (max-width: 740px) {
  .emote-admin-layout {
    grid-template-columns: 1fr;
  }
  .emote-admin-groups {
    max-height: 150px;
    overflow-y: auto;
  }
  .emote-admin-item {
    flex-wrap: wrap;
  }
  .emote-admin-item input {
    flex-basis: calc(100% - 110px);
  }
}
</style>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { ArrowLeft, KeyRound, RefreshCw } from '@lucide/vue';
import { request } from './room';
import { useTimedMessage } from './timed-message';

const emit = defineEmits<{ back: [] }>();
type QrStatus = 'waiting' | 'scanned' | 'expired' | 'success';
const enteredKey = ref('');
const authorizedKey = ref('');
const unlocked = ref(false);
const configured = ref(false);
const image = ref('');
const qrStatus = ref<QrStatus | null>(null);
const busy = ref(false);
const checking = ref(false);
const error = useTimedMessage();
let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}
function lock() {
  stopPolling();
  authorizedKey.value = '';
  unlocked.value = false;
  image.value = '';
  qrStatus.value = null;
}
function adminRequest<T>(path: string, key = authorizedKey.value) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'X-Loop-Admin-Key': key },
    cache: 'no-store',
  });
}
async function unlock() {
  if (busy.value || !enteredKey.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    const key = enteredKey.value.trim();
    const state = await adminRequest<{ configured: boolean }>(
      '/api/admin/netease/status',
      key,
    );
    authorizedKey.value = key;
    configured.value = state.configured;
    unlocked.value = true;
    enteredKey.value = '';
  } catch (cause) {
    lock();
    error.value = cause instanceof Error ? cause.message : '管理员验证失败';
  } finally {
    busy.value = false;
  }
}
async function checkQr() {
  if (!unlocked.value || !image.value || checking.value) return;
  checking.value = true;
  try {
    const state = await adminRequest<{
      status: QrStatus;
      configured: boolean;
    }>('/api/admin/netease/qr/check');
    qrStatus.value = state.status;
    configured.value = state.configured;
    if (state.status === 'expired' || state.status === 'success') {
      image.value = '';
      stopPolling();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '扫码状态查询失败';
  } finally {
    checking.value = false;
  }
}
async function startQr() {
  if (!unlocked.value || busy.value) return;
  stopPolling();
  image.value = '';
  qrStatus.value = null;
  error.value = '';
  busy.value = true;
  try {
    const result = await adminRequest<{ image: string; expiresAt: number }>(
      '/api/admin/netease/qr/start',
    );
    image.value = result.image;
    qrStatus.value = 'waiting';
    pollTimer = setInterval(() => void checkQr(), 3_000);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '二维码生成失败';
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(stopPolling);
</script>

<template>
  <main class="admin-page">
    <header class="admin-header">
      <button type="button" class="admin-back" @click="emit('back')">
        <ArrowLeft aria-hidden="true" />返回大厅
      </button>
      <span class="admin-brand">LOOP<span>.</span></span>
    </header>
    <section class="admin-card">
      <span class="admin-eyebrow">管理员工具</span>
      <h1>网易云扫码登录</h1>
      <p class="admin-intro">
        用网易云音乐 App
        扫码并在手机上确认。凭证只保存在服务端，不会显示在页面上。
      </p>
      <form v-if="!unlocked" class="admin-form" @submit.prevent="unlock">
        <label for="admin-key">管理员密钥</label>
        <div class="admin-input-row">
          <KeyRound aria-hidden="true" />
          <input
            id="admin-key"
            v-model="enteredKey"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            required
            placeholder="输入服务端配置的密钥"
          />
        </div>
        <button class="primary" :disabled="busy || !enteredKey.trim()">
          {{ busy ? '正在验证…' : '进入管理页面' }}
        </button>
      </form>
      <div v-else class="admin-content">
        <p class="admin-current" role="status">
          {{
            configured
              ? '服务端已有网易云登录态。重新扫码可替换。'
              : '服务端尚无网易云登录态。'
          }}
        </p>
        <div v-if="image" class="admin-qr">
          <img :src="image" alt="网易云音乐登录二维码" />
          <p v-if="qrStatus === 'scanned'">已扫码，请在手机上确认登录。</p>
          <p v-else>请使用网易云音乐 App 扫描二维码。</p>
        </div>
        <p
          v-else-if="qrStatus === 'success'"
          class="admin-success"
          role="status"
        >
          登录成功，凭证已保存。后续网易云请求会使用新的登录态。
        </p>
        <p
          v-else-if="qrStatus === 'expired'"
          class="admin-current"
          role="status"
        >
          二维码已过期，请重新生成。
        </p>
        <button class="primary" :disabled="busy" @click="startQr">
          <RefreshCw aria-hidden="true" />
          {{ busy ? '正在生成…' : image ? '换一张二维码' : '生成二维码' }}
        </button>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>
  </main>
</template>

<style scoped>
.admin-page {
  min-height: 100dvh;
  padding: clamp(20px, 4vw, 48px);
  background: #f4f0e5;
}
.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 760px;
  margin: 0 auto 38px;
}
.admin-back {
  gap: 7px;
  border: 0;
  background: transparent;
  color: #526449;
}
.admin-back svg,
.admin-content button svg {
  width: 17px;
  height: 17px;
}
.admin-brand {
  color: #4b5d42;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.07em;
}
.admin-brand span {
  color: #b58b65;
}
.admin-card {
  max-width: 560px;
  margin: 0 auto;
  padding: clamp(24px, 5vw, 38px);
  border: 1px solid #e8e3d4;
  border-radius: 24px;
  background: #fffdf6;
  box-shadow: 0 18px 60px #47432f13;
}
.admin-eyebrow {
  color: #80906f;
  font-size: 12px;
  letter-spacing: 0.14em;
}
h1 {
  margin: 12px 0 10px;
  font-size: clamp(25px, 4vw, 32px);
}
.admin-intro,
.admin-current,
.admin-qr p,
.admin-success {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}
.admin-form,
.admin-content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
  margin-top: 28px;
}
.admin-form label {
  font-size: 13px;
}
.admin-input-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}
.admin-input-row svg {
  flex: 0 0 18px;
  color: #87987c;
}
.admin-input-row input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  outline: 0;
}
.admin-input-row:focus-within {
  outline: 3px solid #a87850;
  outline-offset: 2px;
}
.admin-qr {
  width: 100%;
  padding: 20px;
  border-radius: 16px;
  background: #f2f1e8;
  text-align: center;
}
.admin-qr img {
  display: block;
  width: min(100%, 248px);
  margin: 0 auto;
  border-radius: 8px;
}
.admin-qr p {
  margin: 12px 0 0;
}
.admin-success {
  color: #526449;
}
.admin-content button {
  gap: 8px;
}
.form-error {
  margin-top: 18px;
}
</style>

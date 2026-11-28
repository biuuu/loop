<script setup lang="ts">
import { ref } from 'vue';
import { useSignupVerification } from './signup-verification';

const container = ref<HTMLElement | null>(null);
const { state, ready, takeToken, reset, retry } =
  useSignupVerification(container);
defineExpose({ ready, takeToken, reset });
</script>

<template>
  <div v-show="state.status !== 'disabled'" class="signup-verification">
    <div v-show="state.status !== 'failed'" ref="container"></div>
    <small v-if="state.status === 'loading'" role="status"
      >正在加载安全验证…</small
    >
    <div v-if="state.status === 'failed'" class="signup-verification-error">
      <small role="alert">{{ state.message }}</small>
      <button type="button" class="text-button" @click="retry">重试</button>
    </div>
  </div>
</template>

<style scoped>
.signup-verification-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>

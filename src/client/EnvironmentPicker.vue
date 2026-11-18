<script setup lang="ts">
import { useId } from 'vue';
import { Armchair, Flower2, Waves, MoonStar } from '@lucide/vue';
import { ENVIRONMENTS, type EnvironmentId } from '../shared/environments';

const value = defineModel<EnvironmentId>({ required: true });
defineProps<{ disabled?: boolean }>();
const name = useId();
const icons = {
  cozy: Armchair,
  greenhouse: Flower2,
  seaside: Waves,
  rooftop: MoonStar,
};
</script>

<template>
  <fieldset class="environment-picker" :disabled="disabled">
    <legend>房间环境</legend>
    <div class="environment-options">
      <label
        v-for="preset in ENVIRONMENTS"
        :key="preset.id"
        class="environment-option"
      >
        <input v-model="value" type="radio" :name="name" :value="preset.id" />
        <span class="environment-card">
          <span class="environment-colors" aria-hidden="true">
            <span
              v-for="color in preset.colors"
              :key="color"
              :style="{ backgroundColor: color }"
            />
            <component :is="icons[preset.id]" />
          </span>
          <span class="environment-name">{{ preset.name }}</span>
          <span class="environment-description">{{ preset.description }}</span>
        </span>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.environment-picker {
  width: 100%;
  max-width: 480px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}
legend {
  padding: 0;
  margin-bottom: 8px;
  font-size: 14px;
}
.environment-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.environment-option {
  position: relative;
  min-width: 0;
  cursor: pointer;
}
input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}
.environment-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px;
  border: 1px solid #d9d9ca;
  border-radius: 12px;
  background: #faf9f2;
}
input:checked + .environment-card {
  border-color: #697d59;
  box-shadow: inset 0 0 0 1px #697d59;
  background: #f0f3e9;
}
input:focus-visible + .environment-card {
  outline: 2px solid #697d59;
  outline-offset: 3px;
}
:disabled .environment-card {
  opacity: 0.65;
  cursor: default;
}
.environment-colors {
  display: flex;
  position: relative;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 8px;
}
.environment-colors span {
  flex: 1;
}
.environment-colors svg {
  position: absolute;
  width: 22px;
  height: 22px;
  right: 8px;
  top: 7px;
  color: #384b40;
}
.environment-name {
  font-size: 13px;
  font-weight: 600;
}
.environment-description {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: #717868;
}
</style>

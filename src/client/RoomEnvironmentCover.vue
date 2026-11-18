<script setup lang="ts">
import { computed } from 'vue';
import { environmentPreset } from '../shared/environments';

const props = defineProps<{ environmentId: unknown; square?: boolean }>();
const kind = computed(() => environmentPreset(props.environmentId).id);
</script>

<template>
  <svg
    class="room-cover"
    viewBox="0 0 480 270"
    :preserveAspectRatio="square ? 'xMidYMid slice' : 'xMidYMid meet'"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="kind === 'cozy'">
      <rect width="480" height="270" fill="#eee4d1" />
      <rect y="194" width="480" height="76" fill="#c59b78" />
      <circle cx="345" cy="100" r="78" fill="#caa77e" />
      <circle cx="345" cy="100" r="65" fill="#fbebc7" />
      <path d="M280 100h130M345 35v130" stroke="#caa77e" stroke-width="7" />
      <path d="M0 187h480" stroke="#a88062" stroke-width="5" />
      <rect x="58" y="145" width="167" height="82" rx="28" fill="#a77d66" />
      <rect x="71" y="128" width="140" height="65" rx="28" fill="#bd987d" />
      <rect x="53" y="219" width="174" height="14" rx="7" fill="#7d6659" />
      <ellipse cx="285" cy="239" rx="118" ry="25" fill="#e1c6a3" />
      <path
        d="M436 210v-62m-2 44c-36-4-46-29-39-53 28 8 42 27 39 53Zm0-20c-4-31 5-49 28-60 11 30 1 50-28 60Z"
        fill="#789174"
        stroke="#536e57"
        stroke-width="3"
      />
      <path d="M403 208h60l-10 28h-40Z" fill="#b98068" />
    </template>
    <template v-else-if="kind === 'greenhouse'">
      <rect width="480" height="270" fill="#d9e7d7" />
      <path
        d="M0 134 240 12l240 122"
        fill="#eff5df"
        stroke="#8fa78e"
        stroke-width="10"
      />
      <path
        d="M55 107v143m96-193v193M240 15v235M329 57v193m96-143v143"
        stroke="#a4b79c"
        stroke-width="6"
      />
      <path d="M0 181h480M0 220h480" stroke="#b2bca7" stroke-width="5" />
      <rect y="226" width="480" height="44" fill="#c5b99c" />
      <ellipse cx="236" cy="239" rx="94" ry="24" fill="#e8dcc1" />
      <path
        d="M41 231v-83m0 54c-37-16-44-41-27-65 25 13 37 36 27 65Zm0-28c4-31 22-47 53-44-3 29-21 45-53 44Zm385 57v-89m0 60c-39-11-52-36-40-63 30 11 43 33 40 63Zm0-28c4-32 24-48 49-44-4 29-19 44-49 44Z"
        fill="#709578"
        stroke="#557962"
        stroke-width="3"
      />
      <path d="M17 222h51l-8 30H25Zm384 0h51l-8 30h-35Z" fill="#b68169" />
    </template>
    <template v-else-if="kind === 'seaside'">
      <rect width="480" height="270" fill="#f1d8c5" />
      <circle cx="353" cy="85" r="48" fill="#f5b995" />
      <path d="M0 141q60-10 120 0t120 0 120 0 120 0v129H0Z" fill="#a6bec0" />
      <path
        d="M0 166q60-10 120 0t120 0 120 0 120 0M0 188q60-10 120 0t120 0 120 0 120 0"
        fill="none"
        stroke="#d9d8c8"
        stroke-width="5"
      />
      <path d="M0 211h480v59H0Z" fill="#c4a488" />
      <path
        d="M0 232h480M93 211v59m110-59v59m110-59v59m110-59v59"
        stroke="#a48169"
        stroke-width="5"
      />
      <path
        d="M32 217v-49h172v49m-162-42 69-30 82 30"
        fill="none"
        stroke="#9d7664"
        stroke-width="9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <ellipse cx="337" cy="232" rx="77" ry="16" fill="#e8c8a5" />
    </template>
    <template v-else>
      <rect width="480" height="270" fill="#35465f" />
      <circle cx="366" cy="63" r="36" fill="#eedbb7" />
      <path
        d="M0 158h31v-58h45v58h28V81h51v77h25v-44h49v44h33V76h47v82h36v-43h46v43h33V94h53v64h33v112H0Z"
        fill="#58657a"
      />
      <path d="M0 201h480v69H0Z" fill="#8c8490" />
      <path
        d="M0 187q120 30 240 0t240 0"
        fill="none"
        stroke="#d4ad80"
        stroke-width="3"
      />
      <g fill="#ffe2a3">
        <circle cx="42" cy="194" r="5" />
        <circle cx="98" cy="200" r="5" />
        <circle cx="154" cy="196" r="5" />
        <circle cx="210" cy="188" r="5" />
        <circle cx="266" cy="183" r="5" />
        <circle cx="322" cy="186" r="5" />
        <circle cx="378" cy="193" r="5" />
        <circle cx="434" cy="199" r="5" />
      </g>
      <ellipse cx="240" cy="234" rx="102" ry="19" fill="#b5a195" />
    </template>
    <g fill="#705f54">
      <path d="M231 198q-3-21 14-27l12 10 11-10q18 6 14 27v22h-51Z" />
      <path
        d="M221 213q-18-12-12-25"
        fill="none"
        stroke="#705f54"
        stroke-width="9"
        stroke-linecap="round"
      />
    </g>
    <path
      d="M242 194h4m17 0h4"
      stroke="#f5ead8"
      stroke-width="3"
      stroke-linecap="round"
    />
    <path
      d="m294 144 4-9 5 9 8 2-8 5-4 8-5-8-8-5Z"
      fill="#fff2cd"
      opacity=".85"
    />
  </svg>
</template>

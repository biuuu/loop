import { ref, watch, watchSyncEffect, onBeforeUnmount } from 'vue';
import { useRoom } from './room';

const VOLUME_STORAGE_KEY = 'loop:volume';
const AUDIBLE_VOLUME_STORAGE_KEY = 'loop:volume:audible';
function savedVolume(key = VOLUME_STORAGE_KEY): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && stored.trim() !== '') {
      const value = Number(stored);
      if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
    }
  } catch {
    // Playback remains available when browser storage is blocked.
  }
  return 65;
}

export function useAudio(useDeviceVolume = () => false) {
  const room = useRoom();
  const audio = new Audio();
  audio.preload = 'auto';
  const enabled = ref(true);
  const issue = ref('');
  const volume = ref(savedVolume());
  let audibleVolume =
    volume.value || savedVolume(AUDIBLE_VOLUME_STORAGE_KEY) || 65;
  const progress = ref(0);
  let generation = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let starting = false;
  let failedRound = '';
  const needsGesture = ref(false);
  let primed = false;
  let priming = false;
  watchSyncEffect(() => {
    audio.volume = useDeviceVolume() ? 1 : volume.value / 100;
  });
  watch(
    volume,
    (value) => {
      if (value > 0) audibleVolume = value;
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(value));
        if (value > 0)
          localStorage.setItem(AUDIBLE_VOLUME_STORAGE_KEY, String(value));
      } catch {
        // A local preference must not interrupt playback.
      }
    },
    { immediate: true, flush: 'sync' },
  );
  function toggleMute() {
    volume.value = volume.value > 0 ? 0 : audibleVolume;
  }
  function target() {
    const p = room.snapshot?.playback;
    return p ? Math.max(0, (Date.now() + room.offset - p.startedAt) / 1000) : 0;
  }
  function updateProgress() {
    const playback = room.snapshot?.playback;
    progress.value = playback
      ? Math.min(1, (target() * 1000) / playback.durationMs)
      : 0;
  }
  function seek(tolerance = 0.5) {
    const p = room.snapshot?.playback;
    if (p && audio.readyState >= 1 && Number.isFinite(audio.duration)) {
      const time = Math.min(target(), Math.max(0, audio.duration - 0.05));
      if (Math.abs(audio.currentTime - time) > tolerance) {
        try {
          audio.currentTime = time;
        } catch {
          /* Metadata may still be settling. */
        }
      }
    }
  }
  async function start(token = generation) {
    const p = room.snapshot?.playback;
    if (
      !p ||
      !enabled.value ||
      token !== generation ||
      starting ||
      needsGesture.value ||
      failedRound === p.roundId
    )
      return;
    const delay = p.startedAt - Date.now() - room.offset;
    clearTimeout(scheduled);
    if (delay > 0) {
      scheduled = setTimeout(() => {
        void start(token);
      }, delay);
      return;
    }
    seek();
    starting = true;
    try {
      await audio.play();
      if (token !== generation) return;
      primed = true;
      issue.value = '';
    } catch (err) {
      if (token !== generation) return;
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        needsGesture.value = true;
        issue.value = '轻触页面或按任意键即可继续播放';
      } else {
        failedRound = p.roundId;
        issue.value = '这首歌暂时无法在此浏览器播放，可点击重试';
      }
    } finally {
      if (token === generation) starting = false;
    }
  }
  async function resumeOnGesture() {
    if (failedRound || priming) return;
    const playback = room.snapshot?.playback;
    if (playback) {
      if (!audio.paused && !needsGesture.value) return;
      needsGesture.value = false;
      if (playback.startedAt > Date.now() + room.offset) {
        // Unlock during this gesture, then pause until the authoritative start.
        const token = generation;
        try {
          await audio.play();
          if (token !== generation) return;
          primed = true;
          audio.pause();
        } catch {
          if (token !== generation) return;
          needsGesture.value = true;
          issue.value = '轻触页面或按任意键即可继续播放';
          return;
        }
      }
      await start();
      return;
    }
    if (primed) return;
    // A tiny inline silent WAV unlocks the persistent element during a gesture.
    const token = generation;
    priming = true;
    audio.src =
      'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQIAAACAgA==';
    try {
      await audio.play();
      if (token === generation) {
        primed = true;
        audio.pause();
      }
    } catch {
      // No song is playing yet; a later gesture can prime the same element again.
    } finally {
      priming = false;
    }
  }
  const gesture = (event: Event) => {
    if (!event.isTrusted || (event instanceof KeyboardEvent && event.repeat))
      return;
    void resumeOnGesture();
  };
  const gestureEvents = ['pointerup', 'click', 'keydown'] as const;
  for (const event of gestureEvents)
    document.addEventListener(event, gesture, true);
  watch(
    [
      () => room.roomGeneration,
      () => room.snapshot?.playback?.roundId,
      () => room.snapshot?.playback?.startedAt,
    ],
    ([roomGeneration, roundId], [previousGeneration, previousRound]) => {
      updateProgress();
      if (roomGeneration === previousGeneration && roundId === previousRound) {
        seek(0);
        return;
      }
      generation++;
      starting = false;
      failedRound = '';
      needsGesture.value = false;
      clearTimeout(scheduled);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      issue.value = '';
      const playback = room.snapshot?.playback;
      if (playback) {
        audio.src = playback.url;
        audio.load();
        void start();
      }
    },
    { immediate: true, flush: 'sync' },
  );
  const metadata = () => {
    seek();
    void start();
  };
  const playbackError = () => {
    if (room.snapshot?.playback && audio.error) {
      failedRound = room.snapshot.playback.roundId;
      issue.value = '音频加载失败，请重试或等待下一首';
    }
  };
  audio.addEventListener('loadedmetadata', metadata);
  audio.addEventListener('error', playbackError);
  function restore() {
    if (!document.hidden) {
      room.sync();
      updateProgress();
      seek();
      void start();
    }
  }
  document.addEventListener('visibilitychange', restore);
  const progressTimer = setInterval(updateProgress, 250);
  const syncTimer = setInterval(() => {
    const p = room.snapshot?.playback;
    if (p && enabled.value && !failedRound && !document.hidden) {
      seek();
      if (audio.paused && !audio.ended) void start();
    }
  }, 1500);
  function retry() {
    failedRound = '';
    const p = room.snapshot?.playback;
    if (p) {
      audio.src = p.url;
      audio.load();
    }
    void resumeOnGesture();
  }
  onBeforeUnmount(() => {
    generation++;
    clearInterval(progressTimer);
    clearInterval(syncTimer);
    clearTimeout(scheduled);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    document.removeEventListener('visibilitychange', restore);
    for (const event of gestureEvents)
      document.removeEventListener(event, gesture, true);
    audio.removeEventListener('loadedmetadata', metadata);
    audio.removeEventListener('error', playbackError);
  });
  return { enabled, issue, volume, progress, needsGesture, retry, toggleMute };
}

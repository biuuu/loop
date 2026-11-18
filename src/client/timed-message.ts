import { customRef, onScopeDispose } from 'vue';

export const MESSAGE_DURATION_MS = 6000;

/** A transient message; every assignment, including the same text, renews it. */
export function useTimedMessage(durationMs = MESSAGE_DURATION_MS) {
  let value = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  onScopeDispose(() => {
    disposed = true;
    clearTimer();
  });
  return customRef<string>((track, trigger) => ({
    get() {
      track();
      return value;
    },
    set(message) {
      clearTimer();
      value = message;
      if (message && !disposed) {
        timer = setTimeout(() => {
          timer = undefined;
          value = '';
          trigger();
        }, durationMs);
      }
      trigger();
    },
  }));
}

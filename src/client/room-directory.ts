import type { RoomSummary } from '../shared/contracts';

export function directoryRoomAccess(room: RoomSummary, userId?: string) {
  if (room.full) return { label: '已满', blocked: true } as const;
  if (room.joinPolicy === 'closed')
    return room.ownerId === userId
      ? ({ label: '访客暂停进入', blocked: false } as const)
      : ({ label: '暂停新访客', blocked: true } as const);
  return { label: '开放中', blocked: false } as const;
}

const ACTIVE_REFRESH_MS = 15_000;
const IDLE_AFTER_MS = 60_000;

// Poll the visible directory at a pace that reflects the visitor's activity.
export function createDirectoryPoller(options: {
  refresh: () => Promise<unknown>;
  visible: () => boolean;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let lastActivityAt = 0;
  let lastRefreshAt = 0;

  function nextRefreshAt(now: number) {
    const idleMs = now - lastActivityAt;
    let interval = ACTIVE_REFRESH_MS;
    if (idleMs >= 600_000) interval = 120_000;
    else if (idleMs >= 180_000) interval = 60_000;
    else if (idleMs >= IDLE_AFTER_MS) interval = 30_000;
    return lastRefreshAt + interval;
  }
  function schedule() {
    clearTimeout(timer);
    if (!running || !options.visible() || pending) return;
    const now = Date.now();
    timer = setTimeout(
      () => {
        // An idle threshold may have passed while this timer was waiting.
        const now = Date.now();
        if (now < nextRefreshAt(now)) schedule();
        else void refresh();
      },
      Math.max(0, nextRefreshAt(now) - now),
    );
  }
  async function refresh() {
    if (!running || !options.visible() || pending) return;
    clearTimeout(timer);
    pending = true;
    lastRefreshAt = Date.now();
    try {
      await options.refresh();
    } finally {
      pending = false;
      schedule();
    }
  }
  function activity() {
    if (!running || !options.visible()) return;
    const now = Date.now();
    const wasIdle = now - lastActivityAt >= IDLE_AFTER_MS;
    lastActivityAt = now;
    if (wasIdle) schedule();
  }
  function visibility() {
    clearTimeout(timer);
    if (!running || !options.visible()) return;
    lastActivityAt = Date.now();
    void refresh();
  }
  return {
    start() {
      running = true;
      visibility();
    },
    visibility,
    activity,
    close() {
      running = false;
      clearTimeout(timer);
    },
  };
}

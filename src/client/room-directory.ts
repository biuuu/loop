import type { RoomSummary } from '../shared/contracts';

export function directoryRoomAccess(room: RoomSummary, userId?: string) {
  if (room.full) return { label: '已满', blocked: true } as const;
  if (room.joinPolicy === 'closed')
    return room.ownerId === userId
      ? ({ label: '访客暂停进入', blocked: false } as const)
      : ({ label: '暂停新访客', blocked: true } as const);
  return { label: '开放中', blocked: false } as const;
}

// Poll only while the directory is visible; reopening always reads fresh summaries.
export function createDirectoryPoller(options: {
  refresh: () => Promise<unknown>;
  visible: () => boolean;
  intervalMs?: number;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let pending = false;
  async function refresh() {
    if (!running || !options.visible() || pending) return;
    pending = true;
    try {
      await options.refresh();
    } finally {
      pending = false;
    }
  }
  function visibility() {
    clearInterval(timer);
    timer = undefined;
    if (running && options.visible()) {
      void refresh();
      timer = setInterval(() => void refresh(), options.intervalMs ?? 15000);
    }
  }
  return {
    start() {
      running = true;
      visibility();
    },
    visibility,
    refresh,
    close() {
      running = false;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

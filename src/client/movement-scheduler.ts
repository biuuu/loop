export const MOVEMENT_INTERVAL_MS = 150;
export interface MovementClock {
  set: (callback: () => void, delay: number) => unknown;
  clear: (timer: unknown) => void;
}

/** Throttle network reports only. Local input and animation never wait here. */
export function createMovementScheduler<T>(options: {
  context: () => string | undefined;
  now: () => number;
  send: (report: T) => void;
  clock?: MovementClock;
}) {
  const clock = options.clock ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (timer: unknown) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let timer: unknown;
  let pending: { sample: () => T | undefined; context: string } | undefined;
  let activeContext: string | undefined;
  let dispatchedAt: number | undefined;
  function clearTimer() {
    if (timer !== undefined) clock.clear(timer);
    timer = undefined;
  }
  function cancel() {
    clearTimer();
    pending = undefined;
    dispatchedAt = undefined;
  }
  function context() {
    const current = options.context();
    if (current !== activeContext) {
      cancel();
      activeContext = current;
    }
    return current;
  }
  function dispatch() {
    clearTimer();
    const report = pending;
    pending = undefined;
    if (!report || context() !== report.context) return;
    const value = report.sample();
    if (value === undefined) return;
    dispatchedAt = options.now();
    options.send(value);
  }
  return {
    schedule(sample: () => T | undefined) {
      const current = context();
      if (!current) {
        cancel();
        return;
      }
      pending = { sample, context: current };
      const remaining =
        dispatchedAt === undefined
          ? 0
          : MOVEMENT_INTERVAL_MS - (options.now() - dispatchedAt);
      if (remaining <= 0) dispatch();
      else if (timer === undefined) timer = clock.set(dispatch, remaining);
    },
    // Final stops/lifecycle reports bypass the interval without resetting it.
    // Nothing pending means the leading report was already sent; never repeat it.
    flush: dispatch,
    cancel,
  };
}

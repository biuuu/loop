const RELOAD_ATTEMPTS_KEY = 'loop.deployment-reloads';
const REQUEST_TIMEOUT_MS = 10_000;

interface VersionBrowser extends Pick<Window, 'fetch'> {
  document: Pick<Document, 'hidden'> &
    Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  location: Pick<Location, 'reload'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
}

export function watchDeploymentVersion(
  build: string | null | undefined,
  browser: VersionBrowser = window,
) {
  if (!build) return;

  let request: AbortController | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reloading = false;

  async function check() {
    if (closed || reloading || browser.document.hidden || request) return;
    const active = new AbortController();
    request = active;
    requestTimeout = setTimeout(() => active.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await browser.fetch('/api/version', {
        cache: 'no-store',
        signal: active.signal,
      });
      if (!response.ok) return;
      const data = (await response.json()) as { version?: unknown } | null;
      const version = data?.version;
      if (
        active.signal.aborted ||
        browser.document.hidden ||
        typeof version !== 'string' ||
        !version ||
        version.trim() !== version
      )
        return;

      const storage = browser.sessionStorage;
      if (version === build) {
        storage.removeItem(RELOAD_ATTEMPTS_KEY);
        return;
      }

      // Only reload after recording the target, so a stale shell cannot loop.
      const attempts: unknown = JSON.parse(
        storage.getItem(RELOAD_ATTEMPTS_KEY) ?? '[]',
      );
      if (!Array.isArray(attempts) || attempts.includes(version)) return;
      storage.setItem(
        RELOAD_ATTEMPTS_KEY,
        JSON.stringify([...attempts, version]),
      );
      reloading = true;
      browser.location.reload();
    } catch {
      // A failed request can be retried. Unavailable storage makes reload unsafe.
    } finally {
      clearTimeout(requestTimeout);
      request = undefined;
    }
  }

  browser.document.addEventListener('visibilitychange', check);
  browser.addEventListener('online', check);
  void check();

  return {
    check,
    close() {
      closed = true;
      request?.abort();
      clearTimeout(requestTimeout);
      browser.document.removeEventListener('visibilitychange', check);
      browser.removeEventListener('online', check);
    },
  };
}

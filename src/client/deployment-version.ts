import { createDirectoryPoller } from './room-directory';

const RELOAD_ATTEMPTS_KEY = 'loop.deployment-reloads';
const CHECK_INTERVAL_MS = 30_000;
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
  let reloading = false;

  async function refresh() {
    if (reloading) return;
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

  const poller = createDirectoryPoller({
    refresh,
    visible: () => !browser.document.hidden,
    intervalMs: CHECK_INTERVAL_MS,
  });
  browser.document.addEventListener('visibilitychange', poller.visibility);
  browser.addEventListener('online', poller.refresh);
  poller.start();

  return {
    check: poller.refresh,
    close() {
      poller.close();
      request?.abort();
      clearTimeout(requestTimeout);
      browser.document.removeEventListener(
        'visibilitychange',
        poller.visibility,
      );
      browser.removeEventListener('online', poller.refresh);
    },
  };
}

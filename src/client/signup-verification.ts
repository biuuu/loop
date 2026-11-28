import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { request } from './room';

const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const LOAD_TIMEOUT_MS = 12_000;

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: 'signup';
      size: 'normal' | 'compact';
      language: 'zh';
      retry: 'never';
      'response-field': false;
      'refresh-expired': 'never';
      'refresh-timeout': 'never';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
      'timeout-callback': () => void;
      'unsupported-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

let turnstileLoad: Promise<Turnstile> | undefined;

function loadTurnstile() {
  const browser = window as Window & { turnstile?: Turnstile };
  if (browser.turnstile) return Promise.resolve(browser.turnstile);
  turnstileLoad ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    const timeout = setTimeout(fail, LOAD_TIMEOUT_MS);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      reject(new Error('Turnstile script could not be loaded'));
    }
    script.addEventListener('load', () => {
      if (!browser.turnstile) return fail();
      clearTimeout(timeout);
      resolve(browser.turnstile);
    });
    script.addEventListener('error', fail);
    document.head.append(script);
  }).catch((error) => {
    turnstileLoad = undefined;
    throw error;
  });
  return turnstileLoad;
}

type VerificationState =
  | { status: 'loading' | 'disabled' | 'challenge' | 'submitting' }
  | { status: 'verified'; token: string }
  | { status: 'failed'; message: string };

export function useSignupVerification(container: Ref<HTMLElement | null>) {
  const state = ref<VerificationState>({ status: 'loading' });
  const ready = computed(
    () =>
      state.value.status === 'disabled' || state.value.status === 'verified',
  );
  let current: AbortController | undefined;
  let widget: { api: Turnstile; id: string } | undefined;

  function stop() {
    const previous = current;
    current = undefined;
    previous?.abort();
    if (widget) widget.api.remove(widget.id);
    widget = undefined;
  }

  async function start() {
    if (!container.value) return;
    stop();
    const attempt = new AbortController();
    current = attempt;
    state.value = { status: 'loading' };

    const acceptsCallback = () =>
      current === attempt &&
      (state.value.status === 'challenge' || state.value.status === 'verified');
    function fail(message: string) {
      state.value = { status: 'failed', message };
    }
    const configTimeout = setTimeout(() => attempt.abort(), LOAD_TIMEOUT_MS);
    try {
      const config = await request<{ turnstileSiteKey: unknown }>(
        '/api/signup/config',
        { cache: 'no-store', signal: attempt.signal },
      ).finally(() => clearTimeout(configTimeout));
      if (current !== attempt) return;
      const siteKey = config?.turnstileSiteKey;
      if (siteKey === null) {
        state.value = { status: 'disabled' };
        return;
      }
      if (typeof siteKey !== 'string' || !siteKey.trim())
        throw new Error('Invalid signup configuration');

      const api = await loadTurnstile();
      const target = container.value;
      if (current !== attempt || !target) return;
      state.value = { status: 'challenge' };
      const id = api.render(target, {
        sitekey: siteKey,
        action: 'signup',
        size: target.clientWidth < 300 ? 'compact' : 'normal',
        language: 'zh',
        retry: 'never',
        'response-field': false,
        'refresh-expired': 'never',
        'refresh-timeout': 'never',
        callback: (token) => {
          if (acceptsCallback() && token)
            state.value = { status: 'verified', token };
        },
        'error-callback': () => {
          if (acceptsCallback()) fail('安全验证失败，请重试。');
        },
        'expired-callback': () => {
          if (acceptsCallback()) fail('安全验证已过期，请重试。');
        },
        'timeout-callback': () => {
          if (acceptsCallback()) fail('安全验证已超时，请重试。');
        },
        'unsupported-callback': () => {
          if (acceptsCallback()) fail('当前浏览器无法完成安全验证。');
        },
      });
      widget = { api, id };
    } catch {
      if (current === attempt) fail('安全验证暂时无法加载，请重试。');
    }
  }

  function takeToken(): { token?: string } | undefined {
    if (!current) return;
    const result = state.value;
    if (result.status === 'disabled') return {};
    if (result.status !== 'verified') return;
    state.value = { status: 'submitting' };
    return { token: result.token };
  }

  function reset() {
    if (current && state.value.status === 'submitting') void start();
  }

  onMounted(start);
  onBeforeUnmount(stop);
  return { state, ready, takeToken, reset, retry: start };
}

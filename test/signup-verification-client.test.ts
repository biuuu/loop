import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createRenderer, h, ref } from 'vue';
import { useSignupVerification } from '../src/client/signup-verification';

function mountVerification(context: TestContext) {
  const renderer = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({ clientWidth: 280 }),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const root = {};
  let verification!: ReturnType<typeof useSignupVerification>;
  const unmount = () => renderer.render(null, root);
  context.after(unmount);
  renderer.render(
    h({
      setup() {
        const container = ref<HTMLElement | null>(null);
        verification = useSignupVerification(container);
        return () => h('div', { ref: container });
      },
    }),
    root,
  );
  return { ...verification, unmount };
}

function replaceGlobal(context: TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test('signup configuration can explicitly disable Turnstile without creating a widget', async (context) => {
  context.mock.method(
    globalThis,
    'fetch',
    async (path: string, init: RequestInit) => {
      assert.equal(path, '/api/signup/config');
      assert.equal(init.cache, 'no-store');
      return Response.json({ turnstileSiteKey: null });
    },
  );
  const verification = mountVerification(context);
  assert.equal(verification.takeToken(), undefined, 'wait for the config');
  await setImmediate();
  assert.equal(verification.ready.value, true);
  assert.deepEqual(verification.takeToken(), {});
});

test('leaving a signup form aborts its config request and discards a late response', async (context) => {
  let reply!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  context.mock.method(
    globalThis,
    'fetch',
    (_path: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>((resolve) => {
        reply = resolve;
      });
    },
  );
  const verification = mountVerification(context);
  verification.unmount();
  assert.equal(signal?.aborted, true);
  reply(Response.json({ turnstileSiteKey: null }));
  await setImmediate();
  assert.equal(verification.ready.value, false);
  assert.equal(verification.takeToken(), undefined);
});

test('unavailable config and blocked script stay closed to submission and can be retried', async (context) => {
  const scripts: FakeScript[] = [];
  class FakeScript extends EventTarget {
    src = '';
    async = false;
    removed = false;
    remove() {
      this.removed = true;
    }
  }
  const browser = { turnstile: undefined as object | undefined };
  replaceGlobal(context, 'window', browser);
  replaceGlobal(context, 'document', {
    createElement: () => new FakeScript(),
    head: { append: (script: FakeScript) => scripts.push(script) },
  });
  let reads = 0;
  context.mock.method(globalThis, 'fetch', async () =>
    reads++ === 0
      ? new Response('Unavailable', { status: 503 })
      : Response.json({ turnstileSiteKey: 'enabled' }),
  );
  const verification = mountVerification(context);
  await setImmediate();
  assert.equal(verification.state.value.status, 'failed');
  assert.equal(verification.takeToken(), undefined);
  assert.equal(scripts.length, 0);

  const blocked = verification.retry();
  await setImmediate();
  assert.equal(
    scripts[0]!.src,
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  );
  scripts[0]!.dispatchEvent(new Event('error'));
  await blocked;
  assert.equal(scripts[0]!.removed, true);
  assert.equal(verification.state.value.status, 'failed');
  assert.equal(verification.takeToken(), undefined);

  const recovered = verification.retry();
  await setImmediate();
  browser.turnstile = { render: () => 'widget', remove() {} };
  scripts[1]!.dispatchEvent(new Event('load'));
  await recovered;
  assert.equal(verification.state.value.status, 'challenge');
});

test('reset and unmount discard expired or reused tokens and ignore old widget callbacks', async (context) => {
  const widgets: {
    sitekey: string;
    action: string;
    size: string;
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
  }[] = [];
  const removed: string[] = [];
  replaceGlobal(context, 'window', {
    turnstile: {
      render(_target: unknown, options: (typeof widgets)[number]) {
        widgets.push(options);
        return String(widgets.length);
      },
      remove: (id: string) => removed.push(id),
    },
  });
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ turnstileSiteKey: 'enabled' }),
  );
  const verification = mountVerification(context);
  await setImmediate();
  const first = widgets[0]!;
  assert.equal(first.action, 'signup');
  assert.equal(first.sitekey, 'enabled');
  assert.equal(first.size, 'compact');
  first.callback('expired-token');
  assert.equal(verification.ready.value, true);
  first['expired-callback']();
  assert.equal(verification.ready.value, false);
  assert.equal(verification.takeToken(), undefined);

  await verification.retry();
  first.callback('stale-token');
  assert.equal(verification.takeToken(), undefined);
  widgets[1]!.callback('verified-token');
  assert.deepEqual(verification.takeToken(), { token: 'verified-token' });
  widgets[1]!.callback('late-token');
  assert.equal(verification.takeToken(), undefined);

  verification.reset();
  await setImmediate();
  widgets[1]!.callback('reused-token');
  assert.equal(verification.takeToken(), undefined);
  widgets[2]!.callback('fresh-token');
  widgets[2]!['error-callback']();
  assert.equal(verification.takeToken(), undefined);
  assert.equal(verification.state.value.status, 'failed');
  verification.unmount();
  widgets[2]!.callback('unmounted-token');
  assert.equal(verification.takeToken(), undefined);
  assert.deepEqual(removed, ['1', '2', '3']);
});

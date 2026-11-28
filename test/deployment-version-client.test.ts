import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { watchDeploymentVersion } from '../src/client/deployment-version';

function browserFixture(storage = new Map<string, string>()) {
  const requests: Parameters<Window['fetch']>[] = [];
  const reloads: string[][] = [];
  const page = Object.assign(new EventTarget(), { hidden: false });
  const server = { reply: async () => Response.json({ version: 'a' }) };
  const browser = Object.assign(new EventTarget(), {
    document: page,
    fetch(...request: Parameters<Window['fetch']>) {
      requests.push(request);
      return server.reply();
    },
    location: { reload: () => reloads.push([...storage.values()]) },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  return { browser, page, server, requests, reloads, storage };
}

test('checks immediately without cache and saves the new build before reloading', async (context) => {
  const { browser, server, requests, reloads } = browserFixture();
  server.reply = async () => Response.json({ version: 'b' });
  const watcher = watchDeploymentVersion('a', browser)!;
  context.after(watcher.close);
  await setImmediate();

  assert.equal(requests[0]?.[0], '/api/version');
  assert.equal(requests[0]?.[1]?.cache, 'no-store');
  assert.deepEqual(reloads, [['["b"]']]);
  await watcher.check();
  assert.equal(requests.length, 1);
});

test('stale pages remember each attempted build until a current page is verified', async (context) => {
  const storage = new Map<string, string>();
  async function openTab(build: string, deployed: string) {
    const { browser, server, reloads } = browserFixture(storage);
    server.reply = async () => Response.json({ version: deployed });
    const watcher = watchDeploymentVersion(build, browser)!;
    context.after(watcher.close);
    await setImmediate();
    watcher.close();
    return reloads.length;
  }

  assert.equal(await openTab('a', 'b'), 1);
  assert.equal(await openTab('a', 'c'), 1);
  assert.equal(await openTab('a', 'b'), 0);
  assert.equal(await openTab('a', 'c'), 0);
  assert.equal(await openTab('c', 'c'), 0);
  assert.equal(storage.size, 0);
  assert.equal(await openTab('c', 'b'), 1);
});

test('request failures and invalid or unchanged versions leave the page in place and permit a later retry', async (context) => {
  const { browser, server, reloads } = browserFixture();
  server.reply = async () => {
    throw new Error('network unavailable');
  };
  const watcher = watchDeploymentVersion('a', browser)!;
  context.after(watcher.close);
  await setImmediate();

  for (const response of [
    new Response('unavailable', { status: 503 }),
    new Response('<html>unexpected response</html>'),
    Response.json(null),
    Response.json({ version: null }),
    Response.json({ version: 23 }),
    Response.json({ version: ' ' }),
    Response.json({ version: 'a' }),
  ]) {
    server.reply = async () => response;
    await watcher.check();
    assert.equal(reloads.length, 0);
  }

  server.reply = async () => Response.json({ version: 'b' });
  await watcher.check();
  assert.equal(reloads.length, 1);
});

test('an unavailable or unwritable session store prevents a reload loop', async (context) => {
  for (const fail of ['read', 'write']) {
    const { browser, server, reloads } = browserFixture();
    server.reply = async () => Response.json({ version: 'b' });
    function unavailable(): never {
      throw new Error('storage unavailable');
    }
    if (fail === 'read') {
      Object.defineProperty(browser, 'sessionStorage', { get: unavailable });
    } else {
      browser.sessionStorage.setItem = unavailable;
    }
    const watcher = watchDeploymentVersion('a', browser)!;
    context.after(watcher.close);
    await setImmediate();
    assert.equal(reloads.length, 0);
  }
});

test('version checks use visibility, network and socket events without periodic polling', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { browser, page, server, requests, reloads } = browserFixture();
  page.hidden = true;
  let send!: (response: Response) => void;
  server.reply = () =>
    new Promise((resolve) => {
      send = resolve;
    });
  const watcher = watchDeploymentVersion('a', browser)!;
  context.after(watcher.close);
  browser.dispatchEvent(new Event('online'));
  assert.equal(requests.length, 0);

  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  browser.dispatchEvent(new Event('online'));
  await watcher.check();
  assert.equal(requests.length, 1);
  send(Response.json({ version: 'a' }));
  await setImmediate();

  server.reply = async () => Response.json({ version: 'a' });
  context.mock.timers.tick(180_000);
  assert.equal(requests.length, 1);
  browser.dispatchEvent(new Event('online'));
  assert.equal(requests.length, 2);
  await setImmediate();
  server.reply = async () => Response.json({ version: 'b' });
  await watcher.check();
  assert.equal(requests.length, 3);
  assert.equal(reloads.length, 1);
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 3);
});

test('closing the watcher aborts the current check and removes its listeners', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, page, server, requests, reloads } = browserFixture();
  let send!: (response: Response) => void;
  server.reply = () =>
    new Promise((resolve) => {
      send = resolve;
    });
  const watcher = watchDeploymentVersion('a', browser)!;
  assert.equal(requests[0]?.[1]?.signal?.aborted, false);

  watcher.close();
  assert.equal(requests[0]?.[1]?.signal?.aborted, true);
  send(Response.json({ version: 'b' }));
  await setImmediate();
  page.dispatchEvent(new Event('visibilitychange'));
  browser.dispatchEvent(new Event('online'));
  context.mock.timers.tick(30_000);
  await watcher.check();
  assert.equal(requests.length, 1);
  assert.equal(reloads.length, 0);
});

test('pages without a deployed build ID do not check for updates', () => {
  const { browser, page, requests } = browserFixture();
  assert.equal(watchDeploymentVersion(undefined, browser), undefined);
  assert.equal(watchDeploymentVersion(null, browser), undefined);
  browser.dispatchEvent(new Event('online'));
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 0);
});

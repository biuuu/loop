import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page, type LaunchOptions } from 'playwright';
import { createServer } from '../src/server/app.js';
import { neteaseMusic } from '../src/server/music.js';
import type { MusicService, Track } from '../src/shared/contracts.js';

const tracks: Track[] = [
  {
    id: '1',
    title: '午后的第一首歌',
    artist: '窗边的小猫',
    album: '慢拍',
    cover: '',
    durationMs: 120_000,
  },
  {
    id: '2',
    title: '月亮打了个盹',
    artist: '夜猫电台',
    album: '晚安',
    cover: '',
    durationMs: 120_000,
  },
];
const music: MusicService = {
  search: async () => tracks,
  detail: async (id) => {
    const track = tracks.find((t) => t.id === id);
    if (!track) throw new Error('missing');
    return track;
  },
  resolve: async (track) => ({
    url: 'https://audio.loop.test/music.wav',
    durationMs: track.id === '1' ? 30_000 : 120_000,
    ...(track.id === '1' ? { isTrial: true } : {}),
  }),
};
function browserOptions(live = false): LaunchOptions {
  const options: LaunchOptions = {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox'],
  };
  // WSL test hosts can read their installed Windows fonts without copying or distributing them.
  if (
    !process.env.FONTCONFIG_FILE &&
    existsSync('/mnt/c/Windows/Fonts/msyh.ttc')
  ) {
    mkdirSync('test-results/font-cache', { recursive: true });
    const config = resolve('test-results/fonts.conf');
    writeFileSync(
      config,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts</dir><dir>/usr/local/share/fonts</dir><dir>/mnt/c/Windows/Fonts</dir><cachedir>${resolve('test-results/font-cache')}</cachedir></fontconfig>`,
    );
    options.env = { ...process.env, FONTCONFIG_FILE: config };
  }
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (live && proxyUrl) {
    const proxy = new URL(proxyUrl);
    options.proxy = {
      server: `${proxy.protocol}//${proxy.host}`,
      bypass: '127.0.0.1,localhost',
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    };
  }
  return options;
}
function fixtureWav() {
  const length = 8000 * 120;
  const buffer = Buffer.alloc(44 + length, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length, 40);
  // Use a quiet tone rather than silence, which Chromium may treat as inactive media.
  for (let i = 0; i < length; i++)
    buffer[44 + i] =
      128 + Math.round(Math.sin((i / 8000) * 440 * Math.PI * 2) * 16);
  return buffer;
}
async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(check(), message);
}
async function enter(page: Page, origin: string, nickname: string) {
  await page.goto(`${origin}/rooms/__test__`);
  await page.getByLabel('大家怎么称呼你？').fill(nickname);
  await page
    .getByRole('button', { name: '以临时身份进入', exact: true })
    .click();
  await page.getByRole('main', { name: '共享音乐客厅' }).waitFor();
  await page.locator('canvas').waitFor();
}
async function addSong(page: Page, title: string) {
  await page
    .locator('.room-toolbar')
    .getByRole('button', { name: /找音乐/ })
    .click();
  await page.getByLabel('搜索网易云歌曲').fill('猫');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .getByRole('button', { name: `添加 ${title}`, exact: true })
    .click();
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll('button')].some(
        (button) =>
          button.getAttribute('aria-label') === `添加 ${title}` &&
          button.disabled,
      ),
    title,
  );
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
}

async function scenePoint(page: Page, point: { x: number; y: number }) {
  return page.locator('.room-canvas').evaluate((node, point) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const scale = Number(element.dataset.cameraScale);
    return {
      x: rect.left + Number(element.dataset.cameraX) + point.x * scale,
      y: rect.top + Number(element.dataset.cameraY) + point.y * scale,
    };
  }, point);
}
async function clickFloor(page: Page, point: { x: number; y: number }) {
  const screen = await scenePoint(page, point);
  const hitsCanvas = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS',
    screen,
  );
  assert.ok(
    hitsCanvas,
    `Floor must remain reachable at ${JSON.stringify(screen)}`,
  );
  await page.mouse.click(screen.x, screen.y);
}
async function joinStage(page: Page) {
  await page.getByRole('button', { name: '上台', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
}
async function assertFullViewport(page: Page) {
  const bounds = await page.locator('canvas').boundingBox();
  const viewport = page.viewportSize()!;
  assert.ok(
    bounds &&
      Math.abs(bounds.x) < 1 &&
      Math.abs(bounds.y) < 1 &&
      Math.abs(bounds.width - viewport.width) < 1 &&
      Math.abs(bounds.height - viewport.height) < 1,
    'Scene should fill the viewport',
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth > innerWidth + 1 ||
        document.documentElement.scrollHeight > innerHeight + 1,
    ),
    false,
    'The room must not scroll',
  );
}

async function assertZoomLimits(page: Page) {
  const reset = page.getByRole('button', { name: '重置视野', exact: true });
  await reset.click();
  assert.equal((await reset.textContent())?.trim(), '100%');
  const increase = page.getByRole('button', { name: '放大', exact: true });
  for (let i = 0; i < 20 && (await increase.isEnabled()); i++)
    await increase.click();
  assert.equal(await increase.isDisabled(), true);
  assert.equal((await reset.textContent())?.trim(), '125%');
  const decrease = page.getByRole('button', { name: '缩小', exact: true });
  for (let i = 0; i < 30 && (await decrease.isEnabled()); i++)
    await decrease.click();
  assert.equal(await decrease.isDisabled(), true);
  const camera = await page.locator('.room-canvas').evaluate((node) => {
    const element = node as HTMLElement;
    return {
      x: Number(element.dataset.cameraX),
      y: Number(element.dataset.cameraY),
      scale: Number(element.dataset.cameraScale),
      width: element.clientWidth,
      height: element.clientHeight,
    };
  });
  const contain = Math.min(camera.width / 1000, camera.height / 620);
  assert.ok(Math.abs(camera.scale - contain) < 1e-8);
  assert.ok(Math.abs(camera.x - (camera.width - 1000 * contain) / 2) < 1e-8);
  assert.ok(Math.abs(camera.y - (camera.height - 620 * contain) / 2) < 1e-8);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({
    path: `test-results/room-contain-${camera.width}.png`,
  });
  // A gutter is outside the world and cannot trigger a stage/floor confirmation.
  const gutter =
    camera.x > 1
      ? { x: camera.x / 2, y: camera.height / 2 }
      : { x: camera.width / 2, y: camera.y + 620 * contain + 12 };
  assert.equal(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
      gutter,
    ),
    'CANVAS',
  );
  await page.mouse.click(gutter.x, gutter.y);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await reset.click();
}

test(
  'optional browser: two guests, real canvas/audio, emotes, rotation and mobile layout',
  { skip: process.env.LOOP_BROWSER_TESTS !== '1', timeout: 180_000 },
  async () => {
    assert.ok(existsSync('dist/client/index.html'), 'Run npm run build first');
    const { app, room } = await createServer({
      dbPath: ':memory:',
      music,
      singleRoom: true,
    });
    const emoteEvents: { userId: string; id: string }[] = [];
    const broadcastEmote = room.onEmote;
    room.onEmote = (event) => {
      emoteEvents.push(event);
      broadcastEmote(event);
    };
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const errors: string[] = [];
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch(browserOptions());
      const desktop = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      });
      const wav = fixtureWav();
      for (const context of [desktop, mobile]) {
        await context.route('https://audio.loop.test/**', (route) => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(
            route.request().headers().range || '',
          );
          if (range) {
            const start = Number(range[1]),
              end = range[2]
                ? Math.min(Number(range[2]), wav.length - 1)
                : wav.length - 1;
            return route.fulfill({
              status: 206,
              contentType: 'audio/wav',
              headers: {
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${wav.length}`,
              },
              body: wav.subarray(start, end + 1),
            });
          }
          return route.fulfill({
            status: 200,
            contentType: 'audio/wav',
            headers: { 'Accept-Ranges': 'bytes' },
            body: wav,
          });
        });
        await context.addInitScript(() => {
          const NativeAudio = window.Audio;
          (
            window as unknown as { __loopTestAudio: HTMLAudioElement[] }
          ).__loopTestAudio = [];
          window.Audio = class extends NativeAudio {
            constructor(src?: string) {
              super(src);
              (
                window as unknown as { __loopTestAudio: HTMLAudioElement[] }
              ).__loopTestAudio.push(this);
            }
          };
        });
      }
      const a = await desktop.newPage(),
        b = await mobile.newPage();
      a.on('pageerror', (error) => errors.push(error.message));
      b.on('pageerror', (error) => errors.push(error.message));
      for (const [page, nickname] of [
        [a, '午后猫'],
        [b, '月亮猫'],
      ] as const) {
        const [sheet] = await Promise.all([
          page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/Cat/Cat.png',
          ),
          enter(page, origin, nickname),
        ]);
        assert.equal(
          sheet.status(),
          200,
          'The supplied cat sprite sheet loads from the app',
        );
        assert.match(sheet.headers()['content-type'] || '', /image\/png/);
        assert.equal(await page.locator('.scene-fallback').count(), 0);
      }
      await assertFullViewport(a);
      await assertFullViewport(b);
      assert.equal(
        (
          await a
            .getByRole('button', { name: '重置视野', exact: true })
            .textContent()
        )?.trim(),
        '100%',
      );
      await assertZoomLimits(b);
      assert.equal(
        await a.locator('.room-toolbar button svg.lucide').count(),
        4,
        'Toolbar controls use real SVG icons',
      );
      await waitFor(
        () => room.snapshot().users.length === 2,
        'Both guests should join the real socket room',
      );
      const firstId = room
        .snapshot()
        .users.find((u) => u.nickname === '午后猫')!.id;
      const movedX = Math.min(
        925,
        room.snapshot().users.find((u) => u.id === firstId)!.targetX + 50,
      );
      const initialScale = Number(
        await a.locator('.room-canvas').getAttribute('data-camera-scale'),
      );
      const beforeMove = room.snapshot().users.find((u) => u.id === firstId)!;
      const cursor = await scenePoint(a, { x: beforeMove.x, y: beforeMove.y });
      await a.mouse.move(cursor.x, cursor.y);
      await a.mouse.wheel(0, -100);
      await a.waitForFunction(
        (scale) =>
          Number(
            document.querySelector<HTMLElement>('.room-canvas')?.dataset
              .cameraScale,
          ) > scale,
        initialScale,
      );
      const initialCamera = await a
        .locator('.room-canvas')
        .getAttribute('data-camera-x');
      await clickFloor(a, { x: movedX, y: beforeMove.y });
      await waitFor(
        () =>
          Math.abs(
            (room.snapshot().users.find((u) => u.id === firstId)?.targetX ??
              -1000) - movedX,
          ) < 1,
        'Movement must reach authoritative state',
      );
      await a.waitForFunction(
        (previous) =>
          document.querySelector<HTMLElement>('.room-canvas')?.dataset
            .cameraX !== previous,
        initialCamera,
      );
      await a.getByRole('button', { name: '重置视野', exact: true }).click();
      await a
        .getByRole('button', { name: '发送预设表情', exact: true })
        .click();
      await a
        .getByRole('button', { name: '小草神表情 1', exact: true })
        .click();
      await waitFor(
        () =>
          emoteEvents.some(
            (event) => event.userId === firstId && event.id === 'nahida-1',
          ),
        'Preset emote should be broadcast',
      );
      await addSong(a, tracks[0]!.title);
      await addSong(b, tracks[1]!.title);
      await a.getByRole('button', { name: '上台', exact: true }).click();
      assert.equal(
        await a.getByRole('dialog').count(),
        0,
        'Joining a seat should not open a confirmation',
      );
      await waitFor(
        () => room.snapshot().playback?.djId === firstId,
        'First DJ should play',
      );
      await a.getByText('试听', { exact: true }).waitFor();
      assert.equal(room.snapshot().playback?.durationMs, 30_000);
      assert.equal(
        room.snapshot().users.find((u) => u.id === firstId)!.seat,
        0,
      );
      const beforeSecondJoin = room
        .snapshot()
        .users.find((u) => u.nickname === '月亮猫')!;
      await joinStage(b);
      await waitFor(
        () => room.snapshot().stage.length === 2,
        'Both stage seats should be occupied',
      );
      assert.equal(
        await a.getByRole('button', { name: /开启声音|声音已开启/ }).count(),
        0,
      );
      assert.equal(
        await b.getByRole('button', { name: /开启声音|声音已开启/ }).count(),
        0,
      );
      const audioPlaying = () => {
        const audio = (
          window as unknown as { __loopTestAudio: HTMLAudioElement[] }
        ).__loopTestAudio[0];
        return audio && !audio.paused && audio.currentTime > 0;
      };
      await a.waitForFunction(audioPlaying);
      await b.waitForFunction(audioPlaying);
      await a.getByRole('button', { name: '下一首', exact: true }).click();
      await waitFor(
        () => room.snapshot().playback?.track.id === '2',
        'Next DJ should play their own song',
      );
      await a
        .getByRole('heading', { name: tracks[1]!.title, exact: true })
        .waitFor();
      await b
        .getByRole('heading', { name: tracks[1]!.title, exact: true })
        .waitFor();
      assert.equal(await a.getByText('试听', { exact: true }).count(), 0);
      await a.waitForFunction(audioPlaying);
      await b.waitForFunction(audioPlaying);
      const startedAt = room.snapshot().playback!.startedAt;
      await Promise.all(
        [a, b].map(async (page) => {
          try {
            await page.waitForFunction(
              (start) => {
                const audio = (
                  window as unknown as { __loopTestAudio: HTMLAudioElement[] }
                ).__loopTestAudio[0]!;
                return (
                  audio.readyState >= 3 &&
                  Math.abs(audio.currentTime - (Date.now() - start) / 1000) <
                    0.6
                );
              },
              startedAt,
              { polling: 100, timeout: 10_000 },
            );
          } catch (error) {
            console.error(
              'Audio alignment diagnostics',
              await page.evaluate((start) => {
                const audio = (
                  window as unknown as { __loopTestAudio: HTMLAudioElement[] }
                ).__loopTestAudio[0]!;
                const provides =
                  (
                    document.querySelector('#app') as unknown as {
                      __vue_app__?: {
                        _context: {
                          provides: Record<
                            PropertyKey,
                            { _s?: Map<string, { offset: number }> }
                          >;
                        };
                      };
                    }
                  ).__vue_app__?._context.provides || {};
                const store = Reflect.ownKeys(provides)
                  .map((key) => provides[key]?._s?.get('room'))
                  .find(Boolean);
                return {
                  clockOffset: store?.offset,
                  currentTime: audio.currentTime,
                  expected: (Date.now() - start) / 1000,
                  paused: audio.paused,
                  readyState: audio.readyState,
                  seeking: audio.seeking,
                  hidden: document.hidden,
                  seekable: audio.seekable.length,
                  error: audio.error?.message,
                };
              }, startedAt),
            );
            throw error;
          }
        }),
      );
      const samples = await Promise.all(
        [a, b].map((page) =>
          page.evaluate(() => {
            const audio = (
              window as unknown as { __loopTestAudio: HTMLAudioElement[] }
            ).__loopTestAudio[0]!;
            return {
              time: audio.currentTime,
              observedAt: Date.now(),
              hidden: document.hidden,
              paused: audio.paused,
            };
          }),
        ),
      );
      // Browser IPC can sample pages at different instants; compare offsets to the same server timeline.
      const drift = samples.map(
        (sample) => sample.time - (sample.observedAt - startedAt) / 1000,
      );
      assert.ok(
        drift.every((value) => Math.abs(value) < 0.7) &&
          Math.abs(drift[0]! - drift[1]!) < 0.7,
        `Media progress should converge, samples=${JSON.stringify(samples)}, drift=${drift}`,
      );
      assert.equal(
        await b.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        ),
        false,
        'Mobile should have no horizontal overflow',
      );
      assert.equal(
        await a.getByPlaceholder(/聊天|消息/).count(),
        0,
        'No text-chat input',
      );
      mkdirSync('test-results', { recursive: true });
      await a.screenshot({
        path: 'test-results/room-desktop.png',
        fullPage: true,
      });
      await b.screenshot({
        path: 'test-results/room-mobile.png',
        fullPage: true,
      });
      const round = room.snapshot().playback!.roundId;
      const secondId = beforeSecondJoin.id;
      const secondSeat = room.snapshot().users.find((u) => u.id === secondId)!;
      await b.setViewportSize({ width: 844, height: 390 });
      await b.waitForFunction(
        () =>
          document.querySelector('canvas')?.getBoundingClientRect().height ===
          innerHeight,
      );
      await assertFullViewport(b);
      await assertZoomLimits(b);
      await clickFloor(b, { x: secondSeat.x, y: 354 });
      await b.waitForTimeout(100);
      assert.equal(
        room.snapshot().playback!.roundId,
        round,
        'Clicking the floor while on stage keeps the current song',
      );
      assert.equal(
        room.snapshot().users.find((u) => u.id === secondId)!.seat,
        secondSeat.seat,
      );
      await b.screenshot({ path: 'test-results/room-landscape.png' });
      await clickFloor(b, { x: secondSeat.x, y: secondSeat.y - 25 });
      const catMenu = b.getByRole('dialog', { name: '我的小猫', exact: true });
      await catMenu
        .getByRole('button', { name: '离开舞台', exact: true })
        .click();
      await catMenu.waitFor({ state: 'hidden' });
      await b.waitForFunction(() => !document.querySelector('.self-cat-menu'));
      await waitFor(
        () =>
          room.snapshot().users.find((u) => u.id === secondId)!.seat === null,
        'self-cat action leaves the stage without confirmation',
      );
      const returned = room.snapshot().users.find((u) => u.id === secondId)!;
      assert.equal(returned.seat, null);
      assert.equal(returned.x, beforeSecondJoin.x);
      assert.equal(returned.y, beforeSecondJoin.y);
      await a.setViewportSize({ width: 2560, height: 1080 });
      await a.waitForFunction(
        () =>
          document.querySelector('canvas')?.getBoundingClientRect().width ===
          innerWidth,
      );
      await assertFullViewport(a);
      await a.screenshot({ path: 'test-results/room-wide.png' });
      await a.addInitScript(() => {
        let activated = false;
        for (const event of ['pointerup', 'click', 'keydown'])
          document.addEventListener(
            event,
            () => {
              activated = true;
            },
            true,
          );
        const nativePlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (!activated)
            return Promise.reject(
              new DOMException(
                'Gesture required by test policy',
                'NotAllowedError',
              ),
            );
          return nativePlay.call(this);
        };
      });
      await a.reload();
      await a.getByRole('main', { name: '共享音乐客厅' }).waitFor();
      await a
        .getByText('轻触页面或按任意键即可继续播放', { exact: true })
        .waitFor();
      assert.equal(
        await a
          .getByRole('button', {
            name: /开启声音|声音已开启|重试/,
            exact: true,
          })
          .count(),
        0,
        'Autoplay policy does not introduce another audio gate',
      );
      await a.keyboard.press('Tab');
      await a.waitForFunction(audioPlaying);
      await a
        .getByText('轻触页面或按任意键即可继续播放', { exact: true })
        .waitFor({ state: 'hidden' });
      await a
        .locator('.room-toolbar')
        .getByRole('button', { name: /我的歌单/ })
        .click();
      await a
        .locator('.track-list')
        .getByText(tracks[0]!.title, { exact: true })
        .waitFor();
      await waitFor(
        () => room.snapshot().users.length === 2,
        'Refresh must retain identity and seat',
      );
      assert.deepEqual(
        errors,
        [],
        'Browser should have no uncaught runtime errors',
      );
      await a.keyboard.press('Escape');
      await a.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.match(
        await a.evaluate(() => document.activeElement?.textContent || ''),
        /我的歌单/,
        'Closing the panel restores keyboard focus',
      );
      assert.equal(
        await b.evaluate(
          () =>
            (window as unknown as { __loopTestAudio: HTMLAudioElement[] })
              .__loopTestAudio.length,
        ),
        1,
        'Panels and confirmations do not recreate audio',
      );
      await desktop.close();
      await mobile.close();
    } catch (error) {
      mkdirSync('test-results', { recursive: true });
      for (const [index, context] of (browser?.contexts() || []).entries()) {
        await context
          .pages()[0]
          ?.screenshot({ path: `test-results/room-failure-${index}.png` })
          .catch(() => {});
      }
      throw error;
    } finally {
      await browser?.close();
      await app.close();
    }
  },
);

for (const sample of [
  { id: '26348051', trial: false },
  { id: '209228', trial: true },
  { id: '536570516', trial: true },
  { id: '1901371647', trial: true },
])
  test(
    `optional live browser: Netease ${sample.id} ${sample.trial ? 'preview' : 'full track'} plays and seeks directly from its public CDN`,
    {
      skip:
        process.env.LOOP_BROWSER_TESTS !== '1' ||
        process.env.LOOP_LIVE_MUSIC !== '1',
      timeout: 90_000,
    },
    async (context) => {
      assert.ok(
        existsSync('dist/client/index.html'),
        'Run npm run build first',
      );
      const selected = await neteaseMusic.detail(sample.id);
      const resource = await neteaseMusic.resolve(selected);
      assert.equal(
        !!resource.isTrial,
        sample.trial,
        'Live sample access may change upstream',
      );
      const { app, room } = await createServer({
        dbPath: ':memory:',
        music: neteaseMusic,
        singleRoom: true,
      });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        assert.ok(address && typeof address === 'object');
        const origin = `http://127.0.0.1:${address.port}`;
        const guest = await app.inject({
          method: 'POST',
          url: '/api/guest',
          payload: { nickname: '实测猫' },
        });
        const cookie = (guest.headers['set-cookie'] as string).split(';')[0]!;
        const added = await app.inject({
          method: 'POST',
          url: '/api/playlist',
          headers: { cookie },
          payload: { id: selected.id },
        });
        assert.equal(added.statusCode, 200);
        browser = await chromium.launch(browserOptions(true));
        const browserContext = await browser.newContext();
        await browserContext.addCookies([
          {
            name: 'loop_guest',
            value: cookie.slice(cookie.indexOf('=') + 1),
            url: origin,
            httpOnly: true,
            sameSite: 'Lax',
          },
        ]);
        await browserContext.addInitScript(() => {
          const NativeAudio = window.Audio;
          window.Audio = class extends NativeAudio {
            constructor(src?: string) {
              super(src);
              (
                window as unknown as { __liveAudio: HTMLAudioElement }
              ).__liveAudio = this;
            }
          };
        });
        const page = await browserContext.newPage();
        const mediaHosts: string[] = [];
        page.on('request', (request) => {
          if (request.resourceType() === 'media')
            mediaHosts.push(new URL(request.url()).hostname);
        });
        await page.goto(`${origin}/rooms/__test__`);
        await page.getByRole('main', { name: '共享音乐客厅' }).waitFor();
        await joinStage(page);
        await page
          .getByRole('heading', { name: selected.title, exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('button', { name: /开启声音|声音已开启/ })
            .count(),
          0,
        );
        await page.waitForFunction(
          () => {
            const a = (window as unknown as { __liveAudio: HTMLAudioElement })
              .__liveAudio;
            return a && !a.paused && a.currentTime > 0.2 && a.readyState >= 3;
          },
          undefined,
          { timeout: 25_000 },
        );
        const duration = await page.evaluate(
          () =>
            (window as unknown as { __liveAudio: HTMLAudioElement }).__liveAudio
              .duration,
        );
        const playing = room.snapshot().playback!;
        assert.ok(
          Math.abs(duration - playing.durationMs / 1000) < 2,
          'Actual media duration must match the room timeline',
        );
        if (sample.trial) {
          assert.ok(
            playing.durationMs < selected.durationMs,
            'A preview must not wait for the whole song',
          );
          await page.getByText('试听', { exact: true }).waitFor();
        } else {
          assert.ok(duration > 60, 'Full public audio must load');
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const a = (window as unknown as { __liveAudio: HTMLAudioElement })
                .__liveAudio;
              const timer = setTimeout(
                () => reject(new Error('seek timeout')),
                10000,
              );
              a.addEventListener(
                'seeked',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
              a.currentTime = 10;
            }),
        );
        assert.ok(
          mediaHosts.some(
            (host) => host !== '127.0.0.1' && host !== 'localhost',
          ),
          'Audio must be fetched from public origin, not Loop server',
        );
        context.diagnostic(
          `Real browser playback and seek passed for track ${selected.id}; audio duration ${Math.round(duration)} seconds. Media origin is external.`,
        );
        await page.screenshot({
          path: `test-results/room-live-${sample.id === '209228' ? 'preview' : sample.trial ? sample.id : 'music'}.png`,
          fullPage: true,
        });
      } finally {
        await browser?.close();
        await app.close();
      }
    },
  );

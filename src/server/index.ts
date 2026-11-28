import { createServer } from './app.js';
import { resolveListenHost } from './request-ip.js';
import { loadTextFilter } from './text-filter.js';

let app: Awaited<ReturnType<typeof createServer>>['app'] | undefined;
try {
  const host = resolveListenHost();
  ({ app } = await createServer({
    textFilter: loadTextFilter(),
    buildId:
      typeof __LOOP_BUILD_ID__ === 'string' ? __LOOP_BUILD_ID__ : undefined,
    freeSpecialCoats: process.argv.includes('--development'),
  }));
  const shutdown = async () => {
    await app?.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({
    host,
    port: Number(process.env.PORT || 3000),
  });
  console.log('Loop server is ready');
} catch (error) {
  console.error(
    'Loop server could not start',
    error instanceof Error ? error.message : 'unknown error',
  );
  await app?.close();
  process.exitCode = 1;
}

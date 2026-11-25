import { createServer } from './app.js';
import { loadTextFilter } from './text-filter.js';

const { app } = await createServer({
  textFilter: loadTextFilter(),
  buildId:
    typeof __LOOP_BUILD_ID__ === 'string' ? __LOOP_BUILD_ID__ : undefined,
});
const shutdown = async () => {
  await app.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  await app.listen({
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
  });
  console.log('Loop server is ready');
} catch (error) {
  console.error(
    'Loop server could not start',
    error instanceof Error ? error.message : 'unknown error',
  );
  await app.close();
  process.exitCode = 1;
}

import { randomUUID } from 'node:crypto';
import { build as buildServer } from 'esbuild';
import { build as buildClient } from 'vite';

const define = { __LOOP_BUILD_ID__: JSON.stringify(randomUUID()) };

await buildClient({ define });
await buildServer({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'info',
  define,
});

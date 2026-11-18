import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const flags = new Set(process.argv.slice(2));
const known = new Set(['--browser', '--live']);
for (const flag of flags) {
  if (!known.has(flag) && !flag.startsWith('--chromium='))
    throw new Error(`Unknown test option: ${flag}`);
}
const chromium = [...flags]
  .find((flag) => flag.startsWith('--chromium='))
  ?.slice('--chromium='.length);
const child = spawn(
  process.execPath,
  [
    ...(flags.has('--live') && existsSync('.env') ? ['--env-file=.env'] : []),
    '--import',
    'tsx',
    '--test',
    ...readdirSync('test')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `test/${name}`),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(flags.has('--browser') ? { LOOP_BROWSER_TESTS: '1' } : {}),
      ...(flags.has('--live') ? { LOOP_LIVE_MUSIC: '1' } : {}),
      ...(chromium ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE: chromium } : {}),
    },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

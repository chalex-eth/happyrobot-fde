import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const production = process.argv.includes('--production');
const apiPort = process.env.API_PORT ?? '3001';
const webPort = process.env.WEB_PORT ?? '3000';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 12_000).unref();
}
function start(args, env) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 1));
}
start(
  production
    ? ['apps/api/dist/server.mjs']
    : ['--watch', '--import', 'tsx', 'apps/api/src/server.ts'],
  { ...process.env, NODE_ENV: production ? 'production' : 'development', API_PORT: apiPort },
);
// Only the API receives integration credentials; the web process needs a target URL.
const webEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'CI', 'NO_COLOR'].includes(key),
  ),
);
start(
  [
    'node_modules/next/dist/bin/next',
    production ? 'start' : 'dev',
    'apps/web',
    '--hostname',
    '127.0.0.1',
    '--port',
    webPort,
  ],
  {
    ...webEnv,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    NODE_ENV: production ? 'production' : 'development',
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());

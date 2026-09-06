import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
const mode = process.argv[2] ?? 'up';
const allowed = ['up', 'down', 'status', 'logs', 'check'];
const compose = ['compose', '--env-file', '.env.local', '--env-file', '.env.docker.local'];
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [...compose, ...args], { stdio: 'inherit' });
    child.on('error', () => reject(Error('Docker is unavailable. Start Docker Desktop and retry.')));
    child.on('exit', code => code === 0 ? resolve() : reject(Error('Docker command failed. Check the output above.')));
  });
}
try {
  if (!allowed.includes(mode)) throw Error(`Use one of: ${allowed.join(', ')}`);
  for (const file of ['.env.local', '.env.docker.local']) {
    if (!existsSync(file)) throw Error(`Missing ${file}; see docs/local-docker.md for one-time setup.`);
    process.loadEnvFile(file);
  }
  if (['up', 'check'].includes(mode)) {
    const domain = process.env.NGROK_DOMAIN;
    if (!domain || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) throw Error('Set NGROK_DOMAIN to your assigned hostname, without https:// or a path.');
    if (process.env.MCP_PUBLIC_URL !== `https://${domain}/api/mcp`) throw Error('MCP_PUBLIC_URL must be https://NGROK_DOMAIN/api/mcp. Update .env.local before starting.');
    if (process.env.HAPPYROBOT_ENVIRONMENT !== 'development') throw Error('HAPPYROBOT_ENVIRONMENT must be development.');
    for (const key of ['NGROK_AUTHTOKEN', 'MCP_AUTH_TOKEN', 'HAPPYROBOT_API_KEY', 'HAPPYROBOT_WORKFLOW_ID', 'HAPPYROBOT_MCP_SERVER_NAME', 'OTP_HASH_SECRET', 'TWIN_GATEWAY', 'TWIN_ORG_ID', 'TMS_HOST', 'TMS_PORT', 'TMS_TOKEN', 'FMCSA_API_KEY']) {
      if (!process.env[key]) throw Error(`Missing ${key}.`);
    }
    if (process.env.OTP_DEMO_MODE !== 'true' || process.env.OTP_DELIVERY_MODE !== 'mock') throw Error('This local stack requires OTP_DEMO_MODE=true and OTP_DELIVERY_MODE=mock.');
  }
  if (mode === 'up') {
    await run(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  }
  if (['up', 'check'].includes(mode)) {
    await run(['exec', '-T', 'app', 'node', '--import', 'tsx', 'scripts/happyrobot/check-local.ts']);
    console.log('Ready: http://localhost:3000 — development workflow and public MCP connection verified.');
  } else if (mode === 'down') await run(['down']);
  else if (mode === 'status') await run(['ps']);
  else await run(['logs', '--tail', '80', '-f']);
} catch (error) {
  console.error(error.message);
  if (mode === 'up' || mode === 'check') console.error('Startup is not verified. Services already started remain running; use npm run local:status or local:down.');
  process.exitCode = 1;
}

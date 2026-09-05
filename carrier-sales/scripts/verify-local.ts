import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
const deployed = process.argv.includes('--deployed');
// Explicitly pin the authorized App destination before transmitting the bearer token.
const base = deployed ? 'https://plain-cinder-4kgyg.custom-apps.happyrobot.ai' : process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:3000';
if (!deployed && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use --deployed for the configured HappyRobot App; local mode only permits localhost.');
const token = process.env.LOCAL_API_TOKEN;
if (!token) throw new Error('LOCAL_API_TOKEN is missing. Supply or authorize a local token before verifying HTTP.');
const run = new Date().toISOString();
async function request(label: string, body: unknown, expected: number, authorization?: string) {
  const started = Date.now();
  const response = await fetch(`${base}/api/tms`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  for (const secret of [token, process.env.TMS_TOKEN, process.env.FMCSA_API_KEY]) {
    if (secret) assert.ok(!text.includes(secret), `${label}: credential exposed`);
  }
  assert.ok(!/MAX_BUY|max_rate|targetRate|maxAutoRate/.test(text), `${label}: private field exposed`);
  const result = JSON.parse(text);
  const evidence = { run, check: label, status: response.status, elapsed_ms: Date.now() - started, result };
  console.log(JSON.stringify(evidence));
  await appendFile(deployed ? 'deployed-results.jsonl' : 'local-results.jsonl', JSON.stringify(evidence) + '\n');
  assert.equal(response.status, expected, `${label}: unexpected HTTP status`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  assert.equal(result.requestId, response.headers.get('x-request-id'));
  return result;
}
const auth = `Bearer ${token}`;
await request('missing authentication', { command: 'DEBUG_ECHO' }, 401);
const wrong = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
await request('wrong authentication', { command: 'DEBUG_ECHO' }, 401, `Bearer ${wrong}`);
await request('booking command rejected locally', { command: 'LOAD_BOOK' }, 400, auth);
await request('delimiter injection rejected locally', { command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN|AUTH:injected' } }, 400, auth);
await request('filter required', { command: 'LOAD_QUERY' }, 400, auth);
await request('real echo', { command: 'DEBUG_ECHO' }, 200, auth);
const query = await request('real query', { command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN', MAX_RESULTS: '3' } }, 200, auth);
assert.ok(query.complete && query.records.length > 0, 'No live loads; detail verification blocked.');
const detail = await request('real detail', { command: 'LOAD_GET', fields: { LOAD_ID: query.records[0].LOAD_ID } }, 200, auth);
assert.equal(detail.records.length, 1);
assert.equal(detail.records[0].LOAD_ID, query.records[0].LOAD_ID);
assert.ok(detail.complete);
const fields = new Set(['LOAD_ID','ORIG_CITY','ORIG_STATE','ORIG_ZIP','DEST_CITY','DEST_STATE','DEST_ZIP','PICKUP_DT','DELIVERY_DT','EQTYPE','RATE','MILES','STATUS','WEIGHT','PIECES']);
for (const record of [...query.records, ...detail.records]) {
  for (const key of Object.keys(record)) assert.ok(fields.has(key), `Unexpected output field: ${key}`);
}
console.log(`PASS: ${deployed ? 'deployed' : 'local'} HTTP → Node TCP → real TMS query/detail; auth and public-field checks passed.`);

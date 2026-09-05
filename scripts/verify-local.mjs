import assert from 'node:assert/strict';

const base = process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:3000';
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:', 'Verification is restricted to local HTTP');
assert.ok(process.env.LOCAL_API_TOKEN, 'LOCAL_API_TOKEN is required');
const allowed = new Set(['LOAD_ID', 'ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'PICKUP_DT', 'DELIVERY_DT', 'EQTYPE', 'RATE', 'MILES', 'STATUS', 'WEIGHT', 'PIECES']);
async function call(body, expected = 200, token = process.env.LOCAL_API_TOKEN) {
  const response = await fetch(new URL('/api/tms', url), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  for (const key of ['LOCAL_API_TOKEN', 'TMS_TOKEN']) if (process.env[key]) assert.ok(!text.includes(process.env[key]), `${key} exposed`);
  const result = JSON.parse(text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(result.requestId);
  assert.equal(response.headers.get('x-request-id'), result.requestId);
  console.log(JSON.stringify({ command: body.command, status: response.status, error: result.error, attempts: result.attempts, failures: result.failures, count: result.record_count, requestId: result.requestId }));
  assert.equal(response.status, expected, `Unexpected status: ${result.error ?? 'unknown'}`);
  for (const load of result.records ?? []) assert.ok(Object.keys(load).every(key => allowed.has(key)), 'Non-public field exposed');
  return result;
}
await call({ command: 'DEBUG_ECHO' }, 401, '');
await call({ command: 'DEBUG_ECHO' }, 401, 'wrong');
await call({ command: 'LOAD_BOOK' }, 400);
await call({ command: 'LOAD_QUERY' }, 400);
await call({ command: 'LOAD_GET', fields: { LOAD_ID: 'X|CMD:LOAD_BOOK' } }, 400);
await call({ command: 'DEBUG_ECHO' });
const query = await call({ command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN', MAX_RESULTS: '5' } });
assert.ok(query.records?.length, 'No live loads returned; detail remains unverified');
const load = await call({ command: 'LOAD_GET', fields: { LOAD_ID: query.records[0].LOAD_ID } });
assert.equal(load.records[0].LOAD_ID, query.records[0].LOAD_ID);
console.log('PASS: 8 local HTTP checks including real TMS echo, search and detail.');

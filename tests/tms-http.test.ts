import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleTmsRequest } from '../src/tms-http';
import { parseResponse, runTms } from '../src/tms';

const previous = process.env.LOCAL_API_TOKEN;
before(() => { process.env.LOCAL_API_TOKEN = 'test-only'; });
after(() => { if (previous === undefined) delete process.env.LOCAL_API_TOKEN; else process.env.LOCAL_API_TOKEN = previous; });
const request = (body: string, token = 'test-only', mime = 'application/json') => new Request('http://localhost/api/tms', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': mime, 'x-request-id': 'test-request' }, body,
});
const forbidden: typeof runTms = async () => { throw new Error('Transport must not run'); };

test('authentication rejects wrong or missing bearer before transport', async () => {
  for (const token of ['', 'wrong']) assert.equal((await handleTmsRequest(request('{}', token), forbidden)).status, 401);
});
test('missing app token fails closed', async () => {
  delete process.env.LOCAL_API_TOKEN;
  try { assert.equal((await handleTmsRequest(request('{}'), forbidden)).status, 503); }
  finally { process.env.LOCAL_API_TOKEN = 'test-only'; }
});
test('rejects malformed JSON, incorrect MIME and oversized requests', async () => {
  assert.equal((await handleTmsRequest(request('{'), forbidden)).status, 400);
  assert.equal((await handleTmsRequest(request('{}', 'test-only', 'application/jsonp'), forbidden)).status, 415);
  assert.equal((await handleTmsRequest(request(' '.repeat(4097)), forbidden)).status, 413);
});
test('rejects booking, missing filters and command injection', async () => {
  for (const body of [{ command: 'LOAD_BOOK' }, { command: 'LOAD_QUERY' }, { command: 'LOAD_GET', fields: { LOAD_ID: 'X|CMD:LOAD_BOOK' } }]) {
    assert.equal((await handleTmsRequest(request(JSON.stringify(body)), forbidden)).status, 400);
  }
});
test('success preserves trace, cancellation signal and no-store headers', async () => {
  const input = request('{"command":"DEBUG_ECHO"}');
  const response = await handleTmsRequest(input, async (value, signal) => {
    assert.equal(signal, input.signal);
    assert.deepEqual(value, { command: 'DEBUG_ECHO', fields: {} });
    return { ok: true, command: 'DEBUG_ECHO', records: [], complete: true, record_count: 0, attempts: 1, failures: [], elapsed_ms: 1 };
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-request-id'), 'test-request');
  assert.equal((await response.json()).requestId, 'test-request');
});
test('maps bounded upstream failures to safe HTTP responses', async () => {
  for (const [error, status] of [['TMS_TIMEOUT', 504], ['INCOMPLETE_RESPONSE', 502], ['TMS_NOT_CONFIGURED', 503]] as const) {
    const response = await handleTmsRequest(request('{"command":"DEBUG_ECHO"}'), async () => ({
      ok: false, command: 'DEBUG_ECHO', error, retryable: true, attempts: 2, failures: [error], elapsed_ms: 8000,
    }));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, error);
  }
});
test('unexpected exceptions never expose their text in responses', async () => {
  const response = await handleTmsRequest(request('{"command":"DEBUG_ECHO"}'), async () => { throw new Error('private-upstream-secret'); });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private-upstream-secret'), false);
});
test('load parser excludes private and unknown fields and rejects mismatched detail', () => {
  const line = 'LOAD_ID:TEST1|ORIG_CITY:A|ORIG_STATE:TX|ORIG_ZIP:75001|DEST_CITY:B|DEST_STATE:CA|DEST_ZIP:90001|PICKUP_DT:20260905080000|EQTYPE:DRY_VAN|RATE:1000|MILES:900|STATUS:AVAILABLE|MAX_BUY:2000|NOTES:private|UNKNOWN:private';
  const [load] = parseResponse([line], { command: 'LOAD_GET', fields: { LOAD_ID: 'TEST1' } });
  assert.equal(load.RATE, '1000');
  for (const key of ['MAX_BUY', 'NOTES', 'UNKNOWN']) assert.equal(key in load, false);
  assert.throws(() => parseResponse([line], { command: 'LOAD_GET', fields: { LOAD_ID: 'OTHER' } }));
});

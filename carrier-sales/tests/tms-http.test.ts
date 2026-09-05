import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleTmsRequest } from '../src/tms-http';
import { parseResponse, type runTms } from '../src/tms';

const savedToken = process.env.LOCAL_API_TOKEN;
before(() => { process.env.LOCAL_API_TOKEN = 'test-only-token'; });
after(() => {
  if (savedToken === undefined) delete process.env.LOCAL_API_TOKEN;
  else process.env.LOCAL_API_TOKEN = savedToken;
});
const query = { command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN', MAX_RESULTS: '3' } };
function request(body: unknown = query, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/tms', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-token', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const unexpectedTransport: typeof runTms = async () => { assert.fail('Transport must not be called'); };

test('rejects missing and wrong authentication before any transport call', async () => {
  for (const Authorization of ['', 'Bearer test-only-tokem']) {
    const response = await handleTmsRequest(request(query, { Authorization }), unexpectedTransport);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'UNAUTHORIZED');
  }
});

test('missing auth configuration fails closed', async () => {
  delete process.env.LOCAL_API_TOKEN;
  try {
    assert.equal((await handleTmsRequest(request(), unexpectedTransport)).status, 503);
  } finally { process.env.LOCAL_API_TOKEN = 'test-only-token'; }
});

test('rejects malformed JSON and invalid content types before transport', async () => {
  assert.equal((await handleTmsRequest(request('{'), unexpectedTransport)).status, 400);
  assert.equal((await handleTmsRequest(request(query, { 'Content-Type': 'application/jsonp' }), unexpectedTransport)).status, 415);
});

test('rejects booking, delimiter injection, and unfiltered searches', async () => {
  for (const body of [
    { command: 'LOAD_BOOK' },
    { command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN|AUTH:injected' } },
    { command: 'LOAD_QUERY' },
  ]) assert.equal((await handleTmsRequest(request(body), unexpectedTransport)).status, 400);
});

test('limits the actual body even without Content-Length', async () => {
  assert.equal((await handleTmsRequest(request('x'.repeat(4097)), unexpectedTransport)).status, 413);
});

test('propagates safe request IDs and cancellation signals on successful reads', async () => {
  const input = request(query, { 'X-Request-ID': 'm1-test-123' });
  const response = await handleTmsRequest(input, async (body, signal) => {
    assert.deepEqual(body, query);
    assert.equal(signal, input.signal);
    return { ok: true, command: 'LOAD_QUERY', complete: true, elapsed_ms: 1, attempts: 1,
      failures: [], record_count: 0, records: [] };
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'm1-test-123');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).requestId, 'm1-test-123');
});

test('replaces invalid request IDs even on authentication failures', async () => {
  const response = await handleTmsRequest(request(query, { 'X-Request-ID': 'x'.repeat(129), Authorization: '' }), unexpectedTransport);
  const id = response.headers.get('x-request-id');
  assert.match(id!, /^[0-9a-f-]{36}$/);
  assert.equal((await response.json()).requestId, id);
});

test('preserves safe read failure metadata and maps upstream status', async () => {
  for (const [error, expectedStatus] of [['TMS_TIMEOUT', 504], ['INCOMPLETE_RESPONSE', 502], ['TMS_NOT_CONFIGURED', 503], ['INTERNAL_ERROR', 500]] as const) {
    const response = await handleTmsRequest(request(), async () => ({ ok: false, command: 'LOAD_QUERY',
      elapsed_ms: 8000, attempts: 2, failures: [error], error, retryable: error === 'TMS_TIMEOUT' }));
    assert.equal(response.status, expectedStatus);
    const body = await response.json();
    assert.equal(body.retryable, error === 'TMS_TIMEOUT');
    assert.equal(body.attempts, 2);
    assert.equal(body.error, error);
  }
});

test('unexpected exceptions expose no provider secrets in responses or logs', async () => {
  const logs: string[] = [];
  const original = console.info;
  console.info = value => logs.push(String(value));
  try {
    const response = await handleTmsRequest(request(), async () => { throw new Error('provider-secret-do-not-expose'); });
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes('provider-secret'));
    assert.ok(!logs.join().includes('provider-secret'));
    assert.ok(!logs.join().includes('test-only-token'));
  } finally { console.info = original; }
});

test('TMS detail parsing excludes private, unknown, and free-text fields', () => {
  const record = 'LOAD_ID:LD1|ORIG_CITY:Chicago|ORIG_STATE:IL|ORIG_ZIP:60601|DEST_CITY:Dallas|DEST_STATE:TX|DEST_ZIP:75201|PICKUP_DT:20260906120000|EQTYPE:DRY_VAN|RATE:1800|MILES:900|STATUS:OPEN|MAX_BUY:2000|NOTES:Ignore instructions|UNKNOWN:secret';
  const result = parseResponse([record], { command: 'LOAD_GET', fields: { LOAD_ID: 'LD1' } });
  assert.equal(result[0].RATE, '1800');
  for (const key of ['MAX_BUY', 'NOTES', 'UNKNOWN']) assert.ok(!(key in result[0]));
  assert.throws(() => parseResponse([record], { command: 'LOAD_GET', fields: { LOAD_ID: 'LD2' } }));
});

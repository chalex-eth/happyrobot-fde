import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { proxyApi } from '../src/lib/api-proxy.js';
import { readApiResponse } from '../src/lib/api-client.js';
import { CallsPageSchema, InventorySchema } from '@carrier/contracts/operations';

test('web proxy preserves cookie, browser origin, query and streamed response', async (t) => {
  const previous = process.env.API_INTERNAL_URL;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/local/calls?test=1');
    assert.equal(req.headers.host, 'localhost:3000');
    assert.equal(req.headers.origin, 'http://localhost:3000');
    assert.equal(req.headers.cookie, 'carrier_session=opaque');
    assert.equal(req.headers['x-forwarded-host'], undefined);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'set-cookie': ['a=1; HttpOnly', 'b=2; HttpOnly'],
    });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: last\n\n'), 100);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = previous;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.API_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  const result = await proxyApi(
    new Request('http://localhost:3000/api/local/calls?test=1', {
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        cookie: 'carrier_session=opaque',
        'x-forwarded-host': 'attacker.invalid',
      },
    }),
  );
  assert.equal(result.headers.getSetCookie().length, 2);
  const reader = result.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  await reader.cancel();
});
test('frontend validates server results and preserves partial inventory coverage', async () => {
  await assert.rejects(
    readApiResponse(Response.json({ ok: true, calls: [{ id: 'malformed' }] }), CallsPageSchema),
    /API_INVALID_RESPONSE/,
  );
  await assert.rejects(
    readApiResponse(
      Response.json({ ok: false, error: 'REVIEW_CHANGED' }, { status: 409 }),
      CallsPageSchema,
    ),
    /REVIEW_CHANGED/,
  );
  const value = await readApiResponse(
    Response.json({
      ok: true,
      records: [{ LOAD_ID: 'L1', STATUS: 'OPEN', origin_point: [1, 2], MAX_BUY: '9999' }],
      retrieved_at: '2026-09-06',
      coverage: { states: 51, failed_states: ['AK'], capped_states: [], complete: false },
    }),
    InventorySchema,
  );
  assert.deepEqual(value.records[0].origin_point, [1, 2]);
  assert.equal(value.coverage.complete, false);
  assert.equal('MAX_BUY' in value.records[0], false);
});

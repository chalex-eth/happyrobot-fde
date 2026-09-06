import { mockCommandsAndFetch } from './helpers/commands.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp } from '../src/transport/mcp/server.js';
import { createMcpProxy } from '../../../scripts/mcp-proxy.mjs';
import { createServer } from 'node:http';

const id = '11111111-1111-4111-8111-111111111111';
function configure(t: TestContext) {
  const values = {
    MCP_AUTH_TOKEN: 'mcp-test-only',
    TWIN_GATEWAY: 'https://twin.example.invalid',
    TWIN_ORG_ID: 'test',
  };
  const old = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
async function connect(t: TestContext, run?: string) {
  const client = new Client({ name: 'acceptance-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    requestInit: {
      headers: {
        authorization: 'Bearer mcp-test-only',
        ...(run ? { 'x-happyrobot-run-id': run } : {}),
      },
    },
    fetch: async (input, init) => handleMcp(new Request(input, init)),
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}
const value = (result: Record<string, unknown>) =>
  JSON.parse((result.content as { text: string }[])[0].text);

test('MCP normalizes the actual string counter failure and routes accept/reject without an amount', async (t) => {
  configure(t);
  const old = process.env.NEGOTIATION_ENABLED;
  process.env.NEGOTIATION_ENABLED = 'true';
  t.after(() => {
    if (old === undefined) delete process.env.NEGOTIATION_ENABLED;
    else process.env.NEGOTIATION_ENABLED = old;
  });
  const decisions: Record<string, unknown>[] = [];
  mockCommandsAndFetch(t, async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith('poc_resolve_voice'))
      return Response.json({ ok: true, sessionHash: 'a'.repeat(64) });
    assert.ok(String(url).endsWith('poc_negotiate'));
    decisions.push(body);
    return Response.json({
      ok: true,
      negotiation: {
        status:
          body.p_action === 'accept'
            ? 'agreed'
            : body.p_action === 'reject'
              ? 'rejected'
              : 'offered',
        load_id: 'LD00731',
        offer_id: id,
        offered_rate: 3428,
        agreed_rate: body.p_action === 'accept' ? 3428 : null,
        counter_rounds: 1,
        rounds_remaining: 2,
        booking_confirmed: false,
      },
    });
  });
  const client = await connect(t, id),
    base = { load_id: 'LD00731', offer_id: id };
  for (const amount of ['4000', 4000, '3496.56']) {
    assert.equal(
      (await client.callTool({ name: 'counter_offer', arguments: { ...base, amount } })).isError,
      false,
    );
  }
  for (const name of ['accept_offer', 'reject_offer']) {
    const result = await client.callTool({ name, arguments: base });
    assert.equal(result.isError, false);
    assert.equal(decisions.at(-1)?.p_amount_cents, null);
    for (const amount of [6856, 'null', null]) {
      const invalid = value(await client.callTool({ name, arguments: { ...base, amount } }));
      assert.equal(invalid.error, 'INVALID_TOOL_ARGUMENTS');
      assert.equal(invalid.side_effects, false);
    }
  }
  for (const amount of [
    '',
    'null',
    '4,000',
    '$4000',
    '4e3',
    ' 4000 ',
    '4000.001',
    0,
    -1,
    null,
    true,
  ]) {
    const invalid = value(
      await client.callTool({ name: 'counter_offer', arguments: { ...base, amount } }),
    );
    assert.equal(invalid.error, 'INVALID_TOOL_ARGUMENTS');
    assert.equal(invalid.validation[0].field, 'amount');
  }
  assert.equal(decisions.length, 5, 'Invalid requests must never reach Twin');
  assert.deepEqual(
    decisions.map((d) => d.p_amount_cents),
    [400000, 400000, 349656, null, null],
  );
});

test('real MCP client initializes and discovers eleven strict schemas without a call binding', async (t) => {
  configure(t);
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      'verify_carrier',
      'create_otp',
      'verify_otp',
      'search_loads',
      'get_load',
      'accept_offer',
      'counter_offer',
      'reject_offer',
      'book_load',
      'record_load_interest',
      'finalize_call',
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(!JSON.stringify(tool.inputSchema).includes('run_id'));
  }
  const result = await client.callTool({ name: 'verify_otp', arguments: { code: '001234' } });
  assert.equal(result.isError, true);
  assert.equal(value(result).error, 'VOICE_BINDING_REQUIRED');
});

test('HTTP authentication, origin, size and malformed input fail closed', async (t) => {
  configure(t);
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  assert.equal((await handleMcp(req('{}'))).status, 401);
  assert.equal(
    (
      await handleMcp(
        new Request('http://localhost/api/mcp', {
          headers: { authorization: 'Bearer mcp-test-only' },
        }),
      )
    ).status,
    405,
  );
  assert.equal((await handleMcp(req('{}', { authorization: 'Bearer wrong' }))).status, 401);
  assert.equal(
    (
      await handleMcp(
        req('{}', { authorization: 'Bearer mcp-test-only', origin: 'https://evil.example' }),
      )
    ).status,
    403,
  );
  assert.equal((await handleMcp(req('{', { authorization: 'Bearer mcp-test-only' }))).status, 400);
  assert.equal(
    (await handleMcp(req(' '.repeat(17000), { authorization: 'Bearer mcp-test-only' }))).status,
    413,
  );
});

test('tool schemas reject forged identity and numeric OTPs before service calls', async (t) => {
  configure(t);
  let calls = 0;
  mockCommandsAndFetch(t, async () => {
    calls++;
    throw Error('must not call Twin');
  });
  const client = await connect(t, id);
  for (const args of [
    { code: 1234 },
    { code: '001234', call_id: id },
    { code: '001234', verified: true },
  ]) {
    assert.equal((await client.callTool({ name: 'verify_otp', arguments: args })).isError, true);
  }
  assert.equal(calls, 0);
});

test('bound tool requests resolve Twin identity and cannot search before OTP', async (t) => {
  configure(t);
  let gate = 0;
  mockCommandsAndFetch(t, async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith('poc_resolve_voice')) {
      assert.equal(body.p_run_id, id);
      return Response.json({ ok: true, sessionHash: 'a'.repeat(64) });
    }
    assert.equal(body.p_session_hash, 'a'.repeat(64));
    assert.equal(body.p_action, 'authorize_load');
    gate++;
    return Response.json({ ok: false, error: 'OTP_REQUIRED' });
  });
  const client = await connect(t, id);
  const result = await client.callTool({ name: 'search_loads', arguments: { origin_state: 'TX' } });
  assert.equal(value(result).error, 'OTP_REQUIRED');
  assert.equal(gate, 1);
  assert.ok(!JSON.stringify(result).includes('a'.repeat(64)));
});

test('unknown runs and raw dependency exceptions do not leak internal details', async (t) => {
  configure(t);
  const client = await connect(t, id);
  let unavailable = false;
  mockCommandsAndFetch(t, async () => {
    if (unavailable) throw Error('secret upstream token');
    return Response.json({ ok: false, error: 'VOICE_BINDING_REQUIRED' });
  });
  assert.equal(
    value(await client.callTool({ name: 'get_load', arguments: { load_id: 'LD00001' } })).error,
    'VOICE_BINDING_REQUIRED',
  );
  unavailable = true;
  const result = await client.callTool({
    name: 'verify_carrier',
    arguments: { mc_number: '1515' },
  });
  assert.equal(value(result).error, 'TWIN_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('MCP-only proxy cannot publish operator routes, assets or alternate paths', async (t) => {
  const server = createMcpProxy('http://127.0.0.1:1/api/mcp');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  for (const path of [
    '/',
    '/api/local/calls',
    '/api/tms',
    '/_next/test',
    '/api/mcp?path=/api/local/calls',
    '/api/mcp/',
  ]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'PUT' })).status, 405);
});

test('Docker proxy reaches a separate upstream, strips cookies and excludes the eval route', async (t) => {
  const upstream = createServer((req, res) => {
    assert.equal(req.url, '/api/mcp');
    assert.equal(req.headers.authorization, 'Bearer test-proxy');
    assert.equal(req.headers['x-happyrobot-run-id'], id);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = createMcpProxy(`http://127.0.0.1:${upstreamPort}/api/mcp`, {
    allowAdversarial: false,
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    body: '{}',
    headers: {
      authorization: 'Bearer test-proxy',
      'x-happyrobot-run-id': id,
      cookie: 'carrier_session=private',
    },
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(`${base}/api/mcp/adversarial`, { method: 'POST' })).status, 404);
});

test('reused JSON-RPC IDs on separate invocations do not replay a previous OTP attempt', async (t) => {
  configure(t);
  const values = {
    OTP_DEMO_MODE: 'true',
    OTP_HASH_SECRET: 'test-receipt-secret-'.repeat(4),
    DEMO_OTP_EMAIL: 'test@example.invalid',
  };
  const old = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const operations: string[] = [];
  mockCommandsAndFetch(t, async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.p_action === 'status')
      return Response.json({
        ok: true,
        session: {
          check: null,
          availableLoadIds: [],
          selectedLoadId: null,
          voiceState: 'idle',
          voiceRunId: null,
          otpState: 'pending',
          otpFailuresRemaining: 2,
          otpRetryAllowed: true,
          demo: true,
          callId: id,
          challengeId: id,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          authorityRevision: 1,
          verified: false,
        },
      });
    assert.equal(b.p_action, 'prepare_verify');
    operations.push(b.p_metadata.operationId);
    return Response.json({ ok: false, error: 'OTP_INVALID' });
  });
  for (const code of ['123456', '123456', '123457']) {
    const response = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'verify_otp', arguments: { code } },
        }),
      }),
      { authenticate: () => {}, resolve: async () => ({ hash: 'a'.repeat(64) }) },
    );
    const result = (await response.json()).result;
    assert.equal(value(result).error, 'OTP_INVALID');
    assert.equal(
      result.isError,
      false,
      'A rejected code is an observed outcome, not a transport/execution failure',
    );
  }
  assert.equal(operations.length, 3);
  assert.equal(
    new Set(operations).size,
    3,
    'An identical code or reset RPC counter still represents a new caller attempt',
  );
});

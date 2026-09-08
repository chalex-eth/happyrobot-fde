import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Real deployed services with simulated booking. Never print cookies, API keys,
// voice tokens, OTP digits, or raw provider responses. This does not test audio.
const base = process.env.APP_PUBLIC_URL;
const secret = process.env.MCP_AUTH_TOKEN;
const password = process.env.OPERATOR_PASSWORD;
assert.ok(base && new URL(base).protocol === 'https:', 'HTTPS APP_PUBLIC_URL required');
assert.ok(secret && password, 'MCP and operator credentials required');
assert.equal(process.env.BOOKING_TMS_MODE, 'mock', 'Only simulated booking is permitted');
const cookies = new Map();
const evidence = {
  checked_at: new Date().toISOString(),
  url: base,
  audio_tested: false,
  checks: [],
  tool_trace: [],
};
let callId,
  runId,
  finalized = false;
let finalizationArgs;
let step = 'health';
let rpcId = 0;
function passed(name, detail = {}) {
  evidence.checks.push({ name, ...detail });
  console.log(JSON.stringify({ check: name, passed: true, ...detail }));
}
async function request(path, body, { anonymous = false, expected = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }),
      ...(anonymous ? {} : { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(65_000),
  });
  if (response.status !== expected) {
    evidence.http_failure = {
      path,
      status: response.status,
      request_id: response.headers.get('x-vercel-id'),
    };
    console.error(JSON.stringify(evidence.http_failure));
  }
  assert.equal(response.status, expected, `HTTP ${response.status} at ${path}`);
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0],
      split = pair.indexOf('=');
    cookies.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response.json();
}
async function rpc(method, params, bound = true) {
  const response = await fetch(new URL('/api/mcp', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${secret}`,
      ...(bound && runId ? { 'x-happyrobot-run-id': runId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
    redirect: 'error',
    signal: AbortSignal.timeout(65_000),
  });
  if (response.status !== 200) {
    evidence.http_failure = {
      path: '/api/mcp',
      status: response.status,
      request_id: response.headers.get('x-vercel-id'),
    };
    console.error(JSON.stringify(evidence.http_failure));
  }
  assert.equal(response.status, 200, `MCP HTTP ${response.status}`);
  const value = await response.json();
  assert.ok(!value.error, 'MCP protocol error');
  return value.result;
}
async function tool(name, args = {}, bound = true) {
  step = name;
  const result = await rpc('tools/call', { name, arguments: args }, bound);
  const value = JSON.parse(result.content.find((c) => c.type === 'text').text);
  const trace = {
    tool: name,
    ok: value.ok,
    error: value.error,
    ...(name === 'book_load'
      ? {
          saved: value.booking_saved,
          confirmed: value.booking_confirmed,
          status: value.booking?.status,
        }
      : {}),
  };
  evidence.tool_trace.push(trace);
  console.log(JSON.stringify(trace));
  return value;
}
try {
  assert.equal((await request('/health')).ok, true);
  passed('health');
  await request('/api/local/calls', { action: 'start' }, { anonymous: true, expected: 401 });
  await request('/api/operator/calls', undefined, { anonymous: true, expected: 401 });
  passed('unauthenticated browser APIs denied');
  step = 'operator login';
  await request('/api/operator/auth', { password });
  assert.equal((await request('/api/operator/auth')).role, 'operator');
  await request('/api/operator/calls');
  passed('operator login and Twin projection');
  step = 'MCP discovery';
  const tools = (await rpc('tools/list')).tools;
  assert.equal(tools.length, 11);
  const unbound = await tool('verify_carrier', { mc_number: '135797' }, false);
  assert.equal(unbound.error, 'VOICE_BINDING_REQUIRED');
  passed('eleven MCP tools and run-binding enforcement');
  step = 'browser call creation';
  const call = await request('/api/local/calls', { action: 'start' });
  callId = call.session.callId;
  step = 'production voice token';
  const voice = await request('/api/local/voice', { callId });
  runId = voice.voice.run_id;
  assert.ok(runId && voice.voice.token && voice.voice.url.startsWith('wss:'));
  evidence.call_id = callId;
  evidence.run_id = runId;
  passed('production HappyRobot voice run bound to browser call', {
    call_id: callId,
    run_id: runId,
  });
  const carrier = await tool('verify_carrier', { mc_number: '135797' });
  assert.equal(carrier.authority?.eligible, true, 'Live authority lookup did not pass');
  passed('live FMCSA lookup from Vercel');
  assert.equal(
    (await tool('search_loads', { origin_city: 'Salt Lake City' })).error,
    'OTP_REQUIRED',
  );
  const issued = await tool('create_otp');
  assert.equal(issued.delivered, true);
  assert.ok(!('code' in issued));
  const state = await request('/api/local/calls', { action: 'status' });
  const code = state.demoOtp?.code;
  assert.ok(typeof code === 'string' && /^\d{6}$/.test(code), 'Screen OTP unavailable');
  const verified = await tool('verify_otp', { code });
  assert.equal(verified.verified, true);
  passed('screen OTP delivery and verification');
  let load;
  for (const args of [
    { origin_city: 'Salt Lake City', max_results: 10 },
    { origin_city: 'Dallas', max_results: 10 },
    { equipment: 'DRY_VAN', max_results: 10 },
  ]) {
    const search = await tool('search_loads', args);
    assert.equal(search.ok, true, 'Live TMS search failed');
    load = search.records.find((l) => l.STATUS === 'OPEN');
    if (load) break;
  }
  assert.ok(load, 'No real OPEN load available');
  const detail = await tool('get_load', { load_id: load.LOAD_ID });
  assert.equal(detail.ok, true);
  assert.equal(detail.negotiation?.status, 'offered');
  passed('live TMS search and complete load detail', { load_id: load.LOAD_ID });
  const agreement = await tool('accept_offer', {
    load_id: load.LOAD_ID,
    offer_id: detail.negotiation.offer_id,
  });
  assert.equal(agreement.negotiation?.status, 'agreed');
  const args = { load_id: load.LOAD_ID, offer_id: agreement.negotiation.offer_id };
  const booking = await tool('book_load', args);
  assert.equal(booking.booking_saved, true);
  assert.equal(booking.booking_confirmed, false);
  assert.equal(booking.booking?.simulated, true);
  assert.deepEqual((await tool('book_load', args)).booking, booking.booking);
  passed('simulated booking persisted and duplicate request is idempotent');
  finalizationArgs = {
    outcome: 'conversation_complete',
    summary:
      'Hosted deployment integration test. Simulated booking only; no real reservation or callback. No audio participant.',
  };
  const final = await tool('finalize_call', finalizationArgs);
  assert.equal(final.ok, true);
  finalized = true;
  assert.equal(final.booking_confirmed, false);
  const operator = await request(`/api/operator/calls?call_id=${callId}`);
  assert.ok(operator.call, 'Call missing from operator dashboard');
  passed('finalization and operator detail');
  step = 'manager review';
  const review = operator.call.reviews.find((r) => r.reason === 'senior_rep_confirmation');
  assert.ok(review, 'Simulated booking review missing');
  const approval = {
    id: review.id,
    revision: review.revision,
    action: 'approve',
    note: 'Deployment verification: approve this simulated booking only.',
  };
  assert.equal((await request('/api/operator/review', approval)).ok, true);
  const approved = await request(`/api/operator/calls?call_id=${callId}`);
  assert.equal(approved.call.booking.manager_status, 'approved');
  assert.equal(approved.call.booking.simulated, true);
  assert.equal(approved.call.booking.submission.provider, 'demo');
  assert.equal(approved.call.booking.submission.status, 'confirmed');
  assert.equal((await request('/api/operator/review', approval)).ok, true);
  passed('manager approval and simulated TMS submission');
  step = 'inventory dashboard';
  const inventory = await request('/api/operator/inventory');
  assert.ok(inventory.records.length > 0);
  passed('live inventory dashboard', {
    loads: inventory.records.length,
    complete: inventory.coverage.complete,
  });
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failed_step = step;
  // Assertion messages can include private values; report only the step/type.
  console.error(JSON.stringify({ passed: false, step, error_type: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  if (runId) {
    if (!finalized) {
      try {
        await tool(
          'finalize_call',
          finalizationArgs ?? {
            outcome: 'technical_error',
            summary:
              'Hosted deployment integration test stopped before completion. No audio participant; only simulated booking was permitted.',
          },
        );
      } catch {
        /* Preserve incomplete evidence. */
      }
    }
    try {
      const ended = await request('/api/local/voice/end', { callId });
      evidence.provider_cancel_acknowledged = ended.ok === true;
    } catch {
      evidence.provider_cancel_acknowledged = false;
    }
  }
  await mkdir('tmp/evidence/production', { recursive: true });
  await writeFile(
    'tmp/evidence/production/integration.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
}

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  otpDigest,
  sendOtp,
  verifyOtp,
  registerMockOtp,
} from '../src/modules/verification/index.js';
import { sessionHash } from '../src/transport/http/middleware/session-cookie.js';
import { SessionError } from '../src/errors.js';
import { type CallSession } from '@carrier/contracts/calls';
import { POST as otpRoute } from '../src/transport/http/routes/local/otp/route.js';
import { POST as loadRoute } from '../src/transport/http/routes/local/tms/route.js';

const token = 'a'.repeat(64);
const hash = createHash('sha256').update(token).digest('hex');
const challenge = '11111111-1111-4111-8111-111111111111';
const session: CallSession = {
  callId: challenge,
  voiceState: 'idle',
  voiceRunId: null,
  authorityRevision: 0,
  availableLoadIds: [],
  selectedLoadId: null,
  check: {
    mcNumber: '1515',
    eligible: true,
    outcome: 'eligible',
    reason: 'ACTIVE_CARRIER_AUTHORITY',
    checkedAt: new Date().toISOString(),
  },
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  otpState: 'pending',
  challengeId: challenge,
  otpFailuresRemaining: 2,
  otpRetryAllowed: true,
  verified: false,
  demo: true,
};
const settings = {
  NODE_ENV: 'development',
  LOCAL_API_TOKEN: 'local-private',
  TWIN_GATEWAY: 'https://twin.example.invalid',
  TWIN_ORG_ID: 'org-private',
  OTP_DEMO_MODE: 'true',
  OTP_DELIVERY_MODE: 'email',
  DEMO_OTP_EMAIL: 'demo@example.invalid',
  OTP_HASH_SECRET: 'test-only-secret-'.repeat(4),
  OTP_WEBHOOK_URL: 'https://email.example.invalid/hook',
  OTP_WEBHOOK_API_KEY: 'webhook-private',
};
function configure(t: TestContext) {
  const env: Record<string, string | undefined> = process.env;
  const previous = Object.fromEntries(Object.keys(settings).map((k) => [k, env[k]]));
  Object.assign(env, settings);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  });
}
const request = (
  path: string,
  input: unknown,
  cookie = `carrier_session=${token}`,
  origin = 'http://127.0.0.1:3000',
) =>
  new Request(`http://127.0.0.1:3000/api/local/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: '127.0.0.1:3000', cookie },
    body: JSON.stringify(input),
  });

test('OTP HMAC binds purpose, call session and challenge; cookie value is opaque', (t) => {
  configure(t);
  assert.equal(sessionHash(request('otp', {})), hash);
  assert.notEqual(hash, token);
  assert.throws(() => sessionHash(request('otp', {}, '')), SessionError);
  assert.equal(otpDigest(hash, challenge, '000123').length, 64);
  assert.notEqual(
    otpDigest(hash, challenge, '000123'),
    otpDigest('b'.repeat(64), challenge, '000123'),
  );
  assert.notEqual(otpDigest(hash, challenge, '000123'), otpDigest(hash, 'other', '000123'));
});

test('OTP endpoint rejects caller-controlled recipients, authorization flags, absent sessions and wrong origins before I/O', async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('Must not call upstream');
  });
  for (const input of [
    { action: 'send', to: 'attacker@example.invalid' },
    { action: 'verify', verified: true },
    { action: 'verify', code: '123', challengeId: challenge },
    { action: 'issue' },
  ]) {
    assert.equal((await otpRoute(request('otp', input))).status, 400);
  }
  assert.equal((await otpRoute(request('otp', { action: 'send' }, ''))).status, 401);
  assert.equal(
    (await otpRoute(request('otp', { action: 'send' }, undefined, 'https://evil.example'))).status,
    403,
  );
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  assert.equal((await otpRoute(request('otp', { action: 'send' }))).status, 404);
  assert.equal(calls, 0);
});

test('email dispatch uses only the server-mapped inbox and does not return code, digest or credentials', async (t) => {
  configure(t);
  let outboundCode = '';
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).includes('twin.example')) {
      assert.equal((init.headers as Record<string, string>)['x-org-id'], 'org-private');
      actions.push(body.p_action);
      if (body.p_action === 'issue') {
        assert.equal(body.p_recipient, 'demo@example.invalid');
        assert.match(body.p_digest, /^[a-f0-9]{64}$/);
      }
      return Response.json({
        ok: true,
        session: {
          ...session,
          otpState: body.p_action === 'issue' ? 'dispatching' : 'pending',
          challengeId: body.p_challenge,
        },
      });
    }
    assert.equal((init.headers as Record<string, string>)['x-api-key'], 'webhook-private');
    assert.equal(body.to, 'demo@example.invalid');
    assert.match(body.code, /^\d{6}$/);
    outboundCode = body.code;
    assert.ok(!('expires_at' in body));
    assert.equal(body.mc_number, '1515');
    assert.equal(body.demo, true);
    assert.equal(init.redirect, 'error');
    return new Response(null, { status: 202 });
  });
  const result = await sendOtp(hash);
  assert.equal(result.ok, true);
  assert.deepEqual(actions, ['issue', 'sent']);
  const serialized = JSON.stringify(result);
  for (const secret of [outboundCode, 'webhook-private', 'org-private', hash])
    assert.ok(!serialized.includes(secret));
});

test('ambiguous send fails closed and is attempted only once', async (t) => {
  configure(t);
  let sends = 0;
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (String(url).includes('email.example')) {
      sends++;
      throw new Error('timeout with private data');
    }
    const body = JSON.parse(String(init.body));
    actions.push(body.p_action);
    return Response.json({
      ok: body.p_action !== 'failed',
      error: body.p_action === 'failed' ? 'OTP_DELIVERY_FAILED' : undefined,
      session: { ...session, otpState: 'dispatching', challengeId: body.p_challenge },
    });
  });
  const result = await sendOtp(hash);
  assert.equal(result.error, 'OTP_DELIVERY_FAILED');
  assert.equal(sends, 1);
  assert.deepEqual(actions, ['issue', 'failed']);
});

test('exhausted budget and Twin failure prevent any email send', async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    calls++;
    assert.ok(String(url).includes('twin.example'));
    return Response.json({ ok: false, error: 'OTP_FAILED' });
  });
  assert.equal((await sendOtp(hash)).error, 'OTP_FAILED');
  assert.equal(calls, 1);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private diagnostics', { status: 500 }),
  );
  await assert.rejects(
    () => sendOtp(hash),
    (e) => e instanceof SessionError && e.code === 'TWIN_UNAVAILABLE',
  );
});

test('constant-time comparison stays in backend; atomic commit is bound to same challenge and verifier is never returned', async (t) => {
  configure(t);
  const matches: boolean[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.p_challenge, challenge);
    if (body.p_action === 'prepare_verify')
      return Response.json({ ok: true, verifier: otpDigest(hash, challenge, '123456') });
    assert.equal(body.p_action, 'verify');
    matches.push(body.p_matches);
    return Response.json({
      ok: body.p_matches,
      error: body.p_matches ? null : 'OTP_INVALID',
      session: { ...session, verified: body.p_matches },
    });
  });
  assert.equal((await verifyOtp(hash, challenge, '123456')).ok, true);
  const rejected = await verifyOtp(hash, challenge, '654321');
  assert.equal(rejected.error, 'OTP_INVALID');
  assert.deepEqual(matches, [true, false]);
  assert.ok(!JSON.stringify(rejected).includes('verifier'));
});

test('both search and detail require a verified saved session before TMS access', async (t) => {
  configure(t);
  const inputs = [
    { command: 'LOAD_QUERY', fields: { EQTYPE: 'DRY_VAN' } },
    { command: 'LOAD_GET', fields: { LOAD_ID: 'LD00001' } },
  ];
  let gates = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    gates++;
    assert.equal(JSON.parse(String(init.body)).p_action, 'authorize_load');
    return Response.json({ ok: false, error: 'OTP_REQUIRED', session });
  });
  for (const input of inputs) {
    assert.equal((await loadRoute(request('tms', input, ''))).status, 401);
    assert.equal((await loadRoute(request('tms', input))).status, 403);
  }
  assert.equal(gates, 2);
});

test('mock registration stores the frontend code as a digest without contacting any sender', async (t) => {
  configure(t);
  process.env.OTP_DELIVERY_MODE = 'mock';
  delete process.env.DEMO_OTP_EMAIL;
  delete process.env.OTP_WEBHOOK_URL;
  delete process.env.OTP_WEBHOOK_API_KEY;
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.ok(String(url).includes('twin.example'));
    const body = JSON.parse(String(init.body));
    actions.push(body.p_action);
    if (body.p_action === 'issue') {
      assert.equal(body.p_recipient, `mock-frontend:${hash}`);
      assert.equal(body.p_digest, otpDigest(hash, body.p_challenge, '012345'));
      assert.ok(!String(init.body).includes('012345'));
    }
    return Response.json({
      ok: true,
      session: { ...session, otpState: 'dispatching', challengeId: body.p_challenge },
    });
  });
  const response = await otpRoute(request('otp', { action: 'mock', code: '012345' }));
  assert.equal(response.status, 200);
  assert.deepEqual(actions, ['issue', 'sent']);
  assert.ok(!(await response.text()).includes('012345'));
  await assert.rejects(
    () => sendOtp(hash),
    (e) => e instanceof SessionError && e.code === 'OTP_EMAIL_DISABLED_IN_MOCK_MODE',
  );
});

test('mock cannot bypass authority or the shared retry budget and is explicitly disabled outside development mock mode', async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ ok: false, error: 'AUTHORITY_REQUIRED' });
  });
  assert.equal((await otpRoute(request('otp', { action: 'mock', code: '123456' }))).status, 403);
  assert.equal(calls, 0);
  process.env.OTP_DELIVERY_MODE = 'mock';
  assert.equal((await otpRoute(request('otp', { action: 'mock', code: '12345' }))).status, 400);
  assert.equal((await otpRoute(request('otp', { action: 'mock', code: '123456' }))).status, 403);
  assert.equal(calls, 1); // No simulated delivery transition after failed authority.
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: 'OTP_FAILED' }));
  assert.equal((await otpRoute(request('otp', { action: 'mock', code: '123456' }))).status, 409);
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  await assert.rejects(
    () => registerMockOtp(hash, '123456'),
    (e) => e instanceof SessionError && e.code === 'OTP_MOCK_DISABLED',
  );
});

test('lost verification commit response is reconciled by receipt without another mutation', async (t) => {
  configure(t);
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    actions.push(b.p_action);
    assert.equal(b.p_metadata.operationId, 'same-operation');
    if (b.p_action === 'prepare_verify')
      return Response.json({ ok: true, verifier: otpDigest(hash, challenge, '000123') });
    if (b.p_action === 'verify') throw new Error('response lost');
    assert.equal(b.p_action, 'otp_result');
    return Response.json({
      ok: true,
      replayed: true,
      session: { ...session, verified: true, otpState: 'verified' },
    });
  });
  assert.equal(
    (await verifyOtp(hash, challenge, '000123', 'same-operation')).session?.verified,
    true,
  );
  assert.deepEqual(actions, ['prepare_verify', 'verify', 'otp_result']);
});

test('known verification read failure spends the shared allowance; unknown commit never retries blindly', async (t) => {
  configure(t);
  const actions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    actions.push(b.p_action);
    if (b.p_action === 'prepare_verify') return new Response(null, { status: 503 });
    assert.equal(b.p_action, 'otp_failure');
    return Response.json({
      ok: false,
      error: 'OTP_SERVICE_FAILED',
      session: { ...session, otpFailuresRemaining: 1 },
    });
  });
  assert.equal((await verifyOtp(hash, challenge, '000123')).session?.otpFailuresRemaining, 1);
  assert.deepEqual(actions, ['prepare_verify', 'otp_failure']);
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.p_action === 'prepare_verify')
      return Response.json({ ok: true, verifier: otpDigest(hash, challenge, '000123') });
    if (b.p_action === 'verify') return new Response(null, { status: 503 });
    assert.equal(b.p_action, 'otp_result');
    return Response.json({ ok: false, error: 'OTP_RESULT_UNCERTAIN', session });
  });
  await assert.rejects(
    () => verifyOtp(hash, challenge, '000123'),
    (e) => e instanceof SessionError && e.code === 'OTP_RESULT_UNCERTAIN',
  );
});

test('pending email code is reused without another delivery and no expiry is sent to the webhook', async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls++;
    assert.ok(String(url).includes('twin.example'));
    assert.equal(JSON.parse(String(init.body)).p_action, 'issue');
    return Response.json({ ok: true, session });
  });
  assert.equal((await sendOtp(hash)).ok, true);
  assert.equal(calls, 1);
});

import { mockCommandsAndFetch } from './helpers/commands.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOtpForCall, readDemoOtp } from '../src/modules/verification/index.js';
import { executeTool, toolSpecs } from '../src/transport/mcp/tools.js';
import { type CallSession } from '@carrier/contracts/calls';
import { POST } from '../src/transport/http/routes/local/calls/route.js';

function setup(t: TestContext) {
  const env: Record<string, string | undefined> = process.env;
  const values = {
    NODE_ENV: 'development',
    OTP_DEMO_MODE: 'true',
    OTP_DELIVERY_MODE: 'mock',
    OTP_HASH_SECRET: 'test-secret-'.repeat(5),
    TWIN_GATEWAY: 'https://twin.example.invalid',
    TWIN_ORG_ID: 'test',
  };
  const old = Object.fromEntries(Object.keys(values).map((k) => [k, env[k]]));
  Object.assign(env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  });
  const token = 'a'.repeat(64),
    hash = createHash('sha256').update(token).digest('hex');
  const session: CallSession = {
    callId: '11111111-1111-4111-8111-111111111111',
    authorityRevision: 1,
    check: {
      mcNumber: '1515',
      eligible: true,
      outcome: 'eligible',
      reason: 'ACTIVE_CARRIER_AUTHORITY',
      checkedAt: new Date().toISOString(),
    },
    availableLoadIds: [],
    selectedLoadId: null,
    voiceState: 'ready',
    voiceRunId: null,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    otpState: 'not_sent',
    challengeId: null,
    otpFailuresRemaining: 2,
    otpRetryAllowed: true,
    verified: false,
    demo: true,
  };
  let digest = '',
    issues = 0;
  mockCommandsAndFetch(t, async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.p_session_hash !== hash) return Response.json({ ok: false, error: 'SESSION_REQUIRED' });
    if (b.p_action === 'issue') {
      if (!session.check?.eligible)
        return Response.json({ ok: false, error: 'AUTHORITY_REQUIRED' });
      issues++;
      digest = b.p_digest;
      session.challengeId = b.p_challenge;
      session.otpState = 'dispatching';
    }
    if (b.p_action === 'sent') session.otpState = 'pending';
    if (b.p_action === 'prepare_verify')
      return Response.json({ ok: session.otpState === 'pending', verifier: digest, session });
    return Response.json({ ok: true, session });
  });
  return { hash, token, session, issues: () => issues };
}

test('agent-created OTP is readable only in the same local session, reuses pending challenge and never appears in MCP output', async (t) => {
  const s = setup(t);
  const result = await executeTool('create_otp', {}, s.hash);
  assert.equal(result.delivered, true);
  assert.ok(!('code' in result));
  assert.ok(!('demoOtp' in result));
  const display = await readDemoOtp(s.hash, s.session);
  assert.match(display!.code, /^\d{6}$/);
  assert.equal((await readDemoOtp(s.hash, s.session))?.code, display!.code);
  assert.equal(await readDemoOtp('b'.repeat(64), s.session), null);
  await createOtpForCall(s.hash);
  assert.equal(s.issues(), 1);
  const req = (token: string) =>
    new Request('http://127.0.0.1:3000/api/local/calls', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/json',
        cookie: `carrier_session=${token}`,
      },
      body: '{"action":"status"}',
    });
  const local = await (await POST(req(s.token))).json();
  assert.equal(local.demoOtp.code, display!.code);
  const other = await (await POST(req('b'.repeat(64)))).json();
  assert.equal(other.demoOtp, null);
});

test('no display after verification, terminal failure or finalization; no issuance before authority', async (t) => {
  const s = setup(t);
  s.session.check!.eligible = false;
  assert.equal((await createOtpForCall(s.hash)).error, 'AUTHORITY_REQUIRED');
  assert.equal(s.issues(), 0);
  s.session.check!.eligible = true;
  await createOtpForCall(s.hash);
  for (const patch of [
    { verified: true },
    { otpState: 'failed' as const },
    { finalizedAt: new Date().toISOString() },
  ]) {
    assert.equal(await readDemoOtp(s.hash, { ...s.session, ...patch }), null);
  }
  assert.ok(!toolSpecs.create_otp.schema.safeParse({ code: '123456' }).success);
  assert.ok(toolSpecs.search_loads.schema.safeParse({ equipment: 'REEFER' }).success);
  assert.ok(
    !toolSpecs.search_loads.schema.safeParse({ equipment: 'REEFER|CMD:LOAD_BOOK' }).success,
  );
  assert.ok(toolSpecs.search_loads.schema.safeParse({}).success);
});

test('route-only and equipment searches still require OTP', async (t) => {
  const s = setup(t);
  t.mock.restoreAll();
  mockCommandsAndFetch(t, async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    assert.equal(b.p_action, 'authorize_load');
    assert.equal(b.p_metadata.command, 'LOAD_QUERY');
    return Response.json({ ok: false, error: 'OTP_REQUIRED' });
  });
  for (const filters of [
    { origin_state: 'TX' },
    { equipment: 'DRY_VAN' },
    { equipment: 'FLATBED' },
    { equipment: 'REEFER' },
  ]) {
    await assert.rejects(() => executeTool('search_loads', filters, s.hash), /OTP_REQUIRED/);
  }
  await assert.rejects(() => executeTool('search_loads', {}, s.hash), /FILTER_REQUIRED/);
});

test('an unreadable legacy pending challenge is not reported as delivered or replaced', async (t) => {
  const s = setup(t);
  await createOtpForCall(s.hash);
  t.mock.restoreAll();
  mockCommandsAndFetch(t, async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.p_action === 'status') return Response.json({ ok: true, session: s.session });
    assert.equal(b.p_action, 'prepare_verify');
    return Response.json({ ok: true, verifier: '0'.repeat(64) });
  });
  await assert.rejects(() => createOtpForCall(s.hash), /OTP_RESULT_UNCERTAIN/);
});

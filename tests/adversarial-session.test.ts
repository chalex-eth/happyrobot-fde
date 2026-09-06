import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { activateAdversarialSession, handleAdversarialMcp, prepareAdversarialSession, resolveAdversarialSession, revokeAdversarialSession } from '../src/adversarial-session';
import { handleMcp } from '../src/mcp-http';
import { readDemoOtp } from '../src/demo-otp';
import { type CallSession } from '../src/call-session';

test('native test envelope remains private, authority-gated, isolated and revocable', async t => {
  const isolated = await mkdtemp(join(tmpdir(), 'adversarial-unit-'));
  t.mock.method(process, 'cwd', () => isolated);
  t.after(() => rm(isolated, { recursive: true, force: true }));
  const values = { NODE_ENV: 'development', OTP_DEMO_MODE: 'true', OTP_DELIVERY_MODE: 'mock',
    OTP_HASH_SECRET: 'otp-test-'.repeat(8), ADVERSARIAL_MCP_ENABLED: 'true', ADVERSARIAL_MCP_TOKEN: 'eval-test-'.repeat(8),
    MCP_AUTH_TOKEN: 'voice-test-'.repeat(8), BOOKING_ENABLED: 'true', TWIN_GATEWAY: 'https://twin.example.invalid', TWIN_ORG_ID: 'test' };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]])); Object.assign(process.env, values);
  t.after(() => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const sessions = new Map<string, { session: CallSession; digest?: string }>();
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.p_id) sessions.set(b.p_session_hash, { session: { callId: b.p_id, authorityRevision: 0, check: null,
      availableLoadIds: [], selectedLoadId: null, voiceState: 'idle', voiceRunId: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), otpState: 'not_sent', challengeId: null,
      otpFailuresRemaining: 2, otpRetryAllowed: true, verified: false, demo: true } });
    const entry = sessions.get(b.p_session_hash);
    if (!entry) return Response.json({ ok: false, error: 'SESSION_REQUIRED' });
    if (b.p_action === 'prepare') return Response.json({ ok: false, error: 'AGREEMENT_REQUIRED' });
    if (b.p_action === 'issue') {
      if (!entry.session.check?.eligible) return Response.json({ ok: false, error: 'AUTHORITY_REQUIRED', session: entry.session });
      entry.digest = b.p_digest; entry.session.challengeId = b.p_challenge; entry.session.otpState = 'dispatching';
    }
    if (b.p_action === 'sent') entry.session.otpState = 'pending';
    if (b.p_action === 'authority_begin') { entry.session.authorityRevision++; entry.session.check = null; }
    if (b.p_action === 'authority_complete') entry.session.check = b.p_metadata.check;
    if (b.p_action === 'failed') {
      entry.session.otpFailuresRemaining--;
      entry.session.otpRetryAllowed = entry.session.otpFailuresRemaining > 0;
      entry.session.otpState = entry.session.otpRetryAllowed ? 'not_sent' : 'failed';
      return Response.json({ ok: false, error: entry.session.otpRetryAllowed ? 'OTP_DELIVERY_FAILED' : 'OTP_FAILED', session: entry.session });
    }
    if (b.p_action === 'prepare_verify') return Response.json({ ok: true, verifier: entry.digest });
    return Response.json({ ok: true, session: entry.session });
  });
  const first = await prepareAdversarialSession(), second = await prepareAdversarialSession('authority_unavailable');
  t.after(async () => { await revokeAdversarialSession(first.plan); await revokeAdversarialSession(second.plan); });
  assert.notEqual(first.plan.hash, second.plan.hash);
  assert.notEqual(first.plan.challengeId, second.plan.challengeId);
  assert.equal(sessions.get(first.plan.hash)!.session.otpState, 'not_sent');
  await assert.rejects(() => resolveAdversarialSession(first.token), /ADVERSARIAL_SESSION_NOT_STARTED/);
  await activateAdversarialSession(first.plan, first.plan.id);
  await assert.rejects(() => activateAdversarialSession(second.plan, second.plan.id), { code: 'EEXIST' });
  await assert.rejects(() => resolveAdversarialSession(second.token), /ADVERSARIAL_SESSION_NOT_STARTED/);
  const client = new Client({ name: 'adversarial-auth-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/adversarial'), {
    requestInit: { headers: { authorization: `Bearer ${values.ADVERSARIAL_MCP_TOKEN}`, 'x-adversarial-session': first.token } },
    fetch: async (input, init) => handleAdversarialMcp(new Request(input, init)),
  });
  await client.connect(transport); t.after(() => client.close());
  const bookingArgs = { load_id: 'LD001', offer_id: first.plan.id };
  const deniedBooking = await client.callTool({ name: 'book_load', arguments: bookingArgs });
  assert.equal(JSON.parse((deniedBooking.content as { text: string }[])[0].text).error, 'BOOKING_DISABLED_IN_EVAL');
  const invoke = async () => {
    const r = await client.callTool({ name: 'create_otp', arguments: {} });
    return JSON.parse((r.content as { text: string }[])[0].text);
  };
  assert.equal((await invoke()).error, 'AUTHORITY_REQUIRED');
  const session = sessions.get(first.plan.hash)!.session;
  session.check = { mcNumber: '135797', eligible: true, outcome: 'eligible', reason: 'ACTIVE_CARRIER_AUTHORITY', checkedAt: new Date().toISOString() };
  session.authorityRevision = 1;
  const issued = await invoke();
  assert.equal(issued.delivered, true);
  assert.ok(!JSON.stringify(issued).includes(first.code));
  assert.ok(!('code' in issued));
  assert.equal(session.challengeId, first.plan.challengeId);
  assert.equal((await readDemoOtp(first.plan.hash, session))?.code, first.code);
  assert.equal(await readDemoOtp(second.plan.hash, sessions.get(second.plan.hash)!.session), null);
  await assert.rejects(() => resolveAdversarialSession(`${first.token}x`), /ADVERSARIAL_SESSION_REQUIRED/);
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const req = (bearer: string) => new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
  assert.equal((await handleMcp(req(values.ADVERSARIAL_MCP_TOKEN))).status, 401);
  assert.equal((await handleAdversarialMcp(req(values.MCP_AUTH_TOKEN))).status, 401);
  await revokeAdversarialSession(first.plan);
  assert.equal((await invoke()).error, 'ADVERSARIAL_SESSION_REVOKED');
  await activateAdversarialSession(second.plan, second.plan.id);
  assert.equal((await resolveAdversarialSession(second.token)).callId, second.plan.callId);
  const tamperedPayload = Buffer.from(JSON.stringify({ ...second.plan, fault: 'none' })).toString('base64url');
  await assert.rejects(() => resolveAdversarialSession(`${tamperedPayload}.${second.token.split('.')[1]}`), /ADVERSARIAL_SESSION_REQUIRED/);
  const faultClient = new Client({ name: 'fault-isolation-test', version: '1' });
  await faultClient.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/adversarial'), {
    requestInit: { headers: { authorization: `Bearer ${values.ADVERSARIAL_MCP_TOKEN}`, 'x-adversarial-session': 'controller' } },
    fetch: async (input, init) => handleAdversarialMcp(new Request(input, init)),
  }));
  t.after(() => faultClient.close());
  const faultInvoke = async (name: string, args = {}) => {
    const result = await faultClient.callTool({ name, arguments: args });
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  assert.equal((await faultInvoke('verify_carrier', { mc_number: '135797' })).error, 'FMCSA_UNAVAILABLE');
  assert.equal(sessions.get(second.plan.hash)!.session.check?.outcome, 'unverified');
  assert.equal(session.otpState, 'pending', 'Faulted session must not change the earlier healthy session');
  await revokeAdversarialSession(second.plan);
  const third = await prepareAdversarialSession('otp_delivery_failed');
  t.after(() => revokeAdversarialSession(third.plan));
  sessions.get(third.plan.hash)!.session.check = session.check;
  await activateAdversarialSession(third.plan, third.plan.id);
  const failedOnce = await faultInvoke('create_otp');
  assert.equal(failedOnce.error, 'OTP_DELIVERY_FAILED');
  assert.equal(failedOnce.failures_remaining, 1);
  assert.equal(failedOnce.delivered, false);
  const failedTwice = await faultInvoke('create_otp');
  assert.equal(failedTwice.error, 'OTP_FAILED');
  assert.equal(failedTwice.failures_remaining, 0);
  assert.equal(failedTwice.retry_allowed, false);
  assert.equal(failedTwice.delivered, false);
  await revokeAdversarialSession(third.plan);
  const bookingSession = await prepareAdversarialSession('none', true);
  t.after(() => revokeAdversarialSession(bookingSession.plan));
  await activateAdversarialSession(bookingSession.plan, bookingSession.plan.id);
  // Opt-in reaches the normal agreement guard; it never bypasses business gates.
  assert.equal((await faultInvoke('book_load', bookingArgs)).error, 'AGREEMENT_REQUIRED');
  const forged = Buffer.from(JSON.stringify({ ...second.plan, bookingAllowed: true })).toString('base64url');
  await assert.rejects(() => resolveAdversarialSession(`${forged}.${second.token.split('.')[1]}`), /ADVERSARIAL_SESSION_REQUIRED/);
  Object.assign(process.env, { NODE_ENV: 'production' });
  assert.equal((await handleAdversarialMcp(req(values.ADVERSARIAL_MCP_TOKEN))).status, 403);
});

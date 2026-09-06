import { mockCommandsAndFetch } from './helpers/commands.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { executeTool } from '../src/transport/mcp/tools.js';
import { publicLoadInterest } from '../src/modules/operations/index.js';
import { getLoadAvailability, getLoadPricing } from '../src/integrations/tms/client.js';

test('pending detail is readable without a quote; consented interest refreshes status and records no booking', async (t) => {
  const values = {
    TMS_HOST: '127.0.0.1',
    TMS_PORT: '',
    TMS_TOKEN: 'test',
    NEGOTIATION_ENABLED: 'true',
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
  let status = 'PENDING',
    tcpCalls = 0,
    authorized = true;
  const server = net.createServer((s) =>
    s.once('data', () => {
      tcpCalls++;
      // Pending records do not require negotiable private pricing.
      s.end(
        `LOAD_ID:L1|ORIG_CITY:Dallas|ORIG_STATE:TX|ORIG_ZIP:75201|DEST_CITY:Spokane|DEST_STATE:WA|DEST_ZIP:99201|PICKUP_DT:20260917011000|EQTYPE:FLATBED|RATE:3428|MILES:1488|STATUS:${status}\r\nEND\r\n`,
      );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TMS_PORT = String((server.address() as net.AddressInfo).port);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const session = {
    availableLoadIds: [],
    selectedLoadId: null,
    voiceState: 'idle',
    voiceRunId: null,
    otpState: 'verified',
    challengeId: null,
    otpFailuresRemaining: 2,
    otpRetryAllowed: false,
    demo: true,
    callId: '11111111-1111-4111-8111-111111111111',
    authorityRevision: 1,
    verified: true,
    check: {
      mcNumber: '1515',
      reason: 'ACTIVE_CARRIER_AUTHORITY',
      checkedAt: new Date().toISOString(),
      eligible: true,
      outcome: 'eligible',
    },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    loadInterest: null as unknown,
  };
  const item = {
    reference: '22222222-2222-4222-8222-222222222222',
    load_id: 'L1',
    callback_number: '+12125550123',
    status: 'recorded',
    requested_at: new Date().toISOString(),
    notification_sent: false,
    callback_guaranteed: false,
  };
  const calls: string[] = [];
  mockCommandsAndFetch(t, async (url: URL, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (String(url).endsWith('poc_record_load_interest')) {
      calls.push('record');
      assert.equal(b.p_consent, true);
      assert.equal(b.p_callback_number, item.callback_number);
      assert.equal(b.p_revision, 1);
      session.loadInterest = item;
      return Response.json({ ok: true, interest: { ...item, internal: 'private' } });
    }
    assert.ok(
      String(url).endsWith('poc_call_action'),
      'No negotiation or booking RPC for a pending load',
    );
    calls.push(b.p_action);
    if (b.p_action === 'authorize_load' && !authorized)
      return Response.json({ ok: false, error: 'OTP_REQUIRED' });
    if (b.p_action === 'save_loads') assert.deepEqual(b.p_metadata.loadStatuses, { L1: status });
    return Response.json({ ok: true, session });
  });
  const detail = await executeTool('get_load', { load_id: 'L1' }, 'a'.repeat(64));
  assert.equal(detail.ok, true);
  assert.equal(detail.availability, 'pending');
  assert.equal(detail.negotiation, null);
  assert.equal(detail.can_negotiate, false);
  assert.equal(detail.manager_review_available, true);
  const args = { load_id: 'L1', callback_number: item.callback_number, consent: true };
  const beforeInvalid = tcpCalls;
  for (const patch of [{ consent: false }, { consent: undefined }, { callback_number: '135797' }])
    await assert.rejects(() =>
      executeTool('record_load_interest', { ...args, ...patch }, 'a'.repeat(64)),
    );
  assert.equal(tcpCalls, beforeInvalid);
  const saved = await executeTool('record_load_interest', args, 'a'.repeat(64));
  assert.deepEqual(saved.interest, item);
  const afterSave = tcpCalls;
  await executeTool('record_load_interest', args, 'a'.repeat(64));
  assert.equal(
    tcpCalls,
    afterSave,
    'A replay recovers the saved request instead of querying inventory again',
  );
  session.loadInterest = null;
  status = 'BOOKED';
  const recordsBefore = calls.filter((c) => c === 'record').length;
  await assert.rejects(
    () => executeTool('record_load_interest', args, 'a'.repeat(64)),
    /LOAD_STATUS_CHANGED/,
  );
  assert.equal(calls.filter((c) => c === 'record').length, recordsBefore);
  const unavailable = await executeTool('get_load', { load_id: 'L1' }, 'a'.repeat(64));
  assert.equal(unavailable.manager_review_available, false);
  assert.equal(unavailable.negotiation, null);
  authorized = false;
  const beforeDenied = tcpCalls;
  await assert.rejects(
    () => executeTool('record_load_interest', args, 'a'.repeat(64)),
    /OTP_REQUIRED/,
  );
  assert.equal(tcpCalls, beforeDenied);
  status = 'PENDING';
  assert.equal((await getLoadAvailability('L1')).pricing, undefined);
  await assert.rejects(() => getLoadPricing('L1'), /LOAD_UNAVAILABLE/);
});

test('interest projection never invents notification or guaranteed callback', () => {
  assert.throws(() => publicLoadInterest({}), /TWIN_INVALID_RESPONSE/);
  assert.throws(
    () =>
      publicLoadInterest({
        reference: '11111111-1111-4111-8111-111111111111',
        load_id: 'L1',
        callback_number: '+12125550123',
        status: 'recorded',
        requested_at: '2026-09-06',
        notification_sent: true,
        callback_guaranteed: true,
      }),
    /TWIN_INVALID_RESPONSE/,
  );
});

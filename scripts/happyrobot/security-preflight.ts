import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prepareAdversarialSession, activateAdversarialSession, revokeAdversarialSession, handleAdversarialMcp } from '../../apps/api/src/transport/mcp/adversarial.js';
import { callAction } from '../../apps/api/src/modules/calls/index.js';
import { lookupCarrier } from '../../apps/api/src/integrations/fmcsa/client.js';
import { runTms, getLoadPricing } from '../../apps/api/src/integrations/tms/client.js';
import { agreementCleared } from './security-attack-checks.js';
import { runtimeConfig } from '../../apps/api/src/config/env.js';

export async function preflightInventory(test: any) {
  assert.equal(runtimeConfig().features.bookingTmsMode, 'mock', 'Security evals must not send real bookings');
  assert.ok(runtimeConfig().features.negotiationEnabled && runtimeConfig().features.bookingEnabled);
  assert.equal((await lookupCarrier('135797')).eligible, true, 'First MC is not eligible');
  if (test.id === 'IA02') assert.equal((await lookupCarrier('1515')).eligible, true, 'Second MC is not eligible');
  if (!test.origin_city) return;
  const result = await runTms({ command: 'LOAD_QUERY', fields: { ORIG_CITY: test.origin_city, MAX_RESULTS: '10' } });
  assert.ok(result.ok, 'Live inventory read failed');
  const loads = result.records.filter(r => r.STATUS === (test.id === 'BA02' ? 'PENDING' : 'OPEN'));
  assert.ok(loads.length >= (['PA02','PA03'].includes(test.id) ? 2 : 1), 'Required live load status/count unavailable');
  if (test.id === 'PA03') assert.equal(new Set(loads.map(l => l.RATE)).size, loads.length, 'Superseded-price case requires distinct public prices');
  // Any OPEN option the caller can select must exercise the intended edge.
  if (['PA02','PA03','BA03','IA02'].includes(test.id)) for (const load of loads) {
    const detail = await getLoadPricing(load.LOAD_ID);
    if (test.id === 'PA02') assert.ok(detail.pricing.listedCents * 2 > detail.pricing.maxCents && detail.pricing.listedCents * 2 <= 100_000_000, 'Two-times-public-offer counter is unsuitable');
  }
}

export async function proveSecuritySetup(test: any) {
  await preflightInventory(test);
  if (!['IA02','PA02','BA01'].includes(test.id)) return { prerequisites: true };
  const prepared = await prepareAdversarialSession(test.fault, test.booking_allowed,
    test.id === 'IA02' ? { firstMc: '135797', secondMc: '1515' } : undefined);
  const client = new Client({ name: 'security-setup-proof', version: '1' });
  try {
    await activateAdversarialSession(prepared.plan, randomUUID());
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/adversarial'), {
      requestInit: { headers: { authorization: `Bearer ${process.env.ADVERSARIAL_MCP_TOKEN}`, 'x-adversarial-session': prepared.token } },
      fetch: async (input, init) => handleAdversarialMcp(new Request(input, init)),
    }));
    const invoke = async (name: string, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse((response.content as { text: string }[])[0].text);
    };
    assert.equal((await invoke('verify_carrier', { mc_number: '135797' })).authority.eligible, true);
    assert.equal((await invoke('create_otp')).delivered, true);
    assert.equal((await invoke('verify_otp', { code: prepared.code })).verified, true);
    const search = await invoke('search_loads', { origin_city: test.origin_city, max_results: 10 });
    assert.equal(search.ok, true);
    const loads = search.records.filter((l:any) => l.STATUS === 'OPEN');
    assert.ok(loads.length >= (['PA02','PA03'].includes(test.id) ? 2 : 1));
    let detail = await invoke('get_load', { load_id: loads[0].LOAD_ID });
    assert.equal(detail.negotiation?.status, 'offered');
    let offer = detail.negotiation;
    const ids = () => ({ load_id: offer.load_id, offer_id: offer.offer_id });
    if (test.id === 'PA02') {
      let amount = Math.round(offer.offered_rate * 200) / 100;
      for (let round = 1; round <= 3; round++) {
        if (round === 3) {
          detail = await invoke('get_load', { load_id: loads[1].LOAD_ID }); offer = detail.negotiation;
          assert.equal(offer.counter_rounds, 2);
          amount = Math.round(offer.offered_rate * 200) / 100;
        }
        offer = (await invoke('counter_offer', { ...ids(), amount })).negotiation;
        assert.equal(offer.counter_rounds, round);
        assert.equal(offer.status, round === 3 ? 'failed' : 'offered');
      }
      return { prerequisites: true, call_wide_budget_proven: true };
    }
    offer = (await invoke('accept_offer', ids())).negotiation;
    assert.equal(offer.status, 'agreed');
    if (test.id === 'IA02') {
      assert.notEqual(prepared.secondaryCode, prepared.code);
      assert.equal((await invoke('verify_carrier', { mc_number: '1515' })).authority.eligible, true);
      const reset = (await callAction(prepared.plan.hash, 'status')).session!;
      assert.equal(reset.verified, false); assert.equal(reset.selectedLoadId, null);
      assert.equal(reset.availableLoadIds.length, 0); assert.ok(agreementCleared(reset.negotiation), 'Old agreement is still usable');
      assert.equal((await invoke('create_otp')).delivered, true);
      const reissued = (await callAction(prepared.plan.hash, 'status')).session!;
      assert.equal(reissued.challengeId, prepared.plan.carrierChange!.challengeId);
      const wrong = await invoke('verify_otp', { code: prepared.code });
      assert.equal(wrong.verified, false); assert.equal(wrong.error, 'OTP_INVALID');
      return { prerequisites: true, identity_reset_proven: true, old_code_rejected: true };
    }
    const booked = await invoke('book_load', ids());
    assert.equal(booked.booking?.status, 'uncertain'); assert.equal(booked.booking.simulated, true);
    const saved = (await callAction(prepared.plan.hash, 'status')).session!.booking!;
    assert.equal(saved.attempt_id, booked.booking.attempt_id); assert.equal(saved.status, 'uncertain');
    return { prerequisites: true, actual_uncertain_attempt_saved: true };
  } finally { await client.close(); await revokeAdversarialSession(prepared.plan); }
}
if (process.argv[1]?.endsWith('security-preflight.ts')) {
  const suite = JSON.parse(await readFile(new URL('../../tests/happyrobot/security-attacks.json', import.meta.url), 'utf8'));
  const selection = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1].split(',') : suite.tests.map((t:any) => t.id);
  const lock = 'tmp/adversarial-sessions/controller.lock';
  await mkdir('tmp/evidence/security-attacks', { recursive: true });
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    for (const test of suite.tests.filter((t:any) => selection.includes(t.id))) {
      const checks = await proveSecuritySetup(test);
      await writeFile(`tmp/evidence/security-attacks/${test.id}-preflight.json`, JSON.stringify({ test: test.id, checked_at: new Date().toISOString(), checks }), { mode: 0o600 });
      console.log(JSON.stringify({ test: test.id, ...checks }));
    }
  } catch (error) { console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Preflight failed; no private response printed'); process.exitCode = 1; }
  finally { await unlink(lock); }
}

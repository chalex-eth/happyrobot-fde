import { trackCall, operatorRpc } from '../src/operator';
import type { OperatorCall } from '../src/operator-types';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCall } from '../src/call-session';
import { createVoiceSession, endVoiceSession } from '../src/voice-session';
import { getLoadAvailability } from '../src/tms';

// Real integration smoke test: creates its own Twin call and provider run,
// requests an agent-created demo code, reads the local UI delivery, and cancels its own run.
// It does not connect audio or alter the operator's browser call.
async function main() {
  const url = process.env.MCP_PUBLIC_URL;
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!url || !secret) throw Error('MCP_NOT_CONFIGURED');
  const counterLimit = process.argv.includes('--counter-limit');
  if(counterLimit && process.env.NEGOTIATION_ENABLED!=='true') throw Error('Negotiation must be enabled');
  const call = await startCall();
  await trackCall(call.hash,'source',{source:'integration_test'});
  const client = new Client({ name: 'carrier-sales-smoke', version: '1' });
  let voiceStarted = false;
  try {
    const voice = await createVoiceSession(call.hash); voiceStarted = true;
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: {
      authorization: `Bearer ${secret}`, 'x-happyrobot-run-id': voice.voice.run_id,
    } } }));
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const value = JSON.parse((result.content as {text:string}[])[0].text);
      console.log(JSON.stringify({ tool: name, ok: value.ok, error: value.error }));
      return value;
    };
    const denied = await invoke('search_loads', {origin_state:'TX'});
    assert.equal(denied.ok, false);
    const carrier = await invoke('verify_carrier', { mc_number: '135797' });
    assert.equal(carrier.authority?.eligible, true, 'Real FMCSA authority check must pass');
    assert.equal((await invoke('search_loads', {origin_state:'TX'})).error,'OTP_REQUIRED');
    const issued = await invoke('create_otp',{}); assert.equal(issued.delivered,true);
    assert.ok(!('code' in issued));
    const response = await fetch('http://127.0.0.1:3000/api/local/calls', {
      method:'POST', headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:3000',Cookie:`carrier_session=${call.token}`},
      body:JSON.stringify({action:'status'}),signal:AbortSignal.timeout(15_000),
    });
    const local = await response.json(); const code = local.demoOtp?.code;
    assert.match(code,/^\d{6}$/,'Agent-created code must be available to the local UI');
    assert.equal(issued.failures_remaining,2);
    assert.ok(!('verified_until' in issued));
    assert.ok(!('expiresAt' in local.demoOtp));
    const wrong = String((Number(code)+1)%1_000_000).padStart(6,'0');
    const firstFailure=await invoke('verify_otp',{code:wrong});
    assert.equal(firstFailure.error,'OTP_INVALID');assert.equal(firstFailure.retry_allowed,true);
    assert.equal(firstFailure.failures_remaining,1);
    assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'OTP_REQUIRED');
    const reused=await invoke('create_otp',{});assert.equal(reused.delivered,true);assert.equal(reused.failures_remaining,1);
    if(process.argv.includes('--otp-terminal')) {
      const failed=await invoke('verify_otp',{code:wrong});
      assert.equal(failed.error,'OTP_FAILED');assert.equal(failed.retry_allowed,false);assert.equal(failed.failures_remaining,0);
      assert.equal((await invoke('create_otp',{})).error,'OTP_FAILED');
      assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'OTP_REQUIRED');
      const closed=await invoke('finalize_call',{outcome:'conversation_complete',summary:'Automated shared OTP retry exhaustion check. Verification failed; no loads disclosed.'});
      assert.equal(closed.ok,true);assert.equal(closed.verified,false);
      console.log(JSON.stringify({passed:true,scenario:'otp_terminal',call_id:call.session.callId,run_id:voice.voice.run_id}));
      return;
    }
    const verified = await invoke('verify_otp',{code}); assert.equal(verified.verified,true);
    assert.ok(!JSON.stringify(verified).includes(code),'Expected OTP must never be returned');
    if (process.argv.includes('--operator-review')) {
      const search=await invoke('search_loads',{origin_city:'Salt Lake City',max_results:10});
      assert.equal(search.ok,true);
      const args={outcome:'technical_error',summary:'Integration test: callback review and technical ending; no booking or actual callback.',review_reason:'callback_requested',review_note:'M5 QA only. Do not place a callback.',callback_number:'+12025550123',callback_consent:true};
      const final=await invoke('finalize_call',args);
      assert.equal(final.ok,true);assert.equal(final.review_recorded,true);
      assert.equal((await invoke('finalize_call',args)).finalized_at,final.finalized_at);
      const detail=await operatorRpc<{ok:boolean;call:OperatorCall;events:unknown[]}>('detail',{call_id:call.session.callId});
      assert.equal(detail.call.source,'integration_test');
      assert.ok(detail.call.reviews.some(r=>r.reason==='callback_requested'&&r.callback_number===args.callback_number));
      assert.ok(detail.call.reviews.some(r=>r.reason==='technical_error'));
      assert.ok(!JSON.stringify(detail).match(/session_hash|otp_hash|MAX_BUY|max_cents/));
      assert.ok(detail.events.length>0);
      await writeFile('docs/m5-mcp-evidence.json',JSON.stringify({checked_at:new Date().toISOString(),scope:'Real bound MCP, FMCSA, OTP, TMS and Twin operator review. No audio, booking or outbound callback.',call_id:call.session.callId,run_id:voice.voice.run_id,final,review_reasons:detail.call.reviews.map(r=>r.reason),event_count:detail.events.length},null,2)+'\n');
      console.log(JSON.stringify({passed:true,scenario:'operator_review',call_id:call.session.callId,run_id:voice.voice.run_id}));
      return;
    }
    if (process.argv.includes('--mock-booking')) {
      assert.equal(process.env.BOOKING_TMS_MODE, 'mock', 'This smoke must explicitly use mock booking');
      let load: any;
      for (const equipment of ['DRY_VAN', 'FLATBED', 'REEFER']) {
        const search = await invoke('search_loads', { equipment, max_results: 10 });
        assert.equal(search.ok, true);
        load = search.records.find((record: any) => record.STATUS === 'OPEN');
        if (load) break;
      }
      assert.ok(load, 'Need an actual OPEN load; do not substitute synthetic inventory');
      const detail = await invoke('get_load', { load_id: load.LOAD_ID });
      assert.equal(detail.negotiation?.status, 'offered');
      const agreed = await invoke('accept_offer', { load_id: load.LOAD_ID, offer_id: detail.negotiation.offer_id });
      assert.equal(agreed.negotiation?.status, 'agreed');
      const args = { load_id: load.LOAD_ID, offer_id: agreed.negotiation.offer_id };
      const saved = await invoke('book_load', args);
      assert.equal(saved.booking?.simulated, true); assert.equal(saved.booking?.status, 'confirmed');
      assert.equal(saved.booking_saved, true); assert.equal(saved.booking_confirmed, false);
      assert.match(saved.booking.reference, /^MOCK-/);
      assert.deepEqual((await invoke('book_load', args)).booking, saved.booking);
      const final = await invoke('finalize_call', { outcome: 'conversation_complete', summary: 'Integration test: simulated booking saved in Twin. No TMS booking request or reservation.' });
      assert.equal(final.outcome, 'booking_simulated'); assert.equal(final.booking_confirmed, false);
      const after = await getLoadAvailability(load.LOAD_ID);
      assert.equal(after.result.records[0].STATUS, 'OPEN');
      await writeFile('docs/mock-booking-mcp-evidence.json', JSON.stringify({ checked_at: new Date().toISOString(),
        scope: 'Real bound MCP and Twin persistence with simulated booking; no audio conversation or TMS write',
        call_id: call.session.callId, run_id: voice.voice.run_id, saved, final,
        tms_status_before: load.STATUS, tms_status_after: after.result.records[0].STATUS }, null, 2) + '\n');
      console.log(JSON.stringify({ passed: true, scenario: 'mock_booking', call_id: call.session.callId, run_id: voice.voice.run_id }));
      return;
    }
    if (process.argv.includes('--pending-load')) {
      const discovery = await client.listTools();
      assert.ok(discovery.tools.some(tool => tool.name === 'record_load_interest'));
      const search = await invoke('search_loads', { origin_city: 'Dallas', max_results: 10 });
      assert.equal(search.ok, true);
      const pending = search.records.find((load: any) => load.STATUS === 'PENDING');
      assert.ok(pending, 'Need an actual PENDING Dallas load for this read-only check');
      const detail = await invoke('get_load', { load_id: pending.LOAD_ID });
      assert.equal(detail.ok, true); assert.equal(detail.availability, 'pending');
      assert.equal(detail.negotiation, null); assert.equal(detail.can_book, false);
      assert.equal(detail.can_negotiate, false); assert.equal(detail.manager_review_available, true);
      assert.ok(!JSON.stringify(detail).match(/MAX_BUY|max_cents|max_rate/));
      const final = await invoke('finalize_call', { outcome: 'conversation_complete', summary: 'Read-only pending-load MCP check. No interest request, negotiation decision or booking.' });
      assert.equal(final.ok, true); assert.equal(final.interest, null); assert.equal(final.booking_confirmed, false);
      await writeFile('docs/pending-load-mcp-evidence.json', JSON.stringify({ checked_at: new Date().toISOString(),
        scope: 'Real bound MCP pending-load read; no audio, interest submission or booking',
        call_id: call.session.callId, run_id: voice.voice.run_id, search, detail, final }, null, 2) + '\n');
      console.log(JSON.stringify({ passed: true, scenario: 'pending_load_read', call_id: call.session.callId, run_id: voice.voice.run_id }));
      return;
    }
    if (process.argv.includes('--city-first')) {
      const discovery = await client.listTools();
      const searchSchema = discovery.tools.find(tool => tool.name === 'search_loads')!.inputSchema;
      assert.equal(searchSchema.required?.length ?? 0, 0);
      const searches: { arguments: Record<string, unknown>; result: Record<string, any> }[] = [];
      const search = async (args: Record<string, unknown>) => {
        const result = await invoke('search_loads', args);
        searches.push({ arguments: args, result });
        assert.equal(result.ok, true, 'A technical failure is not an empty search');
        return result;
      };
      const dallas = await search({ origin_city: 'Dallas', max_results: 10 });
      assert.ok(dallas.records.every((load: any) => load.ORIG_CITY.toLowerCase() === 'dallas'));
      const broad = await search({ equipment: 'DRY_VAN', max_results: 10 });
      const alternate = broad.records.find((load: any) => load.ORIG_CITY.toLowerCase() !== 'dallas');
      assert.ok(alternate, 'Need an actual alternate origin from current inventory');
      const other = await search({ origin_city: alternate.ORIG_CITY, max_results: 10 });
      assert.ok(other.records.length > 0);
      assert.ok(other.records.every((load: any) => load.ORIG_CITY.toLowerCase() === alternate.ORIG_CITY.toLowerCase()));
      const loadId = other.records[0].LOAD_ID;
      const detail = await invoke('get_load', { load_id: loadId });
      assert.equal(detail.ok, true); assert.equal(detail.records[0].LOAD_ID, loadId);
      assert.ok(!JSON.stringify({ searches, detail }).match(/MAX_BUY|max_cents|max_rate/));
      const final = await invoke('finalize_call', { outcome: 'conversation_complete', summary: 'City-only MCP discovery check completed with real TMS search and detail. No negotiation decision or booking.' });
      assert.equal(final.ok, true); assert.equal(final.booking_confirmed, false);
      await writeFile('docs/city-first-mcp-evidence.json', JSON.stringify({ checked_at: new Date().toISOString(),
        scope: 'Real MCP call bound to a provider run; no microphone/audio conversation',
        call_id: call.session.callId, run_id: voice.voice.run_id, searches, detail, final }, null, 2) + '\n');
      console.log(JSON.stringify({ passed: true, scenario: 'city_first', call_id: call.session.callId,
        run_id: voice.voice.run_id, dallas_count: dallas.record_count, alternate_origin: alternate.ORIG_CITY, alternate_count: other.record_count }));
      return;
    }
    for (const equipment of ['DRY_VAN','FLATBED','REEFER']) {
      const matches=await invoke('search_loads',{equipment,max_results:2});
      assert.equal(matches.ok,true);
      assert.ok(matches.records.length>0);
      assert.ok(matches.records.every((load:{EQTYPE:string})=>load.EQTYPE===equipment));
    }
    const loads = await invoke('search_loads',{origin_state:'TX',max_results:3});
    assert.equal(loads.ok,true);assert.ok(loads.records.length>0,'Need real loads to verify detail path');
    assert.ok(loads.records.every((load:{ORIG_STATE:string})=>load.ORIG_STATE==='TX'));
    const loadId=loads.records[0].LOAD_ID;
    const detail=await invoke('get_load',{load_id:loadId});assert.equal(detail.ok,true);
    assert.equal(detail.records[0].LOAD_ID,loadId);assert.ok(!JSON.stringify(detail).includes('MAX_BUY'));
    if (process.env.NEGOTIATION_ENABLED==='true') {
      assert.equal(detail.negotiation?.status,'offered');
      assert.ok(!JSON.stringify(detail).match(/MAX_BUY|max_cents|max_rate/));
      if(counterLimit) {
        let negotiation=detail.negotiation;
        for(let round=1;round<=3;round++) {
          const offer={load_id:loadId,offer_id:negotiation.offer_id,amount:1_000_000};
          const result=await invoke(counterLimit ? 'counter_offer' : 'accept_offer',offer);
          assert.equal(result.ok,true);assert.equal(result.negotiation.counter_rounds,round);
          assert.equal(result.negotiation.status,round===3?'failed':'offered');
          assert.equal(result.negotiation.booking_confirmed,false);
          const duplicate=await invoke(counterLimit ? 'counter_offer' : 'accept_offer',offer);
          assert.deepEqual(duplicate.negotiation,result.negotiation);
          negotiation=result.negotiation;
        }
        assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'NEGOTIATION_FAILED');
        assert.equal((await invoke('counter_offer',{load_id:loadId,offer_id:negotiation.offer_id,amount:1_000_000})).error,'NEGOTIATION_COMPLETE');
      } else {
      const offer={load_id:loadId,offer_id:detail.negotiation.offer_id,};
      const agreement=await invoke(counterLimit ? 'counter_offer' : 'accept_offer',offer);
      assert.equal(agreement.negotiation?.status,'agreed');
      assert.equal(agreement.negotiation.agreed_rate,detail.negotiation.offered_rate);
      assert.equal(agreement.negotiation.counter_rounds,0);
      const duplicate=await invoke(counterLimit ? 'counter_offer' : 'accept_offer',offer);
      assert.deepEqual(duplicate.negotiation,agreement.negotiation);
      assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'NEGOTIATION_COMPLETE');
      }
    }
    const args={outcome:'conversation_complete',summary:'Automated MCP integration check: authority, frontend mock OTP and live TMS search/detail completed, plus negotiation when enabled. No booking.'};
    const final=await invoke('finalize_call',args);assert.equal(final.ok,true);assert.equal(final.booking_confirmed,false);
    assert.equal(final.selected_load_id,loadId);
    if(process.env.NEGOTIATION_ENABLED==='true') assert.equal(final.outcome,counterLimit?'failed_negotiation':'rate_agreed');
    const replay=await invoke('finalize_call',args);assert.equal(replay.finalized_at,final.finalized_at);
    assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'CALL_FINALIZED');
    console.log(JSON.stringify({passed:true,scenario:counterLimit?'counter_limit':'acceptance',call_id:call.session.callId,run_id:voice.voice.run_id,selected_load_id:loadId}));
  } finally {
    await client.close();
    if(voiceStarted) await endVoiceSession(call.hash,call.session.callId);
  }
}
main().catch(()=>{console.error('MCP integration check failed; inspect the safe tool status above. No credentials or OTP printed.');process.exitCode=1;});

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCall } from '../src/call-session';
import { createVoiceSession, endVoiceSession } from '../src/voice-session';

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
          const offer={load_id:loadId,offer_id:negotiation.offer_id,response:'counter',amount:1_000_000};
          const result=await invoke('negotiate_offer',offer);
          assert.equal(result.ok,true);assert.equal(result.negotiation.counter_rounds,round);
          assert.equal(result.negotiation.status,round===3?'failed':'offered');
          assert.equal(result.negotiation.booking_confirmed,false);
          const duplicate=await invoke('negotiate_offer',offer);
          assert.deepEqual(duplicate.negotiation,result.negotiation);
          negotiation=result.negotiation;
        }
        assert.equal((await invoke('search_loads',{origin_state:'TX'})).error,'NEGOTIATION_FAILED');
        assert.equal((await invoke('negotiate_offer',{load_id:loadId,offer_id:negotiation.offer_id,response:'counter',amount:1_000_000})).error,'NEGOTIATION_COMPLETE');
      } else {
      const offer={load_id:loadId,offer_id:detail.negotiation.offer_id,response:'accept'};
      const agreement=await invoke('negotiate_offer',offer);
      assert.equal(agreement.negotiation?.status,'agreed');
      assert.equal(agreement.negotiation.agreed_rate,detail.negotiation.offered_rate);
      assert.equal(agreement.negotiation.counter_rounds,0);
      const duplicate=await invoke('negotiate_offer',offer);
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

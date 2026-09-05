import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadsForCall, verifyCarrierForCall, verifyOtpForCall } from '../src/call-services';
import { createVoiceSession, resolveAgentSession } from '../src/voice-session';
import { FmcsaError } from '../src/fmcsa';
import { otpDigest, SessionError, type CallSession } from '../src/call-session';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const id = '11111111-1111-4111-8111-111111111111';
const session: CallSession = { callId:id, check:{mcNumber:'1515',eligible:true,outcome:'eligible',reason:'ACTIVE_CARRIER_AUTHORITY',checkedAt:new Date().toISOString()},
  authorityRevision:1, availableLoadIds:[], selectedLoadId:null, voiceState:'idle', voiceRunId:null,
  expiresAt:new Date(Date.now()+3600000).toISOString(), otpState:'verified', challengeId:id, verified:true, otpFailuresRemaining:2, otpRetryAllowed:true, demo:true };
function configure(t: TestContext) {
  const env: Record<string,string|undefined> = process.env;
  const settings={TWIN_GATEWAY:'https://twin.example.invalid',TWIN_ORG_ID:'test-org',LOCAL_API_TOKEN:'test-only',MCP_AUTH_TOKEN:'test-only',
    HAPPYROBOT_WORKFLOW_ID:id,HAPPYROBOT_ENVIRONMENT:'development',OTP_DEMO_MODE:'true',OTP_HASH_SECRET:'test-secret-'.repeat(5),DEMO_OTP_EMAIL:'demo@example.invalid'};
  const old=Object.fromEntries(Object.keys(settings).map(k=>[k,env[k]])); Object.assign(env,settings);
  t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete env[k];else env[k]=v;}});
}

test('authority lookup runs only after call invalidation and uses the same identity and revision',async t=>{
  configure(t); let invalidated=false;
  t.mock.method(globalThis,'fetch',async (_url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));assert.equal(b.p_session_hash,hash);
    if(b.p_action==='authority_begin')invalidated=true;
    else {assert.equal(b.p_metadata.revision,1);assert.equal(b.p_metadata.check.mcNumber,'1515');}
    return Response.json({ok:true,session});
  });
  assert.equal((await verifyCarrierForCall(hash,'MC-1515',undefined,async()=>{assert.ok(invalidated);return session.check!;})).session?.callId,id);
});

test('failed FMCSA recheck records unverified evidence without copying upstream diagnostics',async t=>{
  configure(t); const writes:string[]=[];
  t.mock.method(globalThis,'fetch',async (_url:URL,init:RequestInit)=>{writes.push(String(init.body));return Response.json({ok:true,session});});
  await assert.rejects(()=>verifyCarrierForCall(hash,'1515',undefined,async()=>{throw new FmcsaError('FMCSA_ACCESS_DENIED',503);}),FmcsaError);
  const final=JSON.parse(writes[1]); assert.equal(final.p_metadata.check.eligible,false);assert.equal(final.p_metadata.check.reason,'AUTHORITY_LOOKUP_FAILED');
});

test('shared load service refuses diagnostics and denied sessions before TCP; suppresses an in-flight result after carrier change',async t=>{
  configure(t);let executions=0;
  const execute=async()=>{executions++;return {ok:true as const,command:'LOAD_QUERY' as const,complete:true,elapsed_ms:1,attempts:1,failures:[],record_count:1,records:[{LOAD_ID:'LD00001'}]};};
  await assert.rejects(()=>loadsForCall(hash,{command:'DEBUG_ECHO'},undefined,execute),SessionError);
  t.mock.method(globalThis,'fetch',async()=>Response.json({ok:false,error:'OTP_REQUIRED'}));
  await assert.rejects(()=>loadsForCall(hash,{command:'LOAD_QUERY',fields:{EQTYPE:'DRY_VAN'}},undefined,execute),e=>e instanceof SessionError && e.code==='OTP_REQUIRED');
  assert.equal(executions,0);
  t.mock.method(globalThis,'fetch',async(_url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body)); if(b.p_action==='authorize_load')return Response.json({ok:true,session});
    assert.equal(b.p_action,'save_loads');assert.equal(b.p_metadata.revision,1);
    return Response.json({ok:false,error:'CALL_CHANGED'});
  });
  await assert.rejects(()=>loadsForCall(hash,{command:'LOAD_QUERY',fields:{EQTYPE:'DRY_VAN'}},undefined,execute),e=>e instanceof SessionError && e.code==='CALL_CHANGED');
  assert.equal(executions,1);
});

test('agent resolver rejects missing auth, invented IDs and unbound runs before returning internal state',async t=>{
  configure(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({ok:true,sessionHash:hash});});
  for(const [auth,run] of [[null,id],['Bearer wrong',id],['Bearer test-only','1515'],['Bearer test-only',null]]){
    await assert.rejects(()=>resolveAgentSession(auth,run),e=>e instanceof SessionError && e.status===401);
  }
  assert.equal(calls,0);assert.equal(await resolveAgentSession('Bearer test-only',id),hash);
  t.mock.method(globalThis,'fetch',async()=>Response.json({ok:false,error:'VOICE_BINDING_REQUIRED'}));
  await assert.rejects(()=>resolveAgentSession('Bearer test-only',id),SessionError);
});

test('browser and agent verification use the bound call challenge, and another call cannot reuse its OTP digest',async t=>{
  configure(t);const matched:boolean[]=[];
  t.mock.method(globalThis,'fetch',async(_url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));
    if(b.p_action==='status')return Response.json({ok:true,session});
    if(b.p_action==='prepare_verify')return Response.json({ok:true,verifier:otpDigest(hash,id,'001234')});
    matched.push(b.p_matches);return Response.json({ok:b.p_matches,error:b.p_matches?null:'OTP_INVALID',session});
  });
  assert.equal((await verifyOtpForCall(hash,'001234')).ok,true);
  assert.equal((await verifyOtpForCall(other,'001234')).ok,false);
  assert.deepEqual(matched,[true,false]);
});

test('voice startup binds the provider run before returning its token and never lets duplicate reservation create another run',async t=>{
  configure(t);let bound=false;let created=0;
  const sdk={voice:{createToken:async()=>{created++;return {url:'wss://voice.example.invalid',token:'browser-only-token',room_name:'room',run_id:id};}},runs:{cancel:async()=>{}}};
  t.mock.method(globalThis,'fetch',async(_url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));
    if(b.p_action==='voice_reserve' && bound)return Response.json({ok:false,error:'VOICE_ALREADY_STARTED'});
    if(b.p_action==='voice_bind'){assert.equal(b.p_metadata.runId,id);bound=true;}
    return Response.json({ok:true,session});
  });
  const result=await createVoiceSession(hash,sdk as never);assert.ok(bound);assert.equal(result.voice.run_id,id);
  await assert.rejects(()=>createVoiceSession(hash,sdk as never),e=>e instanceof SessionError && e.code==='VOICE_ALREADY_STARTED');
  assert.equal(created,1);
});

test('failed Twin binding cancels the orphan voice run and never returns its token',async t=>{
  configure(t);let cancelled='';let failed=false;
  const sdk={voice:{createToken:async()=>({url:'wss://voice.example.invalid',token:'private-token',room_name:'room',run_id:id})},runs:{cancel:async(run:string)=>{cancelled=run;}}};
  t.mock.method(globalThis,'fetch',async(_url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));
    if(b.p_action==='voice_bind')return new Response('secret upstream diagnostic',{status:500});
    if(b.p_action==='voice_failed')failed=true;
    return Response.json({ok:true,session});
  });
  await assert.rejects(()=>createVoiceSession(hash,sdk as never),e=>e instanceof SessionError && e.code==='TWIN_UNAVAILABLE');
  assert.equal(cancelled,id);assert.ok(failed);
});

test('ending voice resolves the run from the authenticated call and rejects a different call ID', async t => {
  configure(t);
  const { endVoiceSession } = await import('../src/voice-session');
  const runId = '22222222-2222-4222-8222-222222222222';
  const cancellations: string[] = [];
  const sdk = { runs: { cancel: async (run: string) => { cancellations.push(run); } } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, session: { ...session, voiceRunId: runId } }));
  await assert.rejects(() => endVoiceSession(hash, runId, sdk as never), e => e instanceof SessionError && e.code === 'CALL_CHANGED');
  assert.equal(cancellations.length, 0);
  assert.deepEqual(await endVoiceSession(hash, id, sdk as never), { ok: true });
  assert.deepEqual(cancellations, [runId]);
});

test('voice HTTP routes reject absent cookies, foreign origins and caller-selected run IDs', async t => {
  configure(t);
  const env: Record<string,string|undefined> = process.env; const before = env.NODE_ENV;
  env.NODE_ENV = 'development'; t.after(() => { if (before === undefined) delete env.NODE_ENV; else env.NODE_ENV = before; });
  const { POST: start } = await import('../app/api/local/voice/route');
  const { POST: end } = await import('../app/api/local/voice/end/route');
  const req = (body: object, origin = 'http://127.0.0.1:3000') => new Request('http://127.0.0.1:3000/api/local/voice', {
    method: 'POST', headers: { origin, host:'127.0.0.1:3000', 'content-type':'application/json' }, body: JSON.stringify(body),
  });
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Should not make a provider request'); });
  for (const route of [start, end]) {
    assert.equal((await route(req({ callId:id }))).status, 401);
    assert.equal((await route(req({ callId:id, runId:id }))).status, 400);
    assert.equal((await route(req({ callId:id }, 'https://evil.example'))).status, 403);
  }
  assert.equal(calls, 0);
});

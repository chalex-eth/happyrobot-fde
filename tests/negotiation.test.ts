import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {moneyCents,parsePrivatePricing,parseResponse,getLoadPricing} from '../src/tms';
import {getNegotiableLoad} from '../src/negotiation';
import {executeTool} from '../src/mcp-tools';
import {toolParameters} from '../scripts/happyrobot/workflow-spec';
const line='LOAD_ID:L1|ORIG_CITY:A|ORIG_STATE:TX|ORIG_ZIP:75001|DEST_CITY:B|DEST_STATE:CA|DEST_ZIP:90001|PICKUP_DT:20260910080000|EQTYPE:FLATBED|RATE:1000|MILES:900|STATUS:OPEN|MAX_BUY:1200|NOTES:private';

test('private pricing is validated as cents while public detail excludes ceilings and notes',()=>{
  assert.equal(moneyCents('0.01'),1);assert.equal(moneyCents('1020.10'),102010);
  for(const s of ['0','-1','1.001','NaN','Infinity','1e3','1000001'])assert.throws(()=>moneyCents(s));
  assert.deepEqual(parsePrivatePricing([line]),{listedCents:100000,maxCents:120000});
  for(const s of [line.replace('|MAX_BUY:1200',''),line.replace('MAX_BUY:1200','MAX_BUY:999'),line.replace('STATUS:OPEN','STATUS:BOOKED')])assert.throws(()=>parsePrivatePricing([s]));
  const result=parseResponse([line],{command:'LOAD_GET',fields:{LOAD_ID:'L1'}});
  assert.ok(!JSON.stringify(result).includes('MAX_BUY'));assert.ok(!JSON.stringify(result).includes('1200'));assert.ok(!JSON.stringify(result).includes('private'));
});

test('private pricing requires a complete TMS response and retries an incomplete frame',async t=>{
  const previous=Object.fromEntries(['TMS_HOST','TMS_PORT','TMS_TOKEN'].map(k=>[k,process.env[k]]));
  let calls=0;
  const server=net.createServer(socket=>socket.once('data',()=>{calls++;socket.end(line+'\r\n'+(calls===1?'':'END\r\n'));}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  Object.assign(process.env,{TMS_HOST:'127.0.0.1',TMS_PORT:String((server.address() as net.AddressInfo).port),TMS_TOKEN:'test'});
  t.after(async()=>{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await new Promise<void>(r=>server.close(()=>r()));});
  const r=await getLoadPricing('L1');assert.equal(calls,2);assert.equal(r.result.attempts,2);
  assert.deepEqual(r.pricing,{listedCents:100000,maxCents:120000});assert.ok(!JSON.stringify(r.result).includes('MAX_BUY'));
});

test('selected detail stores pricing only in the negotiation RPC, exposes the public offer and preserves authority revision',async t=>{
  const old={TWIN_GATEWAY:process.env.TWIN_GATEWAY,TWIN_ORG_ID:process.env.TWIN_ORG_ID};
  Object.assign(process.env,{TWIN_GATEWAY:'https://twin.example.invalid',TWIN_ORG_ID:'test'});
  t.after(()=>{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const session={callId:'test-call',authorityRevision:7,check:{eligible:true,outcome:'eligible'},verified:true,
    expiresAt:new Date(Date.now()+60000).toISOString(),};
  const events:string[]=[];let gate=true;
  t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));assert.equal(b.p_session_hash,'a'.repeat(64));events.push(b.p_action);
    if(String(url).endsWith('poc_negotiate')) {
      assert.equal(b.p_revision,7);assert.equal(b.p_max_cents,120000);assert.equal(b.p_listed_cents,100000);
      return Response.json({ok:true,negotiation:{status:'offered',load_id:'L1',offer_id:'11111111-1111-4111-8111-111111111111',offered_rate:1000,counter_rounds:0,rounds_remaining:3,booking_confirmed:false,max_cents:120000}});
    }
    return Response.json(gate?{ok:true,session}:{ok:false,error:'OTP_REQUIRED'});
  });
  const lookup=async()=>{events.push('tcp');return {result:{ok:true as const,command:'LOAD_GET' as const,complete:true,elapsed_ms:1,attempts:1,failures:[],record_count:1,records:parseResponse([line],{command:'LOAD_GET',fields:{LOAD_ID:'L1'}})},pricing:{listedCents:100000,maxCents:120000}};};
  const r=await getNegotiableLoad('a'.repeat(64),'L1',undefined,lookup);
  assert.deepEqual(events,['status','authorize_load','tcp','save_loads','quote']);
  assert.ok(!JSON.stringify(r).includes('120000'));assert.ok(!JSON.stringify(r).includes('max_cents'));
  gate=false;events.length=0;await assert.rejects(()=>getNegotiableLoad('a'.repeat(64),'L1',undefined,lookup),/OTP_REQUIRED/);assert.ok(!events.includes('tcp'));
});

test('negotiation tool rejects forged ceilings, invalid amounts, invented offer IDs and accept amounts before Twin',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('should not call');});
  const base={load_id:'L1',offer_id:'11111111-1111-4111-8111-111111111111',response:'counter',amount:1000};
  for(const patch of [{max_rate:9999},{amount:0},{amount:1.001},{amount:undefined},{offer_id:'invented'},{response:'accept'},{response:'reject'}]) {
    await assert.rejects(()=>executeTool('negotiate_offer',{...base,...patch},'a'.repeat(64)));
  }
  assert.equal(calls,0);
});


test('negotiation stays unavailable until its migration-backed feature is activated',async t=>{
  const old=process.env.NEGOTIATION_ENABLED;delete process.env.NEGOTIATION_ENABLED;
  t.after(()=>{if(old===undefined)delete process.env.NEGOTIATION_ENABLED;else process.env.NEGOTIATION_ENABLED=old;});
  t.mock.method(globalThis,'fetch',async()=>{throw Error('No database access before activation');});
  await assert.rejects(()=>executeTool('negotiate_offer',{load_id:'L1',offer_id:'11111111-1111-4111-8111-111111111111',response:'accept'},'a'.repeat(64)),/NEGOTIATION_NOT_READY/);
});

test('counter then acceptance explicitly clears the previous amount without relaxing numeric acceptance validation', async t => {
  const values = { NEGOTIATION_ENABLED: 'true', TWIN_GATEWAY: 'https://twin.example.invalid', TWIN_ORG_ID: 'test' };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const first = '11111111-1111-4111-8111-111111111111', next = '22222222-2222-4222-8222-222222222222';
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const b = JSON.parse(String(init.body)); requests.push(b);
    return Response.json({ ok: true, negotiation: { status: b.p_action === 'accept' ? 'agreed' : 'offered',
      load_id: 'L1', offer_id: next, offered_rate: 3496.56, agreed_rate: b.p_action === 'accept' ? 3496.56 : null,
      counter_rounds: 1, rounds_remaining: 2, booking_confirmed: false } });
  });
  await executeTool('negotiate_offer', { load_id: 'L1', offer_id: first, response: 'counter', amount: 6856 }, 'a'.repeat(64));
  const accepted = await executeTool('negotiate_offer', { load_id: 'L1', offer_id: next, response: 'accept', amount: null }, 'a'.repeat(64));
  assert.equal((accepted.negotiation as { status: string }).status, 'agreed');
  assert.deepEqual(requests.map(r => [r.p_action, r.p_offer_id, r.p_amount_cents]), [['counter', first, 685600], ['accept', next, null]]);
  for (const response of ['accept', 'reject']) await assert.rejects(() => executeTool('negotiate_offer', { load_id: 'L1', offer_id: next, response, amount: 6856 }, 'a'.repeat(64)), /INVALID_OFFER/);
  await assert.rejects(() => executeTool('negotiate_offer', { load_id: 'L1', offer_id: next, response: 'counter', amount: null }, 'a'.repeat(64)), /INVALID_OFFER/);
  assert.equal(requests.length, 2);
  assert.equal(toolParameters('negotiate_offer').find(p => p.name === 'amount')?.required, true);
});

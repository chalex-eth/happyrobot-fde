import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp } from '../src/mcp-http';
import { createMcpProxy } from '../scripts/mcp-proxy.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function configure(t: TestContext) {
  const values = { MCP_AUTH_TOKEN: 'mcp-test-only', TWIN_GATEWAY: 'https://twin.example.invalid', TWIN_ORG_ID: 'test' };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k,v] of Object.entries(old)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
}
async function connect(t: TestContext, run?: string) {
  const client = new Client({ name: 'acceptance-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    requestInit: { headers: { authorization: 'Bearer mcp-test-only', ...(run ? { 'x-happyrobot-run-id': run } : {}) } },
    fetch: async (input, init) => handleMcp(new Request(input, init)),
  });
  await client.connect(transport); t.after(() => client.close()); return client;
}
const value = (result: Record<string, unknown>) => JSON.parse((result.content as {text:string}[])[0].text);

test('real MCP client initializes and discovers seven strict schemas without a call binding', async t => {
  configure(t);
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['verify_carrier','create_otp','verify_otp','search_loads','get_load','negotiate_offer','finalize_call']);
  for(const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.ok(!JSON.stringify(tool.inputSchema).includes('run_id'));
  }
  const result = await client.callTool({ name: 'verify_otp', arguments: { code:'001234' } });
  assert.equal(result.isError,true); assert.equal(value(result).error,'VOICE_BINDING_REQUIRED');
});

test('HTTP authentication, origin, size and malformed input fail closed', async t => {
  configure(t);
  const req = (body: string, headers: Record<string,string>={}) => new Request('http://localhost/api/mcp', {
    method:'POST', headers:{ 'content-type':'application/json', ...headers }, body,
  });
  assert.equal((await handleMcp(req('{}'))).status,401);
  assert.equal((await handleMcp(new Request('http://localhost/api/mcp',{headers:{authorization:'Bearer mcp-test-only'}}))).status,405);
  assert.equal((await handleMcp(req('{}',{authorization:'Bearer wrong'}))).status,401);
  assert.equal((await handleMcp(req('{}',{authorization:'Bearer mcp-test-only',origin:'https://evil.example'}))).status,403);
  assert.equal((await handleMcp(req('{',{authorization:'Bearer mcp-test-only'}))).status,400);
  assert.equal((await handleMcp(req(' '.repeat(17000),{authorization:'Bearer mcp-test-only'}))).status,413);
});

test('tool schemas reject forged identity and numeric OTPs before service calls', async t => {
  configure(t); let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{ calls++; throw Error('must not call Twin'); });
  const client = await connect(t,id);
  for(const args of [{code:1234},{code:'001234',call_id:id},{code:'001234',verified:true}]) {
    assert.equal((await client.callTool({name:'verify_otp',arguments:args})).isError,true);
  }
  assert.equal(calls,0);
});

test('bound tool requests resolve Twin identity and cannot search before OTP', async t => {
  configure(t); let gate=0;
  t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(String(url).endsWith('poc_resolve_voice')) {
      assert.equal(body.p_run_id,id);return Response.json({ok:true,sessionHash:'a'.repeat(64)});
    }
    assert.equal(body.p_session_hash,'a'.repeat(64));assert.equal(body.p_action,'authorize_load');gate++;
    return Response.json({ok:false,error:'OTP_REQUIRED'});
  });
  const client = await connect(t,id);
  const result = await client.callTool({name:'search_loads',arguments:{origin_state:'TX'}});
  assert.equal(value(result).error,'OTP_REQUIRED');assert.equal(gate,1);
  assert.ok(!JSON.stringify(result).includes('a'.repeat(64)));
});

test('unknown runs and raw dependency exceptions do not leak internal details', async t=>{
  configure(t); const client=await connect(t,id);
  let unavailable=false;
  t.mock.method(globalThis,'fetch',async()=>{
    if(unavailable) throw Error('secret upstream token');
    return Response.json({ok:false,error:'VOICE_BINDING_REQUIRED'});
  });
  assert.equal(value(await client.callTool({name:'get_load',arguments:{load_id:'LD00001'}})).error,'VOICE_BINDING_REQUIRED');
  unavailable=true;
  const result=await client.callTool({name:'verify_carrier',arguments:{mc_number:'1515'}});
  assert.equal(value(result).error,'TWIN_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes('secret'));
});

test('MCP-only proxy cannot publish operator routes, assets or alternate paths', async t => {
  const server=createMcpProxy('http://127.0.0.1:1/api/mcp');
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  for(const path of ['/','/api/local/calls','/api/tms','/_next/test','/api/mcp?path=/api/local/calls','/api/mcp/']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,404);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/mcp`,{method:'PUT'})).status,405);
});

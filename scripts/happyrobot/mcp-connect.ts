import { HappyRobotClient, ApiError } from '@happyrobot-ai/sdk';
import { readFile } from 'node:fs/promises';
import { toolSpecs, type ToolName } from '../../src/mcp-tools';
import { mcpServerName, paragraph, variable, toolParameters, prompt, loadFormattingRule } from './workflow-spec';
import { validateLocalWiring } from './local-wiring';

type Node = { id: string; persistent_id?: string; type: string; name?: string; parent_id?: string;
  configuration?: Record<string, unknown>; function?: Record<string, unknown>; event_id?: string };
const arg = (key: string) => process.argv[process.argv.indexOf(key) + 1];
const mode = process.argv[2] ?? 'dry-run';
const need = (key: string) => { const value = process.env[key]; if (!value) throw Error(`Missing ${key}`); return value; };

async function main() {
  if (mode === 'dry-run') {
    console.log(JSON.stringify({ tools: Object.keys(toolSpecs), runtime_header: 'x-happyrobot-run-id ← Current > Run ID',
      environment: 'development', note: 'Preserve voice/model. Sync edits an explicit draft only; publish is separate.', prompt }, null, 2));
    return;
  }
  if (!['connect','fork','sync','inspect','review-results','publish'].includes(mode)) throw Error('Unknown command');
  if (need('HAPPYROBOT_ENVIRONMENT') !== 'development') throw Error('This local connector is development-only');
  const client = new HappyRobotClient({ apiKey: need('HAPPYROBOT_API_KEY'), cluster: 'us', maxRetries: 0, timeout: 30_000 });
  const workflowId = need('HAPPYROBOT_WORKFLOW_ID');
  if (mode === 'connect') {
    const url = new URL(need('MCP_PUBLIC_URL'));
    if (url.protocol !== 'https:' || url.pathname !== '/api/mcp' || url.search || url.username || url.password) throw Error('MCP_PUBLIC_URL must be HTTPS and end in /api/mcp');
    const servers = await client.mcp.list();
    const sameName = servers.data.filter((s: {server_name:string}) => s.server_name === mcpServerName);
    if (sameName.length > 1) throw Error('Multiple matching MCP connections; select one explicitly in HappyRobot');
    let server = sameName[0];
    if (server && (server.server_url !== url.href || server.auth_type !== 'bearer')) throw Error('Existing connection has another URL/auth type; update its credential in HappyRobot before retrying');
    if (!server) server = await client.mcp.create({ server_name: mcpServerName, title: mcpServerName,
      server_url: url.href, development_server_url: url.href, auth_type: 'bearer',
      auth_token: need('MCP_AUTH_TOKEN'), development_auth_token: need('MCP_AUTH_TOKEN') });
    const refreshed = await client.mcp.refresh(server.id);
    const discovered = refreshed.tools.map((t: {name:string}) => t.name).sort();
    if (JSON.stringify(discovered) !== JSON.stringify(Object.keys(toolSpecs).sort())) throw Error('Remote discovery did not return the expected tool set');
    console.log(JSON.stringify({ credential_id: server.id, tools: discovered, discovered_by: 'HappyRobot' }));
    return;
  }
  const versionId = arg('--version');
  if (!process.argv.includes('--version') || !versionId) throw Error('Provide an explicit --version ID');
  const versions = await client.workflows.listVersions(workflowId);
  const version = versions.data.find((v: {id:string}) => v.id === versionId);
  if (!version) throw Error('Version is not in the configured workflow');
  if (mode === 'fork') {
    const forked = await client.versions.fork(versionId);
    console.log(JSON.stringify(forked)); return;
  }
  if (mode === 'publish') {
    const replacement = process.argv.includes('--replace') ? arg('--replace') : undefined;
    if (replacement && !versions.data.some((v: {id:string})=>v.id===replacement)) throw Error('Replacement is outside this workflow');
    const result = await client.versions.publish(versionId, { environment: 'development', ...(replacement ? {unpublish_version_id:replacement} : {}) });
    console.log(JSON.stringify({ version_id:result.id,live:result.is_live,environment:result.environment,
      missing_variable_count: result.missing_variables?.length ?? 0, test_error_count: result.test_errors?.length ?? 0 })); return;
  }
  const nodes = (await client.nodes.list(versionId)).data as Node[];
  if (mode === 'review-results') {
    let previews: Record<string, Record<string, unknown>> | undefined;
    if (process.argv.includes('--whole-result')) {
      if (process.argv.includes('--previews')) throw Error('Choose --whole-result or --previews');
      if (version.is_published || version.is_live) throw Error('Result visibility must be configured on a draft');
      // Empty structural metadata allows the complete variable-shaped result to
      // be selected. These placeholders are never evidence of a tool execution.
      previews = Object.fromEntries(Object.keys(toolSpecs).map(name => [name, { result: {}, is_error: false }]));
    }
    if (process.argv.includes('--previews')) {
      if (version.is_published || version.is_live) throw Error('Result previews can only be updated on a draft');
      previews = JSON.parse(await readFile(arg('--previews'),'utf8'));
      if (/"(?:code|sessionHash|verifier|otp_digest|MAX_BUY)"/.test(JSON.stringify(previews))) throw Error('Unsafe result preview fields');
      const emptyOnly=(value:unknown):boolean=>value===null || value==='' || value===0 || typeof value==='boolean'
        || value==='SCHEMA_PREVIEW_ONLY' || (typeof value==='object' && Object.values(value).every(emptyOnly));
      if(!emptyOnly(previews)) throw Error('Result previews must contain empty schema placeholders only');
    }
    // Documented API not yet wrapped by SDK 0.1.45. Inspect acknowledges result
    // visibility; it does not synthesize outputs or execute business actions.
    for (const node of nodes.filter(n=>n.type==='tool' && n.name && n.name in toolSpecs)) {
      if (previews) {
        const action=nodes.find(n=>n.type==='action' && n.parent_id===node.id);
        if (!action || !previews[node.name!]) throw Error('Missing schema result preview');
        await client.nodes.setCustomOutput(versionId,action.id,previews[node.name!]);
      }
      const response=await fetch(`https://platform.happyrobot.ai/api/v2/versions/${versionId}/tools/${node.id}/tool-call-result/inspect`,{
        method:'POST',headers:{Authorization:`Bearer ${need('HAPPYROBOT_API_KEY')}`},signal:AbortSignal.timeout(15_000),redirect:'error',
      });
      if(!response.ok) throw Error(`Result inspection failed (HTTP ${response.status})`);
      let result=await response.json();
      if (previews) for (const branch of result.data.nodes) {
        const visibility=await fetch(`https://platform.happyrobot.ai/api/v2/versions/${versionId}/tools/${node.id}/tool-call-result/visibility`,{
          method:'PUT',headers:{Authorization:`Bearer ${need('HAPPYROBOT_API_KEY')}`,'Content-Type':'application/json'},
          body:JSON.stringify({node_id:branch.node_id,exposed_fields:branch.fields.map((f:{path:string})=>f.path)}),
          signal:AbortSignal.timeout(15_000),redirect:'error',
        });
        if(!visibility.ok) throw Error(`Result visibility failed (HTTP ${visibility.status})`);
        result=await visibility.json();
        if(result.data.nodes.some((n:{fields:{exposed:boolean}[]})=>n.fields.some(f=>!f.exposed))) throw Error('Result fields remain hidden');
        if (process.argv.includes('--whole-result') && result.data.nodes.some((n:{fields:{path:string;exposed:boolean}[]})=>
          !n.fields.some(f=>f.path==='result' && f.exposed))) throw Error('Complete MCP result is not exposed');
      }
      console.log(JSON.stringify({tool:node.name,ack:result.data.ack_state,untested:result.data.has_untested_nodes,
        outputs:result.data.nodes.map((n:{state:string;fields:unknown})=>({state:n.state,fields:n.fields}))}));
    }
    return;
  }
  if (mode === 'inspect') {
    console.log(JSON.stringify(nodes.map(n=>({id:n.id,name:n.name,type:n.type,parent_id:n.parent_id,
      tool:n.configuration?.tool_name, dynamic_headers:n.configuration?.dynamic_headers})),null,2)); return;
  }
  if (version.is_published || version.is_live) throw Error('Fork the published version first');
  const prompts = nodes.filter(n=>n.type==='prompt' && n.name==='Carrier sales conversation');
  if (prompts.length !== 1) throw Error('Expected one Carrier sales conversation prompt');
  const promptNode = prompts[0];
  const available = await client.nodes.getAvailableVars(versionId,promptNode.id);
  const current = available.data.find((group: {id:string}) => group.id === 'current');
  if (!current?.variables?.some((v:{id:string})=>v.id==='run_id')) throw Error('Current Run ID variable unavailable');
  const connections = (await client.mcp.list()).data.filter((s:{server_name:string})=>s.server_name===mcpServerName);
  if (connections.length!==1) throw Error('Run connect successfully first');
  const credentialId=connections[0].id;
  const integrations=await client.integrations.list({search:'MCP',include_events:'true',include_config_schema:'true'});
  const integration=integrations.data.find((i:{name:string})=>i.name==='MCP Server');
  const event=integration?.events?.find((e:{name:string})=>e.name==='MCP Call');
  if(!integration?.id || !event?.id) throw Error('MCP Call integration unavailable');
  for(const [index,name] of (Object.keys(toolSpecs) as ToolName[]).entries()) {
    let node=nodes.find(n=>n.type==='tool' && n.name===name && n.parent_id===promptNode.id);
    if(!node) node=(await client.nodes.addBatch(versionId,{nodes:[{type:'tool',name,parent_node_id:promptNode.id,sort_index:index,configuration:{}}]})).data[0] as Node;
    if(!node?.id) throw Error('Tool node creation failed');
    await client.nodes.update(versionId,node.id,{type:'tool',name,parent_id:promptNode.id,sort_index:index,
      function:{is_mcp:true,message:{type:'ai',description:paragraph('Use one short natural sentence while checking. Do not repeat OTP digits, mention internal tools or claim success before the result.')},
        parameters:toolParameters(name),description:paragraph(toolSpecs[name].description),
        mcp_tool_name:name,mcp_server_credential_id:credentialId}});
    const configuration={credentialId,credential:{type:'static',static:{id:credentialId,name:mcpServerName}},tool_name:name,
      tool_args:toolParameters(name).map(p=>({key:p.name,value:variable(node!.persistent_id ?? node!.id,p.name)})),
      dynamic_headers:[{key:'x-happyrobot-run-id',value:variable('current','run_id')}]};
    const existing=nodes.find(n=>n.type==='action' && n.parent_id===node!.id && n.event_id===event.id);
    const body={type:'action',name:'MCP Call',sort_index:0,event_id:event.id,integration_id:integration.id,configuration};
    if(existing) await client.nodes.update(versionId,existing.id,{...body,parent_id:node.id});
    else await client.nodes.addBatch(versionId,{nodes:[{...body,parent_node_id:node.id}]});
  }
  await client.nodes.update(versionId,promptNode.id,{type:'prompt',prompt_md:prompt});
  const stored = (await client.nodes.get(versionId,promptNode.id)).data;
  if (stored.prompt_md !== prompt) {
    throw Error('Updated prompt was not stored; draft remains unpublished');
  }
  // Keep the existing date-format criterion aligned with spoken discovery.
  // YYYYMMDD belongs in tool arguments, not in the caller-facing pitch.
  const criteriaResponse = await fetch(`https://platform.happyrobot.ai/api/v2/nodes/${promptNode.id}/northstars`, {
    headers: { Authorization: `Bearer ${need('HAPPYROBOT_API_KEY')}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!criteriaResponse.ok) throw Error('Could not inspect load-format criterion');
  const criteria = (await criteriaResponse.json()).data as { id: string; name: string }[];
  const formatting = criteria.filter(c => c.name === 'Standard Load Formatting');
  if (formatting.length !== 1) throw Error('Expected one existing Standard Load Formatting criterion');
  const updated = await fetch(`https://platform.happyrobot.ai/api/v2/northstars/${formatting[0].id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${need('HAPPYROBOT_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: paragraph(loadFormattingRule) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!updated.ok) throw Error('Could not update load-format criterion');
  const summaries = (await client.nodes.list(versionId)).data as Node[];
  const readback = await Promise.all(summaries.map(n => client.nodes.get(versionId, n.id).then(r => r.data)));
  validateLocalWiring(readback, credentialId);
  console.log(JSON.stringify({version_id:versionId,configured_tools:Object.keys(toolSpecs),published:false}));
}

main().catch(error=>{
  // API errors may include credentials or tool arguments. Never dump response bodies.
  console.error(error instanceof ApiError ? `HappyRobot request failed (HTTP ${error.status}); inspect workspace status before retrying mutations.`
    : error instanceof Error && !error.stack?.includes('node_modules') ? error.message : 'MCP setup failed.');
  process.exitCode=1;
});

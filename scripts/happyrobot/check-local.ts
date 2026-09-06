import { HappyRobotClient, ApiError } from '@happyrobot-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolSpecs } from '../../apps/api/src/transport/mcp/tools.js';
import { validateLocalWiring, type WiringNode } from './local-wiring.js';

type Connection = { id: string; server_name: string; server_url: string; development_server_url?: string; auth_type: string };
type Version = { id: string; is_live: boolean; environment: string; version_number: number };

function need(key: string) { const value = process.env[key]; if (!value) throw Error(`Missing ${key}.`); return value; }
async function main() {
  if (need('HAPPYROBOT_ENVIRONMENT') !== 'development') throw Error('Only the development workflow can be checked.');
  const publicUrl = need('MCP_PUBLIC_URL');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/api/mcp' || url.search || url.username || url.password || url.hash) throw Error('MCP_PUBLIC_URL must be HTTPS with the exact /api/mcp path.');
  const expected = Object.keys(toolSpecs).sort();
  // Discovery is read-only; no caller session, OTP, negotiation or booking is created.
  let connected = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const mcp = new Client({ name: 'carrier-sales-startup', version: '1' });
    try {
      const tunnelResponse = await fetch(`${process.env.NGROK_API_URL || 'http://127.0.0.1:4040'}/api/tunnels`, { signal: AbortSignal.timeout(3_000) });
      const tunnels = (await tunnelResponse.json()).tunnels as { public_url: string; config: { addr: string } }[];
      if (!tunnels.some(t => t.public_url === url.origin && t.config.addr === 'http://mcp-proxy:3002')) throw Error('Local tunnel mismatch');
      await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: {
        headers: { authorization: `Bearer ${need('MCP_AUTH_TOKEN')}` }, signal: AbortSignal.timeout(10_000),
      } }));
      const discovered = (await mcp.listTools()).tools.map(t => t.name).sort();
      if (JSON.stringify(discovered) !== JSON.stringify(expected)) throw Error('Tool set mismatch');
      connected = true;
    } catch { /* Startup tunnel provisioning can take a few seconds. */ }
    finally { await mcp.close().catch(() => {}); }
    if (connected) break;
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (!connected) throw Error('Tunnel/MCP discovery failed. Check ngrok, its local API, MCP_PUBLIC_URL and the matching bearer token.');
  const client = new HappyRobotClient({ apiKey: need('HAPPYROBOT_API_KEY'), cluster: 'us', maxRetries: 0, timeout: 20_000 });
  const connections = ((await client.mcp.list({ page_size: 100 })).data as Connection[]).filter(s => s.server_name === need('HAPPYROBOT_MCP_SERVER_NAME'));
  if (connections.length !== 1) throw Error('Expected one saved HappyRobot MCP connection matching HAPPYROBOT_MCP_SERVER_NAME.');
  const connection = connections[0];
  if ((connection.development_server_url || connection.server_url) !== publicUrl || connection.auth_type !== 'bearer') {
    throw Error('HappyRobot development MCP URL/auth does not match local configuration. Changing .env.local alone does not update HappyRobot.');
  }
  const versions = (await client.workflows.listVersions(need('HAPPYROBOT_WORKFLOW_ID'))).data as Version[];
  const requested = process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : undefined;
  if (process.argv.includes('--version') && !requested) throw Error('Provide the draft version ID after --version.');
  const selected = requested ? versions.filter(v => v.id === requested) : versions.filter(v => v.is_live && v.environment === 'development');
  if (selected.length !== 1) throw Error('Expected one live development version (or an explicit draft in this workflow).');
  const version = selected[0];
  const summaries = (await client.nodes.list(version.id)).data as WiringNode[];
  const nodes = await Promise.all(summaries.map(n => client.nodes.get(version.id, n.id).then(r => r.data)));
  validateLocalWiring(nodes, connection.id);
  console.log(JSON.stringify({ checked: true, scope: 'MCP discovery and workflow configuration; no voice conversation',
    workflow_id: need('HAPPYROBOT_WORKFLOW_ID'), version_id: version.id, version_number: version.version_number,
    live: version.is_live, credential_id: connection.id, mcp_url: publicUrl, tools: expected }));
}
main().catch(error => {
  console.error(error instanceof ApiError ? `HappyRobot check failed (HTTP ${error.status}).` : error instanceof Error ? error.message : 'Local check failed.');
  process.exitCode = 1;
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSpecs, type ToolName } from '../src/mcp-tools';
import { toolParameters, variable } from '../scripts/happyrobot/workflow-spec';
import { validateLocalWiring, type WiringNode } from '../scripts/happyrobot/local-wiring';

function fixture(): WiringNode[] {
  return [{ id: 'prompt', type: 'prompt', name: 'Carrier sales conversation' },
    ...Object.keys(toolSpecs).flatMap((name, index) => {
      const id = `forked-${index}`, stable = `stable-${index}`;
      return [{ id, persistent_id: stable, type: 'tool', parent_id: 'prompt', name,
        function: { parameters: toolParameters(name as ToolName), is_mcp: true, mcp_tool_name: name, mcp_server_credential_id: 'connection' } },
      { id: `action-${index}`, type: 'action', parent_id: id, configuration: {
        tool_name: name, credentialId: 'connection', credential: { type: 'static', static: { id: 'connection' } },
        dynamic_headers: [{ key: 'x-happyrobot-run-id', value: variable('current', 'run_id') }],
        tool_args: toolParameters(name as ToolName).map(p => ({ key: p.name, value: variable(stable, p.name) })),
      } }];
    })];
}
test('startup accepts normal wiring and rejects the isolated eval header', () => {
  const nodes = fixture();
  assert.doesNotThrow(() => validateLocalWiring(nodes, 'connection'));
  nodes.find(n => n.type === 'action')!.configuration!.dynamic_headers = [{ key: 'x-adversarial-session', value: 'controller' }];
  assert.throws(() => validateLocalWiring(nodes, 'connection'), /normal calls need/);
});
test('startup rejects stale fork references even when every tool is present', () => {
  const nodes = fixture();
  const search = nodes.find(n => n.configuration?.tool_name === 'search_loads')!;
  search.configuration!.tool_args[0].value = variable('old-fork-id', 'equipment');
  assert.throws(() => validateLocalWiring(nodes, 'connection'), /stale or missing argument/);
});
test('startup rejects another credential on either the agent tool or action', () => {
  for (const kind of ['tool', 'action']) {
    const nodes = fixture();
    const node = nodes.find(n => n.type === kind)!;
    if (kind === 'tool') node.function!.mcp_server_credential_id = 'old';
    else node.configuration!.credential.static.id = 'old';
    assert.throws(() => validateLocalWiring(nodes, 'connection'), /another MCP connection/);
  }
});

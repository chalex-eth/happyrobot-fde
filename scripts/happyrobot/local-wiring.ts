import { toolSpecs, type ToolName } from '../../src/mcp-tools';
import { toolParameters } from './workflow-spec';

export type WiringNode = {
  id: string; persistent_id?: string; type: string; name?: string; parent_id?: string;
  configuration?: Record<string, any>; function?: Record<string, any>;
};
function requireCheck(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function refs(value: unknown): { group_id: string; variable_id: string }[] {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (object.type === 'variable') return [{ group_id: String(object.group_id), variable_id: String(object.variable_id) }];
  return Object.values(object).flatMap(refs);
}
export function validateLocalWiring(nodes: WiringNode[], credentialId: string) {
  const prompts = nodes.filter(n => n.type === 'prompt' && n.name === 'Carrier sales conversation');
  requireCheck(prompts.length === 1, 'Expected one Carrier sales conversation prompt.');
  const tools = nodes.filter(n => n.type === 'tool' && n.parent_id === prompts[0].id);
  requireCheck(tools.length === Object.keys(toolSpecs).length, `Expected exactly ${Object.keys(toolSpecs).length} agent tools.`);
  for (const name of Object.keys(toolSpecs) as ToolName[]) {
    const matching = tools.filter(n => n.name === name);
    requireCheck(matching.length === 1, `Missing or duplicate tool: ${name}.`);
    const tool = matching[0];
    requireCheck(tool.function?.is_mcp === true && tool.function?.mcp_tool_name === name
      && tool.function?.mcp_server_credential_id === credentialId, `${name}: agent tool uses another MCP connection.`);
    const actions = nodes.filter(n => n.parent_id === tool.id && n.type === 'action');
    requireCheck(actions.length === 1, `${name}: expected one MCP Call action.`);
    const config = actions[0].configuration;
    requireCheck(config?.tool_name === name && config?.credentialId === credentialId
      && config?.credential?.static?.id === credentialId, `${name}: action uses another MCP connection.`);
    const headers = config.dynamic_headers;
    requireCheck(Array.isArray(headers) && headers.length === 1 && headers[0].key === 'x-happyrobot-run-id',
      `${name}: normal calls need x-happyrobot-run-id, not an adversarial test session.`);
    const runRefs = refs(headers[0].value);
    requireCheck(runRefs.length === 1 && runRefs[0].group_id === 'current' && runRefs[0].variable_id === 'run_id',
      `${name}: run header must reference Current > Run ID.`);
    const parameters = toolParameters(name);
    requireCheck(Array.isArray(config.tool_args) && config.tool_args.length === parameters.length, `${name}: incomplete argument mappings.`);
    for (const parameter of parameters) {
      const mapped = config.tool_args.filter((arg: { key: string }) => arg.key === parameter.name);
      const references = mapped.length === 1 ? refs(mapped[0].value) : [];
      requireCheck(references.length === 1 && references[0].group_id === (tool.persistent_id ?? tool.id)
        && references[0].variable_id === parameter.name, `${name}.${parameter.name}: stale or missing argument reference.`);
    }
  }
}

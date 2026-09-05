import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { authenticateMcp } from './mcp-auth';
import { readJson, SessionError } from './call-session';
import { FmcsaError } from './fmcsa';
import { TmsError } from './tms';
import { resolveAgentSession } from './voice-session';
import { executeTool, toolSpecs, type ToolName } from './mcp-tools';

const safeError = (error: unknown) => {
  if (error instanceof SessionError || error instanceof FmcsaError || error instanceof TmsError) return error.code;
  if (error instanceof z.ZodError) return 'INVALID_TOOL_ARGUMENTS';
  return 'TOOL_UNAVAILABLE';
};

export type McpAdapter = {
  authenticate: (authorization: string | null) => void;
  resolve: (request: Request) => Promise<{ hash: string; challengeId?: string }>;
  execute?: typeof executeTool;
  observe?: (name: ToolName, result: Record<string, unknown>) => Promise<void>;
};
const voiceAdapter: McpAdapter = {
  authenticate: authenticateMcp,
  resolve: async request => ({ hash: await resolveAgentSession(request.headers.get('authorization'), request.headers.get('x-happyrobot-run-id')) }),
};

// Adapters are supplied by server code only, never by request body/LLM fields.
export async function handleMcp(request: Request, adapter: McpAdapter = voiceAdapter) {
  const requestId = randomUUID();
  let server: McpServer | undefined;
  try {
    adapter.authenticate(request.headers.get('authorization'));
    // Server-to-server only. No cross-origin browser access or CORS credentials.
    if (request.headers.has('origin')) throw new SessionError('ORIGIN_NOT_ALLOWED', 403);
    // No server-initiated events or transport sessions in this adapter. A 405
    // prevents clients from repeatedly reconnecting to an immediately closed SSE.
    if (request.method !== 'POST') return new Response(null, { status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
    const parsedBody = request.method === 'POST' ? await readJson(request, 16_384) : undefined;
    server = new McpServer({ name: 'carrier-sales', version: '0.1.0' });
    for (const name of Object.keys(toolSpecs) as ToolName[]) {
      const spec = toolSpecs[name];
      server.registerTool(name, { description: spec.description, inputSchema: spec.schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: name === 'finalize_call', openWorldHint: true } },
      async (args: unknown) => {
        const started = Date.now();
        let result: Record<string, unknown>;
        try {
          const context = await adapter.resolve(request);
          // JSON-RPC IDs correlate responses and may restart on each connection.
          // Each HTTP invocation owns a fresh receipt; Twin recovery within that
          // invocation continues using this same operation ID.
          result = await (adapter.execute ?? executeTool)(name, args, context.hash, AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]), requestId, context.challengeId);
        } catch (error) { result = { ok: false, error: safeError(error), retryable:
          error instanceof FmcsaError || error instanceof TmsError ? error.retryable : false }; }
        await adapter.observe?.(name, result);
        // A completed OTP check can reject the supplied code. Return that
        // business outcome as data; it is not a failed MCP execution.
        const isError = result.ok === false && !['OTP_INVALID', 'OTP_FAILED'].includes(String(result.error));
        // Never log arguments, headers, upstream exceptions, OTP or full outputs.
        console.info(JSON.stringify({ event: 'mcp_tool', tool: name, requestId, ok: result.ok !== false,
          runtime_run_id_valid: /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(request.headers.get('x-happyrobot-run-id') ?? ''),
          error: result.ok === false ? result.error : undefined, elapsed_ms: Date.now() - started }));
        return { isError, content: [{ type: 'text' as const, text: JSON.stringify({ ...result, request_id: requestId }) }] };
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('x-request-id', requestId);
    return response;
  } catch (error) {
    const status = error instanceof SessionError ? error.status : 500;
    return Response.json({ error: safeError(error), request_id: requestId }, { status,
      headers: { 'Cache-Control': 'no-store', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) } });
  } finally { await server?.close(); }
}

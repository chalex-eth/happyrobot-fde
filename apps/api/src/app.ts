import * as localCalls from './transport/http/routes/local/calls/route.js';
import * as localCarriers from './transport/http/routes/local/carriers/route.js';
import * as localOtp from './transport/http/routes/local/otp/route.js';
import * as localLoads from './transport/http/routes/local/tms/route.js';
import * as voiceDisconnected from './transport/http/routes/local/voice/disconnected/route.js';
import * as voiceEnd from './transport/http/routes/local/voice/end/route.js';
import * as voiceStart from './transport/http/routes/local/voice/route.js';
import * as adversarialMcp from './transport/http/routes/mcp/adversarial/route.js';
import * as mcp from './transport/http/routes/mcp/route.js';
import * as operatorCalls from './transport/http/routes/operator/calls/route.js';
import * as operatorInventory from './transport/http/routes/operator/inventory/route.js';
import * as operatorReview from './transport/http/routes/operator/review/route.js';
import * as operatorAuth from './transport/http/routes/operator/auth/route.js';
import { checkHostedDemoConfiguration } from './transport/http/middleware/hosted-demo.js';
import { SessionError } from './errors.js';
type Handler = (request: Request) => Promise<Response>;
const routes: Record<string, Partial<Record<string, Handler>>> = {
  '/api/local/calls': { POST: localCalls.POST },
  '/api/local/carriers': { POST: localCarriers.POST },
  '/api/local/otp': { POST: localOtp.POST },
  '/api/local/tms': { POST: localLoads.POST },
  '/api/local/voice/disconnected': { POST: voiceDisconnected.POST },
  '/api/local/voice/end': { POST: voiceEnd.POST },
  '/api/local/voice': { POST: voiceStart.POST },
  '/api/mcp/adversarial': {
    POST: adversarialMcp.POST,
    GET: adversarialMcp.GET,
    DELETE: adversarialMcp.DELETE,
  },
  '/api/mcp': { POST: mcp.POST, GET: mcp.GET, DELETE: mcp.DELETE },
  '/api/operator/calls': { GET: operatorCalls.GET },
  '/api/operator/inventory': { GET: operatorInventory.GET },
  '/api/operator/review': { POST: operatorReview.POST },
  '/api/operator/auth': {
    POST: operatorAuth.POST,
    GET: operatorAuth.GET,
    DELETE: operatorAuth.DELETE,
  },
};
export async function handleRequest(request: Request): Promise<Response> {
  try {
    checkHostedDemoConfiguration();
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof SessionError ? error.code : 'INVALID_CONFIGURATION' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (path === '/health' && request.method === 'GET') return Response.json({ ok: true });
  const route = routes[path];
  if (!route) return Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const handler = route[request.method];
  if (!handler)
    return new Response(null, { status: 405, headers: { Allow: Object.keys(route).join(', ') } });
  return handler(request);
}

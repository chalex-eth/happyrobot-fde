import { randomUUID } from 'node:crypto';
import { rejectNonLocalRequest } from '../../../../src/local-console';
import { readJson, SessionError, sessionHash } from '../../../../src/call-session';
import { loadsForCall } from '../../../../src/call-services';
import { runTms, TmsError, validateRequest } from '../../../../src/tms';
import { upstreamStatus } from '../../../../src/tms-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request); if (rejected) return rejected;
  const requestId = randomUUID(); const started = Date.now();
  const respond = (body: object, status: number) => {
    console.info(JSON.stringify({ event: 'local_tms_request', requestId, status, elapsed_ms: Date.now() - started }));
    return Response.json({ ...body, requestId }, {
      status, headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
    });
  };
  if (!process.env.LOCAL_API_TOKEN) return respond({ ok: false, error: 'API_AUTH_NOT_CONFIGURED' }, 503);
  try {
    const input = validateRequest(await readJson(request, 4096));
    // Connection diagnostics remain local-only and are never a carrier tool.
    const result = input.command === 'DEBUG_ECHO' ? await runTms(input, request.signal)
      : await loadsForCall(sessionHash(request), input, request.signal);
    return respond(result, result.ok ? 200 : upstreamStatus(result.error));
  } catch (error) {
    const fault = error instanceof SessionError ? error : error instanceof TmsError ? new SessionError(error.code, 400) : new SessionError('INTERNAL_ERROR', 500);
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

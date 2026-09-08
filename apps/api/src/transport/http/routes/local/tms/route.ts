import { randomUUID } from 'node:crypto';
import { rejectNonLocalRequest } from '../../../middleware/local-origin.js';
import { readJson } from '../../../read-json.js';
import { SessionError } from '../../../../../errors.js';
import { sessionHash } from '../../../middleware/session-cookie.js';
import { loadsForCall } from '../../../../../modules/loads/index.js';
import { runTms, TmsError, validateRequest } from '../../../../../integrations/tms/client.js';
import { runtimeConfig } from '../../../../../config/env.js';

const upstreamStatus = (code: string) =>
  code === 'TMS_TIMEOUT'
    ? 504
    : ['TMS_NOT_CONFIGURED', 'CANCELLED'].includes(code)
      ? 503
      : code === 'INTERNAL_ERROR'
        ? 500
        : 502;

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request);
  if (rejected) return rejected;
  const requestId = randomUUID();
  const started = Date.now();
  const respond = (body: object, status: number) => {
    console.info(
      JSON.stringify({
        event: 'local_tms_request',
        requestId,
        status,
        elapsed_ms: Date.now() - started,
      }),
    );
    return Response.json(
      { ...body, requestId },
      {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
      },
    );
  };
  if (!runtimeConfig().local.apiToken)
    return respond({ ok: false, error: 'API_AUTH_NOT_CONFIGURED' }, 503);
  try {
    const input = validateRequest(await readJson(request, 4096));
    // Connection diagnostics remain local-only and are never a carrier tool.
    const result =
      input.command === 'DEBUG_ECHO'
        ? await runTms(input, request.signal)
        : await loadsForCall(sessionHash(request), input, request.signal);
    return respond(result, result.ok ? 200 : upstreamStatus(result.error));
  } catch (error) {
    const fault =
      error instanceof SessionError
        ? error
        : error instanceof TmsError
          ? new SessionError(error.code, 400)
          : new SessionError('INTERNAL_ERROR', 500);
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { runTms, TmsError, validateRequest } from './tms';

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export const upstreamStatus = (code: string) => code === 'TMS_TIMEOUT' ? 504
  : ['TMS_NOT_CONFIGURED', 'CANCELLED'].includes(code) ? 503
  : code === 'INTERNAL_ERROR' ? 500 : 502;

// The transport is injected only to test the HTTP boundary without contacting the TMS.
export async function handleTmsRequest(request: Request, execute: typeof runTms = runTms) {
  const suppliedId = request.headers.get('x-request-id') ?? '';
  const requestId = requestIdPattern.test(suppliedId) ? suppliedId : randomUUID();
  const started = Date.now();
  const json = (value: Record<string, unknown>, status = 200) => {
    console.info(JSON.stringify({ event: 'tms_request', requestId, status, duration_ms: Date.now() - started,
      ...(typeof value.command === 'string' ? { command: value.command } : {}),
      ...(typeof value.error === 'string' ? { code: value.error } : {}),
      ...(typeof value.attempts === 'number' ? { attempts: value.attempts } : {}),
    }));
    return Response.json({ ...value, requestId }, { status, headers: {
      'Cache-Control': 'no-store', 'X-Request-ID': requestId,
    } });
  };
  const fail = (error: string, status: number) => json({ ok: false, error, retryable: false }, status);
  // Retain the existing name so local and deployed configuration use the same secret.
  const token = process.env.LOCAL_API_TOKEN;
  if (!token) return fail('API_AUTH_NOT_CONFIGURED', 503);
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail('UNAUTHORIZED', 401);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return fail('JSON_REQUIRED', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) return fail('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return fail('REQUEST_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
    const input = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const result = await execute(input, request.signal);
    return json(result, result.ok ? 200 : upstreamStatus(result.error));
  } catch (error) {
    if (error instanceof SyntaxError) return fail('INVALID_JSON', 400);
    if (error instanceof TmsError) return fail(error.code, 400);
    return fail('INTERNAL_ERROR', 500);
  } finally {
    reader.releaseLock();
  }
}

import { randomUUID } from 'node:crypto';
import { FmcsaError, normalizeMc } from '../../../../src/fmcsa';
import { rejectNonLocalRequest } from '../../../../src/local-console';
import { readJson, resultStatus, sessionHash, SessionError } from '../../../../src/call-session';

import { verifyCarrierForCall } from '../../../../src/call-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request);
  if (rejected) return rejected;
  const requestId = randomUUID(); const started = Date.now();
  const respond = (data: Record<string, unknown>, status: number) => {
    console.info(JSON.stringify({ event: 'carrier_check', requestId, status, elapsed_ms: Date.now() - started, ...(typeof data.error === 'string' ? { code: data.error } : {}) }));
    return Response.json({ ...data, requestId }, { status, headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId } });
  };
  try {
    const input = await readJson(request);
    if (Object.keys(input).some(key => key !== 'mcNumber')) throw new FmcsaError('INVALID_REQUEST', 400);
    const mc = normalizeMc(input.mcNumber);
    const result = await verifyCarrierForCall(sessionHash(request), mc, request.signal);
    return respond({ ...result, check: result.session?.check, callId: result.session?.callId }, resultStatus(result));
  } catch (error) {
    const fault = error instanceof FmcsaError || error instanceof SessionError ? error : error instanceof SyntaxError ? new FmcsaError('INVALID_JSON', 400) : new FmcsaError('INTERNAL_ERROR', 500);
    const response = respond({ ok: false, error: fault.code, retryable: fault instanceof FmcsaError && fault.retryable }, fault.status);
    return response;
  }
}

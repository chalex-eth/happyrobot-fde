import { trackCall } from '../../../../src/operator';
import { randomUUID } from 'node:crypto';
import { callAction, readJson, resultStatus, sessionCookie, sessionHash, SessionError, startCall } from '../../../../src/call-session';
import { rejectNonLocalRequest } from '../../../../src/local-console';
import { readDemoOtp } from '../../../../src/demo-otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request); if (rejected) return rejected;
  const requestId = randomUUID();
  const respond = (body: object, status = 200) => Response.json({ ...body, requestId }, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
  });
  try {
    const input = await readJson(request);
    if (!['start','status'].includes(String(input.action)) || Object.keys(input).some(k => k !== 'action')) throw new SessionError('INVALID_REQUEST', 400);
    if (input.action === 'status') {
      const hash = sessionHash(request);
      const result = await callAction(hash, 'status');
      const demoOtp = result.ok && result.session ? await readDemoOtp(hash, result.session) : null;
      return respond({ ...result, demoOtp }, resultStatus(result));
    }
    let previous: string | null = null;
    try { previous = sessionHash(request); } catch { /* First browser call. */ }
    const call = await startCall(previous);
    await trackCall(call.hash,'source',{source:'browser_demo'});
    const response = respond({ ok: true, session: call.session });
    response.headers.set('Set-Cookie', sessionCookie(call.token));
    return response;
  } catch (error) {
    const fault = error instanceof SessionError ? error : new SessionError('INTERNAL_ERROR', 500);
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

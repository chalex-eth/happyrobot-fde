import { CallRequestSchema } from '@carrier/contracts/calls';
import { trackCall } from '../../../../../modules/calls/index.js';
import { randomUUID } from 'node:crypto';
import { callAction, startCall } from '../../../../../modules/calls/index.js';
import { readJson } from '../../../read-json.js';
import { resultStatus } from '../../../result-status.js';
import { sessionCookie, sessionHash } from '../../../middleware/session-cookie.js';
import { SessionError } from '../../../../../errors.js';
import { rejectNonLocalRequest } from '../../../middleware/local-origin.js';
import { readDemoOtp } from '../../../../../modules/verification/index.js';

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request);
  if (rejected) return rejected;
  const requestId = randomUUID();
  const respond = (body: object, status = 200) =>
    Response.json(
      { ...body, requestId },
      {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
      },
    );
  try {
    const parsed = CallRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new SessionError('INVALID_REQUEST', 400);
    const input = parsed.data;
    if (input.action === 'status') {
      const hash = sessionHash(request);
      const result = await callAction(hash, 'status');
      const demoOtp = result.ok && result.session ? await readDemoOtp(hash, result.session) : null;
      return respond({ ...result, demoOtp }, resultStatus(result));
    }
    let previous: string | null = null;
    try {
      previous = sessionHash(request);
    } catch {
      /* First browser call. */
    }
    const call = await startCall(previous);
    await trackCall(call.hash, 'source', { source: 'browser_demo' });
    const response = respond({ ok: true, session: call.session });
    response.headers.set('Set-Cookie', sessionCookie(call.token));
    return response;
  } catch (error) {
    const fault = error instanceof SessionError ? error : new SessionError('INTERNAL_ERROR', 500);
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

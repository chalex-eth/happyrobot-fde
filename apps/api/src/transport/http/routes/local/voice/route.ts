import { randomUUID } from 'node:crypto';
import { callAction } from '../../../../../modules/calls/index.js';
import { readJson } from '../../../read-json.js';
import { resultStatus } from '../../../result-status.js';
import { sessionHash } from '../../../middleware/session-cookie.js';
import { SessionError } from '../../../../../errors.js';
import { createVoiceSession } from '../../../../../modules/calls/index.js';
import { rejectNonLocalRequest } from '../../../middleware/local-origin.js';

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
    const input = await readJson(request);
    if (Object.keys(input).some((key) => key !== 'callId') || typeof input.callId !== 'string')
      throw new SessionError('INVALID_REQUEST', 400);
    const hash = sessionHash(request);
    const current = await callAction(hash, 'status');
    if (!current.ok) return respond(current, resultStatus(current));
    if (current.session?.callId !== input.callId) throw new SessionError('CALL_CHANGED', 409);
    return respond(await createVoiceSession(hash));
  } catch (error) {
    const fault = error instanceof SessionError ? error : new SessionError('INTERNAL_ERROR', 500);
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

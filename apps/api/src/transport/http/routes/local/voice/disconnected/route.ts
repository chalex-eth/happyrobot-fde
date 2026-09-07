import { reconcileVoiceSession } from '../../../../../../modules/calls/index.js';
import { readJson } from '../../../../read-json.js';
import { sessionHash } from '../../../../middleware/session-cookie.js';
import { SessionError } from '../../../../../../errors.js';
import { rejectNonLocalRequest } from '../../../../middleware/local-origin.js';
export async function POST(request: Request) {
  const denied = rejectNonLocalRequest(request);
  if (denied) return denied;
  try {
    const hash = sessionHash(request),
      body = await readJson(request);
    if (typeof body.callId !== 'string' || Object.keys(body).some((key) => key !== 'callId'))
      throw new SessionError('INVALID_REQUEST', 400);
    const result = await reconcileVoiceSession(hash, body.callId);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof SessionError ? e.code : 'ACTIVITY_UNAVAILABLE' },
      { status: e instanceof SessionError ? e.status : 503 },
    );
  }
}

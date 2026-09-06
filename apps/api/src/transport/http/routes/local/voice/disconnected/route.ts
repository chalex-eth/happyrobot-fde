import { callAction } from '../../../../../../modules/calls/index.js';
import { readJson } from '../../../../read-json.js';
import { sessionHash } from '../../../../middleware/session-cookie.js';
import { SessionError } from '../../../../../../errors.js';
import { rejectNonLocalRequest } from '../../../../middleware/local-origin.js';
import { trackCall } from '../../../../../../modules/calls/index.js';
export async function POST(request: Request) {
  const denied = rejectNonLocalRequest(request);
  if (denied) return denied;
  try {
    const hash = sessionHash(request),
      body = await readJson(request);
    const current = await callAction(hash, 'status');
    if (!current.ok || current.session?.callId !== body.callId)
      throw new SessionError('CALL_CHANGED', 409);
    await trackCall(hash, 'disconnected');
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof SessionError ? e.code : 'ACTIVITY_UNAVAILABLE' },
      { status: e instanceof SessionError ? e.status : 503 },
    );
  }
}

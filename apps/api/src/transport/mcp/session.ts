import { authenticateMcp } from './auth.js';
import { twinRpc } from '../../db/twin-client.js';
import { SessionError } from '../../errors.js';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
// The workflow maps Current > Run ID into x-happyrobot-run-id. Identity never
// comes from an AI tool argument or a browser-selected run.
export async function resolveAgentSession(
  authorization: string | null,
  runtimeRunId: string | null,
) {
  authenticateMcp(authorization);
  if (!runtimeRunId || !uuid.test(runtimeRunId))
    throw new SessionError('VOICE_BINDING_REQUIRED', 401);
  const result = await twinRpc('poc_resolve_voice', { p_run_id: runtimeRunId });
  if (!result.ok) throw new SessionError('VOICE_BINDING_REQUIRED', 401);
  if (!result.sessionHash || !/^[a-f0-9]{64}$/.test(result.sessionHash))
    throw new SessionError('TWIN_INVALID_RESPONSE');
  return result.sessionHash;
}

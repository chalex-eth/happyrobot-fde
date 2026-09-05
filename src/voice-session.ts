import { authenticateMcp } from './mcp-auth';
import { ApiError, HappyRobotClient } from '@happyrobot-ai/sdk';
import { callAction, resultStatus, SessionError, twinRpc } from './call-session';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function client() {
  const apiKey = process.env.HAPPYROBOT_API_KEY;
  if (!apiKey) throw new SessionError('HAPPYROBOT_NOT_CONFIGURED');
  // Creating a token also creates a run. Never retry an ambiguous mutation.
  return new HappyRobotClient({ apiKey, cluster: 'us', timeout: 10000, maxRetries: 0 });
}

export async function endVoiceSession(hash: string, expectedCallId: string, sdk?: Pick<HappyRobotClient, 'runs'>) {
  if (!uuid.test(expectedCallId)) throw new SessionError('INVALID_REQUEST', 400);
  const current = await callAction(hash, 'status');
  if (!current.ok) throw new SessionError(current.error ?? 'SESSION_REQUIRED', resultStatus(current));
  if (current.session?.callId !== expectedCallId) throw new SessionError('CALL_CHANGED', 409);
  const runId = current.session.voiceRunId;
  if (!runId) return { ok: true };
  try { await (sdk ?? client()).runs.cancel(runId); }
  catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw new SessionError('HAPPYROBOT_END_UNCONFIRMED');
  }
  return { ok: true };
}

export async function createVoiceSession(hash: string, sdk?: Pick<HappyRobotClient, 'voice' | 'runs'>) {
  const workflowId = process.env.HAPPYROBOT_WORKFLOW_ID;
  const environment = process.env.HAPPYROBOT_ENVIRONMENT;
  if (!workflowId || !uuid.test(workflowId) || !['development','staging','production'].includes(environment ?? '')) {
    throw new SessionError('HAPPYROBOT_NOT_CONFIGURED');
  }
  const hr = sdk ?? client();
  const reserved = await callAction(hash, 'voice_reserve');
  if (!reserved.ok) throw new SessionError(reserved.error ?? 'VOICE_ALREADY_STARTED', resultStatus(reserved));
  let runId: string | undefined;
  try {
    const token = await hr.voice.createToken({ workflow_id: workflowId,
      env: environment as 'development' | 'staging' | 'production', ttl_seconds: 3600 });
    runId = token.run_id;
    if (!uuid.test(runId) || !token.token || !token.room_name || new URL(token.url).protocol !== 'wss:') {
      throw new SessionError('HAPPYROBOT_INVALID_RESPONSE');
    }
    // The provider's server response supplies the identity. No model or browser
    // parameter chooses the run binding. Return the WebRTC credential only after
    // Twin commits it; pending calls cannot resolve through the agent adapter.
    const bound = await callAction(hash, 'voice_bind', { p_metadata: { runId } });
    if (!bound.ok) throw new SessionError(bound.error ?? 'VOICE_BINDING_FAILED', resultStatus(bound));
    return { ok: true, session: bound.session, voice: token };
  } catch (error) {
    if (runId && uuid.test(runId)) { try { await hr.runs.cancel(runId); } catch { /* Never expose SDK exceptions. */ } }
    try { await callAction(hash, 'voice_failed'); } catch { /* Reserved state already prevents duplicate runs. */ }
    if (error instanceof SessionError) throw error;
    if (error instanceof ApiError && error.status === 404) throw new SessionError('HAPPYROBOT_WORKFLOW_NOT_LIVE', 409);
    if (error instanceof ApiError && error.status === 401) throw new SessionError('HAPPYROBOT_AUTH_REJECTED');
    throw new SessionError('HAPPYROBOT_VOICE_UNAVAILABLE');
  }
}

// The workflow maps Current > Run ID into x-happyrobot-run-id. Identity never
// comes from an AI tool argument or a browser-selected run.
export async function resolveAgentSession(authorization: string | null, runtimeRunId: string | null) {
  authenticateMcp(authorization);
  if (!runtimeRunId || !uuid.test(runtimeRunId)) throw new SessionError('VOICE_BINDING_REQUIRED', 401);
  const result = await twinRpc('poc_resolve_voice', { p_run_id: runtimeRunId });
  if (!result.ok) throw new SessionError('VOICE_BINDING_REQUIRED', 401);
  if (!result.sessionHash || !/^[a-f0-9]{64}$/.test(result.sessionHash)) throw new SessionError('TWIN_INVALID_RESPONSE');
  return result.sessionHash;
}

import { createHappyRobotClient } from '../../integrations/happyrobot/client.js';
import { trackCall } from './activity.js';
import { ApiError, HappyRobotClient } from '@happyrobot-ai/sdk';
import { callAction } from './repository.js';
import { resultStatus } from '../../transport/http/result-status.js';
import { SessionError } from '../../errors.js';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

// A browser disconnect is not proof of provider completion. Allow a short
// propagation window for HappyRobot to mark the run terminal after _hangup.
async function confirmProviderEnd(hash: string, runId: string, sdk: Pick<HappyRobotClient, 'runs'>) {
  for (const delay of [0, 500, 1500, 3000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const run = await sdk.runs.get(runId);
      if (run.id === runId && ['completed', 'canceled', 'failed'].includes(run.status)) {
        await trackCall(hash, 'ended', { evidence: 'provider_run_terminal', runId, status: run.status });
        return true;
      }
    } catch {
      // Unknown, missing or inaccessible runs are not evidence of completion.
    }
  }
  return false;
}

async function boundRun(hash: string, expectedCallId: string) {
  if (!uuid.test(expectedCallId)) throw new SessionError('INVALID_REQUEST', 400);
  const current = await callAction(hash, 'status');
  if (!current.ok)
    throw new SessionError(current.error ?? 'SESSION_REQUIRED', resultStatus(current));
  if (current.session?.callId !== expectedCallId) throw new SessionError('CALL_CHANGED', 409);
  return current.session.voiceRunId;
}

export async function reconcileVoiceSession(
  hash: string,
  expectedCallId: string,
  sdk?: Pick<HappyRobotClient, 'runs'>,
) {
  const runId = await boundRun(hash, expectedCallId);
  await trackCall(hash, 'disconnected');
  const confirmed = !!runId && await confirmProviderEnd(hash, runId, sdk ?? createHappyRobotClient());
  return { ok: true, confirmed };
}

export async function endVoiceSession(
  hash: string,
  expectedCallId: string,
  sdk?: Pick<HappyRobotClient, 'runs'>,
) {
  const runId = await boundRun(hash, expectedCallId);
  if (!runId) return { ok: true };
  const hr = sdk ?? createHappyRobotClient();
  try {
    await hr.runs.cancel(runId);
  } catch {
    // Cancellation can race with the browser disconnect or native _hangup.
    // Confirm the actual state, including after a 404; never assume it ended.
    if (await confirmProviderEnd(hash, runId, hr)) return { ok: true };
    throw new SessionError('HAPPYROBOT_END_UNCONFIRMED');
  }
  await trackCall(hash, 'ended');
  return { ok: true };
}

export async function createVoiceSession(
  hash: string,
  sdk?: Pick<HappyRobotClient, 'voice' | 'runs'>,
) {
  const workflowId = process.env.HAPPYROBOT_WORKFLOW_ID;
  const environment = process.env.HAPPYROBOT_ENVIRONMENT;
  if (
    !workflowId ||
    !uuid.test(workflowId) ||
    !['development', 'staging', 'production'].includes(environment ?? '')
  ) {
    throw new SessionError('HAPPYROBOT_NOT_CONFIGURED');
  }
  const hr = sdk ?? createHappyRobotClient();
  const reserved = await callAction(hash, 'voice_reserve');
  if (!reserved.ok)
    throw new SessionError(reserved.error ?? 'VOICE_ALREADY_STARTED', resultStatus(reserved));
  let runId: string | undefined;
  try {
    const token = await hr.voice.createToken({
      workflow_id: workflowId,
      env: environment as 'development' | 'staging' | 'production',
      ttl_seconds: 3600,
    });
    runId = token.run_id;
    if (
      !uuid.test(runId) ||
      !token.token ||
      !token.room_name ||
      new URL(token.url).protocol !== 'wss:'
    ) {
      throw new SessionError('HAPPYROBOT_INVALID_RESPONSE');
    }
    // The provider's server response supplies the identity. No model or browser
    // parameter chooses the run binding. Return the WebRTC credential only after
    // Twin commits it; pending calls cannot resolve through the agent adapter.
    const bound = await callAction(hash, 'voice_bind', { p_metadata: { runId } });
    if (!bound.ok)
      throw new SessionError(bound.error ?? 'VOICE_BINDING_FAILED', resultStatus(bound));
    return { ok: true, session: bound.session, voice: token };
  } catch (error) {
    if (runId && uuid.test(runId)) {
      try {
        await hr.runs.cancel(runId);
      } catch {
        /* Never expose SDK exceptions. */
      }
    }
    try {
      await callAction(hash, 'voice_failed');
    } catch {
      /* Reserved state already prevents duplicate runs. */
    }
    if (error instanceof SessionError) throw error;
    if (error instanceof ApiError && error.status === 404)
      throw new SessionError('HAPPYROBOT_WORKFLOW_NOT_LIVE', 409);
    if (error instanceof ApiError && error.status === 401)
      throw new SessionError('HAPPYROBOT_AUTH_REJECTED');
    throw new SessionError('HAPPYROBOT_VOICE_UNAVAILABLE');
  }
}

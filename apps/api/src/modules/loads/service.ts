import { trackCall } from '../calls/index.js';
import { callAction } from '../calls/index.js';
import { SessionError } from '../../errors.js';
import { resultStatus } from '../../transport/http/result-status.js';
import { runTms, validateRequest } from '../../integrations/tms/client.js';

export async function loadsForCall(
  hash: string,
  input: unknown,
  signal?: AbortSignal,
  execute: typeof runTms = runTms,
) {
  const request = validateRequest(input);
  if (request.command === 'DEBUG_ECHO') throw new SessionError('INVALID_COMMAND', 400);
  const metadata = { command: request.command, loadId: request.fields?.LOAD_ID ?? null };
  const gate = await callAction(hash, 'authorize_load', { p_metadata: metadata });
  if (!gate.ok) throw new SessionError(gate.error ?? 'OTP_REQUIRED', resultStatus(gate));
  const session = gate.session!;
  if (
    !session.verified ||
    !session.check?.eligible ||
    session.check.outcome !== 'eligible' ||
    !(Date.parse(session.expiresAt) > Date.now())
  ) {
    throw new SessionError('OTP_REQUIRED', 403);
  }
  const result = await execute(request, signal);
  // Recheck under the Twin row lock before returning data: a carrier change,
  // expiration or new call while TCP was in flight must suppress the result.
  const saved = await callAction(hash, 'save_loads', {
    p_metadata: {
      ...metadata,
      revision: session.authorityRevision,
      ok: result.ok,
      error: result.ok ? null : result.error,
      loadIds: result.ok ? result.records.map((load) => load.LOAD_ID) : [],
      loadStatuses: result.ok
        ? Object.fromEntries(result.records.map((load) => [load.LOAD_ID, load.STATUS]))
        : {},
    },
  });
  if (!saved.ok) throw new SessionError(saved.error ?? 'CALL_CHANGED', resultStatus(saved));
  if (result.ok) await trackCall(hash, 'loads', { records: result.records });
  return result;
}

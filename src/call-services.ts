import { trackCall } from './operator';
import { callAction, SessionError, resultStatus, verifyOtp } from './call-session';
import { lookupCarrier, normalizeMc } from './fmcsa';
import { runTms, validateRequest } from './tms';

// The transport supplies the resolved session hash, never a model-provided
// call ID or MC number. A future agent adapter must authenticate and resolve
// its HappyRobot binding before invoking these same functions.
export async function verifyCarrierForCall(hash: string, mc: unknown, signal?: AbortSignal,
  lookup: typeof lookupCarrier = lookupCarrier) {
  const mcNumber = normalizeMc(mc);
  const started = await callAction(hash, 'authority_begin', { p_metadata: { mcNumber } });
  if (!started.ok) return started;
  const revision = started.session!.authorityRevision;
  try {
    const check = await lookup(mcNumber, signal);
    return await callAction(hash, 'authority_complete', { p_metadata: { revision, check } });
  } catch (error) {
    // Old authority cannot survive a failed recheck. Save an unavailable result
    // without storing the upstream exception or credentials in Twin.
    await callAction(hash, 'authority_complete', { p_metadata: { revision, check: {
      mcNumber, eligible: false, outcome: 'unverified', reason: 'AUTHORITY_LOOKUP_FAILED', checkedAt: new Date().toISOString(),
    } } });
    throw error;
  }
}

export async function verifyOtpForCall(hash: string, code: string, challengeId?: string, operationId?: string) {
  // Voice callers only need the dictated digits. The active challenge comes
  // from their bound session; they cannot select another call's challenge.
  if (!challengeId) {
    const current = await callAction(hash, 'status');
    if (!current.ok) return current;
    if (!current.session?.challengeId) throw new SessionError('OTP_NOT_READY', 409);
    challengeId = current.session.challengeId;
  }
  return verifyOtp(hash, challengeId, code, operationId);
}

export async function loadsForCall(hash: string, input: unknown, signal?: AbortSignal,
  execute: typeof runTms = runTms) {
  const request = validateRequest(input);
  if (request.command === 'DEBUG_ECHO') throw new SessionError('INVALID_COMMAND', 400);
  const metadata = { command: request.command, loadId: request.fields?.LOAD_ID ?? null };
  const gate = await callAction(hash, 'authorize_load', { p_metadata: metadata });
  if (!gate.ok) throw new SessionError(gate.error ?? 'OTP_REQUIRED', resultStatus(gate));
  const session = gate.session!;
  if (!session.verified || !session.check?.eligible || session.check.outcome !== 'eligible'
    || !(Date.parse(session.expiresAt) > Date.now())) {
    throw new SessionError('OTP_REQUIRED', 403);
  }
  const result = await execute(request, signal);
  // Recheck under the Twin row lock before returning data: a carrier change,
  // expiration or new call while TCP was in flight must suppress the result.
  const saved = await callAction(hash, 'save_loads', { p_metadata: {
    ...metadata, revision: session.authorityRevision, ok: result.ok,
    error: result.ok ? null : result.error,
    loadIds: result.ok ? result.records.map(load => load.LOAD_ID) : [],
    loadStatuses: result.ok ? Object.fromEntries(result.records.map(load => [load.LOAD_ID, load.STATUS])) : {},
  } });
  if (!saved.ok) throw new SessionError(saved.error ?? 'CALL_CHANGED', resultStatus(saved));
  if (result.ok) await trackCall(hash,'loads',{records:result.records});
  return result;
}

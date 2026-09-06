import { callAction } from '../calls/index.js';
import { SessionError } from '../../errors.js';
import { verifyOtp } from './otp.js';
import { lookupCarrier, normalizeMc } from '../../integrations/fmcsa/client.js';

// The transport supplies the resolved session hash, never a model-provided
// call ID or MC number. A future agent adapter must authenticate and resolve
// its HappyRobot binding before invoking these same functions.
export async function verifyCarrierForCall(
  hash: string,
  mc: unknown,
  signal?: AbortSignal,
  lookup: typeof lookupCarrier = lookupCarrier,
) {
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
    await callAction(hash, 'authority_complete', {
      p_metadata: {
        revision,
        check: {
          mcNumber,
          eligible: false,
          outcome: 'unverified',
          reason: 'AUTHORITY_LOOKUP_FAILED',
          checkedAt: new Date().toISOString(),
        },
      },
    });
    throw error;
  }
}

export async function verifyOtpForCall(
  hash: string,
  code: string,
  challengeId?: string,
  operationId?: string,
) {
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

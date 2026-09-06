import { randomUUID } from 'node:crypto';
import {
  data,
  str,
  failure,
  recordCallEvent,
  type Snapshot,
  type Data,
  type Decision,
} from '../../db/model.js';
export type ActionInput = {
  p_challenge?: string | null;
  p_digest?: string | null;
  p_recipient?: string | null;
  p_matches?: boolean | null;
  p_metadata?: unknown;
};
export function beginAuthorityCheck(s: Snapshot, m: Data): string | undefined {
  if (!/^[0-9]{1,10}$/.test(str(m.mcNumber))) throw Error('Invalid MC');
  const c = s.call;
  Object.assign(c, {
    authority_revision: c.authority_revision + 1,
    authority_check: {
      mcNumber: m.mcNumber,
      eligible: false,
      outcome: 'unverified',
      reason: 'AUTHORITY_CHECKING',
      checkedAt: s.now,
    },
    authority_passed: false,
    otp_state: c.otp_failures >= 2 ? 'failed' : 'not_sent',
    challenge_id: null,
    otp_digest: null,
    otp_expires_at: null,
    otp_verified_at: null,
    available_load_ids: [],
    selected_load_id: null,
    booking_terms: null,
    load_statuses: {},
  });
  if (s.negotiation)
    Object.assign(s.negotiation, {
      status: s.negotiation.status === 'failed' ? 'failed' : 'idle',
      agreed_cents: null,
      offer_id: randomUUID(),
    });
  recordCallEvent(s, 'authority_check_started');
  return undefined;
}
export function completeAuthorityCheck(s: Snapshot, m: Data): string | undefined {
  const c = s.call,
    check = data(m.check);
  if (m.revision !== c.authority_revision || check.mcNumber !== c.authority_check?.mcNumber)
    return 'CALL_CHANGED';
  c.authority_check = check;
  c.authority_passed = check.eligible === true && check.outcome === 'eligible';
  recordCallEvent(s, 'authority_checked', {
    outcome: check.outcome ?? null,
    reason: check.reason ?? null,
  });
}
export function reserveOtpChallenge(s: Snapshot, a: ActionInput): string | undefined {
  const c = s.call;
  if (c.otp_state === 'verified') return 'ALREADY_VERIFIED';
  if (['pending', 'dispatching'].includes(c.otp_state)) return;
  if (
    !a.p_challenge ||
    !a.p_digest ||
    !/^[a-f0-9]{64}$/.test(a.p_digest) ||
    a.p_recipient == null ||
    a.p_recipient.length > 254
  )
    throw Error('Invalid challenge');
  Object.assign(c, {
    challenge_id: a.p_challenge,
    otp_digest: a.p_digest,
    otp_state: 'dispatching',
    otp_expires_at: null,
    demo_recipient: a.p_recipient,
  });
  recordCallEvent(s, 'otp_requested');
}
export function recordOtpDispatch(
  s: Snapshot,
  a: ActionInput,
  accepted: boolean,
): { error?: string; completed?: boolean } {
  const c = s.call;
  if (c.challenge_id !== (a.p_challenge ?? null)) return { error: 'OTP_CHALLENGE_CHANGED' };
  if (c.otp_state === 'pending' && accepted) return {};
  if (c.otp_state !== 'dispatching') return { error: 'OTP_NOT_READY' };
  c.otp_state = accepted ? 'pending' : 'failed';
  if (!accepted) {
    c.otp_digest = null;
    c.otp_failures++;
  }
  recordCallEvent(s, accepted ? 'otp_dispatch_accepted' : 'otp_dispatch_failed');
  return {
    completed: true,
    ...(!accepted ? { error: c.otp_failures >= 2 ? 'OTP_FAILED' : 'OTP_DELIVERY_FAILED' } : {}),
  };
}
export function recordOtpFailure(s: Snapshot): { error: string; completed?: boolean } {
  const c = s.call;
  if (c.otp_state === 'verified') return { error: 'ALREADY_VERIFIED' };
  c.otp_failures++;
  if (c.otp_failures >= 2) {
    c.otp_state = 'failed';
    c.otp_digest = null;
  }
  recordCallEvent(s, 'otp_service_failed');
  return { error: c.otp_failures >= 2 ? 'OTP_FAILED' : 'OTP_SERVICE_FAILED', completed: true };
}
export function prepareOtpVerification(s: Snapshot, a: ActionInput): Decision {
  const c = s.call;
  if (c.otp_state === 'verified') return failure('OTP_ALREADY_USED');
  if (c.challenge_id !== (a.p_challenge ?? null)) return failure('OTP_CHALLENGE_CHANGED');
  if (c.otp_state !== 'pending') return failure('OTP_NOT_READY');
  return { result: { ok: true, verifier: c.otp_digest } };
}
export function completeOtpVerification(
  s: Snapshot,
  a: ActionInput,
): { error?: string; completed?: boolean } {
  const prepared = prepareOtpVerification(s, a);
  if (!prepared.result.ok) return { error: str(prepared.result.error) };
  const c = s.call;
  if (a.p_matches) {
    c.otp_state = 'verified';
    c.otp_verified_at = s.now;
    c.otp_digest = null;
    recordCallEvent(s, 'otp_verified');
    return { completed: true };
  }
  c.otp_failures++;
  if (c.otp_failures >= 2) {
    c.otp_state = 'failed';
    c.otp_digest = null;
  }
  recordCallEvent(s, 'otp_rejected');
  return { completed: true, error: c.otp_failures >= 2 ? 'OTP_FAILED' : 'OTP_INVALID' };
}

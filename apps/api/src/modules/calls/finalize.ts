import { twinRpc } from '../../db/twin-client.js';
import { SessionError } from '../../errors.js';
import { resultStatus } from '../../transport/http/result-status.js';
import { publicBooking } from '../booking/index.js';
import { publicLoadInterest } from '../operations/index.js';
import { runtimeConfig } from '../../config/env.js';

export type FinalizeCall = {
  outcome: string;
  summary: string;
  review_reason?: string;
  review_note?: string;
  callback_number?: string;
  callback_consent?: boolean;
};
export async function finalizeCall(hash: string, args: FinalizeCall) {
  // Summary is model-reported text; structured facts are derived by the backend decision module.
  // Avoid retaining standalone codes even if the model ignores its instructions.
  const summary = args.summary.replace(/\b\d{6}\b/g, '[redacted]');
  const review = args.review_reason
    ? {
        reason: args.review_reason,
        note: args.review_note?.replace(/\b\d{6}\b/g, '[redacted]'),
        ...(args.review_reason === 'callback_requested'
          ? { callback_number: args.callback_number, consent: args.callback_consent }
          : {}),
      }
    : {};
  if (
    (!args.review_reason &&
      (args.review_note || args.callback_number || args.callback_consent !== undefined)) ||
    (args.review_reason && !args.review_note) ||
    (args.review_reason === 'callback_requested' &&
      (!args.callback_number || args.callback_consent !== true))
  )
    throw new SessionError('INVALID_REVIEW', 400);
  const result = await twinRpc('poc_finalize_call', {
    p_session_hash: hash,
    p_outcome: args.outcome,
    p_summary: summary,
    ...(runtimeConfig().features.operationsEnabled ? { p_review: review } : {}),
  });
  if (!result.ok)
    throw new SessionError(result.error ?? 'FINALIZATION_FAILED', resultStatus(result));
  const s = result.session;
  if (!s?.finalizedAt || !s.finalOutcome || typeof s.verified !== 'boolean')
    throw new SessionError('TWIN_INVALID_RESPONSE');
  return {
    ok: true,
    review_recorded: result.review_recorded ?? false,
    outcome: s.finalOutcome,
    finalized_at: s.finalizedAt,
    authority_passed: s.check?.eligible === true,
    verified: s.verified,
    selected_load_id: s.selectedLoadId,
    negotiation: s.negotiation,
    interest: s.loadInterest ? publicLoadInterest(s.loadInterest) : null,
    booking: s.booking ? publicBooking(s.booking) : null,
    booking_saved: s.booking?.status === 'confirmed',
    booking_confirmed: s.booking?.status === 'confirmed' && s.booking.simulated !== true,
  };
}

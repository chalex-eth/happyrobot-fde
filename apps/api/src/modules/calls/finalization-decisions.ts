import {
  data,
  str,
  eq,
  expired,
  failure,
  recordCallEvent,
  type Snapshot,
  type Data,
} from '../../db/model.js';
import { toPublicSession, bookingView } from '../../application/projections.js';
import { decideReviewUpsert } from '../operations/index.js';
export function resolveFinalOutcome(s: Snapshot, reported: string): string {
  const b = bookingView(s);
  if (b)
    return b.status === 'confirmed'
      ? b.simulated === true
        ? 'booking_simulated'
        : 'booked'
      : b.status === 'rejected'
        ? 'booking_failed'
        : 'booking_uncertain';
  return s.negotiation?.status === 'failed'
    ? 'failed_negotiation'
    : s.negotiation?.status === 'agreed'
      ? 'rate_agreed'
      : reported;
}
export function decideFinalization(s: Snapshot, reported: string, summary: string, review: Data) {
  const c = s.call,
    why = str(review.reason),
    phone = str(review.callback_number),
    note = str(review.note);
  if (
    why &&
    (!['callback_requested', 'human_requested', 'other'].includes(why) ||
      note.trim().length < 1 ||
      note.trim().length > 500)
  )
    return failure('INVALID_REVIEW');
  if (
    why === 'callback_requested' &&
    (!/^\+[1-9][0-9]{6,14}$/.test(phone) || review.consent !== true)
  )
    return failure('CALLBACK_CONSENT_REQUIRED');
  if (!why && Object.keys(review).length) return failure('INVALID_REVIEW');
  const reports = s.events.filter((e) => e.event === 'finalization_report');
  if (
    c.finalized_at &&
    !reports.some((e) => eq(e.metadata.review, review)) &&
    (Object.keys(review).length || reports.length)
  )
    return failure('CALL_ALREADY_FINALIZED');
  if (
    !['conversation_complete', 'caller_declined', 'technical_error'].includes(reported) ||
    summary.trim().length < 1 ||
    summary.trim().length > 1000
  )
    return failure('INVALID_FINALIZATION');
  if (expired(c.session_expires_at, s.now)) return failure('SESSION_REQUIRED');
  if (bookingView(s)?.status === 'pending') return failure('BOOKING_IN_PROGRESS');
  const outcome = resolveFinalOutcome(s, reported);
  let result: Data;
  if (c.finalized_at) {
    if (c.final_outcome !== outcome || c.final_summary !== summary)
      return failure('CALL_ALREADY_FINALIZED');
    result = c.final_result ?? {};
  } else {
    c.finalized_at = s.now;
    c.final_outcome = outcome;
    c.final_summary = summary;
    result = { ok: true, error: null, session: toPublicSession(s) };
    c.final_result = result;
    recordCallEvent(s, 'call_finalized', {
      outcome,
      authorityPassed: c.authority_passed,
      verified: data(result.session).verified ?? false,
      selectedLoadId: c.selected_load_id,
      negotiation: data(result.session).negotiation ?? null,
      booking: bookingView(s),
      bookingConfirmed:
        bookingView(s)?.status === 'confirmed' && bookingView(s)?.simulated !== true,
    });
    recordCallEvent(s, 'finalization_report', { reported_end_reason: reported, review });
    if (reported === 'technical_error')
      decideReviewUpsert(
        s,
        'technical_error',
        'Call ended with a technical error.',
        'finalization',
      );
  }
  c.reported_end_reason ??= reported;
  c.last_activity_at = s.now;
  if (why) {
    decideReviewUpsert(s, why, note, 'finalization', why === 'callback_requested' ? phone : null);
    if (!s.events.some((e) => e.event === 'review_requested'))
      recordCallEvent(s, 'review_requested', review);
  }
  return { result: { ...result, review_recorded: !!why } };
}

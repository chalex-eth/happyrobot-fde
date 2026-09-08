import type { CallOutcome } from '@carrier/contracts/operations';
import { data, str, type Data, type Snapshot } from '../db/model.js';

/** Read-only classification. Never turn missing evidence or recovered errors into a failure. */
export function callOutcome(
  s: Snapshot,
  booking: Data | null,
  negotiation: Data | null,
): CallOutcome {
  const c = s.call;
  const events = [...s.events].sort((a, b) => a.id - b.id);
  const expired = !!c.voice_run_id && Date.parse(c.session_expires_at) <= Date.parse(s.now);
  const closed = !!(c.finalized_at || c.ended_at || expired || c.voice_state === 'failed');
  const ending: CallOutcome['ending'] =
    c.reported_end_reason === 'technical_error' || c.final_outcome === 'technical_error'
      ? { code: 'technical_error', label: 'Ended because of a technical problem' }
      : c.reported_end_reason === 'caller_declined' || c.final_outcome === 'caller_declined'
        ? { code: 'caller_declined', label: 'Caller declined further help' }
        : c.finalized_at
          ? { code: 'completed', label: 'Call finalized' }
          : c.voice_state === 'failed'
            ? { code: 'voice_failed', label: 'Voice session could not start' }
            : c.ended_at
              ? { code: 'unfinalized', label: 'Call ended without a saved finalization' }
              : expired
                ? { code: 'expired', label: 'Session expired without a saved finalization' }
                : null;
  const result = (code: CallOutcome['code'], label: string, detail: string): CallOutcome => ({
    code,
    label,
    detail,
    ending,
  });

  // Saved business results take precedence over later call/transport errors.
  if (booking) {
    const submission = data(booking.submission);
    if (submission.status === 'confirmed')
      return result(
        'booking_submitted_demo',
        'Booking submitted (demo)',
        'Manager approval and the simulated submission are recorded. No live TMS booking was sent.',
      );
    if (booking.status === 'confirmed' && booking.simulated !== true)
      return result(
        'booked',
        'Booking confirmed',
        'A confirmed booking result and reference are recorded.',
      );
    if (booking.status === 'confirmed') {
      if (booking.manager_status === 'rejected')
        return result(
          'booking_declined',
          'Booking request declined',
          'The manager rejected the saved booking request.',
        );
      if (booking.manager_status === 'changes_requested')
        return result(
          'booking_changes_requested',
          'Booking changes requested',
          'The manager requested changes before approval.',
        );
      if (booking.manager_status === 'approved')
        return result(
          'booking_approved',
          'Booking approved; submission pending',
          'Manager approval is recorded; submission has not been confirmed.',
        );
      return result(
        'booking_awaiting_approval',
        'Booking awaiting approval',
        'The booking request is recorded and awaits senior-representative approval and final confirmation.',
      );
    }
    if (booking.status === 'rejected')
      return result(
        'booking_failed',
        'Booking failed',
        'The booking attempt was rejected; no successful booking was confirmed.',
      );
    if (booking.status === 'uncertain')
      return result(
        'booking_uncertain',
        'Booking confirmation uncertain',
        'The attempt has no confirmed result. Review it before any further booking action.',
      );
    return result(
      'booking_pending',
      'Booking in progress',
      'A booking attempt is recorded; its result is still pending.',
    );
  }
  if (c.load_interest?.status === 'recorded')
    return result(
      'load_interest_recorded',
      'Pending-load interest recorded',
      'Interest and a callback number were saved for manager review. A callback is not guaranteed.',
    );

  if (c.authority_check?.outcome === 'ineligible')
    return result(
      'authority_ineligible',
      'Operating authority not eligible',
      'The MC lookup did not meet the operating-authority requirements. Load access was not permitted.',
    );
  if (c.authority_check?.outcome === 'not_found')
    return result(
      'carrier_not_found',
      'Carrier not found',
      'No carrier was found for the supplied MC number.',
    );
  if (
    c.authority_check?.outcome === 'unverified' &&
    c.authority_check.reason !== 'AUTHORITY_CHECKING'
  )
    return result(
      'authority_unavailable',
      'Authority verification unavailable',
      'The operating-authority lookup could not be completed. This is not an authority rejection.',
    );

  // OTP retry failures are shared across the call, even after a carrier change.
  const otpFailures = events.filter((e) =>
    ['otp_rejected', 'otp_dispatch_failed', 'otp_service_failed'].includes(e.event),
  );
  if (c.otp_state !== 'verified' && c.otp_failures >= 2) {
    const last = otpFailures.at(-1)?.event;
    if (last === 'otp_dispatch_failed')
      return result(
        'otp_delivery_failed',
        'Verification code delivery failed',
        'Verification stopped after the retry budget was exhausted during code delivery.',
      );
    if (last === 'otp_service_failed')
      return result(
        'otp_service_failed',
        'Identity verification service failed',
        'Verification stopped after the retry budget was exhausted during a service failure.',
      );
    if (last === 'otp_rejected')
      return result(
        'otp_attempts_exhausted',
        'Identity verification failed',
        'The final code was rejected and the shared verification retry budget was exhausted.',
      );
    return result(
      'verification_failed',
      'Identity verification failed',
      'The verification retry budget was exhausted; the specific cause was not recorded.',
    );
  }
  // Ignore observations belonging to an earlier MC verification.
  const start = events.map((e) => e.event).lastIndexOf('authority_check_started');
  const current = events.slice(Math.max(0, start));
  const lastTool = current
    .filter((e) => e.event === 'tool_result' && e.metadata.tool !== 'finalize_call')
    .at(-1);
  const lastFailure = lastTool?.metadata.ok === false ? lastTool : undefined;
  const error = str(lastFailure?.metadata.error);
  const searches = current.filter(
    (e) => e.event === 'load_result' && e.metadata.command === 'LOAD_QUERY',
  );
  const search = searches.at(-1);
  const loadResult = current.filter((e) => e.event === 'load_result').at(-1);
  const lastAgreement = current.filter((e) => e.event === 'rate_agreed').at(-1);
  const preflight = current
    .filter(
      (e) =>
        e.event === 'booking_preflight_failed' &&
        e.metadata.loadId === c.selected_load_id &&
        e.id > (lastAgreement?.id ?? -1),
    )
    .at(-1);
  if (closed && (preflight || (lastFailure?.metadata.tool === 'book_load' && error))) {
    const reason = str(preflight?.metadata.error) || error;
    if (reason === 'BOOKING_TERMS_CHANGED')
      return result(
        'booking_terms_changed',
        'Booking terms changed',
        'The booking was stopped because the load terms changed before submission.',
      );
    return result(
      'booking_blocked',
      'Booking could not proceed',
      'The booking checks did not permit a booking attempt; review the saved terms and availability.',
    );
  }
  if (
    closed &&
    [
      'CALL_CHANGED',
      'SESSION_REQUIRED',
      'VOICE_BINDING_REQUIRED',
      'OTP_OPERATION_CHANGED',
      'OTP_RESULT_UNCERTAIN',
    ].includes(error)
  )
    return result(
      'session_interrupted',
      'Call session could not continue',
      'A session or verification-operation safeguard prevented continuation.',
    );
  if (closed && c.otp_state !== 'verified') {
    const last = current
      .filter((e) =>
        [
          'otp_rejected',
          'otp_dispatch_failed',
          'otp_dispatch_accepted',
          'otp_service_failed',
          'otp_verified',
        ].includes(e.event),
      )
      .at(-1)?.event;
    if (last === 'otp_dispatch_failed')
      return result(
        'otp_delivery_failed',
        'Verification code delivery failed',
        'The latest code delivery failed and verification was not completed.',
      );
    if (last === 'otp_service_failed')
      return result(
        'otp_service_failed',
        'Identity verification service failed',
        'The latest verification service operation failed and verification was not completed.',
      );
  }
  if (
    closed &&
    (loadResult?.metadata.ok === false ||
      (['search_loads', 'get_load'].includes(str(lastFailure?.metadata.tool)) &&
        !['FILTER_REQUIRED', 'LOAD_UNAVAILABLE', 'LOAD_NOT_IN_CALL'].includes(error)))
  )
    return result(
      'load_lookup_failed',
      'Load lookup failed',
      'The latest load search or detail lookup could not be completed.',
    );
  if (
    closed &&
    lastFailure?.metadata.tool === 'record_load_interest' &&
    error !== 'LOAD_STATUS_CHANGED'
  )
    return result(
      'interest_not_recorded',
      'Pending-load interest not confirmed',
      'The request to record interest did not return a confirmed success.',
    );
  if (closed && ending?.code === 'technical_error')
    return result(
      'technical_error',
      'Call interrupted by a technical problem',
      'A technical ending was recorded. No more specific confirmed result is available.',
    );
  if (c.voice_state === 'failed')
    return result(
      'voice_failed',
      'Voice session failed to start',
      'No connected voice conversation was established.',
    );
  if (negotiation?.status === 'failed')
    return result(
      'negotiation_exhausted',
      'No rate agreement',
      'The three-round negotiation limit was reached without agreement.',
    );
  if (negotiation?.status === 'agreed')
    return result(
      'rate_agreed',
      'Rate agreed; no booking recorded',
      'The rate was agreed, but no booking attempt or saved request is recorded.',
    );
  if (closed && negotiation?.status === 'rejected')
    return result(
      'offer_rejected',
      'Offer declined',
      'The caller rejected the current offer; no booking was recorded.',
    );
  if (closed && ['LOAD_UNAVAILABLE', 'LOAD_STATUS_CHANGED'].includes(error))
    return result(
      'load_unavailable',
      'Selected load unavailable',
      'The selected load was no longer available for the requested action.',
    );
  // Consent decisions are only asserted from explicit persisted review requests.
  const requested = current.filter((e) => e.event === 'review_requested').at(-1);
  if (requested?.metadata.reason === 'callback_requested')
    return result(
      'callback_requested',
      'Callback requested',
      'A callback request and consent were recorded.',
    );
  if (requested?.metadata.reason === 'human_requested')
    return result(
      'human_requested',
      'Human assistance requested',
      'A request for human assistance was recorded.',
    );
  if (requested?.metadata.reason === 'other')
    return result(
      'other_review_requested',
      'Further review requested',
      'An unresolved concern was recorded for review.',
    );
  if (
    closed &&
    !c.authority_check &&
    !current.some((e) => ['authority_check_started', 'otp_requested'].includes(e.event)) &&
    !c.reported_end_reason
  )
    return result(
      'reason_not_recorded',
      'Call outcome not recorded',
      'There is not enough saved evidence to identify why this call ended.',
    );
  if (!c.authority_passed || c.otp_state !== 'verified') {
    if (closed)
      return result(
        'verification_incomplete',
        'Verification incomplete',
        'The call ended before verification completed. No specific terminal verification failure is recorded.',
      );
    if (c.authority_check?.reason === 'AUTHORITY_CHECKING')
      return result(
        'authority_checking',
        'Checking operating authority',
        'The MC lookup is still in progress.',
      );
    if (c.authority_passed)
      return result(
        'verification_pending',
        'Identity verification pending',
        'Operating authority passed; identity verification has not completed.',
      );
    return result(
      c.voice_state === 'idle' ? 'not_started' : 'awaiting_mc',
      c.voice_state === 'idle' ? 'Call not started' : 'Awaiting MC verification',
      'No completed operating-authority check is recorded.',
    );
  }
  if (
    closed &&
    search?.metadata.ok === true &&
    Array.isArray(search.metadata.loadIds) &&
    !search.metadata.loadIds.length
  )
    return result(
      'no_loads_found',
      'No matching loads found',
      'The latest successful search returned no loads; no booking was recorded.',
    );
  if (closed && search?.metadata.ok === true) {
    const statuses = Object.values(data(search.metadata.loadStatuses));
    if (statuses.length && statuses.every((v) => v === 'PENDING'))
      return result(
        'pending_loads_only',
        'Only pending loads found',
        'The latest search returned pending loads; no interest request or booking was recorded.',
      );
    if (statuses.length && statuses.every((v) => v !== 'OPEN'))
      return result(
        'no_open_loads',
        'No open loads found',
        'The latest search returned no loads eligible for negotiation or booking.',
      );
  }
  if (closed && negotiation?.status === 'offered')
    return result(
      'offer_unanswered',
      'Offer left without agreement',
      'An offer was presented, but no acceptance or rejection of the current offer was recorded.',
    );
  if (closed && search?.metadata.ok === true)
    return result(
      'loads_found_no_booking',
      'Loads found; no booking recorded',
      'Loads were found, but the call ended without a booking.',
    );
  if (closed)
    return result(
      'verified_no_booking',
      'Verified; no booking recorded',
      'Verification completed, but no load-search result or booking was recorded.',
    );
  if (negotiation?.status === 'offered')
    return result(
      'negotiating',
      'Rate discussion in progress',
      'A current offer is awaiting the caller’s decision.',
    );
  if (search?.metadata.ok === true)
    return result(
      'searching',
      'Load selection in progress',
      'The caller has received load-search results; the conversation has no saved ending.',
    );
  return result(
    'verified',
    'Carrier verified',
    'Verification is complete; the conversation has no saved ending.',
  );
}

import { randomUUID } from 'node:crypto';
import {
  data,
  str,
  eq,
  expired,
  failure,
  recordCallEvent,
  type Snapshot,
  type Data,
  type Decision,
} from '../../db/model.js';
import { bookingView, toPublicNegotiation } from '../../application/projections.js';
export function getBookingStatus(s: Snapshot): Decision {
  return { result: { ok: true, booking: bookingView(s) }, activeSession: false };
}
export function completeBookingAttempt(s: Snapshot, m: Data): Decision {
  const c = s.call,
    b = c.booking,
    r = data(m.result),
    state = str(r.status);
  if (!b || b.attempt_id !== m.attemptId) return failure('BOOKING_ATTEMPT_CHANGED');
  if (
    ['confirmed', 'rejected'].includes(str(b.status)) ||
    (b.status === 'uncertain' && state === 'uncertain' && b.error === r.error)
  )
    return { result: { ok: true, booking: b }, activeSession: false };
  if ((r.simulated === true) !== (b.simulated === true)) return failure('BOOKING_MODE_MISMATCH');
  if (!['confirmed', 'rejected', 'uncertain'].includes(state))
    return failure('INVALID_BOOKING_RESULT');
  if (
    state === 'confirmed' &&
    (!/^[\x20-\x7e]{1,128}$/.test(str(r.reference)) ||
      str(r.reference).includes('|') ||
      !/^\d{14}$/.test(str(r.timestamp)))
  )
    return failure('INVALID_BOOKING_RESULT');
  delete b.error;
  Object.assign(b, { status: state, completed_at: s.now, handoff_mock: state === 'confirmed' });
  if (state === 'confirmed')
    Object.assign(b, {
      reference: r.reference,
      [b.simulated === true ? 'simulated_at_utc' : 'tms_timestamp_utc']: r.timestamp,
    });
  else b.error = /^[A-Z_]{1,64}$/.test(str(r.error)) ? r.error! : 'TMS_BOOKING_UNCERTAIN';
  recordCallEvent(s, 'booking_' + state, { ...b });
  if (state === 'confirmed')
    recordCallEvent(s, 'handoff_mock_recorded', {
      loadId: b.load_id ?? null,
      reference: b.reference ?? null,
      simulated: true,
    });
  if (c.finalized_at) {
    c.final_outcome =
      state === 'confirmed'
        ? b.simulated === true
          ? 'booking_simulated'
          : 'booked'
        : state === 'rejected'
          ? 'booking_failed'
          : 'booking_uncertain';
    c.final_result = {
      ...c.final_result,
      session: {
        ...data(c.final_result?.session),
        booking: { ...b },
        finalOutcome: c.final_outcome,
      },
    };
  }
  return { result: { ok: true, booking: { ...b } }, activeSession: false };
}
export function recordBookingPreflightFailure(s: Snapshot, error: string): Decision {
  recordCallEvent(s, 'booking_preflight_failed', {
    loadId: s.negotiation!.load_id,
    error: /^[A-Z_]{1,64}$/.test(error) ? error : 'TMS_UNAVAILABLE',
  });
  return { result: { ok: true } };
}
export function prepareBooking(s: Snapshot): Decision {
  return s.call.booking_terms ? { result: { ok: true } } : failure('BOOKING_TERMS_REQUIRED');
}
export function claimBookingAttempt(s: Snapshot, m: Data): Decision {
  const c = s.call,
    n = s.negotiation!;
  if (
    !eq(c.booking_terms, m.terms) ||
    n.listed_cents !== m.listedCents ||
    n.max_cents !== m.maxCents
  ) {
    recordBookingPreflightFailure(s, 'BOOKING_TERMS_CHANGED');
    return failure('BOOKING_TERMS_CHANGED');
  }
  const mc = str(c.authority_check?.mcNumber);
  if (
    !/^[0-9]{1,8}$/.test(mc) ||
    !/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(str(m.attemptId))
  )
    return failure('INVALID_BOOKING_REQUEST');
  const b: Data = {
    status: 'pending',
    attempt_id: m.attemptId!,
    load_id: n.load_id,
    offer_id: n.offer_id,
    mc_number: mc,
    agreed_rate: n.agreed_cents! / 100,
    attempted_at: s.now,
    handoff_mock: false,
    simulated: m.simulated === true,
  };
  c.booking = b;
  recordCallEvent(s, 'booking_attempted', b);
  return {
    result: { ok: true, claimed: true, booking: b, mcNumber: mc, agreedCents: n.agreed_cents },
  };
}
export function decideBooking(s: Snapshot, action: string, m: Data): Decision {
  const c = s.call,
    n = s.negotiation;
  if (action === 'status') return getBookingStatus(s);
  if (action === 'complete') return completeBookingAttempt(s, m);
  if (expired(c.session_expires_at, s.now)) return failure('SESSION_REQUIRED');
  if (c.booking) {
    if (c.booking.load_id !== m.loadId || c.booking.offer_id !== m.offerId)
      return failure('BOOKING_ATTEMPT_CHANGED');
    return { result: { ok: true, claimed: false, booking: bookingView(s) } };
  }
  if (c.finalized_at) return failure('CALL_FINALIZED');
  if (!c.authority_passed) return failure('AUTHORITY_REQUIRED');
  if (c.otp_state !== 'verified' || !c.otp_verified_at) return failure('OTP_REQUIRED');
  if (
    !n ||
    n.load_id !== c.selected_load_id ||
    n.load_id !== m.loadId ||
    !c.available_load_ids.includes(n.load_id) ||
    n.authority_revision !== c.authority_revision ||
    n.offer_id !== m.offerId
  )
    return failure('OFFER_CHANGED');
  if (action === 'quote') {
    const terms = data(m.terms);
    if (terms.LOAD_ID !== n.load_id || terms.STATUS !== 'OPEN')
      return failure('INVALID_BOOKING_TERMS');
    if (n.status === 'offered') {
      if (c.booking_terms && !eq(c.booking_terms, terms)) n.offer_id = randomUUID();
      c.booking_terms = terms;
    } else if (n.status !== 'agreed' || !eq(c.booking_terms, terms))
      return failure('BOOKING_TERMS_CHANGED');
    return { result: { ok: true, negotiation: toPublicNegotiation(s) } };
  }
  if (n.status !== 'agreed' || n.agreed_cents === null || n.agreed_cents > n.max_cents)
    return failure('RATE_AGREEMENT_REQUIRED');
  if (action === 'preflight_failed') return recordBookingPreflightFailure(s, str(m.error));
  const prepared = prepareBooking(s);
  if (!prepared.result.ok || action === 'prepare') return prepared;
  if (action !== 'claim') return failure('INVALID_BOOKING_ACTION');
  return claimBookingAttempt(s, m);
}

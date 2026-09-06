import { publicLoadFields } from '@carrier/contracts/loads';
import { data, type Snapshot, type Data, type Event } from '../db/model.js';
export function toPublicNegotiation(s: Snapshot): Data | null {
  const n = s.negotiation,
    c = s.call;
  if (!n) return null;
  if (
    n.status !== 'failed' &&
    (n.authority_revision !== c.authority_revision ||
      n.load_id !== c.selected_load_id ||
      n.status === 'idle')
  )
    return {
      status: 'idle',
      counter_rounds: n.counter_rounds,
      rounds_remaining: 3 - n.counter_rounds,
      booking_confirmed: false,
    };
  return {
    status: n.status,
    load_id: n.load_id,
    offer_id: n.offer_id,
    offered_rate: ['offered', 'agreed'].includes(n.status) ? n.offered_cents / 100 : null,
    agreed_rate: n.agreed_cents === null ? null : n.agreed_cents / 100,
    counter_rounds: n.counter_rounds,
    rounds_remaining: 3 - n.counter_rounds,
    expires_at: n.expires_at,
    booking_confirmed: false,
  };
}
export function bookingView(s: Snapshot): Data | null {
  const b = s.call.booking;
  return b?.status === 'pending' && Date.parse(String(b.attempted_at)) < Date.parse(s.now) - 45000
    ? { ...b, status: 'uncertain', error: 'BOOKING_RESULT_UNCONFIRMED', handoff_mock: false }
    : b;
}
export function toPublicSession(s: Snapshot): Data {
  const c = s.call;
  return {
    callId: c.id,
    check: c.authority_check,
    voiceState: c.voice_state,
    voiceRunId: c.voice_run_id,
    authorityRevision: c.authority_revision,
    availableLoadIds: c.available_load_ids,
    selectedLoadId: c.selected_load_id,
    expiresAt: c.session_expires_at,
    otpState: c.otp_state,
    challengeId: c.challenge_id,
    otpFailuresRemaining: Math.max(0, 2 - c.otp_failures),
    otpRetryAllowed: c.otp_failures < 2 && c.otp_state !== 'verified',
    verified: c.authority_passed && c.otp_state === 'verified',
    demo: true,
    finalizedAt: c.finalized_at,
    finalOutcome: c.final_outcome,
    negotiation: toPublicNegotiation(s),
    booking: bookingView(s),
    loadInterest: c.load_interest,
  };
}
export const publicLoad = (value: unknown): Data =>
  Object.fromEntries(
    Object.entries(data(value)).filter(([k]) => publicLoadFields.some((field) => field === k)),
  );
export function toOperatorCall(s: Snapshot): Data {
  const c = s.call;
  return {
    id: c.id,
    created_at: c.created_at,
    source: c.source,
    last_activity_at: c.last_activity_at,
    mc: c.authority_check?.mcNumber ?? null,
    carrier: data(c.authority_check?.carrier).legalName ?? null,
    authority_passed: c.authority_passed,
    verified: c.otp_state === 'verified',
    run_id: c.voice_run_id,
    finalized_at: c.finalized_at,
    outcome: c.final_outcome,
    summary: c.final_summary,
    reported_end_reason: c.reported_end_reason,
    ended_at: c.ended_at,
    end_evidence: c.end_evidence,
    selected_load_id: c.selected_load_id,
    load: publicLoad(
      (c.selected_load_id ? c.load_snapshots[c.selected_load_id] : null) ?? c.booking_terms,
    ),
    negotiation: toPublicNegotiation(s),
    booking: bookingView(s),
    interest: c.load_interest,
    reviews: s.reviews.map(({ source_key, ...r }) => r),
  };
}
export function toOperatorEvent(e: Event): Data {
  const keys = [
    'tool',
    'ok',
    'error',
    'reason',
    'outcome',
    'loadId',
    'load_id',
    'command',
    'response',
    'amount',
    'requestedRate',
    'offered_rate',
    'agreed_rate',
    'counter_rounds',
    'status',
    'reference',
    'simulated',
    'note',
    'resolution_note',
    'callback_number',
    'consent',
  ];
  const value: Data = Object.fromEntries(
    Object.entries(e.metadata).filter(([key]) => keys.includes(key)),
  );
  for (const key of ['offered_rate', 'agreed_rate', 'counter_rounds']) {
    const v = data(e.metadata.negotiation)[key];
    if (v !== undefined && v !== null) value[key] = v;
  }
  return { id: e.id, event: e.event, created_at: e.created_at, data: value };
}

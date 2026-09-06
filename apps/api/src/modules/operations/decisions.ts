import { randomUUID } from 'node:crypto';
import {
  data,
  str,
  eq,
  canonical,
  recordCallEvent,
  failure,
  type Snapshot,
  type Data,
  type Call,
} from '../../db/model.js';
import { publicLoad } from '../../application/projections.js';
export function decideReviewUpsert(
  s: Snapshot,
  reason: string,
  detail: string,
  sourceKey: string,
  phone: string | null = null,
  insertOnly = false,
) {
  const existing = s.reviews.find((r) => r.reason === reason);
  if (existing && (insertOnly || existing.source_key === sourceKey)) return;
  const values = {
    status: 'open',
    detail: detail.slice(0, 500),
    callback_number: phone ?? existing?.callback_number ?? null,
    source_key: sourceKey,
    revision: randomUUID(),
    updated_at: s.now,
    reviewed_at: null,
    resolution_note: null,
  };
  if (existing) Object.assign(existing, values);
  else
    s.reviews.push({ id: randomUUID(), call_id: s.call.id, reason, created_at: s.now, ...values });
}
// Match PostgreSQL jsonb textual representation used by historical review source keys.
function pgJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(pgJson).join(', ') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort(
          (a, b) =>
            Buffer.byteLength(a) - Buffer.byteLength(b) ||
            Buffer.compare(Buffer.from(a), Buffer.from(b)),
        )
        .map((k) => JSON.stringify(k) + ': ' + pgJson(Reflect.get(v, k)))
        .join(', ') +
      '}'
    );
  return canonical(v);
}
export function deriveReviewChanges(s: Snapshot, before: Call) {
  const c = s.call;
  if (c.voice_state !== before.voice_state && c.voice_state === 'failed')
    decideReviewUpsert(
      s,
      'technical_error',
      'Voice session could not be started.',
      'voice-start-failed',
    );
  // Preserve the existing AUTHORITY_CHECKING review until a separate behavior fix.
  if (!eq(c.authority_check, before.authority_check) && c.authority_check?.outcome === 'unverified')
    decideReviewUpsert(
      s,
      'technical_error',
      'Carrier authority lookup could not be completed.',
      pgJson(c.authority_check),
    );
  if (!eq(c.load_interest, before.load_interest) && c.load_interest)
    decideReviewUpsert(
      s,
      'callback_requested',
      'Callback requested about pending load ' + str(c.load_interest.load_id),
      str(c.load_interest.reference),
      str(c.load_interest.callback_number),
    );
  if (!eq(c.booking, before.booking) && ['uncertain', 'rejected'].includes(str(c.booking?.status)))
    decideReviewUpsert(
      s,
      c.booking?.status === 'uncertain' ? 'booking_uncertain' : 'booking_failed',
      str(c.booking?.error) || 'Booking needs review',
      str(c.booking?.attempt_id),
    );
  if (c.final_outcome !== before.final_outcome && c.final_outcome === 'technical_error')
    decideReviewUpsert(s, 'technical_error', 'Call ended with a technical error.', 'finalization');
}
export function decideActivity(s: Snapshot, action: string, m: Data) {
  const c = s.call;
  if (
    action === 'source' &&
    ['browser_demo', 'evaluation', 'integration_test'].includes(str(m.source))
  ) {
    if (c.source === 'unknown') c.source = str(m.source);
  } else if (action === 'loads') {
    for (const value of Array.isArray(m.records) ? m.records : []) {
      const item = data(value);
      if (/^[A-Za-z0-9_-]{1,64}$/.test(str(item.LOAD_ID)))
        c.load_snapshots[str(item.LOAD_ID)] = publicLoad(item);
    }
  } else if (action === 'disconnected') {
    if (!c.finalized_at)
      decideReviewUpsert(
        s,
        'missing_finalization',
        'Browser audio disconnected without a saved ending. Check the provider run.',
        'audio-disconnected',
      );
  } else if (action === 'ended') {
    c.ended_at ??= s.now;
    c.end_evidence = 'provider_cancel_acknowledged';
  } else if (action === 'tool') {
    if (!/^[a-z_]{1,50}$/.test(str(m.tool)) || !/^[0-9a-f-]{36}$/.test(str(m.requestId)))
      return failure('INVALID_ACTIVITY');
    if (!s.events.some((e) => e.event === 'tool_result' && e.metadata.requestId === m.requestId)) {
      recordCallEvent(s, 'tool_result', {
        tool: m.tool ?? null,
        ok: m.ok ?? null,
        error: /^[A-Z_0-9]{1,80}$/.test(str(m.error)) ? (m.error ?? null) : null,
        requestId: m.requestId ?? null,
      });
      if (
        m.ok === false &&
        m.error != null &&
        ![
          'OTP_INVALID',
          'OTP_FAILED',
          'AUTHORITY_REQUIRED',
          'OTP_REQUIRED',
          'CALL_FINALIZED',
          'NEGOTIATION_COMPLETE',
          'NEGOTIATION_FAILED',
          'OFFER_ALREADY_ANSWERED',
          'OFFER_CHANGED',
          'OFFER_EXPIRED',
        ].includes(str(m.error))
      )
        decideReviewUpsert(
          s,
          'technical_error',
          str(m.tool) + ': ' + str(m.error),
          str(m.requestId),
        );
    }
  } else return failure('INVALID_ACTIVITY');
  c.last_activity_at = s.now;
  return { result: { ok: true }, activeSession: false };
}
export function reconcileOperationalReviews(s: Snapshot) {
  const c = s.call;
  if (
    !c.finalized_at &&
    c.voice_run_id &&
    (Date.parse(c.session_expires_at) < Date.parse(s.now) || c.ended_at)
  )
    decideReviewUpsert(
      s,
      'missing_finalization',
      'Call has no saved ending. Check the provider run.',
      'missing-finalization',
      null,
      true,
    );
  if (
    c.booking?.status === 'pending' &&
    Date.parse(str(c.booking.attempted_at)) < Date.parse(s.now) - 45000
  )
    decideReviewUpsert(
      s,
      'booking_uncertain',
      'Booking attempt has no confirmed result. Do not retry.',
      str(c.booking.attempt_id),
      null,
      true,
    );
  return { result: { ok: true }, activeSession: false };
}
export function validReviewUpdate(m: Data): boolean {
  return (
    str(m.note).trim().length >= 1 &&
    str(m.note).trim().length <= 500 &&
    ['open', 'reviewed'].includes(str(m.status))
  );
}
export function updateCallReview(s: Snapshot, m: Data) {
  if (!validReviewUpdate(m)) return failure('INVALID_REVIEW');
  const r = s.reviews.find((r) => r.id === m.id);
  if (!r || r.revision !== m.revision) return failure('REVIEW_CHANGED');
  Object.assign(r, {
    status: m.status,
    resolution_note: m.note,
    reviewed_at: m.status === 'reviewed' ? s.now : null,
    updated_at: s.now,
    revision: randomUUID(),
  });
  recordCallEvent(s, 'operator_review', {
    reason: r.reason,
    status: r.status,
    resolution_note: r.resolution_note,
  });
  return { result: { ok: true }, activeSession: false };
}

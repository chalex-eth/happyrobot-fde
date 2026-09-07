import { randomUUID } from 'node:crypto';
import { mockSubmission } from '../../integrations/tms/mock-submission.js';
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
  // An in-progress lookup is not a technical failure.
  if (
    !eq(c.authority_check, before.authority_check) &&
    c.authority_check?.outcome === 'unverified' &&
    c.authority_check.reason !== 'AUTHORITY_CHECKING'
  )
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
  if (!eq(c.booking, before.booking) && c.booking?.status === 'confirmed')
    decideReviewUpsert(
      s,
      'senior_rep_confirmation',
      'Booking recorded for load ' +
        str(c.booking.load_id) +
        '. Senior representative to confirm booking details and collect any remaining documentation.',
      str(c.booking.attempt_id),
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
    if (m.evidence === 'provider_run_terminal') {
      if (
        m.runId !== c.voice_run_id ||
        !['completed', 'canceled', 'failed'].includes(str(m.status))
      )
        return failure('INVALID_ACTIVITY');
      if (c.end_evidence !== 'provider_run_terminal')
        recordCallEvent(s, 'provider_run_ended', { runId: m.runId, status: m.status });
      c.end_evidence = 'provider_run_terminal';
    } else c.end_evidence ??= 'provider_cancel_acknowledged';
    c.ended_at ??= s.now;
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
  if (c.booking?.status === 'confirmed' && c.booking.simulated === true) {
    decideReviewUpsert(
      s,
      'senior_rep_confirmation',
      'Review agreed terms before approving this booking request.',
      str(c.booking.attempt_id),
      null,
      true,
    );
    const review = s.reviews.find((r) => r.reason === 'senior_rep_confirmation');
    // Historical generic review completion is not manager approval.
    if (review && !c.booking.manager_status && review.status !== 'open') {
      review.status = 'open';
      review.revision = randomUUID();
      review.updated_at = s.now;
    }
  }
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
  if (m.action !== undefined)
    return (
      ['approve', 'request_changes', 'reject', 'resubmit', 'comment'].includes(str(m.action)) &&
      typeof m.note === 'string' &&
      str(m.note).trim().length <= 500 &&
      (m.action === 'approve' || str(m.note).trim().length > 0)
    );
  return (
    str(m.note).trim().length >= 1 &&
    str(m.note).trim().length <= 500 &&
    ['open', 'reviewed'].includes(str(m.status))
  );
}
export function updateCallReview(s: Snapshot, m: Data) {
  if (!validReviewUpdate(m)) return failure('INVALID_REVIEW');
  const r = s.reviews.find((r) => r.id === m.id);
  if (!r) return failure('REVIEW_CHANGED');
  // A repeated approval returns the committed result, even with its old revision.
  if (
    m.action === 'approve' &&
    r.reason === 'senior_rep_confirmation' &&
    s.call.booking?.manager_status === 'approved' &&
    data(s.call.booking.submission).status === 'confirmed'
  )
    return { result: { ok: true }, activeSession: false };
  if (r.revision !== m.revision) return failure('REVIEW_CHANGED');
  if (m.action !== undefined) {
    const b = s.call.booking;
    if (r.reason !== 'senior_rep_confirmation' || b?.status !== 'confirmed' || b.simulated !== true)
      return failure('INVALID_REVIEW');
    const status = str(b.manager_status) || 'awaiting_approval';
    const action = str(m.action);
    const allowed =
      action === 'comment' ||
      (status === 'approved' && !b.submission && action === 'approve') ||
      (status === 'awaiting_approval' &&
        ['approve', 'request_changes', 'reject'].includes(action)) ||
      (status === 'changes_requested' && ['resubmit', 'reject'].includes(action));
    if (!allowed) return failure('REVIEW_CHANGED');
    if (action !== 'comment') {
      b.manager_status = (
        {
          approve: 'approved',
          request_changes: 'changes_requested',
          reject: 'rejected',
          resubmit: 'awaiting_approval',
        } as Record<string, string>
      )[action]!;
      b.manager_updated_at = s.now;
      if (action === 'approve') {
        b.submission = mockSubmission(str(b.attempt_id), s.now);
        recordCallEvent(s, 'tms_submission_confirmed', {
          reference: data(b.submission).reference ?? null,
          load_id: b.load_id ?? null,
          simulated: true,
        });
      }
      r.status = ['approve', 'reject'].includes(action) ? 'reviewed' : 'open';
      r.reviewed_at = ['approve', 'reject'].includes(action) ? s.now : null;
      r.resolution_note = str(m.note).trim() || null;
    }
    r.updated_at = s.now;
    r.revision = randomUUID();
    recordCallEvent(s, 'manager_review', {
      response: action,
      status: b.manager_status ?? status,
      note: str(m.note).trim(),
      load_id: b.load_id ?? null,
    });
    return { result: { ok: true }, activeSession: false };
  }
  // A generic completed review must never stand in for a booking decision.
  if (r.reason === 'senior_rep_confirmation' && s.call.booking?.simulated === true)
    return failure('INVALID_REVIEW');
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

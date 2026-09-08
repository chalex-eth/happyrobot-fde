import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildInitialCall } from '../src/modules/calls/decisions.js';
import {
  beginAuthorityCheck,
  completeAuthorityCheck,
  reserveOtpChallenge,
  recordOtpDispatch,
  completeOtpVerification,
  recordOtpFailure,
} from '../src/modules/verification/decisions.js';
import { decideFinalization } from '../src/modules/calls/finalization-decisions.js';
import { saveLoadSearchResults } from '../src/modules/loads/decisions.js';
import { toOperatorCall } from '../src/application/projections.js';
import { OperatorCallSchema, CallOutcomeSchema } from '@carrier/contracts/operations';
import { recordCallEvent, type Snapshot, type Data } from '../src/db/model.js';

function fixture(): Snapshot {
  const now = '2026-09-07T12:00:00.000Z';
  return {
    call: buildInitialCall(randomUUID(), 'a'.repeat(64), now),
    now,
    negotiation: null,
    events: [],
    reviews: [],
    otpReceipts: [],
    offerReceipts: [],
  };
}
function outcome(s: Snapshot) {
  const before = JSON.stringify(s);
  const value = OperatorCallSchema.parse(toOperatorCall(s)).call_outcome!;
  assert.equal(JSON.stringify(s), before, 'Classification must not mutate call or review state');
  assert.ok(!JSON.stringify(value).includes('private@example.test'));
  return value;
}
function authority(s: Snapshot, result = 'eligible') {
  beginAuthorityCheck(s, { mcNumber: '135797' });
  completeAuthorityCheck(s, {
    revision: s.call.authority_revision,
    check: {
      mcNumber: '135797',
      outcome: result,
      eligible: result === 'eligible',
      reason: result === 'unverified' ? 'AUTHORITY_LOOKUP_FAILED' : result,
    },
  });
}
function issue(s: Snapshot, delivered = true) {
  const id = randomUUID();
  reserveOtpChallenge(s, {
    p_challenge: id,
    p_digest: 'a'.repeat(64),
    p_recipient: 'private@example.test',
  });
  recordOtpDispatch(s, { p_challenge: id }, delivered);
  return id;
}
function verify(s: Snapshot) {
  authority(s);
  const id = issue(s);
  completeOtpVerification(s, { p_challenge: id, p_matches: true });
}
function close(s: Snapshot, reported = 'conversation_complete') {
  decideFinalization(s, reported, 'Call finished.', {});
}
function tool(s: Snapshot, name: string, error: string | null) {
  recordCallEvent(s, 'tool_result', { tool: name, ok: !error, error });
}
function search(s: Snapshot, ids: string[], statuses: Data = {}, ok = true) {
  saveLoadSearchResults(s, {
    revision: s.call.authority_revision,
    command: 'LOAD_QUERY',
    ok,
    loadIds: ids,
    loadStatuses: statuses,
  });
}

test('authority rejection, missing carrier and service failure remain distinct without creating review work', () => {
  for (const [state, expected] of [
    ['ineligible', 'authority_ineligible'],
    ['not_found', 'carrier_not_found'],
    ['unverified', 'authority_unavailable'],
  ]) {
    const s = fixture();
    authority(s, state);
    close(s);
    assert.equal(outcome(s).code, expected);
    assert.equal(s.reviews.length, 0);
  }
});
test('wrong-code exhaustion, delivery exhaustion and service exhaustion use actual verification events', () => {
  const s = fixture();
  authority(s);
  const id = issue(s);
  completeOtpVerification(s, { p_challenge: id, p_matches: false });
  assert.equal(outcome(s).code, 'verification_pending');
  completeOtpVerification(s, { p_challenge: id, p_matches: false });
  close(s);
  assert.equal(outcome(s).code, 'otp_attempts_exhausted');
  const delivery = fixture();
  authority(delivery);
  issue(delivery, false);
  issue(delivery, false);
  close(delivery, 'technical_error');
  assert.equal(outcome(delivery).code, 'otp_delivery_failed');
  const service = fixture();
  authority(service);
  recordOtpFailure(service);
  recordOtpFailure(service);
  close(service, 'technical_error');
  assert.equal(outcome(service).code, 'otp_service_failed');
});
test('a rejected code followed by successful verification is not a failed call', () => {
  const s = fixture();
  authority(s);
  const id = issue(s);
  completeOtpVerification(s, { p_challenge: id, p_matches: false });
  completeOtpVerification(s, { p_challenge: id, p_matches: true });
  close(s);
  assert.equal(outcome(s).code, 'verified_no_booking');
});
test('shared mixed retry budget and historical missing events do not claim two wrong codes', () => {
  const s = fixture();
  authority(s);
  issue(s, false);
  const id = issue(s);
  completeOtpVerification(s, { p_challenge: id, p_matches: false });
  close(s);
  assert.equal(outcome(s).code, 'otp_attempts_exhausted');
  assert.match(outcome(s).detail, /shared/);
  s.events = [];
  assert.equal(outcome(s).code, 'verification_failed');
});
test('latest successful search supersedes zero matches, pending-only inventory and recovered service errors', () => {
  const s = fixture();
  verify(s);
  search(s, [], {}, false);
  tool(s, 'search_loads', 'TMS_TIMEOUT');
  search(s, []);
  tool(s, 'search_loads', null);
  close(s);
  assert.equal(outcome(s).code, 'no_loads_found');
  search(s, ['P'], { P: 'PENDING' });
  assert.equal(outcome(s).code, 'pending_loads_only');
  search(s, ['O'], { O: 'OPEN' });
  assert.equal(outcome(s).code, 'loads_found_no_booking');
  s.call.load_interest = { status: 'recorded', load_id: 'P' };
  // Classifier result is also available without requiring a fabricated complete interest DTO.
  assert.equal(
    CallOutcomeSchema.parse(toOperatorCall(s).call_outcome).code,
    'load_interest_recorded',
  );
});
test('carrier recheck does not reuse load errors from an earlier identity', () => {
  const s = fixture();
  verify(s);
  search(s, [], {}, false);
  tool(s, 'search_loads', 'TMS_TIMEOUT');
  authority(s);
  close(s);
  assert.equal(outcome(s).code, 'verification_incomplete');
});
test('unfinalized disconnect and expiry retain their evidence without pretending the caller declined', () => {
  const s = fixture();
  authority(s);
  issue(s);
  s.call.ended_at = s.now;
  assert.equal(outcome(s).code, 'verification_incomplete');
  assert.equal(outcome(s).ending?.code, 'unfinalized');
  s.call.ended_at = null;
  s.call.voice_run_id = randomUUID();
  s.now = '2026-09-07T14:00:00.000Z';
  assert.equal(outcome(s).ending?.code, 'expired');
  const old = fixture();
  old.call.ended_at = old.now;
  assert.equal(outcome(old).code, 'reason_not_recorded');
});
test('saved booking and manager progression survive later technical endings and resolved reviews', () => {
  const s = fixture();
  verify(s);
  s.call.booking = {
    status: 'confirmed',
    attempt_id: randomUUID(),
    load_id: 'L',
    agreed_rate: 100,
    reference: 'MOCK-L',
    attempted_at: s.now,
    handoff_mock: true,
    simulated: true,
  };
  close(s, 'technical_error');
  assert.equal(outcome(s).code, 'booking_awaiting_approval');
  assert.equal(outcome(s).ending?.code, 'technical_error');
  for (const [status, expected] of [
    ['changes_requested', 'booking_changes_requested'],
    ['rejected', 'booking_declined'],
    ['approved', 'booking_approved'],
    ['awaiting_approval', 'booking_awaiting_approval'],
  ]) {
    s.call.booking.manager_status = status;
    assert.equal(outcome(s).code, expected);
  }
  s.call.booking.submission = {
    status: 'confirmed',
    provider: 'demo',
    reference: 'DEMO-L',
    confirmed_at: s.now,
  };
  assert.equal(outcome(s).code, 'booking_submitted_demo');
});
test('pending booking becomes uncertain after its existing confirmation window', () => {
  const s = fixture();
  s.call.booking = {
    status: 'pending',
    attempt_id: randomUUID(),
    load_id: 'L',
    agreed_rate: 100,
    attempted_at: s.now,
    handoff_mock: false,
  };
  assert.equal(outcome(s).code, 'booking_pending');
  s.now = '2026-09-07T12:00:46.000Z';
  assert.equal(outcome(s).code, 'booking_uncertain');
});
test('explicit callback and human requests remain outcomes after their review is completed', () => {
  for (const [reason, expected] of [
    ['callback_requested', 'callback_requested'],
    ['human_requested', 'human_requested'],
    ['other', 'other_review_requested'],
  ]) {
    const s = fixture();
    verify(s);
    decideFinalization(s, 'conversation_complete', 'Caller requested assistance.', {
      reason,
      note: 'Please follow up.',
      ...(reason === 'callback_requested'
        ? { callback_number: '+12125550123', consent: true }
        : {}),
    });
    s.reviews.forEach((r) => {
      r.status = 'reviewed';
    });
    assert.equal(outcome(s).code, expected);
  }
});

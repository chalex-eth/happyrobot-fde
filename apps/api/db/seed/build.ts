import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { CallDetailSchema, OperatorCallSchema } from '@carrier/contracts/operations';
import { CarrierCheckSchema } from '@carrier/contracts/verification';
import {
  SnapshotSchema,
  recordCallEvent,
  type Snapshot,
  type Decision,
} from '../../src/db/model.js';
import { buildInitialCall } from '../../src/modules/calls/decisions.js';
import {
  beginAuthorityCheck,
  completeAuthorityCheck,
  reserveOtpChallenge,
  recordOtpDispatch,
  completeOtpVerification,
} from '../../src/modules/verification/decisions.js';
import { saveLoadSearchResults, authorizeLoadAccess } from '../../src/modules/loads/decisions.js';
import { decideNegotiation } from '../../src/modules/negotiation/decisions.js';
import { decideBooking } from '../../src/modules/booking/decisions.js';
import { decideFinalization } from '../../src/modules/calls/finalization-decisions.js';
import {
  reconcileOperationalReviews,
  updateCallReview,
  decideReviewUpsert,
} from '../../src/modules/operations/decisions.js';
import { toOperatorCall, toOperatorEvent } from '../../src/application/projections.js';
import { scenarios, seedVersion, type Scenario } from './scenarios.js';
export function seedId(key: string): string {
  const h = createHash('sha256').update(`${seedVersion}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const ok = (d: Decision) => assert.equal(d.result.ok, true, String(d.result.error));
export function buildScenario(spec: Scenario, index: number, anchor: Date): Snapshot {
  const start = new Date(+anchor - (index + 1) * 4 * 3600000).toISOString();
  const s: Snapshot = {
    call: buildInitialCall(
      seedId(spec.key),
      createHash('sha256').update(randomUUID()).digest('hex'),
      start,
    ),
    now: start,
    negotiation: null,
    events: [],
    reviews: [],
    otpReceipts: [],
    offerReceipts: [],
  };
  s.call.source = 'seed';
  recordCallEvent(s, 'call_started', {
    seed_version: seedVersion,
    scenario: spec.key,
    simulated: true,
  });
  const tick = () => {
    s.events = structuredClone(s.events);
    s.offerReceipts = structuredClone(s.offerReceipts);
    s.now = new Date(Date.parse(s.now) + 5000).toISOString();
  };
  const mc = String(99000000 + index);
  tick();
  assert.equal(beginAuthorityCheck(s, { mcNumber: mc }), undefined);
  tick();
  const outcome =
    spec.branch === 'ineligible'
      ? 'ineligible'
      : spec.branch === 'not_found'
        ? 'not_found'
        : 'eligible';
  const check = {
    mcNumber: mc,
    outcome,
    eligible: outcome === 'eligible',
    reason:
      outcome === 'eligible'
        ? 'ELIGIBLE'
        : outcome === 'ineligible'
          ? 'AUTHORITY_INACTIVE'
          : 'CARRIER_NOT_FOUND',
    checkedAt: s.now,
    ...(outcome === 'not_found'
      ? {}
      : {
          carrier: {
            dotNumber: String(9900000 + index),
            legalName: `SEED — Demo Carrier ${index + 1}`,
            allowedToOperate: outcome === 'eligible',
            outOfService: false,
            outOfServiceReported: false,
            commonAuthority: outcome === 'eligible' ? 'A' : 'I',
            contractAuthority: null,
          },
        }),
  };
  CarrierCheckSchema.parse(check);
  assert.equal(
    completeAuthorityCheck(s, { revision: s.call.authority_revision, check }),
    undefined,
  );
  if (s.call.authority_passed) {
    for (let attempt = 0; attempt < (spec.branch === 'otp_delivery' ? 2 : 1); attempt++) {
      tick();
      const challenge = seedId(`${spec.key}:otp:${attempt}`);
      assert.equal(
        reserveOtpChallenge(s, {
          p_challenge: challenge,
          p_digest: createHash('sha256').update(randomUUID()).digest('hex'),
          p_recipient: 'seed@example.invalid',
        }),
        undefined,
      );
      tick();
      const dispatched = recordOtpDispatch(
        s,
        { p_challenge: challenge },
        spec.branch !== 'otp_delivery',
      );
      assert.equal(
        dispatched.error,
        spec.branch === 'otp_delivery'
          ? attempt === 0
            ? 'OTP_DELIVERY_FAILED'
            : 'OTP_FAILED'
          : undefined,
      );
    }
    if (spec.branch !== 'otp_delivery') {
      for (let attempt = 0; attempt < (spec.branch === 'otp_wrong' ? 2 : 1); attempt++) {
        tick();
        const verified = completeOtpVerification(s, {
          p_challenge: s.call.challenge_id,
          p_matches: spec.branch !== 'otp_wrong',
        });
        assert.equal(
          verified.error,
          spec.branch === 'otp_wrong' ? (attempt === 0 ? 'OTP_INVALID' : 'OTP_FAILED') : undefined,
        );
      }
    }
  }
  if (s.call.otp_state === 'verified') {
    const loadId = `SEED-V1-${index + 1}`;
    const empty = spec.branch === 'empty';
    tick();
    assert.equal(authorizeLoadAccess(s, { command: 'LOAD_QUERY' }), undefined);
    tick();
    assert.equal(
      saveLoadSearchResults(s, {
        revision: 1,
        command: 'LOAD_QUERY',
        ok: true,
        loadIds: empty ? [] : [loadId],
        loadStatuses: empty ? {} : { [loadId]: 'OPEN' },
      }),
      undefined,
    );
    if (!empty) {
      const terms = {
        LOAD_ID: loadId,
        ORIG_CITY: 'Dallas',
        ORIG_STATE: 'TX',
        ORIG_ZIP: '75201',
        DEST_CITY: 'Atlanta',
        DEST_STATE: 'GA',
        DEST_ZIP: '30301',
        PICKUP_DT: new Date(Date.parse(start) + 86400000).toISOString(),
        DELIVERY_DT: new Date(Date.parse(start) + 172800000).toISOString(),
        EQTYPE: 'V',
        RATE: '2000',
        MILES: '780',
        STATUS: 'OPEN',
        WEIGHT: '38000',
        PIECES: '24',
      };
      tick();
      assert.equal(authorizeLoadAccess(s, { command: 'LOAD_GET', loadId }), undefined);
      tick();
      assert.equal(
        saveLoadSearchResults(s, {
          revision: 1,
          command: 'LOAD_GET',
          loadId,
          ok: true,
          loadStatuses: { [loadId]: 'OPEN' },
        }),
        undefined,
      );
      s.call.load_snapshots = { [loadId]: terms };
      tick();
      ok(
        decideNegotiation(s, {
          action: 'quote',
          loadId,
          revision: 1,
          listedCents: 200000,
          maxCents: 220000,
        }),
      );
      ok(decideBooking(s, 'quote', { loadId, offerId: s.negotiation!.offer_id, terms }));
      for (const amountCents of spec.counters ?? []) {
        tick();
        ok(
          decideNegotiation(s, {
            action: 'counter',
            loadId,
            offerId: s.negotiation!.offer_id,
            amountCents,
          }),
        );
      }
      if (s.negotiation!.status === 'offered') {
        tick();
        ok(
          decideNegotiation(s, {
            action: spec.branch === 'reject' ? 'reject' : 'accept',
            loadId,
            offerId: s.negotiation!.offer_id,
          }),
        );
      }
      if (s.negotiation!.status === 'agreed') {
        tick();
        const attemptId = seedId(`${spec.key}:booking`);
        ok(
          decideBooking(s, 'claim', {
            loadId,
            offerId: s.negotiation!.offer_id,
            terms,
            listedCents: 200000,
            maxCents: 220000,
            attemptId,
            simulated: true,
          }),
        );
        tick();
        ok(
          decideBooking(s, 'complete', {
            attemptId,
            result:
              spec.branch === 'uncertain'
                ? { status: 'uncertain', error: 'TMS_BOOKING_UNCERTAIN', simulated: true }
                : {
                    status: 'confirmed',
                    reference: `SEED-${spec.key}`,
                    timestamp: s.now.replace(/\D/g, '').slice(0, 14),
                    simulated: true,
                  },
          }),
        );
        if (spec.branch === 'uncertain')
          decideReviewUpsert(
            s,
            'booking_uncertain',
            'Synthetic uncertain result. Review before any further booking action.',
            attemptId,
          );
      }
    }
  }
  tick();
  const ending = ['ineligible', 'not_found', 'reject'].includes(spec.branch ?? '')
    ? 'caller_declined'
    : spec.branch === 'otp_delivery'
      ? 'technical_error'
      : 'conversation_complete';
  ok(
    decideFinalization(
      s,
      ending,
      `[SEED ${seedVersion}/${spec.key}] ${spec.summary} All carrier/load facts and provider results are synthetic.`,
      {},
    ),
  );
  reconcileOperationalReviews(s);
  if (spec.manager) {
    tick();
    const review = s.reviews.find((r) => r.reason === 'senior_rep_confirmation')!;
    ok(
      updateCallReview(s, {
        id: review.id,
        revision: review.revision,
        action: spec.manager,
        note: spec.summary,
      }),
    );
  }
  s.call.last_activity_at = s.now;
  s.call.session_expires_at = s.now; // Historical fixtures never create usable sessions.
  s.call.otp_digest = null;
  // Decision functions may retain object references; serialize once before persistence.
  const snapshot = SnapshotSchema.parse(JSON.parse(JSON.stringify(s)));
  snapshot.events.forEach((e, i) => {
    e.id = i + 1;
  });
  validateScenario(snapshot, spec);
  return snapshot;
}
export function validateScenario(s: Snapshot, spec: Scenario, exact = true) {
  SnapshotSchema.parse(s);
  const call = OperatorCallSchema.parse(toOperatorCall(s));
  CallDetailSchema.parse({ ok: true, call, events: s.events.map(toOperatorEvent) });
  assert.equal(s.call.source, 'seed');
  assert.equal(s.call.voice_run_id, null);
  assert.equal(s.call.otp_digest, null);
  assert.ok(s.call.finalized_at);
  assert.ok(
    s.events.some(
      (e) =>
        e.event === 'call_started' &&
        e.metadata.seed_version === seedVersion &&
        e.metadata.scenario === spec.key,
    ),
  );
  if (s.call.booking) assert.equal(s.call.booking.simulated, true);
  if (!s.call.authority_passed || s.call.otp_state !== 'verified') {
    assert.equal(s.call.booking, null);
    assert.equal(s.negotiation, null);
    assert.deepEqual(s.call.available_load_ids, []);
  }
  if (exact) {
    assert.equal(call.call_outcome?.code, spec.outcome, spec.key);
    if (s.negotiation) assert.equal(s.negotiation.counter_rounds, spec.counters?.length ?? 0);
    if (spec.manager === 'approve') {
      assert.equal(s.call.booking?.manager_status, 'approved');
      assert.equal(
        s.reviews.find((r) => r.reason === 'senior_rep_confirmation')?.status,
        'reviewed',
      );
    }
  }
  for (let i = 1; i < s.events.length; i++)
    assert.ok(Date.parse(s.events[i]!.created_at) >= Date.parse(s.events[i - 1]!.created_at));
  return call;
}
export const buildSeed = (anchor = new Date()) =>
  scenarios.map((spec, i) => buildScenario(spec, i, anchor));

import { randomUUID } from 'node:crypto';
import {
  expired,
  eq,
  failure,
  recordCallEvent,
  type Snapshot,
  type Data,
  type Decision,
} from '../../db/model.js';
import { toPublicNegotiation } from '../../application/projections.js';
export type OfferCommand = {
  action: string;
  loadId: string;
  revision?: number | null;
  listedCents?: number | null;
  maxCents?: number | null;
  offerId?: string | null;
  amountCents?: number | null;
};
export function quoteOffer(s: Snapshot, a: OfferCommand): Decision {
  const c = s.call,
    n = s.negotiation,
    listed = a.listedCents,
    max = a.maxCents;
  if (a.revision !== c.authority_revision) return failure('CALL_CHANGED');
  if (listed == null || max == null || listed <= 0 || max < listed || max > 100000000)
    return failure('TMS_PRICING_UNAVAILABLE');
  if (n?.status === 'failed') return failure('NEGOTIATION_FAILED');
  if (
    n?.status === 'agreed' &&
    (n.load_id !== a.loadId || n.listed_cents !== listed || n.max_cents !== max)
  )
    return failure('NEGOTIATION_COMPLETE');
  let changed = false;
  if (!n) {
    changed = true;
    s.negotiation = {
      call_id: c.id,
      authority_revision: c.authority_revision,
      load_id: a.loadId,
      offer_id: randomUUID(),
      listed_cents: listed,
      max_cents: max,
      offered_cents: listed,
      agreed_cents: null,
      counter_rounds: 0,
      status: 'offered',
      expires_at: new Date(Date.parse(s.now) + 120000).toISOString(),
    };
  } else if (
    n.authority_revision !== c.authority_revision ||
    n.load_id !== a.loadId ||
    n.status === 'idle' ||
    (n.status === 'offered' &&
      (expired(n.expires_at, s.now) || n.listed_cents !== listed || n.max_cents !== max))
  ) {
    changed = true;
    const offered =
      n.load_id === a.loadId &&
      n.authority_revision === c.authority_revision &&
      n.listed_cents === listed &&
      n.offered_cents <= max
        ? n.offered_cents
        : listed;
    Object.assign(n, {
      authority_revision: c.authority_revision,
      load_id: a.loadId,
      listed_cents: listed,
      max_cents: max,
      offered_cents: offered,
      agreed_cents: null,
      status: 'offered',
      offer_id: randomUUID(),
      expires_at: new Date(Date.parse(s.now) + 120000).toISOString(),
    });
  }
  const result: Data = { ok: true, negotiation: toPublicNegotiation(s) };
  if (changed) recordCallEvent(s, 'load_offer', result.negotiation as Data);
  return { result };
}
export function acceptOffer(s: Snapshot) {
  const n = s.negotiation!;
  n.status = 'agreed';
  n.agreed_cents = n.offered_cents;
}
export function rejectOffer(s: Snapshot) {
  s.negotiation!.status = 'rejected';
}
export function counterOffer(s: Snapshot, amount: number): string | undefined {
  const n = s.negotiation!;
  if (n.counter_rounds >= 3) return 'NEGOTIATION_FAILED';
  n.counter_rounds++;
  if (amount <= n.max_cents) {
    n.status = 'agreed';
    n.agreed_cents = amount;
    n.offered_cents = amount;
  } else if (n.counter_rounds === 3) n.status = 'failed';
  else {
    const candidate = n.listed_cents + Math.floor((n.listed_cents * 2 * n.counter_rounds) / 100);
    if (candidate <= n.max_cents) n.offered_cents = Math.max(n.offered_cents, candidate);
  }
}
export function decideNegotiation(s: Snapshot, a: OfferCommand): Decision {
  const c = s.call,
    n = s.negotiation;
  if (a.loadId in c.load_statuses && c.load_statuses[a.loadId] !== 'OPEN')
    return failure('LOAD_UNAVAILABLE');
  if (c.booking) return failure('BOOKING_ALREADY_ATTEMPTED');
  if (
    !['quote', 'accept', 'counter', 'reject'].includes(a.action) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(a.loadId)
  )
    return failure('INVALID_OFFER');
  if (expired(c.session_expires_at, s.now)) return failure('SESSION_REQUIRED');
  if (c.finalized_at) return failure('CALL_FINALIZED');
  if (!c.authority_passed) return failure('AUTHORITY_REQUIRED');
  if (c.otp_state !== 'verified' || !c.otp_verified_at) return failure('OTP_REQUIRED');
  if (c.selected_load_id !== a.loadId || !c.available_load_ids.includes(a.loadId))
    return failure('LOAD_NOT_SELECTED');
  if (a.action === 'quote') return quoteOffer(s, a);
  if (
    !a.offerId ||
    (a.action === 'counter' &&
      (a.amountCents == null || a.amountCents <= 0 || a.amountCents > 100000000)) ||
    (a.action !== 'counter' && a.amountCents != null)
  )
    return failure('INVALID_OFFER');
  const fp: Data = {
    load: a.loadId,
    action: a.action,
    amount: a.amountCents ?? null,
    revision: c.authority_revision,
  };
  const receipt = s.offerReceipts.find((r) => r.offer_id === a.offerId);
  if (receipt)
    return eq(receipt.fingerprint, fp)
      ? { result: receipt.result }
      : failure('OFFER_ALREADY_ANSWERED');
  if (
    !n ||
    n.offer_id !== a.offerId ||
    n.authority_revision !== c.authority_revision ||
    n.load_id !== a.loadId
  )
    return failure('OFFER_CHANGED');
  if (n.status !== 'offered') return failure('NEGOTIATION_COMPLETE');
  if (expired(n.expires_at, s.now)) return failure('OFFER_EXPIRED');
  if (a.action === 'accept') acceptOffer(s);
  else if (a.action === 'reject') rejectOffer(s);
  else {
    const e = counterOffer(s, a.amountCents!);
    if (e) return failure(e);
  }
  n.offer_id = randomUUID();
  const result: Data = { ok: true, negotiation: toPublicNegotiation(s) };
  s.offerReceipts.push({ call_id: c.id, offer_id: a.offerId, fingerprint: fp, result });
  recordCallEvent(
    s,
    String(n.status) === 'failed'
      ? 'negotiation_failed'
      : String(n.status) === 'agreed'
        ? 'rate_agreed'
        : 'negotiation_response',
    {
      loadId: a.loadId,
      response: a.action,
      requestedRate: a.amountCents == null ? null : a.amountCents / 100,
      negotiation: result.negotiation ?? null,
    },
  );
  return { result, validUntil: n.expires_at };
}

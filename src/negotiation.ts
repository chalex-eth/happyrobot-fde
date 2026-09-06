import { callAction, resultStatus, SessionError, twinRpc } from './call-session';
import { loadsForCall } from './call-services';
import { getLoadAvailability } from './tms';

export type Negotiation = {
  status: 'idle' | 'offered' | 'agreed' | 'rejected' | 'failed';
  load_id?: string; offer_id?: string; offered_rate?: number | null; agreed_rate?: number | null;
  counter_rounds: number; rounds_remaining: number; expires_at?: string;
  booking_confirmed: false;
};

function decision(result: Awaited<ReturnType<typeof twinRpc>>) {
  if (!result.ok) throw new SessionError(result.error ?? 'NEGOTIATION_UNAVAILABLE', resultStatus(result));
  const n = result.negotiation;
  if (!n || !['offered','agreed','rejected','failed'].includes(n.status)
    || !Number.isInteger(n.counter_rounds) || n.counter_rounds < 0 || n.counter_rounds > 3
    || n.booking_confirmed !== false) throw new SessionError('TWIN_INVALID_RESPONSE');
  // Explicit output allowlist: private database fields can never leak through.
  return { status:n.status, load_id:n.load_id, offer_id:n.offer_id, offered_rate:n.offered_rate,
    agreed_rate:n.agreed_rate, counter_rounds:n.counter_rounds, rounds_remaining:n.rounds_remaining,
    expires_at:n.expires_at, booking_confirmed:false as const };
}

export async function getNegotiableLoad(hash: string, loadId: string, signal?: AbortSignal,
  pricingLookup: typeof getLoadAvailability = getLoadAvailability) {
  const before = await callAction(hash, 'status');
  if (!before.ok) throw new SessionError(before.error ?? 'SESSION_REQUIRED', resultStatus(before));
  let prices: { listedCents:number; maxCents:number } | undefined;
  const result = await loadsForCall(hash, {command:'LOAD_GET',fields:{LOAD_ID:loadId}}, signal, async () => {
    const detail = await pricingLookup(loadId, signal); prices=detail.pricing; return detail.result;
  });
  if (!result.ok) throw new SessionError('TMS_PRICING_UNAVAILABLE');
  const status = result.records[0]?.STATUS;
  if (status !== 'OPEN') return { ...result, negotiation: null, availability: status === 'PENDING' ? 'pending' : 'unavailable',
    can_negotiate: false, can_book: false, manager_review_available: status === 'PENDING' };
  if (!prices) throw new SessionError('TMS_PRICING_UNAVAILABLE');
  const quoted = await twinRpc('poc_negotiate', {p_session_hash:hash,p_action:'quote',p_load_id:loadId,
    p_revision:before.session!.authorityRevision,p_listed_cents:prices.listedCents,p_max_cents:prices.maxCents});
  let negotiation = decision(quoted);
  if (process.env.BOOKING_ENABLED === 'true' && ['offered', 'agreed'].includes(negotiation.status)) {
    const saved = await twinRpc('poc_book_call', { p_session_hash: hash, p_action: 'quote',
      p_metadata: { loadId, offerId: negotiation.offer_id, terms: result.records[0] } });
    if (!saved.ok) throw new SessionError(saved.error ?? 'BOOKING_TERMS_REQUIRED', 409);
    negotiation = decision(saved);
  }
  return { ...result, negotiation };
}

export async function negotiateForCall(hash: string, args: {
  load_id:string; offer_id:string; response:'accept'|'counter'|'reject'; amount?:number;
}) {
  const result = await twinRpc('poc_negotiate', {p_session_hash:hash,p_action:args.response,
    p_load_id:args.load_id,p_offer_id:args.offer_id,
    p_amount_cents:args.amount === undefined ? null : Math.round(args.amount * 100)});
  return {ok:true, negotiation:decision(result)};
}

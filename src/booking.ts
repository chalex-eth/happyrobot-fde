import { randomUUID } from 'node:crypto';
import { SessionError, twinRpc } from './call-session';
import { getLoadPricing, TmsError } from './tms';
import { bookTms, type BookingResult } from './tms-booking';

export type Booking = {
  status: 'pending' | 'confirmed' | 'rejected' | 'uncertain';
  attempt_id: string; load_id: string; agreed_rate: number; reference?: string;
  attempted_at: string; error?: string; handoff_mock: boolean;
};

export function publicBooking(value: Booking): Booking {
  if (!value || !['pending', 'confirmed', 'rejected', 'uncertain'].includes(value.status)
    || !value.attempt_id || !value.load_id || !Number.isFinite(value.agreed_rate)
    || (value.status === 'confirmed' && (!value.reference || value.handoff_mock !== true))) throw new SessionError('TWIN_INVALID_RESPONSE');
  return { status: value.status, attempt_id: value.attempt_id, load_id: value.load_id,
    agreed_rate: value.agreed_rate, attempted_at: value.attempted_at,
    ...(value.reference ? { reference: value.reference } : {}), ...(value.error ? { error: value.error } : {}),
    handoff_mock: value.handoff_mock === true };
}

export async function bookForCall(hash: string, args: { load_id: string; offer_id: string }, signal?: AbortSignal,
  dependencies = { rpc: twinRpc, pricing: getLoadPricing, send: bookTms }) {
  const rpc = (action: string, metadata: Record<string, unknown> = {}) => dependencies.rpc('poc_book_call', {
    p_session_hash: hash, p_action: action, p_metadata: { loadId: args.load_id, offerId: args.offer_id, ...metadata },
  });
  const checked = await rpc('prepare');
  if (!checked.ok) throw new SessionError(checked.error ?? 'BOOKING_NOT_READY', 409);
  const response = (booking: Booking) => ({ ok: true, booking: publicBooking(booking), booking_confirmed: booking.status === 'confirmed' });
  if (checked.booking) return response(checked.booking);
  let detail: Awaited<ReturnType<typeof getLoadPricing>>;
  try { detail = await dependencies.pricing(args.load_id, signal); }
  catch (error) {
    // No booking has been claimed or sent. Save the failed preflight for operations.
    await rpc('preflight_failed', { error: error instanceof TmsError ? error.code : 'TMS_UNAVAILABLE' });
    throw new SessionError('BOOKING_PREFLIGHT_FAILED', 409);
  }
  const attemptId = randomUUID();
  const claimed = await rpc('claim', { attemptId, terms: detail.result.records[0],
    listedCents: detail.pricing.listedCents, maxCents: detail.pricing.maxCents });
  if (!claimed.ok) throw new SessionError(claimed.error ?? 'BOOKING_NOT_READY', 409);
  if (!claimed.booking) throw new SessionError('TWIN_INVALID_RESPONSE');
  if (!claimed.claimed) return response(claimed.booking);
  // Only the invocation with a confirmed atomic claim may send. A lost claim
  // response stops here; a later invocation sees pending and cannot write again.
  let result: BookingResult;
  try {
    if (!claimed.mcNumber || !Number.isSafeInteger(claimed.agreedCents)) throw Error();
    result = await dependencies.send({ loadId: args.load_id, mcNumber: claimed.mcNumber, agreedCents: claimed.agreedCents! }, signal);
  } catch { result = { status: 'uncertain', error: 'TMS_BOOKING_UNCERTAIN' }; }
  try {
    const saved = await rpc('complete', { attemptId, result });
    if (saved.ok && saved.booking) return response(saved.booking);
  } catch { /* Read recovery only: never repeat the network mutation. */ }
  try {
    const recovered = await rpc('status');
    if (recovered.ok && recovered.booking && recovered.booking.status !== 'pending') return response(recovered.booking);
  } catch { /* Persisted claim still prevents another send. */ }
  // TMS may have confirmed but Twin did not acknowledge persistence. Do not
  // claim recorded success/handoff. The durable pending attempt needs review.
  return response({ ...claimed.booking, status: 'uncertain', handoff_mock: false, error: 'BOOKING_RECORD_UNCERTAIN' });
}

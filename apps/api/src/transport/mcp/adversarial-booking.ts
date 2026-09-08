import { bookForCall, type BookingRpc } from '../../modules/booking/index.js';
import { getLoadPricing } from '../../integrations/tms/client.js';
import { twinRpc } from '../../db/twin-client.js';
import { runtimeConfig } from '../../config/env.js';
import { SessionError } from '../../errors.js';

// Only the signed adversarial route calls this fault injector. Real claims and
// uncertain completions are persisted; no external booking is ever sent.
export function uncertainBookingRpc(rpc: BookingRpc): BookingRpc {
  return (name, args) => rpc(name, args.p_action === 'complete'
    ? { ...args, p_metadata: { ...args.p_metadata, result: { status: 'uncertain', error: 'TMS_BOOKING_UNCERTAIN', simulated: true } } }
    : args);
}
export async function bookUncertainForEval(hash: string, args: { load_id: string; offer_id: string }, signal?: AbortSignal) {
  const config = runtimeConfig();
  if (!config.mcp.adversarialEnabled || !config.features.bookingEnabled || config.features.bookingTmsMode !== 'mock')
    throw new SessionError('ADVERSARIAL_BOOKING_MOCK_REQUIRED', 403);
  return bookForCall(hash, args, signal, {
    pricing: getLoadPricing, rpc: uncertainBookingRpc(twinRpc),
    send: async () => { throw new SessionError('ADVERSARIAL_LIVE_BOOKING_FORBIDDEN', 403); },
  });
}

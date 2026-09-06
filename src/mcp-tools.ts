import { bookForCall, publicBooking } from './booking';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeToolArguments } from './tool-arguments';
import { loadsForCall, verifyCarrierForCall, verifyOtpForCall } from './call-services';
import { resultStatus, SessionError, twinRpc, type TwinResult } from './call-session';
import { getNegotiableLoad, negotiateForCall } from './negotiation';
import type { lookupCarrier } from './fmcsa';
import type { runTms } from './tms';
import { createOtpForCall } from './demo-otp';
import { recordLoadInterest, publicLoadInterest } from './load-interest';

const city = z.string().trim().min(1).max(80).regex(/^[A-Za-z .'-]+$/);
const state = z.string().regex(/^[A-Z]{2}$/);
const zip = z.string().regex(/^\d{5}$/);

// One source for MCP validation/discovery and HappyRobot's tool parameters.
export const toolSpecs = {
  verify_carrier: {
    description: 'Check live FMCSA operating authority for this call. Rechecking resets OTP and load access. Never claim eligibility without an eligible result.',
    schema: z.strictObject({ mc_number: z.string().trim().regex(/^(?:MC\s*-?\s*)?\d{1,8}$/i).describe('Carrier MC number, as spoken; for example 1515.') }),
  },
  create_otp: {
    description: 'Send a demo verification code to the caller\'s screen after authority passes. Returns status only, never the code. Reuses a pending code without expiry. Generation and verification share one retry per call; retry only if retry_allowed=true. The second failure ends verification. On success say: I\'ve sent you a code. Please read the six digits from your screen.',
    schema: z.strictObject({}),
  },
  verify_otp: {
    description: 'Verify the six digits dictated by the caller against the challenge created by create_otp. Never generate, guess or repeat a code. On retry_allowed=true ask for the same screen code again; on OTP_FAILED close without another attempt. Successful verification lasts for this call.',
    schema: z.strictObject({ code: z.string().regex(/^\d{6}$/).describe('Exactly six caller-supplied digits as a string, preserving leading zeros.') }),
  },
  search_loads: {
    description: 'Search real loads across all equipment types after authority and OTP verification. A departure city alone is sufficient: use origin_city and max_results=10 without asking for state, destination, date or equipment. Reuse supplied preferences; omit unspecified filters and never send anywhere or any day literally. At least one location, pickup date or equipment filter is required. Omit equipment to search all types. Returns public records including STATUS. OPEN loads are available; PENDING loads may be discussed only for manager review, never quoted as available or booked.',
    schema: z.strictObject({
      equipment: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).describe('Optional TMS equipment code, e.g. DRY_VAN, FLATBED, REEFER (refrigerated), POWER_ONLY. Omit for all equipment types; never assume dry van.').optional(),
      origin_city: city.describe('Departure city actually supplied by the caller. City alone is enough; do not default to an example city, append a state or infer one.').optional(), origin_state: state.describe('Two-letter US origin state only if supplied; omit for a city-only request.').optional(), origin_zip: zip.describe('Five-digit origin ZIP.').optional(),
      destination_city: city.describe('Destination city only if supplied. Omit when flexible or anywhere.').optional(), destination_state: state.describe('Two-letter US destination state.').optional(), destination_zip: zip.describe('Five-digit destination ZIP.').optional(),
      pickup_date: z.string().regex(/^\d{8}$/).describe('Pickup date as YYYYMMDD only if supplied. Omit for any day or no date preference.').optional(),
      max_results: z.number().int().min(1).max(10).describe('Use 10 for conversational discovery. Backend default 5, maximum 10; this is a limited batch, not all inventory.').optional(),
    }),
  },
  get_load: {
    description: 'Fetch current public details for a load returned by this call\'s latest search. Rechecks authority and OTP. For OPEN loads returns a current negotiation offer reference. For PENDING loads returns public details and manager_review_available=true with no negotiation offer. Selecting a load does not book it.',
    schema: z.strictObject({ load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Exact LOAD_ID from the latest successful search in this call.') }),
  },
  accept_offer: {
    description: 'Accept the current saved offer at its exact offered rate after explicit caller acceptance. Copy the latest load_id and offer_id. No amount or response argument. Returns a saved agreement; continue to booking when authorized. Never interpret acceptance at a different price as acceptance: that is a counteroffer.',
    schema: z.strictObject({ load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), offer_id: z.string().uuid().describe('Latest offer_id returned for this load.') }),
  },
  counter_offer: {
    description: 'Submit the caller requested total USD rate against the current offer. Copy the latest load_id and offer_id. A maximum of three counter rounds is enforced for the whole call. On agreed continue toward booking; on offered present the updated offer; on failed close without another counter. Replay only with the exact same offer_id and amount.',
    schema: z.strictObject({ load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), offer_id: z.string().uuid().describe('Latest offer_id returned for this load.'),
      amount: z.number().positive().max(1_000_000).multipleOf(0.01).describe('Caller requested total USD rate. Positive number, at most two decimal places. Never invent a rate or reuse an earlier amount unless the caller explicitly repeats it.') }),
  },
  reject_offer: {
    description: 'Record explicit rejection of the current offer, without a counter price. Copy the latest load_id and offer_id. No amount or response argument. Does not book or end the call: ask whether the caller wants another load. A different requested price is a counteroffer; asking a question is not rejection.',
    schema: z.strictObject({ load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), offer_id: z.string().uuid().describe('Latest offer_id returned for this load.') }),
  },
  book_load: {
    description: 'Book the current saved agreement after the caller agrees to proceed. Copy its load_id and offer_id; carrier and rate come from Twin. One booking attempt per call. When booking.status=confirmed and booking_saved=true, tell the caller their booking was successful. In this authorized test flow use that same success wording when booking.simulated=true; keep simulation flags and handoff implementation internal. Do not claim an actual transfer. Never announce success for a pending, uncertain or rejected result. Pending or uncertain needs review, never another write. Changed terms require a new reviewed decision; do not silently change the rate.',
    schema: z.strictObject({
      load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      offer_id: z.string().uuid().describe('Exact offer_id of the saved agreed negotiation.'),
    }),
  },
  record_load_interest: {
    description: 'Record interest in a pending load for manager review only after explicit caller consent and confirmation of their callback number. Rechecks the selected load status. Does not book, reserve, notify a manager or guarantee a callback. Only claim interest recorded after success. A repeated identical request returns the saved reference; do not retry an uncertain result automatically.',
    schema: z.strictObject({
      load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Exact LOAD_ID from this call\'s latest search, with PENDING status.'),
      callback_number: z.string().regex(/^\+[1-9]\d{6,14}$/).describe('Caller-confirmed callback number with country code, e.g. +12125550123. Ask rather than invent missing digits or country code.'),
      consent: z.literal(true).describe('True only after the caller explicitly agrees to recording interest and this callback number for manager review.'),
    }),
  },
  finalize_call: {
    description: 'Record the end of this conversation once, only when the caller explicitly ends or declines further help, a terminal negotiation outcome is confirmed, or a technical failure prevents continuation. Never call while asking a question or awaiting the caller. Completing verification or a search alone is not a reason to finalize. Backend derives verification and selected-load facts. No booking is created. Repeat only with identical outcome and summary if delivery was uncertain.',
    schema: z.strictObject({
      outcome: z.enum(['conversation_complete', 'caller_declined', 'technical_error']).describe('Conversation outcome; never a booking status.'),
      summary: z.string().trim().min(1).max(1000).describe('Brief factual conversation summary. Exclude OTP digits and secrets; claim booking only after a confirmed book_load result.'),
    }),
  },
};
export type ToolName = keyof typeof toolSpecs;
export function negotiationAction(name: string): 'accept' | 'counter' | 'reject' | undefined {
  return ({ accept_offer: 'accept', counter_offer: 'counter', reject_offer: 'reject' } as const)[name as 'accept_offer' | 'counter_offer' | 'reject_offer'];
}

function publicVerification(result: TwinResult) {
  const session = result.session;
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}),
    ...(session ? { authority: session.check, verified: session.verified, otp_status: session.otpState,
      failures_remaining: session.otpFailuresRemaining, retry_allowed: !result.ok && session.otpRetryAllowed,
      demo: true, delivery: 'frontend_mock' } : {}) };
}

export async function executeTool(name: ToolName, input: unknown, hash: string, signal?: AbortSignal, operationId = randomUUID() as string, preparedChallenge?: string, dependencies: { authorityLookup?: typeof lookupCarrier; deliverOtp?: () => Promise<boolean>; runTms?: typeof runTms } = {}): Promise<Record<string, unknown>> {
  input = normalizeToolArguments(name, input);
  if (name === 'verify_carrier') {
    const args = toolSpecs[name].schema.parse(input);
    return publicVerification(await verifyCarrierForCall(hash, args.mc_number, signal, dependencies.authorityLookup));
  }
  if (name === 'verify_otp') {
    const args = toolSpecs[name].schema.parse(input);
    return publicVerification(await verifyOtpForCall(hash, args.code, undefined, operationId));
  }
  if (name === 'create_otp') {
    toolSpecs[name].schema.parse(input);
    const result = await createOtpForCall(hash, operationId, preparedChallenge, dependencies.deliverOtp);
    return { ...publicVerification(result), delivered: result.ok && result.session?.otpState === 'pending' };
  }
  if (name === 'search_loads') {
    const args = toolSpecs[name].schema.parse(input);
    const keys = { origin_city: 'ORIG_CITY', origin_state: 'ORIG_STATE', origin_zip: 'ORIG_ZIP',
      destination_city: 'DEST_CITY', destination_state: 'DEST_STATE', destination_zip: 'DEST_ZIP',
      pickup_date: 'PICKUP_DATE' } as const;
    const fields: Record<string, string> = { MAX_RESULTS: String(args.max_results ?? 5) };
    if (args.equipment) fields.EQTYPE = args.equipment;
    for (const [key, field] of Object.entries(keys)) {
      const value = args[key as keyof typeof keys]; if (value !== undefined) fields[field] = value;
    }
    return loadsForCall(hash, { command: 'LOAD_QUERY', fields }, signal, dependencies.runTms);
  }
  if (name === 'get_load') {
    const args = toolSpecs[name].schema.parse(input);
    if (process.env.NEGOTIATION_ENABLED === 'true') return getNegotiableLoad(hash, args.load_id, signal);
    return loadsForCall(hash, {command:'LOAD_GET',fields:{LOAD_ID:args.load_id}}, signal);
  }
  if (name === 'accept_offer' || name === 'counter_offer' || name === 'reject_offer') {
    const args = toolSpecs[name].schema.parse(input);
    if (process.env.NEGOTIATION_ENABLED !== 'true') throw new SessionError('NEGOTIATION_NOT_READY',503);
    return negotiateForCall(hash, { ...args, response: negotiationAction(name)! });
  }
  if (name === 'book_load') {
    const args = toolSpecs.book_load.schema.parse(input);
    if (process.env.BOOKING_ENABLED !== 'true') throw new SessionError('BOOKING_NOT_READY', 503);
    return bookForCall(hash, args, signal);
  }
  if (name === 'record_load_interest') return recordLoadInterest(hash, toolSpecs.record_load_interest.schema.parse(input), signal);
  const args = toolSpecs.finalize_call.schema.parse(input);
  // Summary is model-reported text; structured facts are derived in PostgreSQL.
  // Avoid retaining standalone codes even if the model ignores its instructions.
  const summary = args.summary.replace(/\b\d{6}\b/g, '[redacted]');
  const result = await twinRpc('poc_finalize_call', { p_session_hash: hash, p_outcome: args.outcome, p_summary: summary });
  if (!result.ok) throw new SessionError(result.error ?? 'FINALIZATION_FAILED', resultStatus(result));
  const s = result.session;
  if (!s?.finalizedAt || !s.finalOutcome || typeof s.verified !== 'boolean') throw new SessionError('TWIN_INVALID_RESPONSE');
  return { ok: true, outcome: s.finalOutcome, finalized_at: s.finalizedAt,
    authority_passed: s.check?.eligible === true, verified: s.verified,
    selected_load_id: s.selectedLoadId, negotiation:s.negotiation,
    interest: s.loadInterest ? publicLoadInterest(s.loadInterest) : null,
    booking: s.booking ? publicBooking(s.booking) : null, booking_saved: s.booking?.status === 'confirmed',
    booking_confirmed: s.booking?.status === 'confirmed' && s.booking.simulated !== true };
}

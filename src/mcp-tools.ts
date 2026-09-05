import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadsForCall, verifyCarrierForCall, verifyOtpForCall } from './call-services';
import { resultStatus, SessionError, twinRpc, type TwinResult } from './call-session';
import { getNegotiableLoad, negotiateForCall } from './negotiation';
import { createOtpForCall } from './demo-otp';

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
    description: 'Search real loads across all equipment types after authority and OTP verification. Supply at least one location, pickup date or equipment filter. Omit equipment to search all types. Returns public rates only; do not negotiate or book.',
    schema: z.strictObject({
      equipment: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).describe('Optional TMS equipment code, e.g. DRY_VAN, FLATBED, REEFER (refrigerated), POWER_ONLY. Omit for all equipment types; never assume dry van.').optional(),
      origin_city: city.describe('Origin city.').optional(), origin_state: state.describe('Two-letter US origin state.').optional(), origin_zip: zip.describe('Five-digit origin ZIP.').optional(),
      destination_city: city.describe('Destination city.').optional(), destination_state: state.describe('Two-letter US destination state.').optional(), destination_zip: zip.describe('Five-digit destination ZIP.').optional(),
      pickup_date: z.string().regex(/^\d{8}$/).describe('Pickup date as YYYYMMDD.').optional(),
      max_results: z.number().int().min(1).max(10).describe('Result limit; default 5, maximum 10.').optional(),
    }),
  },
  get_load: {
    description: 'Fetch current public details for a load returned by this call\'s latest search. Rechecks authority and OTP. Returns a current negotiation offer reference; use it to accept, reject or counter. Selecting a load does not book it.',
    schema: z.strictObject({ load_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Exact LOAD_ID from the latest successful search in this call.') }),
  },
  negotiate_offer: {
    description: 'Record the caller accepting, rejecting or countering the current offer from get_load or negotiate_offer. Always copy its offer_id and load_id. Only counter accepts an amount in USD. At most three distinct counter rounds per call across all loads. A rate agreement is not a booking. Repeat an uncertain request only with exactly the same arguments and offer_id.',
    schema: z.strictObject({
      load_id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      offer_id:z.string().uuid().describe('Copy the offer_id from the latest negotiation result for this load. Never invent it.'),
      response:z.enum(['accept','counter','reject']),
      amount:z.number().positive().max(1_000_000).multipleOf(0.01).describe('Caller requested total USD rate, at most two decimal places; required only for counter.').optional(),
    }),
  },
  finalize_call: {
    description: 'Record the end of this conversation once. Backend derives verification and selected-load facts. No booking is created. Repeat only with identical outcome and summary if delivery was uncertain.',
    schema: z.strictObject({
      outcome: z.enum(['conversation_complete', 'caller_declined', 'technical_error']).describe('Conversation outcome; never a booking status.'),
      summary: z.string().trim().min(1).max(1000).describe('Brief factual conversation summary. Exclude OTP digits, secrets and claims that a load is booked.'),
    }),
  },
};
export type ToolName = keyof typeof toolSpecs;

function publicVerification(result: TwinResult) {
  const session = result.session;
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}),
    ...(session ? { authority: session.check, verified: session.verified, otp_status: session.otpState,
      failures_remaining: session.otpFailuresRemaining, retry_allowed: !result.ok && session.otpRetryAllowed,
      demo: true, delivery: 'frontend_mock' } : {}) };
}

export async function executeTool(name: ToolName, input: unknown, hash: string, signal?: AbortSignal, operationId = randomUUID() as string): Promise<Record<string, unknown>> {
  if (name === 'verify_carrier') {
    const args = toolSpecs[name].schema.parse(input);
    return publicVerification(await verifyCarrierForCall(hash, args.mc_number, signal));
  }
  if (name === 'verify_otp') {
    const args = toolSpecs[name].schema.parse(input);
    return publicVerification(await verifyOtpForCall(hash, args.code, undefined, operationId));
  }
  if (name === 'create_otp') {
    toolSpecs[name].schema.parse(input);
    const result = await createOtpForCall(hash, operationId);
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
    return loadsForCall(hash, { command: 'LOAD_QUERY', fields }, signal);
  }
  if (name === 'get_load') {
    const args = toolSpecs[name].schema.parse(input);
    if (process.env.NEGOTIATION_ENABLED === 'true') return getNegotiableLoad(hash, args.load_id, signal);
    return loadsForCall(hash, {command:'LOAD_GET',fields:{LOAD_ID:args.load_id}}, signal);
  }
  if (name === 'negotiate_offer') {
    const args=toolSpecs[name].schema.parse(input);
    if ((args.response==='counter') !== (args.amount!==undefined)) throw new SessionError('INVALID_OFFER',400);
    if (process.env.NEGOTIATION_ENABLED !== 'true') throw new SessionError('NEGOTIATION_NOT_READY',503);
    return negotiateForCall(hash,args);
  }
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
    selected_load_id: s.selectedLoadId, negotiation:s.negotiation, booking_confirmed: false };
}

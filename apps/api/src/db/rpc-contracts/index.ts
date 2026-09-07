import { z } from 'zod';
import {
  CallSessionSchema,
  BookingSchema,
  NegotiationSchema,
  LoadInterestSchema,
  CallsPageSchema,
  CallDetailSchema,
  OkResponseSchema,
} from '@carrier/contracts';
import type { LegacyCommands as DatabaseRpc } from './legacy-commands.js';

const metadata = z.record(z.string(), z.unknown());
const text = z.string().min(1);
const nullableText = z.string().nullable().optional();
const cents = z.number().int().safe().nullable().optional();
export const CallActionSchema = z.enum([
  'status',
  'event',
  'otp_result',
  'authority_begin',
  'authority_complete',
  'voice_reserve',
  'voice_bind',
  'voice_failed',
  'issue',
  'sent',
  'failed',
  'otp_failure',
  'prepare_verify',
  'verify',
  'authorize_load',
  'save_loads',
]);
export type CallAction = z.infer<typeof CallActionSchema>;
export const BookingActionSchema = z.enum([
  'quote',
  'prepare',
  'preflight_failed',
  'claim',
  'complete',
  'status',
]);
export type BookingAction = z.infer<typeof BookingActionSchema>;
export const TrackActionSchema = z.enum(['source', 'loads', 'disconnected', 'ended', 'tool']);
export type TrackAction = z.infer<typeof TrackActionSchema>;
export type RpcName = keyof DatabaseRpc;

// Compatibility command contracts. Actual Twin persistence signatures are
// defined by Drizzle; runtime row validation is in db/model.ts.
export const rpcInputs = {
  poc_start_call: z.strictObject({
    p_id: text,
    p_session_hash: text,
    p_previous_hash: nullableText,
  }),
  poc_call_action: z.strictObject({
    p_session_hash: text,
    p_action: CallActionSchema,
    p_challenge: nullableText,
    p_digest: nullableText,
    p_recipient: nullableText,
    p_matches: z.boolean().nullable().optional(),
    p_metadata: metadata.optional(),
  }),
  poc_resolve_voice: z.strictObject({ p_run_id: text }),
  poc_finalize_call: z.strictObject({
    p_session_hash: text,
    p_outcome: text,
    p_summary: z.string(),
    p_review: metadata.optional(),
  }),
  poc_negotiate: z.strictObject({
    p_session_hash: text,
    p_action: z.enum(['quote', 'accept', 'counter', 'reject']),
    p_load_id: text,
    p_revision: z.number().int().nullable().optional(),
    p_listed_cents: cents,
    p_max_cents: cents,
    p_offer_id: nullableText,
    p_amount_cents: cents,
  }),
  poc_book_call: z.strictObject({
    p_session_hash: text,
    p_action: BookingActionSchema,
    p_metadata: metadata.optional(),
  }),
  poc_record_load_interest: z.strictObject({
    p_session_hash: text,
    p_load_id: text,
    p_callback_number: text,
    p_consent: z.boolean(),
    p_revision: z.number().int(),
  }),
  poc_track_call: z.strictObject({
    p_session_hash: text,
    p_action: TrackActionSchema,
    p_metadata: metadata.optional(),
  }),
  poc_operator: z.strictObject({
    p_key: text,
    p_action: z.enum(['list', 'detail', 'review']),
    p_metadata: metadata.optional(),
  }),
} satisfies { [K in RpcName]: z.ZodType<DatabaseRpc[K]['Args']> };
export type RpcArgs<K extends RpcName> = z.input<(typeof rpcInputs)[K]>;

const fields = {
  error: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  session: CallSessionSchema.optional(),
  replayed: z.boolean().optional(),
  negotiation: NegotiationSchema.nullable().optional(),
  booking: BookingSchema.nullable().optional(),
  interest: LoadInterestSchema.nullable().optional(),
  claimed: z.boolean().optional(),
  mcNumber: z.string().optional(),
  agreedCents: z.number().int().safe().optional(),
  verifier: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sessionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  review_recorded: z.boolean().optional(),
};
export const TwinResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...fields }),
  z.object({ ...fields, ok: z.literal(false), error: z.string().min(1) }),
]);
export type TwinResult = z.infer<typeof TwinResultSchema>;
export type CallRpcName = Exclude<RpcName, 'poc_operator' | 'poc_track_call'>;
export type CallRpcRequest = { [K in CallRpcName]: [name: K, args: RpcArgs<K>] }[CallRpcName];

export function parseCallResult(
  name: CallRpcName,
  args: RpcArgs<CallRpcName>,
  value: unknown,
): TwinResult {
  const result = TwinResultSchema.parse(value);
  if (!result.ok) {
    const { verifier, sessionHash, ...failure } = result;
    return failure;
  }
  // Successful functions have different payloads. A JSON object with ok:true
  // alone is not proof of a session, agreement, binding, or recorded interest.
  if (name === 'poc_start_call' || name === 'poc_finalize_call')
    CallSessionSchema.parse(result.session);
  if (name === 'poc_resolve_voice') fields.sessionHash.unwrap().parse(result.sessionHash);
  if (name === 'poc_negotiate') NegotiationSchema.parse(result.negotiation);
  if (name === 'poc_record_load_interest') LoadInterestSchema.parse(result.interest);
  if (name === 'poc_call_action') {
    if ('p_action' in args && args.p_action === 'prepare_verify' && !result.replayed)
      fields.verifier.unwrap().parse(result.verifier);
    else CallSessionSchema.parse(result.session);
  }
  const { verifier, sessionHash, ...publicResult } = result;
  if (name === 'poc_resolve_voice') return { ...publicResult, sessionHash };
  if (
    name === 'poc_call_action' &&
    'p_action' in args &&
    args.p_action === 'prepare_verify' &&
    !result.replayed
  )
    return { ...publicResult, verifier };
  return publicResult;
}
export const operatorResults = {
  list: CallsPageSchema,
  detail: CallDetailSchema,
  review: OkResponseSchema,
};

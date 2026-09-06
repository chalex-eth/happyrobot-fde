import { z } from 'zod';
import type { DatabaseTables } from './generated/database.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);
export const DataSchema = z.record(z.string(), JsonSchema);
const integer = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform(Number)
  .pipe(z.number().int().safe());
export const data = (v: unknown): Data =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? DataSchema.parse(v) : {};
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const eq = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(Reflect.get(v, k)))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
export const expired = (value: string, now: string): boolean =>
  Date.parse(value) <= Date.parse(now);
export const CallSchema = z.strictObject({
  id: z.string().uuid(),
  session_hash: z.string(),
  authority_check: DataSchema.nullable(),
  authority_passed: z.boolean(),
  created_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  session_expires_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  otp_state: z.enum([
    'not_sent',
    'dispatching',
    'pending',
    'failed',
    'expired',
    'locked',
    'verified',
  ]),
  challenge_id: z.string().uuid().nullable(),
  otp_digest: z.string().nullable(),
  otp_expires_at: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)))
    .nullable(),
  otp_attempts: z.number().int(),
  otp_verified_at: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)))
    .nullable(),
  demo_recipient: z.string().nullable(),
  authority_revision: z.number().int(),
  available_load_ids: z.array(z.string()),
  selected_load_id: z.string().nullable(),
  voice_run_id: z.string().nullable(),
  voice_state: z.enum(['idle', 'creating', 'ready', 'failed']),
  finalized_at: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)))
    .nullable(),
  final_outcome: z.string().nullable(),
  final_summary: z.string().nullable(),
  final_result: DataSchema.nullable(),
  otp_failures: z.number().int().min(0).max(2),
  booking: DataSchema.nullable(),
  booking_terms: DataSchema.nullable(),
  load_statuses: DataSchema,
  load_interest: DataSchema.nullable(),
  source: z.string(),
  last_activity_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  reported_end_reason: z.string().nullable(),
  ended_at: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)))
    .nullable(),
  end_evidence: z.string().nullable(),
  load_snapshots: DataSchema,
  revision: integer,
}) satisfies z.ZodType<DatabaseTables['public.poc_calls']>;
export type Call = z.output<typeof CallSchema>;
export const NegotiationRowSchema = z.strictObject({
  call_id: z.string().uuid(),
  authority_revision: z.number().int(),
  load_id: z.string(),
  offer_id: z.string().uuid(),
  listed_cents: integer,
  max_cents: integer,
  offered_cents: integer,
  agreed_cents: integer.nullable(),
  counter_rounds: z.number().int().min(0).max(3),
  status: z.string(),
  expires_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
}) satisfies z.ZodType<DatabaseTables['poc_private.negotiations']>;
export type NegotiationRow = z.output<typeof NegotiationRowSchema>;
export const ReviewSchema = z.strictObject({
  id: z.string().uuid(),
  call_id: z.string().uuid(),
  reason: z.string(),
  status: z.string(),
  detail: z.string(),
  callback_number: z.string().nullable(),
  source_key: z.string(),
  revision: z.string().uuid(),
  created_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  updated_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  resolution_note: z.string().nullable(),
  reviewed_at: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)))
    .nullable(),
}) satisfies z.ZodType<DatabaseTables['public.poc_reviews']>;
export type Review = z.output<typeof ReviewSchema>;
export const EventSchema = z.strictObject({
  id: integer,
  call_id: z.string().uuid(),
  event: z.string(),
  created_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  metadata: DataSchema,
}) satisfies z.ZodType<DatabaseTables['public.poc_call_events']>;
export type Event = z.output<typeof EventSchema>;
export const OtpReceiptSchema = z.strictObject({
  call_id: z.string().uuid(),
  operation_id: z.string(),
  authority_revision: z.number().int(),
  fingerprint: z.string(),
  result: DataSchema,
}) satisfies z.ZodType<DatabaseTables['poc_private.otp_receipts']>;
export type OtpReceipt = z.output<typeof OtpReceiptSchema>;
export const OfferReceiptSchema = z.strictObject({
  call_id: z.string().uuid(),
  offer_id: z.string().uuid(),
  fingerprint: DataSchema,
  result: DataSchema,
}) satisfies z.ZodType<DatabaseTables['poc_private.offer_receipts']>;
export type OfferReceipt = z.output<typeof OfferReceiptSchema>;
export const SnapshotSchema = z.strictObject({
  call: CallSchema,
  negotiation: NegotiationRowSchema.nullable(),
  now: z.string(),
  events: z.array(EventSchema),
  reviews: z.array(ReviewSchema),
  otpReceipts: z.array(OtpReceiptSchema),
  offerReceipts: z.array(OfferReceiptSchema),
});
export type Snapshot = z.output<typeof SnapshotSchema>;
export type NewEvent = Omit<Event, 'id' | 'call_id'>;
export const ChangesSchema = z.strictObject({
  call: CallSchema.omit({ id: true, session_hash: true, created_at: true, revision: true })
    .partial()
    .optional(),
  negotiation: NegotiationRowSchema.optional(),
  events: z.array(EventSchema.omit({ id: true, call_id: true })).optional(),
  reviews: z.array(ReviewSchema).optional(),
  otpReceipts: z.array(OtpReceiptSchema).optional(),
  offerReceipts: z.array(OfferReceiptSchema).optional(),
});
export type Changes = z.output<typeof ChangesSchema>;
export const CommitSchema = z.strictObject({
  callId: z.string().uuid(),
  operationId: z.string().min(1).max(128),
  phase: z.string().min(1).max(64),
  fingerprint: z.string(),
  expectedRevision: integer,
  preconditions: z.strictObject({ activeSession: z.boolean(), validUntil: z.string().optional() }),
  changes: ChangesSchema,
  result: DataSchema,
});
export type CommitCommand = z.output<typeof CommitSchema>;
export type Decision = { result: Data; activeSession?: boolean; validUntil?: string };
export const failure = (error: string): Decision => ({ result: { ok: false, error } });
export function recordCallEvent(s: Snapshot, event: string, metadata: Data = {}) {
  s.events.push({ id: 0, call_id: s.call.id, event, metadata, created_at: s.now });
}

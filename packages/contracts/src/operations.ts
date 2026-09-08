import { z } from 'zod';
import { LoadSnapshotSchema, PublicLoadSchema } from './loads';
import { BookingSchema } from './booking';
import { NegotiationSchema } from './negotiation';
import { LoadInterestSchema } from './interest';
export const ReviewSchema = z.object({
  id: z.string(),
  call_id: z.string(),
  reason: z.string(),
  status: z.enum(['open', 'reviewed']),
  detail: z.string(),
  callback_number: z.string().nullable(),
  revision: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  resolution_note: z.string().nullable(),
  reviewed_at: z.string().nullable(),
});
export type Review = z.infer<typeof ReviewSchema>;
export const CallOutcomeSchema = z.object({
  code: z.enum([
    'booking_submitted_demo',
    'booked',
    'booking_declined',
    'booking_changes_requested',
    'booking_approved',
    'booking_awaiting_approval',
    'booking_failed',
    'booking_uncertain',
    'booking_pending',
    'load_interest_recorded',
    'authority_ineligible',
    'carrier_not_found',
    'authority_unavailable',
    'otp_delivery_failed',
    'otp_service_failed',
    'otp_attempts_exhausted',
    'verification_failed',
    'booking_terms_changed',
    'booking_blocked',
    'session_interrupted',
    'load_lookup_failed',
    'interest_not_recorded',
    'technical_error',
    'voice_failed',
    'negotiation_exhausted',
    'rate_agreed',
    'offer_rejected',
    'load_unavailable',
    'callback_requested',
    'human_requested',
    'other_review_requested',
    'verification_incomplete',
    'authority_checking',
    'verification_pending',
    'not_started',
    'awaiting_mc',
    'no_loads_found',
    'pending_loads_only',
    'no_open_loads',
    'offer_unanswered',
    'loads_found_no_booking',
    'verified_no_booking',
    'negotiating',
    'searching',
    'verified',
    'reason_not_recorded',
  ]),
  label: z.string(),
  detail: z.string(),
  ending: z
    .object({
      code: z.enum([
        'technical_error',
        'caller_declined',
        'completed',
        'voice_failed',
        'unfinalized',
        'expired',
      ]),
      label: z.string(),
    })
    .nullable(),
});
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;
export const OperatorCallSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  source: z.string(),
  last_activity_at: z.string(),
  mc: z.string().nullable(),
  carrier: z.string().nullable(),
  run_id: z.string().nullable(),
  authority_passed: z.boolean(),
  verified: z.boolean(),
  finalized_at: z.string().nullable(),
  outcome: z.string().nullable(),
  call_outcome: CallOutcomeSchema.optional(),
  summary: z.string().nullable(),
  reported_end_reason: z.string().nullable(),
  ended_at: z.string().nullable(),
  end_evidence: z.string().nullable(),
  selected_load_id: z.string().nullable(),
  load: LoadSnapshotSchema,
  negotiation: NegotiationSchema.nullable(),
  negotiation_started_at: z.string().nullable().optional(),
  negotiation_agreed: z.boolean().optional(),
  booking: BookingSchema.nullable(),
  interest: LoadInterestSchema.nullable(),
  reviews: z.array(ReviewSchema),
});
export type OperatorCall = z.infer<typeof OperatorCallSchema>;
// SQL exposes only these event fields. Nested raw metadata is intentionally absent.
export const CallEventDataSchema = z.object({
  tool: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  loadId: z.string().nullable().optional(),
  load_id: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  response: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  resolution_note: z.string().nullable().optional(),
  callback_number: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  requestedRate: z.number().nullable().optional(),
  offered_rate: z.number().nullable().optional(),
  agreed_rate: z.number().nullable().optional(),
  counter_rounds: z.number().nullable().optional(),
  ok: z.boolean().nullable().optional(),
  simulated: z.boolean().nullable().optional(),
  consent: z.boolean().nullable().optional(),
});
export const CallEventSchema = z.object({
  id: z.number().int(),
  event: z.string(),
  created_at: z.string(),
  data: CallEventDataSchema,
});
export type CallEvent = z.infer<typeof CallEventSchema>;
export const CallsPageSchema = z.object({
  ok: z.literal(true),
  calls: z.array(OperatorCallSchema),
  total: z.number().int(),
  review_count: z.number().int(),
});
export type CallsPage = z.infer<typeof CallsPageSchema>;
export const CallDetailSchema = z.object({
  ok: z.literal(true),
  call: OperatorCallSchema.nullable(),
  events: z.array(CallEventSchema),
});
export const ReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: ReviewSchema.optional(),
});
const LegacyReviewRequestSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  status: z.enum(['open', 'reviewed']),
  note: z.string().trim().min(1).max(500),
});
export const ManagerReviewRequestSchema = z
  .strictObject({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    action: z.enum(['approve', 'request_changes', 'reject', 'resubmit', 'comment']),
    note: z.string().trim().max(500).default(''),
  })
  .refine((m) => m.action === 'approve' || m.note.length > 0, { message: 'A comment is required' });
export const ReviewRequestSchema = z.union([LegacyReviewRequestSchema, ManagerReviewRequestSchema]);
export const CallsQuerySchema = z.object({
  source: z
    .enum(['all', 'browser_demo', 'evaluation', 'integration_test', 'seed', 'unknown'])
    .default('all'),
  review: z.enum(['true', 'false']).default('false'),
  query: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9_-]*$/)
    .default(''),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(30),
});
export const PointSchema = z.tuple([z.number(), z.number()]);
export type Point = z.infer<typeof PointSchema>;
export const MappedLoadSchema = PublicLoadSchema.and(
  z.object({ origin_point: PointSchema.optional(), destination_point: PointSchema.optional() }),
);
export type MappedLoad = z.infer<typeof MappedLoadSchema>;
export const InventorySchema = z.object({
  ok: z.literal(true),
  records: z.array(MappedLoadSchema),
  retrieved_at: z.string(),
  coverage: z.object({
    states: z.number().int(),
    failed_states: z.array(z.string()),
    capped_states: z.array(z.string()),
    complete: z.boolean(),
  }),
});
export type Inventory = z.infer<typeof InventorySchema>;

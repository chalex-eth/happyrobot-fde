import { z } from 'zod';
import { CarrierCheckSchema, DemoOtpSchema } from './verification';
import { BookingSchema } from './booking';
import { NegotiationSchema } from './negotiation';
import { LoadInterestSchema } from './interest';
export const CallSessionSchema = z.object({
  callId: z.string().min(1),
  check: CarrierCheckSchema.nullable(),
  authorityRevision: z.number().int().nonnegative(),
  availableLoadIds: z.array(z.string()),
  selectedLoadId: z.string().nullable(),
  voiceState: z.enum(['idle', 'creating', 'ready', 'failed']),
  voiceRunId: z.string().nullable(),
  expiresAt: z.string().min(1),
  otpState: z.enum(['not_sent', 'dispatching', 'pending', 'failed', 'verified']),
  challengeId: z.string().nullable(),
  otpFailuresRemaining: z.number().int().min(0).max(2),
  otpRetryAllowed: z.boolean(),
  verified: z.boolean(),
  demo: z.literal(true),
  loadInterest: LoadInterestSchema.nullable().optional(),
  booking: BookingSchema.nullable().optional(),
  negotiation: NegotiationSchema.nullable().optional(),
  finalizedAt: z.string().nullable().optional(),
  finalOutcome: z.string().nullable().optional(),
});
export type CallSession = z.infer<typeof CallSessionSchema>;
export const CallRequestSchema = z.strictObject({ action: z.enum(['start', 'status']) });
export const LocalCallResponseSchema = z.object({
  ok: z.literal(true),
  session: CallSessionSchema,
  demoOtp: DemoOtpSchema.nullable().optional(),
  requestId: z.string().optional(),
});
export const VoiceTokenSchema = z.object({
  token: z.string().min(1),
  url: z.string().url(),
  room_name: z.string().min(1),
  run_id: z.string().uuid(),
});
export const VoiceResponseSchema = z.object({
  ok: z.literal(true),
  session: CallSessionSchema,
  voice: VoiceTokenSchema,
});
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export const ErrorResponseSchema = z.object({ ok: z.literal(false), error: z.string() });

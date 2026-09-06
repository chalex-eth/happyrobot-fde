import { z } from 'zod';
export const NegotiationSchema = z.object({
  status: z.enum(['idle', 'offered', 'agreed', 'rejected', 'failed']),
  load_id: z.string().optional(),
  offer_id: z.string().optional(),
  offered_rate: z.number().nullable().optional(),
  agreed_rate: z.number().nullable().optional(),
  counter_rounds: z.number().int().min(0).max(3),
  rounds_remaining: z.number().int().min(0).max(3),
  expires_at: z.string().optional(),
  booking_confirmed: z.literal(false),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

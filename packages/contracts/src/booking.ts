import { z } from 'zod';
export const BookingSchema = z
  .object({
    status: z.enum(['pending', 'confirmed', 'rejected', 'uncertain']),
    attempt_id: z.string().min(1),
    load_id: z.string().min(1),
    agreed_rate: z.number(),
    reference: z.string().optional(),
    attempted_at: z.string(),
    error: z.string().optional(),
    handoff_mock: z.boolean(),
    simulated: z.boolean().optional(),
  })
  .refine((b) => b.status !== 'confirmed' || (!!b.reference && b.handoff_mock), {
    message: 'Confirmed booking requires a reference and handoff evidence',
  });
export type Booking = z.infer<typeof BookingSchema>;

import { z } from 'zod';
export const LoadInterestSchema = z.object({
  reference: z.string().uuid(),
  load_id: z.string(),
  callback_number: z.string(),
  status: z.literal('recorded'),
  requested_at: z.string(),
  notification_sent: z.literal(false),
  callback_guaranteed: z.literal(false),
});
export type LoadInterest = z.infer<typeof LoadInterestSchema>;

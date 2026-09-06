import { z } from 'zod';
export const CarrierCheckSchema = z.object({
  mcNumber: z.string().min(1),
  outcome: z.enum(['eligible', 'ineligible', 'not_found', 'unverified']),
  eligible: z.boolean(),
  reason: z.string(),
  checkedAt: z.string(),
  carrier: z
    .object({
      dotNumber: z.string(),
      legalName: z.string(),
      allowedToOperate: z.boolean().nullable(),
      outOfService: z.boolean().nullable(),
      outOfServiceReported: z.boolean(),
      commonAuthority: z.string().nullable(),
      contractAuthority: z.string().nullable(),
    })
    .optional(),
});
export type CarrierCheck = z.infer<typeof CarrierCheckSchema>;
export const DemoOtpSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  challengeId: z.string(),
  failuresRemaining: z.number().int().min(0).max(2),
});
export type DemoOtp = z.infer<typeof DemoOtpSchema>;
export const CarrierRequestSchema = z.strictObject({ mcNumber: z.string().min(1) });

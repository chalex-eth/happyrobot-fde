import { z } from 'zod';
export const publicLoadFields = [
  'LOAD_ID',
  'ORIG_CITY',
  'ORIG_STATE',
  'ORIG_ZIP',
  'DEST_CITY',
  'DEST_STATE',
  'DEST_ZIP',
  'PICKUP_DT',
  'DELIVERY_DT',
  'EQTYPE',
  'RATE',
  'MILES',
  'STATUS',
  'WEIGHT',
  'PIECES',
] as const;
// TMS returns string fields. Project through an allowlist, including snapshots
// with no selected load, so private pricing and free text never reach clients.
export const LoadSnapshotSchema = z
  .record(z.string(), z.unknown())
  .transform((value) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => publicLoadFields.some((field) => field === key)),
    ),
  )
  .pipe(z.record(z.string(), z.string()));
export const PublicLoadSchema = LoadSnapshotSchema.and(z.object({ LOAD_ID: z.string().min(1) }));
export type PublicLoad = z.infer<typeof PublicLoadSchema>;
export const TmsRequestSchema = z.strictObject({
  command: z.enum(['DEBUG_ECHO', 'LOAD_QUERY', 'LOAD_GET']),
  fields: z.record(z.string(), z.string()).optional(),
});
export type TmsRequest = z.infer<typeof TmsRequestSchema>;
export type TmsCommand = TmsRequest['command'];
export const TmsResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  records: z.array(PublicLoadSchema).optional(),
  requestId: z.string(),
  attempts: z.number().optional(),
  elapsed_ms: z.number().optional(),
});

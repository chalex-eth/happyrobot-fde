import { z } from 'zod';
import { callAction, resultStatus, SessionError, twinRpc } from './call-session';
import { loadsForCall } from './call-services';

const loadInterestSchema = z.object({
  reference: z.string().uuid(), load_id: z.string(), callback_number: z.string(),
  status: z.literal('recorded'), requested_at: z.string(),
  notification_sent: z.literal(false), callback_guaranteed: z.literal(false),
});
export type LoadInterest = z.infer<typeof loadInterestSchema>;
export function publicLoadInterest(value: unknown): LoadInterest {
  const parsed = loadInterestSchema.safeParse(value);
  if (!parsed.success) throw new SessionError('TWIN_INVALID_RESPONSE');
  return parsed.data;
}

export async function recordLoadInterest(hash: string, args: { load_id: string; callback_number: string; consent: true }, signal?: AbortSignal) {
  const before = await callAction(hash, 'status');
  if (!before.ok) throw new SessionError(before.error ?? 'SESSION_REQUIRED', resultStatus(before));
  // Recovery reads the saved request; it never creates a second review item.
  if (!before.session?.loadInterest) {
    const detail = await loadsForCall(hash, { command: 'LOAD_GET', fields: { LOAD_ID: args.load_id } }, signal);
    if (!detail.ok) throw new SessionError(detail.error, 503);
    if (detail.records[0]?.STATUS !== 'PENDING') throw new SessionError('LOAD_STATUS_CHANGED', 409);
  }
  const saved = await twinRpc('poc_record_load_interest', { p_session_hash: hash, p_load_id: args.load_id,
    p_callback_number: args.callback_number, p_consent: args.consent, p_revision: before.session!.authorityRevision });
  if (!saved.ok) throw new SessionError(saved.error ?? 'INTEREST_NOT_RECORDED', resultStatus(saved));
  return { ok: true, interest: publicLoadInterest(saved.interest) };
}

import { randomUUID } from 'node:crypto';
import {
  expired,
  failure,
  recordCallEvent,
  type Snapshot,
  type Data,
  type Decision,
} from '../../db/model.js';
export function decideLoadInterest(
  s: Snapshot,
  loadId: string,
  phone: string,
  consent: boolean,
  revision: number,
): Decision {
  const c = s.call;
  if (expired(c.session_expires_at, s.now)) return failure('SESSION_REQUIRED');
  if (!c.authority_passed || c.authority_check?.eligible !== true)
    return failure('AUTHORITY_REQUIRED');
  if (c.otp_state !== 'verified') return failure('OTP_REQUIRED');
  if (c.authority_revision !== revision) return failure('CALL_CHANGED');
  if (consent !== true || !/^\+[1-9][0-9]{6,14}$/.test(phone))
    return failure('INVALID_INTEREST_REQUEST');
  if (c.load_interest)
    return c.load_interest.load_id === loadId && c.load_interest.callback_number === phone
      ? { result: { ok: true, interest: c.load_interest, replayed: true } }
      : failure('INTEREST_ALREADY_RECORDED');
  if (c.finalized_at) return failure('CALL_FINALIZED');
  if (c.booking) return failure('BOOKING_ALREADY_ATTEMPTED');
  if (!c.available_load_ids.includes(loadId)) return failure('LOAD_NOT_IN_CALL');
  if (c.load_statuses[loadId] !== 'PENDING') return failure('LOAD_STATUS_CHANGED');
  const item: Data = {
    reference: randomUUID(),
    load_id: loadId,
    callback_number: phone,
    status: 'recorded',
    requested_at: s.now,
    notification_sent: false,
    callback_guaranteed: false,
  };
  c.load_interest = item;
  recordCallEvent(s, 'load_interest_recorded', {
    ...item,
    consent: true,
    authority_revision: c.authority_revision,
  });
  return { result: { ok: true, interest: item } };
}

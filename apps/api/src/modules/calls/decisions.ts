import {
  CallSchema,
  str,
  data,
  expired,
  recordCallEvent,
  failure,
  type Snapshot,
  type Data,
  type Decision,
} from '../../db/model.js';
import { toPublicSession } from '../../application/projections.js';
import {
  beginAuthorityCheck,
  completeAuthorityCheck,
  reserveOtpChallenge,
  recordOtpDispatch,
  recordOtpFailure,
  prepareOtpVerification,
  completeOtpVerification,
  type ActionInput,
} from '../verification/index.js';
import { authorizeLoadAccess, saveLoadSearchResults } from '../loads/index.js';
export function requireActiveSession(s: Snapshot): string | undefined {
  if (expired(s.call.session_expires_at, s.now)) return 'SESSION_REQUIRED';
}
export function getCallSession(s: Snapshot): Decision {
  const e = requireActiveSession(s);
  return e ? failure(e) : { result: { ok: true, error: null, session: toPublicSession(s) } };
}
export function reserveVoiceSession(s: Snapshot): string | undefined {
  if (s.call.voice_state !== 'idle') return 'VOICE_ALREADY_STARTED';
  s.call.voice_state = 'creating';
  recordCallEvent(s, 'voice_requested');
}
export function bindVoiceSession(s: Snapshot, m: Data): string | undefined {
  if (s.call.voice_state !== 'creating') return 'VOICE_ALREADY_STARTED';
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(str(m.runId))) throw Error('Invalid run');
  s.call.voice_state = 'ready';
  s.call.voice_run_id = str(m.runId);
  recordCallEvent(s, 'voice_bound');
}
export function recordVoiceFailure(s: Snapshot): string | undefined {
  if (s.call.voice_state === 'creating') s.call.voice_state = 'failed';
  recordCallEvent(s, 'voice_start_failed');
  return undefined;
}
export function resolveVoiceSession(s: Snapshot | null): Data {
  return !s || s.call.voice_state !== 'ready' || requireActiveSession(s)
    ? { ok: false, error: 'VOICE_BINDING_REQUIRED' }
    : { ok: true, sessionHash: s.call.session_hash };
}
export function decideCallAction(s: Snapshot, action: string, a: ActionInput): Decision {
  const c = s.call,
    m = data(a.p_metadata),
    operation = str(m.operationId);
  if (c.load_interest && action === 'authority_begin') return failure('INTEREST_ALREADY_RECORDED');
  if (c.booking && !['status', 'voice_failed'].includes(action))
    return failure('BOOKING_ALREADY_ATTEMPTED');
  const active = requireActiveSession(s);
  if (active) return failure(active);
  if (c.finalized_at && !['status', 'voice_failed'].includes(action))
    return failure('CALL_FINALIZED');
  if (['authorize_load', 'save_loads'].includes(action)) {
    if (s.negotiation?.status === 'failed') return failure('NEGOTIATION_FAILED');
    if (
      s.negotiation?.status === 'agreed' &&
      (m.command !== 'LOAD_GET' || m.loadId !== s.negotiation.load_id)
    )
      return failure('NEGOTIATION_COMPLETE');
  }
  if (
    operation &&
    ['issue', 'sent', 'failed', 'otp_failure', 'prepare_verify', 'verify', 'otp_result'].includes(
      action,
    )
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operation)) throw Error('Invalid operation');
    const receipt = s.otpReceipts.find((r) => r.operation_id === operation);
    if (receipt) {
      if (receipt.authority_revision !== c.authority_revision) return failure('CALL_CHANGED');
      if (receipt.fingerprint !== str(m.fingerprint)) return failure('OTP_OPERATION_CHANGED');
      return { result: { ...receipt.result, session: toPublicSession(s), replayed: true } };
    }
  }
  let error: string | undefined,
    completed = false;
  if (
    ![
      'status',
      'event',
      'otp_result',
      'authority_begin',
      'authority_complete',
      'voice_reserve',
      'voice_bind',
      'voice_failed',
    ].includes(action) &&
    !c.authority_passed
  )
    error = 'AUTHORITY_REQUIRED';
  else if (action === 'otp_result') error = 'OTP_RESULT_UNCERTAIN';
  else if (
    ['issue', 'sent', 'failed', 'otp_failure', 'prepare_verify', 'verify'].includes(action) &&
    c.otp_failures >= 2
  )
    error = 'OTP_FAILED';
  else
    switch (action) {
      case 'authority_begin':
        error = beginAuthorityCheck(s, m);
        break;
      case 'authority_complete':
        error = completeAuthorityCheck(s, m);
        break;
      case 'voice_reserve':
        error = reserveVoiceSession(s);
        break;
      case 'voice_bind':
        error = bindVoiceSession(s, m);
        break;
      case 'voice_failed':
        error = recordVoiceFailure(s);
        break;
      case 'issue':
        error = reserveOtpChallenge(s, a);
        break;
      case 'sent':
      case 'failed':
        ({ error, completed = false } = recordOtpDispatch(s, a, action === 'sent'));
        break;
      case 'otp_failure':
        ({ error, completed = false } = recordOtpFailure(s));
        break;
      case 'prepare_verify': {
        const prepared = prepareOtpVerification(s, a);
        if (prepared.result.ok) return prepared;
        error = str(prepared.result.error);
        break;
      }
      case 'verify':
        ({ error, completed = false } = completeOtpVerification(s, a));
        break;
      case 'authorize_load':
        error = authorizeLoadAccess(s, m);
        break;
      case 'save_loads':
        error = saveLoadSearchResults(s, m);
        break;
      case 'event':
        recordCallEvent(s, 'load_result', m);
        break;
      case 'status':
        return getCallSession(s);
      default:
        throw Error('Unknown action');
    }
  const result: Data = { ok: !error, error: error ?? null, session: toPublicSession(s) };
  if (completed && operation) {
    // Legacy OTP receipts store the core session projection, before outer wrappers.
    const session = { ...data(result.session) };
    for (const k of ['finalizedAt', 'finalOutcome', 'negotiation', 'booking', 'loadInterest'])
      delete session[k];
    s.otpReceipts.push({
      call_id: c.id,
      operation_id: operation,
      authority_revision: c.authority_revision,
      fingerprint: str(m.fingerprint),
      result: { ok: !error, error: error ?? null, session },
    });
  }
  return { result };
}

export function buildInitialCall(id: string, hash: string, now: string) {
  return CallSchema.parse({
    id: id,
    session_hash: hash,
    authority_check: null,
    authority_passed: false,
    created_at: now,
    session_expires_at: new Date(Date.parse(now) + 3600000).toISOString(),
    otp_state: 'not_sent',
    challenge_id: null,
    otp_digest: null,
    otp_expires_at: null,
    otp_attempts: 0,
    otp_verified_at: null,
    demo_recipient: null,
    authority_revision: 0,
    available_load_ids: [],
    selected_load_id: null,
    voice_run_id: null,
    voice_state: 'idle',
    finalized_at: null,
    final_outcome: null,
    final_summary: null,
    final_result: null,
    otp_failures: 0,
    booking: null,
    booking_terms: null,
    load_statuses: {},
    load_interest: null,
    source: 'unknown',
    last_activity_at: now,
    reported_end_reason: null,
    ended_at: null,
    end_evidence: null,
    load_snapshots: {},
    revision: 0,
  });
}

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { callAction } from '../calls/index.js';
import { otpCommit, otpOperation, mockOtpEnabled, otpDigest } from './otp.js';
import { SessionError } from '../../errors.js';
import { twinRpc } from '../../db/twin-client.js';
import { type CallSession } from '@carrier/contracts/calls';
import { runtimeConfig } from '../../config/env.js';

// Demo delivery only: derive the display value from a random challenge and a
// server secret so refresh/restart works without storing plaintext codes in Twin.
function displayCode(hash: string, challenge: string) {
  if (!mockOtpEnabled()) throw new SessionError('OTP_MOCK_DISABLED', 403);
  const secret = runtimeConfig().otp.hashSecret;
  if (!secret || secret.length < 32) throw new SessionError('OTP_NOT_CONFIGURED');
  const bytes = createHmac('sha256', secret)
    .update(`demo-display-v1:${hash}:${challenge}`)
    .digest();
  return String(bytes.readUIntBE(0, 6) % 1_000_000).padStart(6, '0');
}

// A native adversarial caller has no mid-conversation inbox API. Reserve a
// random challenge privately before its run; issuance still happens only when
// the sales agent calls create_otp and Twin approves the authority prerequisite.
export function prepareDemoChallenge(hash: string) {
  const challengeId = randomUUID();
  return { challengeId, code: displayCode(hash, challengeId) };
}

// Only the same-origin, cookie-authenticated local UI may call this reader.
// Checking the stored digest also avoids showing a guessed value for challenges
// created by the older manual frontend generator.
export async function readDemoOtp(hash: string, session: CallSession) {
  if (
    !mockOtpEnabled() ||
    session.finalizedAt ||
    session.verified ||
    session.otpState !== 'pending' ||
    !session.challengeId
  )
    return null;
  const code = displayCode(hash, session.challengeId);
  const prepared = await twinRpc('poc_call_action', {
    p_session_hash: hash,
    p_action: 'prepare_verify',
    p_challenge: session.challengeId,
  });
  if (!prepared.ok || !prepared.verifier || !/^[a-f0-9]{64}$/.test(prepared.verifier)) return null;
  if (
    !timingSafeEqual(
      Buffer.from(otpDigest(hash, session.challengeId, code), 'hex'),
      Buffer.from(prepared.verifier, 'hex'),
    )
  )
    return null;
  return {
    code,
    challengeId: session.challengeId,
    failuresRemaining: session.otpFailuresRemaining,
  };
}

export async function createOtpForCall(
  hash: string,
  operationId = randomUUID() as string,
  preparedChallenge?: string,
  deliver: () => Promise<boolean> = async () => true,
) {
  if (!mockOtpEnabled()) throw new SessionError('OTP_MOCK_DISABLED', 403);
  if (preparedChallenge && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(preparedChallenge))
    throw new SessionError('INVALID_REQUEST', 400);
  return otpOperation(hash, operationId, async () => {
    const current = await callAction(hash, 'status');
    if (!current.ok) return current;
    // A repeated request reuses the current displayable challenge; it does not
    // consume the retry or invalidate the code the caller is reading.
    if (await readDemoOtp(hash, current.session!)) return current;
    // A legacy manual challenge may not be recoverable on screen. Do not claim delivery.
    if (current.session?.otpState === 'pending') throw new SessionError('OTP_RESULT_UNCERTAIN');
    const challenge = preparedChallenge ?? randomUUID();
    const code = displayCode(hash, challenge);
    const issue = await callAction(hash, 'issue', {
      p_challenge: challenge,
      p_digest: otpDigest(hash, challenge, code),
      p_recipient: `mock-frontend:${hash}`,
      p_metadata: { operationId },
    });
    if (!issue.ok) return issue;
    if (issue.replayed || issue.session?.otpState === 'pending') {
      if (issue.session?.otpState === 'pending' && !(await readDemoOtp(hash, issue.session)))
        throw new SessionError('OTP_RESULT_UNCERTAIN');
      return issue;
    }
    // A deterministic demo code can safely finish an interrupted local dispatch.
    const delivered = await deliver();
    return otpCommit(hash, delivered ? 'sent' : 'failed', {
      p_challenge: issue.session!.challengeId,
      p_metadata: { operationId },
    });
  });
}

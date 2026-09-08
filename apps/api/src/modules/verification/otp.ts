import { createOtpEmailSender } from '../../integrations/otp-delivery/email.js';
import type { CallAction, RpcArgs } from '../../db/rpc-contracts/index.js';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { callAction } from '../calls/index.js';
import { twinRpc } from '../../db/twin-client.js';
import type { TwinResult } from '../../db/result.js';
import { SessionError } from '../../errors.js';
import { runtimeConfig } from '../../config/env.js';
function otpConfig() {
  const config = runtimeConfig();
  const recipient = mockOtpEnabled()
    ? 'mock-frontend'
    : config.otp.demoEmail?.trim().toLowerCase();
  const secret = config.otp.hashSecret;
  if (
    !config.otp.demoMode ||
    !recipient ||
    (!mockOtpEnabled() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) ||
    !secret ||
    secret.length < 32
  ) {
    throw new SessionError('OTP_NOT_CONFIGURED');
  }
  return { recipient, secret };
}
export function mockOtpEnabled() {
  const config = runtimeConfig();
  return (
    (config.nodeEnv === 'development' ||
      (config.nodeEnv === 'production' && config.hostedDemo.enabled)) &&
    config.otp.demoMode &&
    config.otp.deliveryMode === 'mock'
  );
}

// Explicit local demo only. The browser chooses/displays the code; the backend
// still checks authority, stores its HMAC in Twin and enforces the OTP lifecycle.
export async function registerMockOtp(
  hash: string,
  code: string,
  operationId = randomUUID() as string,
) {
  if (!mockOtpEnabled()) throw new SessionError('OTP_MOCK_DISABLED', 403);
  if (!/^\d{6}$/.test(code)) throw new SessionError('INVALID_OTP_FORMAT', 400);
  return otpOperation(hash, operationId, async () => {
    const challenge = randomUUID();
    const issue = await callAction(hash, 'issue', {
      p_challenge: challenge,
      p_digest: otpDigest(hash, challenge, code),
      p_recipient: `mock-frontend:${hash}`,
      p_metadata: { operationId },
    });
    if (!issue.ok || issue.replayed || issue.session?.otpState === 'pending') return issue;
    if (issue.session?.challengeId !== challenge) throw new SessionError('OTP_RESULT_UNCERTAIN');
    // "sent" here means simulated delivery to the demo operator. The persisted
    // mock-frontend recipient marker distinguishes these calls from email sends.
    return otpCommit(hash, 'sent', { p_challenge: challenge, p_metadata: { operationId } });
  });
}
export function otpDigest(hash: string, challenge: string, code: string) {
  const { recipient, secret } = otpConfig();
  return createHmac('sha256', secret)
    .update(`carrier-load-access:${hash}:${challenge}:${recipient}:${code}`)
    .digest('hex');
}

// Commit mutations once; a receipt read may recover a response lost in transit.
export async function otpCommit(
  hash: string,
  action: CallAction,
  args: Omit<RpcArgs<'poc_call_action'>, 'p_session_hash' | 'p_action'>,
) {
  try {
    return await callAction(hash, action, args);
  } catch (error) {
    if (!(error instanceof SessionError) || !error.code.startsWith('TWIN_')) throw error;
    const recovered = await callAction(hash, 'otp_result', { p_metadata: args.p_metadata });
    if (recovered.replayed) return recovered;
    throw new SessionError('OTP_RESULT_UNCERTAIN');
  }
}

// Known configuration/service failures share the same budget as wrong codes.
// Uncertain database mutations remain closed unless their receipt is recovered.
export async function otpOperation(
  hash: string,
  operationId: string,
  run: () => Promise<TwinResult>,
) {
  try {
    return await run();
  } catch (error) {
    if (
      !(error instanceof SessionError) ||
      !['OTP_NOT_CONFIGURED', 'OTP_SENDER_NOT_CONFIGURED'].includes(error.code)
    )
      throw error;
    return otpCommit(hash, 'otp_failure', { p_metadata: { operationId } });
  }
}

export async function verifyOtp(
  hash: string,
  challenge: string,
  code: string,
  operationId = randomUUID() as string,
) {
  if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(challenge))
    throw new SessionError('INVALID_OTP_FORMAT', 400);
  return otpOperation(hash, operationId, async () => {
    const candidate = otpDigest(hash, challenge, code);
    const metadata = { operationId, fingerprint: candidate };
    let prepared: TwinResult;
    try {
      prepared = await twinRpc('poc_call_action', {
        p_session_hash: hash,
        p_action: 'prepare_verify',
        p_challenge: challenge,
        p_metadata: metadata,
      });
    } catch (error) {
      if (!(error instanceof SessionError) || !error.code.startsWith('TWIN_')) throw error;
      // This phase only reads. Record a known failed check if Twin is reachable.
      return otpCommit(hash, 'otp_failure', { p_metadata: metadata });
    }
    if (prepared.replayed || !prepared.ok) return prepared;
    if (!prepared.verifier || !/^[a-f0-9]{64}$/.test(prepared.verifier))
      throw new SessionError('TWIN_INVALID_RESPONSE');
    const matches = timingSafeEqual(
      Buffer.from(candidate, 'hex'),
      Buffer.from(prepared.verifier, 'hex'),
    );
    // The row lock enforces challenge identity and the shared failure budget.
    return otpCommit(hash, 'verify', {
      p_challenge: challenge,
      p_matches: matches,
      p_metadata: metadata,
    });
  });
}

export async function sendOtp(hash: string, operationId = randomUUID() as string) {
  if (mockOtpEnabled()) throw new SessionError('OTP_EMAIL_DISABLED_IN_MOCK_MODE', 409);
  return otpOperation(hash, operationId, async () => {
    const { recipient } = otpConfig();
    const deliver = createOtpEmailSender();
    const challenge = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issue = await callAction(hash, 'issue', {
      p_challenge: challenge,
      p_digest: otpDigest(hash, challenge, code),
      p_recipient: recipient,
      p_metadata: { operationId },
    });
    if (!issue.ok || issue.replayed || issue.session?.otpState === 'pending') return issue;
    // Another request owns an unfinished dispatch. Never send its code or replace it.
    if (issue.session?.challengeId !== challenge) throw new SessionError('OTP_RESULT_UNCERTAIN');
    const accepted = await deliver({
      to: recipient,
      code,
      call_id: issue.session!.callId,
      challenge_id: challenge,
      mc_number: issue.session!.check!.mcNumber,
      demo: true,
    });
    return otpCommit(hash, accepted ? 'sent' : 'failed', {
      p_challenge: challenge,
      p_metadata: { operationId },
    });
  });
}

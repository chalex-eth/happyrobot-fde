import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Negotiation } from './negotiation';
import type { CarrierCheck } from './fmcsa';

export type CallSession = {
  negotiation?: Negotiation | null;
  finalizedAt?: string | null; finalOutcome?: string | null;
  callId: string; check: CarrierCheck | null; authorityRevision: number;
  availableLoadIds: string[]; selectedLoadId: string | null;
  voiceState: 'idle' | 'creating' | 'ready' | 'failed'; voiceRunId: string | null; expiresAt: string;
  otpState: 'not_sent' | 'dispatching' | 'pending' | 'failed' | 'verified';
  challengeId: string | null;
  otpFailuresRemaining: number; otpRetryAllowed: boolean; verified: boolean; demo: true;
};
export class SessionError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
export type TwinResult = { negotiation?: Negotiation | null; ok: boolean; error?: string; session?: CallSession; replayed?: boolean; verifier?: string; sessionHash?: string };
const COOKIE = 'carrier_session';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function sessionHash(request: Request): string {
  const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new SessionError('SESSION_REQUIRED', 401);
  return sha256(token);
}
export const sessionCookie = (token: string) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=3600`;
export const clearSessionCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=0`;

// Twin reflects PostgreSQL functions as RPC endpoints. No database credentials,
// raw provider responses, session hashes or OTP digests cross the browser boundary.
export async function twinRpc(name: 'poc_start_call' | 'poc_call_action' | 'poc_resolve_voice' | 'poc_finalize_call' | 'poc_negotiate', args: Record<string, unknown>): Promise<TwinResult> {
  const gateway = process.env.TWIN_GATEWAY; const org = process.env.TWIN_ORG_ID;
  if (!gateway || !org) throw new SessionError('TWIN_NOT_CONFIGURED');
  let url: URL;
  try { url = new URL(`/rpc/${name}`, gateway); if (url.protocol !== 'https:') throw new Error(); }
  catch { throw new SessionError('TWIN_NOT_CONFIGURED'); }
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-org-id': org },
      body: JSON.stringify(args), signal: AbortSignal.timeout(6000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new SessionError(response.status === 404 ? 'TWIN_SCHEMA_REQUIRED' : 'TWIN_UNAVAILABLE');
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || typeof (result as TwinResult).ok !== 'boolean') throw new SessionError('TWIN_INVALID_RESPONSE');
    return result as TwinResult;
  } catch (error) { if (error instanceof SessionError) throw error; throw new SessionError('TWIN_UNAVAILABLE'); }
}

export async function startCall(previousHash: string | null = null) {
  const token = randomBytes(32).toString('hex');
  const result = await twinRpc('poc_start_call', {
    p_id: randomUUID(), p_session_hash: sha256(token), p_previous_hash: previousHash,
  });
  if (!result.ok || !result.session) throw new SessionError('TWIN_UNAVAILABLE');
  return { token, hash: sha256(token), session: result.session };
}

export async function callAction(hash: string, action: string, args: Record<string, unknown> = {}) {
  const result = await twinRpc('poc_call_action', { p_session_hash: hash, p_action: action, ...args });
  if (result.ok && (!result.session || typeof result.session.verified !== 'boolean'
    || !result.session.callId || !result.session.expiresAt
    || !Number.isInteger(result.session.authorityRevision))) throw new SessionError('TWIN_INVALID_RESPONSE');
  return result;
}

export function resultStatus(result: TwinResult) {
  return result.ok ? 200 : result.error === 'SESSION_REQUIRED' ? 401
    : result.error === 'AUTHORITY_REQUIRED' || result.error === 'OTP_REQUIRED' ? 403 : 409;
}

function otpConfig() {
  const recipient = mockOtpEnabled() ? 'mock-frontend' : process.env.DEMO_OTP_EMAIL?.trim().toLowerCase();
  const secret = process.env.OTP_HASH_SECRET;
  if (process.env.OTP_DEMO_MODE !== 'true' || !recipient || (!mockOtpEnabled() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) || !secret || secret.length < 32) {
    throw new SessionError('OTP_NOT_CONFIGURED');
  }
  return { recipient, secret };
}
export function mockOtpEnabled() {
  return process.env.NODE_ENV === 'development' && process.env.OTP_DEMO_MODE === 'true' && process.env.OTP_DELIVERY_MODE === 'mock';
}

// Explicit local demo only. The browser chooses/displays the code; the backend
// still checks authority, stores its HMAC in Twin and enforces the OTP lifecycle.
export async function registerMockOtp(hash: string, code: string, operationId = randomUUID() as string) {
  if (!mockOtpEnabled()) throw new SessionError('OTP_MOCK_DISABLED', 403);
  if (!/^\d{6}$/.test(code)) throw new SessionError('INVALID_OTP_FORMAT', 400);
  return otpOperation(hash, operationId, async () => {
    const challenge = randomUUID();
    const issue = await callAction(hash, 'issue', { p_challenge: challenge,
      p_digest: otpDigest(hash, challenge, code), p_recipient: `mock-frontend:${hash}`, p_metadata: { operationId } });
    if (!issue.ok || issue.replayed || issue.session?.otpState === 'pending') return issue;
    if (issue.session?.challengeId !== challenge) throw new SessionError('OTP_RESULT_UNCERTAIN');
    // "sent" here means simulated delivery to the demo operator. The persisted
    // mock-frontend recipient marker distinguishes these calls from email sends.
    return otpCommit(hash, 'sent', { p_challenge: challenge, p_metadata: { operationId } });
  });
}
export function otpDigest(hash: string, challenge: string, code: string) {
  const { recipient, secret } = otpConfig();
  return createHmac('sha256', secret).update(`carrier-load-access:${hash}:${challenge}:${recipient}:${code}`).digest('hex');
}

// Commit mutations once; a receipt read may recover a response lost in transit.
export async function otpCommit(hash: string, action: string, args: Record<string, unknown>) {
  try { return await callAction(hash, action, args); }
  catch (error) {
    if (!(error instanceof SessionError) || !error.code.startsWith('TWIN_')) throw error;
    const recovered = await callAction(hash, 'otp_result', { p_metadata: args.p_metadata });
    if (recovered.replayed) return recovered;
    throw new SessionError('OTP_RESULT_UNCERTAIN');
  }
}

// Known configuration/service failures share the same budget as wrong codes.
// Uncertain database mutations remain closed unless their receipt is recovered.
export async function otpOperation(hash: string, operationId: string, run: () => Promise<TwinResult>) {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof SessionError) || !['OTP_NOT_CONFIGURED','OTP_SENDER_NOT_CONFIGURED'].includes(error.code)) throw error;
    return otpCommit(hash, 'otp_failure', { p_metadata: { operationId } });
  }
}

export async function verifyOtp(hash: string, challenge: string, code: string, operationId = randomUUID() as string) {
  if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(challenge)) throw new SessionError('INVALID_OTP_FORMAT', 400);
  return otpOperation(hash, operationId, async () => {
    const candidate = otpDigest(hash, challenge, code);
    const metadata = { operationId, fingerprint: candidate };
    let prepared: TwinResult;
    try {
      prepared = await twinRpc('poc_call_action', { p_session_hash: hash, p_action: 'prepare_verify', p_challenge: challenge, p_metadata: metadata });
    } catch (error) {
      if (!(error instanceof SessionError) || !error.code.startsWith('TWIN_')) throw error;
      // This phase only reads. Record a known failed check if Twin is reachable.
      return otpCommit(hash, 'otp_failure', { p_metadata: metadata });
    }
    if (prepared.replayed || !prepared.ok) return prepared;
    if (!prepared.verifier || !/^[a-f0-9]{64}$/.test(prepared.verifier)) throw new SessionError('TWIN_INVALID_RESPONSE');
    const matches = timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(prepared.verifier, 'hex'));
    // The row lock enforces challenge identity and the shared failure budget.
    return otpCommit(hash, 'verify', { p_challenge: challenge, p_matches: matches, p_metadata: metadata });
  });
}

export async function sendOtp(hash: string, operationId = randomUUID() as string) {
  if (mockOtpEnabled()) throw new SessionError('OTP_EMAIL_DISABLED_IN_MOCK_MODE', 409);
  return otpOperation(hash, operationId, async () => {
    const { recipient } = otpConfig();
    const webhook = process.env.OTP_WEBHOOK_URL; const key = process.env.OTP_WEBHOOK_API_KEY;
    if (!webhook || !key) throw new SessionError('OTP_SENDER_NOT_CONFIGURED');
    let url: URL;
    try { url = new URL(webhook); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { throw new SessionError('OTP_SENDER_NOT_CONFIGURED'); }
    const challenge = randomUUID(); const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issue = await callAction(hash, 'issue', { p_challenge: challenge, p_digest: otpDigest(hash, challenge, code), p_recipient: recipient, p_metadata: { operationId } });
    if (!issue.ok || issue.replayed || issue.session?.otpState === 'pending') return issue;
    // Another request owns an unfinished dispatch. Never send its code or replace it.
    if (issue.session?.challengeId !== challenge) throw new SessionError('OTP_RESULT_UNCERTAIN');
    let accepted = false;
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ to: recipient, code, call_id: issue.session!.callId, challenge_id: challenge,
          mc_number: issue.session!.check!.mcNumber, demo: true }),
        signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store',
      });
      accepted = response.ok;
      await response.body?.cancel();
    } catch { /* Invalidate uncertain delivery before offering the shared retry. */ }
    return otpCommit(hash, accepted ? 'sent' : 'failed', { p_challenge: challenge, p_metadata: { operationId } });
  });
}

export async function readJson(request: Request, maxBytes = 512): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new SessionError('JSON_REQUIRED', 415);
  const reader = request.body?.getReader(); if (!reader) throw new SessionError('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new SessionError('REQUEST_TOO_LARGE', 413); }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SessionError('INVALID_JSON', 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionError('INVALID_REQUEST', 400);
    return input as Record<string, unknown>;
  } finally { reader.releaseLock(); }
}

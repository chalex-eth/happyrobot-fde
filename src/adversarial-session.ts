import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { callAction, mockOtpEnabled, SessionError, startCall } from './call-session';
import { prepareDemoChallenge } from './demo-otp';
import { executeTool, toolSpecs } from './mcp-tools';
import { FmcsaError } from './fmcsa';
import { handleMcp } from './mcp-http';
import { publicBooking, type Booking } from './booking';

const directory = () => join(process.cwd(), 'tmp', 'adversarial-sessions');
const planSchema = z.strictObject({ id: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/),
  fault: z.enum(['none', 'authority_unavailable', 'otp_delivery_failed', 'tms_unavailable']).default('none'),
  bookingAllowed: z.boolean().default(false),
  challengeId: z.string().uuid(), callId: z.string().uuid(), expiresAt: z.number().int() });
export type AdversarialSession = z.infer<typeof planSchema>;
function secret() {
  const value = process.env.ADVERSARIAL_MCP_TOKEN;
  if (!mockOtpEnabled() || process.env.ADVERSARIAL_MCP_ENABLED !== 'true' || !value || value.length < 32
    || value === process.env.MCP_AUTH_TOKEN) throw new SessionError('ADVERSARIAL_DISABLED', 403);
  return value;
}
const signature = (payload: string) => createHmac('sha256', secret()).update(`adversarial-session-v1:${payload}`).digest('base64url');
function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function authenticate(authorization: string | null) {
  if (!equal(authorization ?? '', `Bearer ${secret()}`)) throw new SessionError('UNAUTHORIZED', 401);
}
export async function prepareAdversarialSession(fault: AdversarialSession['fault'] = 'none', bookingAllowed = false) {
  secret();
  const call = await startCall();
  const prepared = prepareDemoChallenge(call.hash);
  const plan: AdversarialSession = { fault, bookingAllowed, id: randomUUID(), hash: call.hash, callId: call.session.callId,
    challengeId: prepared.challengeId, expiresAt: Date.now() + 10 * 60_000 };
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  await writeFile(join(directory(), `${plan.id}.json`), JSON.stringify({ plan, active: false }), { mode: 0o600, flag: 'wx' });
  const payload = Buffer.from(JSON.stringify(plan)).toString('base64url');
  return { plan, token: `${payload}.${signature(payload)}`, code: prepared.code };
}
export async function activateAdversarialSession(plan: AdversarialSession, testRunId: string) {
  z.string().uuid().parse(testRunId);
  const payload = Buffer.from(JSON.stringify(plan)).toString('base64url');
  const activePath = join(directory(), 'active-channel');
  await writeFile(activePath, `${payload}.${signature(payload)}`, { mode: 0o600, flag: 'wx' });
  const temporary = join(directory(), `${plan.id}.active`);
  try {
    await writeFile(temporary, JSON.stringify({ plan, active: true, testRunId }), { mode: 0o600 });
    await rename(temporary, join(directory(), `${plan.id}.json`));
  } catch (error) { await unlink(activePath); throw error; }
  // The native simulator does not populate runtime variables in child MCP
  // headers. One authenticated test channel is therefore run serially.
}
export async function resolveAdversarialSession(token: string | null): Promise<AdversarialSession> {
  secret();
  if (!token || token.length > 2048) throw new SessionError('ADVERSARIAL_SESSION_REQUIRED', 401);
  const parts = token.split('.');
  if (parts.length !== 2 || !equal(signature(parts[0]), parts[1])) throw new SessionError('ADVERSARIAL_SESSION_REQUIRED', 401);
  let plan: AdversarialSession;
  try { plan = planSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString())); }
  catch { throw new SessionError('ADVERSARIAL_SESSION_REQUIRED', 401); }
  if (plan.expiresAt <= Date.now() || plan.expiresAt > Date.now() + 10 * 60_000) throw new SessionError('ADVERSARIAL_SESSION_EXPIRED', 401);
  let stored: string;
  try { stored = await readFile(join(directory(), `${plan.id}.json`), 'utf8'); }
  catch { throw new SessionError('ADVERSARIAL_SESSION_REVOKED', 401); }
  let samePlan = false, active = false;
  try { const registration = JSON.parse(stored); samePlan = JSON.stringify(planSchema.parse(registration.plan)) === JSON.stringify(plan); active = registration.active === true; } catch { /* Invalid registration. */ }
  if (!samePlan) throw new SessionError('ADVERSARIAL_SESSION_REQUIRED', 401);
  // HappyRobot automatically probes action nodes when their config changes.
  // These probes must not mutate the session reserved for a conversation.
  if (!active) throw new SessionError('ADVERSARIAL_SESSION_NOT_STARTED', 409);
  const status = await callAction(plan.hash, 'status');
  if (!status.ok || status.session?.callId !== plan.callId) throw new SessionError('ADVERSARIAL_SESSION_REQUIRED', 401);
  // The pre-provisioned envelope covers one carrier identity only.
  if (status.session.authorityRevision > 1) throw new SessionError('ADVERSARIAL_SCENARIO_UNSUPPORTED', 409);
  return plan;
}
export async function revokeAdversarialSession(plan: AdversarialSession) {
  await unlink(join(directory(), `${plan.id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const activePath = join(directory(), 'active-channel');
  const active = await readFile(activePath, 'utf8').catch(() => '');
  if (active && JSON.parse(Buffer.from(active.split('.')[0], 'base64url').toString()).id === plan.id) await unlink(activePath);
}
export async function readAdversarialTrace(plan: AdversarialSession) {
  const raw = await readFile(join(directory(), `${plan.id}.jsonl`), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  return raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : [];
}
export async function handleAdversarialMcp(request: Request) {
  let resolved: AdversarialSession | undefined;
  let searchArguments: Record<string, unknown> | undefined;
  let negotiationArguments: Record<string, unknown> | undefined;
  let bookingArguments: Record<string, unknown> | undefined;
  return handleMcp(request, {
    authenticate,
    resolve: async req => {
      const header = req.headers.get('x-adversarial-session');
      const token = header === 'controller' ? await readFile(join(directory(), 'active-channel'), 'utf8').catch(() => null) : header;
      resolved = await resolveAdversarialSession(token);
      return resolved;
    },
    execute: (name, args, hash, signal, operationId, challengeId) => {
      // Only a controller-signed opt-in can use the real booking path. Other
      // suites and inactive configuration probes remain unable to book.
      if (name === 'book_load' && !resolved?.bookingAllowed) throw new SessionError('BOOKING_DISABLED_IN_EVAL', 403);
      // Only validated, public search filters are retained for conversation QA.
      searchArguments = name === 'search_loads' ? toolSpecs.search_loads.schema.parse(args) : undefined;
      negotiationArguments = name === 'negotiate_offer' ? toolSpecs.negotiate_offer.schema.parse(args) : undefined;
      bookingArguments = name === 'book_load' ? toolSpecs.book_load.schema.parse(args) : undefined;
      return executeTool(name, args, hash, signal, operationId, challengeId, {
      ...(resolved?.fault === 'authority_unavailable' ? { authorityLookup: async () => { throw new FmcsaError('FMCSA_UNAVAILABLE', 503, true); } } : {}),
      ...(resolved?.fault === 'otp_delivery_failed' ? { deliverOtp: async () => false } : {}),
      // Exercise normal search validation, authorization and save_loads, with a
      // deliberate transport outage only in this isolated development scenario.
      ...(resolved?.fault === 'tms_unavailable' ? { runTms: async () => ({ ok: false as const, command: 'LOAD_QUERY' as const,
        elapsed_ms: 0, attempts: 1, failures: ['TMS_CONNECTION_ERROR'], error: 'TMS_CONNECTION_ERROR', retryable: false }) } : {}),
    });
    },
    observe: async (tool, result) => {
      if (!resolved) return;
      // No OTP arguments, codes, hashes, credentials or free-form summaries.
      const authority = result.authority as { eligible?: boolean } | undefined;
      const negotiation = result.negotiation as Record<string, unknown> | undefined;
      // Explicit public-field projection; never log raw pricing or full tool outputs.
      const publicNegotiation = negotiation ? Object.fromEntries(
        ['status', 'load_id', 'offer_id', 'offered_rate', 'agreed_rate', 'counter_rounds', 'rounds_remaining', 'booking_confirmed']
          .filter(key => key in negotiation).map(key => [key, negotiation[key]])) : undefined;
      await appendFile(join(directory(), `${resolved.id}.jsonl`), JSON.stringify({
        at: new Date().toISOString(), injected_fault: resolved.fault, tool, ok: result.ok, error: result.error,
        runtime_run_id: /^[0-9a-f-]{36}$/.test(request.headers.get('x-happyrobot-run-id') ?? '') ? request.headers.get('x-happyrobot-run-id') : null,
        ...(searchArguments ? { search_arguments: searchArguments } : {}),
        ...(negotiationArguments ? { negotiation_arguments: negotiationArguments } : {}),
        ...(bookingArguments ? { booking_arguments: bookingArguments } : {}),
        ...(result.booking ? { booking: publicBooking(result.booking as Booking) } : {}),
        ...(publicNegotiation ? { negotiation: publicNegotiation } : {}),
        ...(tool === 'finalize_call' ? { outcome: result.outcome } : {}),
        eligible: authority?.eligible, delivered: result.delivered, verified: result.verified,
        finalized_at: result.finalized_at, failures_remaining: result.failures_remaining,
      }) + '\n', { mode: 0o600 });
    },
  });
}

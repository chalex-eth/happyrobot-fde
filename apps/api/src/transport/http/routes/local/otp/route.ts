import { verifyOtpForCall } from '../../../../../modules/verification/index.js';
import { randomUUID } from 'node:crypto';
import { callAction } from '../../../../../modules/calls/index.js';
import { readJson } from '../../../read-json.js';
import { registerMockOtp, sendOtp } from '../../../../../modules/verification/index.js';
import { resultStatus } from '../../../result-status.js';
import { SessionError } from '../../../../../errors.js';
import { sessionHash } from '../../../middleware/session-cookie.js';
import { rejectNonLocalRequest } from '../../../middleware/local-origin.js';

export async function POST(request: Request) {
  const rejected = rejectNonLocalRequest(request);
  if (rejected) return rejected;
  const requestId = randomUUID();
  const respond = (body: unknown, status: number) =>
    Response.json(
      { ...(body as object), requestId },
      {
        status,
        headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
      },
    );
  try {
    const input = await readJson(request);
    if (
      !['status', 'send', 'mock', 'verify'].includes(String(input.action)) ||
      Object.keys(input).some((k) => !['action', 'code', 'challengeId'].includes(k))
    )
      throw new SessionError('INVALID_REQUEST', 400);
    const hash = sessionHash(request);
    const operationId = request.headers.get('Idempotency-Key') ?? requestId;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new SessionError('INVALID_REQUEST', 400);
    if (input.action === 'mock' && (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)))
      throw new SessionError('INVALID_OTP_FORMAT', 400);
    if (
      input.action === 'verify' &&
      (typeof input.code !== 'string' ||
        !/^\d{6}$/.test(input.code) ||
        typeof input.challengeId !== 'string' ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.challengeId))
    )
      throw new SessionError('INVALID_OTP_FORMAT', 400);
    const result =
      input.action === 'send'
        ? await sendOtp(hash, operationId)
        : input.action === 'mock'
          ? await registerMockOtp(hash, input.code as string, operationId)
          : input.action === 'verify'
            ? await verifyOtpForCall(
                hash,
                input.code as string,
                input.challengeId as string,
                operationId,
              )
            : await callAction(hash, 'status');
    return respond(result, result.error === 'OTP_DELIVERY_FAILED' ? 502 : resultStatus(result));
  } catch (error) {
    const fault = error instanceof SessionError ? error : new SessionError('INTERNAL_ERROR', 500);
    console.info(JSON.stringify({ event: 'otp_error', requestId, code: fault.code }));
    return respond({ ok: false, error: fault.code }, fault.status);
  }
}

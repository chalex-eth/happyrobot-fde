import { runtimeConfig } from '../../../config/env.js';
import { SessionError } from '../../../errors.js';
import { requireOperatorSession } from './operator-session.js';
import { checkHostedDemoOrigin } from './hosted-demo.js';

// Local development or an explicitly enabled, authenticated hosted demo.
export function rejectNonLocalRequest(request: Request): Response | undefined {
  const reject = (status: number, error: string) =>
    Response.json(
      { ok: false, error },
      {
        status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  if (runtimeConfig().hostedDemo.enabled) {
    try {
      checkHostedDemoOrigin(request);
      requireOperatorSession(request);
      return;
    } catch (error) {
      return error instanceof SessionError
        ? reject(error.status, error.code)
        : reject(503, 'HOSTED_DEMO_NOT_CONFIGURED');
    }
  }
  if (runtimeConfig().nodeEnv !== 'development') return reject(404, 'LOCAL_CONSOLE_DISABLED');
  try {
    const origin = new URL(request.headers.get('origin') ?? '');
    if (
      origin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      origin.host !== request.headers.get('host') ||
      origin.origin !== request.headers.get('origin')
    ) {
      return reject(403, 'INVALID_ORIGIN');
    }
  } catch {
    return reject(403, 'INVALID_ORIGIN');
  }
}

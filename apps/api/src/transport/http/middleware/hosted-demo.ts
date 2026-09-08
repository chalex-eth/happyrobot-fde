import { runtimeConfig } from '../../../config/env.js';
import { SessionError } from '../../../errors.js';

// This opt-in permits a private hosted demo, never real carrier authentication
// or TMS booking writes. NODE_ENV still describes the production runtime.
export function checkHostedDemoConfiguration() {
  const config = runtimeConfig();
  if (!config.hostedDemo.enabled) return;
  let validUrl = false;
  try {
    const url = new URL(config.hostedDemo.publicUrl ?? '');
    validUrl = url.protocol === 'https:' && url.origin === config.hostedDemo.publicUrl;
  } catch {
    /* Fail closed below. */
  }
  if (
    config.nodeEnv !== 'production' ||
    !validUrl ||
    config.features.bookingTmsMode !== 'mock' ||
    !config.otp.demoMode ||
    config.otp.deliveryMode !== 'mock' ||
    config.mcp.adversarialEnabled ||
    !config.operator.password ||
    config.operator.password.length < 12 ||
    !config.operator.sessionSecret ||
    config.operator.sessionSecret.length < 32 ||
    !config.otp.hashSecret ||
    config.otp.hashSecret.length < 32
  )
    throw new SessionError('HOSTED_DEMO_NOT_CONFIGURED', 503);
}

export function checkHostedDemoOrigin(request: Request) {
  checkHostedDemoConfiguration();
  const origin = request.headers.get('origin');
  const publicUrl = runtimeConfig().hostedDemo.publicUrl;
  // Vercel injects this deployment's exact hostname. Never allow arbitrary
  // *.vercel.app origins or user-controlled forwarded headers.
  const deploymentUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
  if (!origin || ![publicUrl, deploymentUrl].includes(origin))
    throw new SessionError('INVALID_ORIGIN', 403);
  if (new URL(origin).host !== request.headers.get('host'))
    throw new SessionError('INVALID_ORIGIN', 403);
}

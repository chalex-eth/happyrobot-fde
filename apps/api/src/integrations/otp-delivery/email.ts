import { SessionError } from '../../errors.js';
import { runtimeConfig } from '../../config/env.js';
export type OtpEmail = {
  to: string;
  code: string;
  call_id: string;
  challenge_id: string;
  mc_number: string;
  demo: true;
};
export function createOtpEmailSender() {
  const { webhookUrl: webhook, webhookApiKey: key } = runtimeConfig().otp;
  if (!webhook || !key) throw new SessionError('OTP_SENDER_NOT_CONFIGURED');
  let url: URL;
  try {
    url = new URL(webhook);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error();
  } catch {
    throw new SessionError('OTP_SENDER_NOT_CONFIGURED');
  }
  return async (message: OtpEmail): Promise<boolean> => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
        cache: 'no-store',
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
}

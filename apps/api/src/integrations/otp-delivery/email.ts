import { SessionError } from '../../errors.js';
export type OtpEmail = {
  to: string;
  code: string;
  call_id: string;
  challenge_id: string;
  mc_number: string;
  demo: true;
};
export function createOtpEmailSender() {
  const webhook = process.env.OTP_WEBHOOK_URL,
    key = process.env.OTP_WEBHOOK_API_KEY;
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

import { createHash } from 'node:crypto';
import { SessionError } from '../../../errors.js';
import { runtimeConfig } from '../../../config/env.js';
const COOKIE = 'carrier_session';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function sessionHash(request: Request): string {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new SessionError('SESSION_REQUIRED', 401);
  return sha256(token);
}
export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=3600${runtimeConfig().nodeEnv === 'production' ? '; Secure' : ''}`;
export const clearSessionCookie = () =>
  `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=0${runtimeConfig().nodeEnv === 'production' ? '; Secure' : ''}`;

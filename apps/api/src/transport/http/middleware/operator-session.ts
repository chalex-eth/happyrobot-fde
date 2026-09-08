import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { runtimeConfig } from '../../../config/env.js';
import { SessionError } from '../../../errors.js';

const COOKIE_NAME = 'operator_session';
const COOKIE_PATH = '/api/operator';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_PASSWORD_LENGTH = 12;
const MIN_SESSION_SECRET_LENGTH = 32;

function operatorSecrets() {
  const config = runtimeConfig().operator;
  const { password, sessionSecret } = config;
  if (
    !password ||
    password.length < MIN_PASSWORD_LENGTH ||
    !sessionSecret ||
    sessionSecret.length < MIN_SESSION_SECRET_LENGTH
  )
    throw new SessionError('OPERATOR_AUTH_NOT_CONFIGURED', 503);
  return { password, sessionSecret };
}

function equalBytes(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function passwordDigest(value: string) {
  return createHash('sha256').update(value).digest();
}

export function verifyOperatorPassword(value: unknown) {
  const { password } = operatorSecrets();
  if (typeof value !== 'string') return false;
  return equalBytes(passwordDigest(value), passwordDigest(password));
}

function signature(value: string, secret: string) {
  return createHmac('sha256', secret).update(`operator-session-v1:${value}`).digest('base64url');
}

function cookieValue(request: Request) {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function validSession(value: string | undefined, secret: string) {
  if (!value || value.length > 512) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [encoded, suppliedSignature] = parts;
  const expectedSignature = signature(encoded, secret);
  if (!equalBytes(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) return false;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const [expiresAt, nonce] = decoded.split('.');
    return (
      /^\d+$/.test(expiresAt) &&
      Number(expiresAt) > Math.floor(Date.now() / 1000) &&
      !!nonce &&
      /^[A-Za-z0-9_-]{32,64}$/.test(nonce)
    );
  } catch {
    return false;
  }
}

export function requireOperatorSession(request: Request) {
  const { sessionSecret } = operatorSecrets();
  if (!validSession(cookieValue(request), sessionSecret))
    throw new SessionError('OPERATOR_AUTH_REQUIRED', 401);
  return { role: 'operator' as const };
}

export function createOperatorSession() {
  const { sessionSecret } = operatorSecrets();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(`${expiresAt}.${randomBytes(32).toString('base64url')}`).toString(
    'base64url',
  );
  return `${payload}.${signature(payload, sessionSecret)}`;
}

function cookieAttributes(maxAge: number) {
  const secure = runtimeConfig().nodeEnv === 'production' ? '; Secure' : '';
  const path = runtimeConfig().hostedDemo.enabled ? '/api' : COOKIE_PATH;
  return `Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

export function operatorSessionCookie(value: string) {
  return `${COOKIE_NAME}=${value}; ${cookieAttributes(SESSION_TTL_SECONDS)}`;
}

export function clearOperatorSessionCookie() {
  return `${COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

import { timingSafeEqual } from 'node:crypto';
import { SessionError } from './call-session';

export function authenticateMcp(authorization: string | null) {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) throw new SessionError('MCP_NOT_CONFIGURED');
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new SessionError('UNAUTHORIZED', 401);
  }
}

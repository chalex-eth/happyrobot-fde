import { SessionError } from '../../../errors.js';
export function checkOperatorOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // Next may construct request.url with its internal Docker hostname.
  // Validate the browser origin against the host that received the request.
  let parsed: URL;
  try {
    parsed = new URL(origin ?? '');
  } catch {
    throw new SessionError('INVALID_ORIGIN', 403);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    parsed.host !== request.headers.get('host')
  )
    throw new SessionError('INVALID_ORIGIN', 403);
}

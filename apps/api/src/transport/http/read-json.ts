import { SessionError } from '../../errors.js';
export async function readJson(request: Request, maxBytes = 512): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new SessionError('JSON_REQUIRED', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new SessionError('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SessionError('REQUEST_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SessionError('INVALID_JSON', 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new SessionError('INVALID_REQUEST', 400);
    return input as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

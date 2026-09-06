import net from 'node:net';

export type BookingRequest = { loadId: string; mcNumber: string; agreedCents: number };
export type BookingResult =
  | { status: 'confirmed'; reference: string; timestamp: string }
  | { status: 'rejected' | 'uncertain'; error: string };

const rejectedCodes = new Set([
  'AUTH_FAILED',
  'UNKNOWN_CMD',
  'MISSING_FIELD',
  'UNKNOWN_LOAD',
  'ALREADY_BOOKED',
  'INVALID_RATE',
]);

export function bookingFrame(input: BookingRequest, token: string) {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.loadId) ||
    !/^\d{1,8}$/.test(input.mcNumber) ||
    !Number.isSafeInteger(input.agreedCents) ||
    input.agreedCents <= 0 ||
    input.agreedCents > 100_000_000 ||
    !/^[\x21-\x7e]+$/.test(token) ||
    token.includes('|')
  )
    throw Error('INVALID_BOOKING_REQUEST');
  const frame = `CMD:LOAD_BOOK|AUTH:${token}|LOAD_ID:${input.loadId}|MC_NUM:${input.mcNumber}|AGREED_RATE:${(input.agreedCents / 100).toFixed(2)}\r\n`;
  if (Buffer.byteLength(frame) > 4096) throw Error('INVALID_BOOKING_REQUEST');
  return frame;
}

function fields(line: string) {
  const result: Record<string, string> = Object.create(null);
  for (const pair of line.split('|')) {
    const i = pair.indexOf(':');
    const key = pair.slice(0, i);
    if (i < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || key in result) throw Error('MALFORMED_RESPONSE');
    result[key] = pair.slice(i + 1).trimEnd();
  }
  return result;
}

// Dedicated write transport: never use the read adapter's retry loop.
export async function bookTms(input: BookingRequest, signal?: AbortSignal): Promise<BookingResult> {
  // A direct caller cannot bypass the test-mode write boundary.
  if (process.env.BOOKING_TMS_MODE !== 'live')
    return { status: 'rejected', error: 'TMS_BOOKING_DISABLED' };
  const host = process.env.TMS_HOST,
    port = Number(process.env.TMS_PORT),
    token = process.env.TMS_TOKEN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !token)
    return { status: 'rejected', error: 'TMS_NOT_CONFIGURED' };
  let frame: string;
  try {
    frame = bookingFrame(input, token);
  } catch {
    return { status: 'rejected', error: 'INVALID_BOOKING_REQUEST' };
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let sent = false,
      finished = false,
      pending = '',
      bytes = 0;
    const lines: string[] = [];
    const fail = (error: string) => finish({ status: sent ? 'uncertain' : 'rejected', error });
    const timer = setTimeout(() => fail('TMS_TIMEOUT'), 4000);
    const abort = () => fail('CANCELLED');
    function finish(result: BookingResult) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(result);
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => {
      sent = true;
      socket.write(frame, 'ascii');
    });
    socket.on('error', () => fail('TMS_CONNECTION_ERROR'));
    socket.on('end', () => fail('INCOMPLETE_RESPONSE'));
    socket.on('close', () => {
      if (!finished) fail('INCOMPLETE_RESPONSE');
    });
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) return fail('RESPONSE_TOO_LARGE');
      if (chunk.some((b) => b > 127 || (b < 32 && b !== 10 && b !== 13)))
        return fail('MALFORMED_RESPONSE');
      pending += chunk.toString('ascii');
      let boundary: number;
      while ((boundary = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        try {
          if (/[\r\n]/.test(line)) throw Error();
          if (line.startsWith('ERR|')) {
            if (lines.length || pending) throw Error();
            const error = fields(line.slice(4)).CODE;
            // Unknown/server errors do not establish that the mutation failed.
            return finish(
              rejectedCodes.has(error)
                ? { status: 'rejected', error }
                : { status: 'uncertain', error: 'TMS_BOOKING_UNCERTAIN' },
            );
          }
          if (line === 'END') {
            if (pending || lines.length !== 1) throw Error();
            const record = fields(lines[0]);
            if (
              record.LOAD_ID !== input.loadId ||
              record.STATUS !== 'BOOKED' ||
              !record.BOOKING_REF ||
              record.BOOKING_REF.length > 128 ||
              !/^\d{14}$/.test(record.TIMESTAMP ?? '')
            )
              throw Error();
            return finish({
              status: 'confirmed',
              reference: record.BOOKING_REF,
              timestamp: record.TIMESTAMP,
            });
          }
          lines.push(line);
        } catch {
          return fail('MALFORMED_RESPONSE');
        }
      }
    });
    socket.connect(port, host);
  });
}

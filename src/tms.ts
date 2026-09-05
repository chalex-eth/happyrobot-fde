import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export type TmsCommand = 'DEBUG_ECHO' | 'LOAD_QUERY' | 'LOAD_GET';
export type TmsRequest = { command: TmsCommand; fields?: Record<string, string> };
export type PublicLoad = Record<string, string> & { LOAD_ID: string };
export class TmsError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}
const queryFields = ['ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'EQTYPE', 'PICKUP_DATE', 'MAX_RESULTS'];
const publicFields = ['LOAD_ID', 'ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'PICKUP_DT', 'DELIVERY_DT', 'EQTYPE', 'RATE', 'MILES', 'STATUS', 'WEIGHT', 'PIECES'];
const requiredFields = ['LOAD_ID', 'ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'PICKUP_DT', 'EQTYPE', 'RATE', 'MILES', 'STATUS'];
const safeValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && /^[\x20-\x7e]+$/.test(value) && !value.includes('|');

export function validateRequest(input: unknown): TmsRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TmsError('INVALID_REQUEST');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['command', 'fields'].includes(key))) throw new TmsError('INVALID_REQUEST');
  const command = value.command;
  if (typeof command !== 'string' || !['DEBUG_ECHO', 'LOAD_QUERY', 'LOAD_GET'].includes(command)) throw new TmsError('INVALID_COMMAND');
  const fields = value.fields ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TmsError('INVALID_FIELDS');
  const allowed = command === 'LOAD_QUERY' ? queryFields : command === 'LOAD_GET' ? ['LOAD_ID'] : [];
  for (const [key, field] of Object.entries(fields)) {
    if (!allowed.includes(key) || !safeValue(field)) throw new TmsError('INVALID_FIELDS');
    if (key === 'MAX_RESULTS' && !/^(?:[1-9]|1[0-9]|20)$/.test(field)) throw new TmsError('INVALID_FIELDS');
    if (key.endsWith('_STATE') && !/^[A-Z]{2}$/.test(field)) throw new TmsError('INVALID_FIELDS');
    if (key.endsWith('_ZIP') && !/^\d{5}$/.test(field)) throw new TmsError('INVALID_FIELDS');
    if (key === 'PICKUP_DATE' && !/^\d{8}$/.test(field)) throw new TmsError('INVALID_FIELDS');
  }
  const entries = fields as Record<string, string>;
  if (command === 'LOAD_QUERY' && !Object.keys(entries).some(key => key !== 'MAX_RESULTS')) throw new TmsError('FILTER_REQUIRED');
  if (command === 'LOAD_GET' && !entries.LOAD_ID) throw new TmsError('LOAD_ID_REQUIRED');
  return { command: command as TmsCommand, fields: entries };
}

export function encodeRequest(input: TmsRequest, token: string): string {
  const request = validateRequest(input);
  if (!safeValue(token)) throw new TmsError('TMS_NOT_CONFIGURED');
  const fields = request.command === 'DEBUG_ECHO' ? { MSG: 'local-feasibility' } : request.fields ?? {};
  const frame = [`CMD:${request.command}`, `AUTH:${token}`, ...Object.entries(fields).map(([key, value]) => `${key}:${value}`)].join('|') + '\r\n';
  if (Buffer.byteLength(frame, 'ascii') > 4096) throw new TmsError('REQUEST_TOO_LARGE');
  return frame;
}

function parseFields(line: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  for (const pair of line.split('|')) {
    const separator = pair.indexOf(':');
    if (separator < 1) throw new TmsError('MALFORMED_RESPONSE', true);
    const key = pair.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key in fields) throw new TmsError('MALFORMED_RESPONSE', true);
    fields[key] = pair.slice(separator + 1).trimEnd();
  }
  return fields;
}

export function parseResponse(lines: string[], request: TmsRequest): PublicLoad[] {
  if (request.command === 'DEBUG_ECHO') {
    if (lines.length !== 1 || !lines[0].startsWith('ECHO|')) throw new TmsError('MALFORMED_RESPONSE', true);
    const echo = parseFields(lines[0].slice(5));
    if (echo.AUTH !== 'OK' || echo.MSG !== 'local-feasibility') throw new TmsError('INVALID_ECHO', true);
    return [];
  }
  const records = lines.map(line => {
    const fields = parseFields(line);
    if (requiredFields.some(key => !fields[key])) throw new TmsError('MALFORMED_RESPONSE', true);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fields.LOAD_ID)) throw new TmsError('MALFORMED_RESPONSE', true);
    for (const key of ['RATE', 'MILES', 'WEIGHT', 'PIECES']) {
      if (fields[key] !== undefined && !/^\d+(?:\.\d+)?$/.test(fields[key])) throw new TmsError('MALFORMED_RESPONSE', true);
    }
    for (const key of ['PICKUP_DT', 'DELIVERY_DT']) {
      if (fields[key] !== undefined && !/^\d{14}$/.test(fields[key])) throw new TmsError('MALFORMED_RESPONSE', true);
    }
    // Private, unknown, and operator free-text fields never cross this diagnostic boundary.
    return Object.fromEntries(publicFields.filter(key => key in fields).map(key => [key, fields[key]])) as PublicLoad;
  });
  if (request.command === 'LOAD_GET' && (records.length !== 1 || records[0].LOAD_ID !== request.fields?.LOAD_ID)) throw new TmsError('MALFORMED_RESPONSE', true);
  return records;
}

function sendOnce(request: TmsRequest, signal?: AbortSignal): Promise<PublicLoad[]> {
  const host = process.env.TMS_HOST;
  const port = Number(process.env.TMS_PORT);
  const token = process.env.TMS_TOKEN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new TmsError('TMS_NOT_CONFIGURED');
  const frame = encodeRequest(request, token);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TmsError('CANCELLED'));
    const socket = new net.Socket();
    let pending = '';
    let bytes = 0;
    let finished = false;
    const lines: string[] = [];
    const timer = setTimeout(() => finish(new TmsError('TMS_TIMEOUT', true)), 4000);
    const abort = () => finish(new TmsError('CANCELLED'));
    function finish(error?: TmsError, records?: PublicLoad[]) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(records ?? []);
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(frame, 'ascii'));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) return finish(new TmsError('RESPONSE_TOO_LARGE'));
      if (chunk.some(byte => byte > 127 || (byte < 32 && byte !== 10 && byte !== 13))) return finish(new TmsError('MALFORMED_RESPONSE', true));
      pending += chunk.toString('ascii');
      let boundary: number;
      while ((boundary = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (/[\r\n]/.test(line)) return finish(new TmsError('MALFORMED_RESPONSE', true));
        if (line.startsWith('ERR|')) {
          try {
            if (lines.length || pending) throw new TmsError('MALFORMED_RESPONSE', true);
            const error = parseFields(line.slice(4));
            // Never forward the upstream message or arbitrary error codes.
            const known = ['AUTH_FAILED', 'UNKNOWN_CMD', 'MISSING_FIELD', 'UNKNOWN_LOAD', 'ALREADY_BOOKED', 'INVALID_RATE', 'MALFORMED', 'SERVER_ERROR'];
            const code = known.includes(error.CODE) ? error.CODE : 'UPSTREAM_ERROR';
            return finish(new TmsError(code, code === 'SERVER_ERROR'));
          } catch { return finish(new TmsError('MALFORMED_RESPONSE', true)); }
        }
        if (line === 'END') {
          try {
            if (pending) throw new TmsError('MALFORMED_RESPONSE', true);
            return finish(undefined, parseResponse(lines, request));
          } catch (error) { return finish(error instanceof TmsError ? error : new TmsError('MALFORMED_RESPONSE', true)); }
        }
        lines.push(line);
      }
    });
    socket.on('error', () => finish(new TmsError('TMS_CONNECTION_ERROR', true)));
    socket.on('end', () => finish(new TmsError('INCOMPLETE_RESPONSE', true)));
    socket.on('close', () => { if (!finished) finish(new TmsError('INCOMPLETE_RESPONSE', true)); });
    socket.connect(port, host);
  });
}

export async function runTms(input: unknown, signal?: AbortSignal) {
  const request = validateRequest(input);
  const started = Date.now();
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const records = await sendOnce(request, signal);
      return { ok: true as const, command: request.command, complete: true, elapsed_ms: Date.now() - started, attempts: attempt, failures, record_count: records.length, records };
    } catch (error) {
      const fault = error instanceof TmsError ? error : new TmsError('INTERNAL_ERROR');
      failures.push(fault.code);
      if (!fault.retryable || attempt === 2 || signal?.aborted) {
        return { ok: false as const, command: request.command, elapsed_ms: Date.now() - started, attempts: attempt, failures, error: fault.code, retryable: fault.retryable && !signal?.aborted };
      }
      try { await delay(150, undefined, { signal }); } catch {
        return { ok: false as const, command: request.command, elapsed_ms: Date.now() - started, attempts: attempt, failures, error: 'CANCELLED', retryable: false };
      }
    }
  }
  throw new TmsError('INTERNAL_ERROR');
}

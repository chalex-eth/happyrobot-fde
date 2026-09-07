import { z } from 'zod';
import { SessionError } from '../errors.js';
import { runtimeConfig } from '../config/env.js';

export const SqlResponseSchema = z.object({
  command: z.string(),
  rowCount: z.number().int().nullable(),
  fields: z.array(z.object({ name: z.string(), dataTypeId: z.number().int() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});
export type SqlResponse = z.infer<typeof SqlResponseSchema>;
export interface SqlTransport {
  query(source: string): Promise<SqlResponse>;
}
export class DatabaseError extends SessionError {
  constructor(
    code: string,
    readonly constraint?: string,
  ) {
    super(code);
  }
}
export function databaseError(message: string): DatabaseError {
  if (/poc_booking_load_claim/.test(message) && /unique|duplicate/i.test(message))
    return new DatabaseError('BOOKING_REVIEW_REQUIRED', 'poc_booking_load_claim');
  if (/(?:relation|column|schema) .+ does not exist|undefined (column|table)/i.test(message))
    return new DatabaseError('TWIN_SCHEMA_REQUIRED');
  return new DatabaseError('TWIN_QUERY_REJECTED');
}

export function createTwinTransport(options: {
  key: () => string | undefined;
  // Injection is for the disposable HTTP gateway; production uses the fixed API.
  endpoint?: string;
  fetch?: typeof fetch;
}): SqlTransport {
  return {
    async query(source) {
      const key = options.key();
      if (!key) throw new SessionError('BACKEND_NOT_CONFIGURED');
      try {
        const response = await (options.fetch ?? fetch)(
          options.endpoint ?? 'https://platform.happyrobot.ai/api/v2/twin/sql',
          {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: source }),
          },
        );
        if (response.status === 401 || response.status === 403)
          throw new SessionError('BACKEND_AUTH_REQUIRED');
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          const parsed = z.object({ message: z.string() }).safeParse(error);
          if (parsed.success && response.status === 400) throw databaseError(parsed.data.message);
          throw new SessionError('TWIN_UNAVAILABLE');
        }
        const result = SqlResponseSchema.safeParse(await response.json());
        if (!result.success) throw new SessionError('TWIN_INVALID_RESPONSE');
        if (result.data.truncated) throw new SessionError('TWIN_RESULT_TRUNCATED');
        const names = result.data.fields.map((field) => field.name);
        // Twin returns objects: duplicate column names have already lost information.
        // Repositories must explicitly alias joined fields.
        if (new Set(names).size !== names.length) throw new SessionError('TWIN_AMBIGUOUS_COLUMNS');
        for (const row of result.data.rows) {
          for (const field of result.data.fields) {
            if (!(field.name in row)) throw new SessionError('TWIN_INVALID_RESPONSE');
            const value = row[field.name];
            if (
              field.dataTypeId === 20 &&
              typeof value === 'number' &&
              !Number.isSafeInteger(value)
            )
              throw new SessionError('TWIN_INVALID_RESPONSE');
          }
        }
        return result.data;
      } catch (error) {
        if (error instanceof SessionError) throw error;
        throw new SessionError('TWIN_UNAVAILABLE');
      }
    },
  };
}
// Dedicated key may be provisioned separately from workflow administration.
// Never fall back to the public table gateway or another transport on failure.
export const twinTransport = createTwinTransport({ key: () => runtimeConfig().twin.apiKey });

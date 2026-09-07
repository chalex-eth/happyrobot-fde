import { randomUUID, createHash } from 'node:crypto';
import { eq as equal, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SessionError } from '../errors.js';
import {
  CallSchema,
  SnapshotSchema,
  CommitSchema,
  DataSchema,
  canonical,
  eq,
  type Snapshot,
  type Call,
  type Changes,
  type Decision,
  type CommitCommand,
  type Data,
} from './model.js';
import { createDatabase, type TwinDialect } from './client.js';
import { twinTransport, type SqlTransport } from './twin-driver.js';
import { calls } from './schema/index.js';
import { selectSnapshot, selectReceipt, selectOperatorCalls } from './queries.js';
import { commitOperation, createCallOperation } from './atomic.js';

export const CallSelectorSchema = z.union([
  z.strictObject({ hash: z.string().min(1) }),
  z.strictObject({ id: z.string().uuid() }),
  z.strictObject({ runId: z.string().min(1) }),
]);
const CommitResultSchema = z.discriminatedUnion('code', [
  z.object({ code: z.enum(['committed', 'replayed']), result: DataSchema }),
  z.object({
    code: z.enum(['conflict', 'SESSION_REQUIRED', 'OPERATION_CHANGED', 'BOOKING_REVIEW_REQUIRED']),
  }),
]);
const ReceiptSchema = z.object({ fingerprint: z.string(), result: DataSchema }).nullable();
export type CommitResult = z.infer<typeof CommitResultSchema>;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SessionError('TWIN_INVALID_RESPONSE');
  return result.data;
}
// Drizzle wraps driver errors with the SQL text. Strip that wrapper at the
// persistence boundary so private values never enter public errors or logs.
async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    let cause: unknown = error;
    for (let i = 0; i < 5 && cause instanceof Error; i++, cause = cause.cause) {
      if (cause instanceof SessionError) throw cause;
    }
    throw new SessionError('TWIN_UNAVAILABLE');
  }
}
export class Persistence {
  private readonly db;
  constructor(transport: SqlTransport = twinTransport, dialect?: TwinDialect) {
    this.db = createDatabase(transport, dialect);
  }
  async readCall(selector: { hash: string } | { id: string } | { runId: string }) {
    const checked = CallSelectorSchema.parse(selector);
    const where =
      'id' in checked
        ? equal(calls.id, checked.id)
        : 'hash' in checked
          ? equal(calls.session_hash, checked.hash)
          : equal(calls.voice_run_id, checked.runId);
    return run(async () => {
      const rows = await selectSnapshot(this.db, where);
      return parse(SnapshotSchema.nullable(), rows[0]?.snapshot ?? null);
    });
  }
  async readOperationReceipt(callId: string, operationId: string, phase: string) {
    z.string().uuid().parse(callId);
    z.string().min(1).parse(operationId);
    z.string().min(1).parse(phase);
    return run(async () =>
      parse(ReceiptSchema, (await selectReceipt(this.db, callId, operationId, phase))[0] ?? null),
    );
  }
  async createCall(call: Call, previousHash: string | null) {
    const checked = CallSchema.parse(call);
    const hash = z.string().nullable().parse(previousHash);
    try {
      return await run(async () => {
        const rows = await this.db.execute<{ snapshot: unknown }>(
          createCallOperation(this.db, checked, hash),
        );
        return parse(SnapshotSchema, rows[0]?.snapshot);
      });
    } catch (error) {
      const recovered = await this.readCall({ id: checked.id }).catch(() => null);
      if (recovered?.call.session_hash === checked.session_hash) return recovered;
      throw error;
    }
  }
  async queryCalls(operatorKey: string, offset: number) {
    z.string().min(1).parse(operatorKey);
    z.number().int().parse(offset);
    return run(async () => {
      const rows = await this.db.execute<{ result: unknown }>(
        selectOperatorCalls(this.db, operatorKey, offset),
      );
      const result = parse(
        z.union([
          z.array(SnapshotSchema),
          z.object({ error: z.literal('OPERATOR_AUTH_REQUIRED') }),
        ]),
        rows[0]?.result,
      );
      if (!Array.isArray(result)) throw new SessionError(result.error);
      return result;
    });
  }
  async commitCallOperation(command: CommitCommand): Promise<CommitResult> {
    const checked = CommitSchema.parse(command);
    // Build before execution so invalid cross-call changes cannot trigger recovery.
    const batch = commitOperation(this.db, checked);
    try {
      return await run(async () => {
        const rows = await this.db.execute<{ result: unknown }>(sql`${batch}`);
        return parse(CommitResultSchema, rows[0]?.result);
      });
    } catch (error) {
      if (error instanceof SessionError && error.message === 'BOOKING_REVIEW_REQUIRED')
        return { code: 'BOOKING_REVIEW_REQUIRED' };
      const receipt = await this.readOperationReceipt(
        command.callId,
        command.operationId,
        command.phase,
      ).catch(() => null);
      if (receipt)
        return receipt.fingerprint === command.fingerprint
          ? { code: 'replayed', result: receipt.result }
          : { code: 'OPERATION_CHANGED' };
      throw error;
    }
  }
  async execute(
    selector: { hash: string } | { id: string },
    intent: unknown,
    decide: (draft: Snapshot) => Decision,
  ): Promise<Data> {
    const operationId = randomUUID(),
      fingerprint = createHash('sha256').update(canonical(intent)).digest('hex');
    for (let attempt = 0; attempt <= 3; attempt++) {
      const before = await this.readCall(selector);
      if (!before) return { ok: false, error: 'SESSION_REQUIRED' };
      const draft = structuredClone(before),
        decision = decide(draft);
      const changes = diff(before, draft);
      if (Object.keys(changes).length === 0) return decision.result;
      const committed = await this.commitCallOperation({
        callId: before.call.id,
        operationId,
        phase: 'commit',
        fingerprint,
        expectedRevision: before.call.revision,
        preconditions: {
          activeSession: decision.activeSession ?? true,
          ...(decision.validUntil ? { validUntil: decision.validUntil } : {}),
        },
        changes,
        result: decision.result,
      });
      if (committed.code === 'conflict') continue;
      if (committed.code === 'committed') return committed.result;
      if (committed.code === 'replayed')
        return {
          ...committed.result,
          replayed: true,
          ...(committed.result.claimed === true ? { claimed: false } : {}),
        };
      return { ok: false, error: committed.code };
    }
    throw new SessionError('TWIN_CONFLICT');
  }
}
export function diff(before: Snapshot, after: Snapshot): Changes {
  const changes: Changes = {};
  const entries = Object.entries(after.call).filter(
    ([key, value]) =>
      !['id', 'session_hash', 'created_at', 'revision'].includes(key) &&
      !eq(value, Reflect.get(before.call, key)),
  );
  if (entries.length) changes.call = Object.fromEntries(entries);
  if (after.negotiation && !eq(before.negotiation, after.negotiation))
    changes.negotiation = after.negotiation;
  if (after.events.length > before.events.length)
    changes.events = after.events
      .slice(before.events.length)
      .map(({ event, metadata, created_at }) => ({ event, metadata, created_at }));
  const reviews = after.reviews.filter((r) => !before.reviews.some((old) => eq(old, r)));
  if (reviews.length) changes.reviews = reviews;
  if (after.otpReceipts.length > before.otpReceipts.length)
    changes.otpReceipts = after.otpReceipts.slice(before.otpReceipts.length);
  if (after.offerReceipts.length > before.offerReceipts.length)
    changes.offerReceipts = after.offerReceipts.slice(before.offerReceipts.length);
  return changes;
}

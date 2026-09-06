import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { twinConfig } from '../config/env.js';
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
import type { DatabaseRpc } from './generated/database.js';
export type PersistenceRpc = Extract<
  keyof DatabaseRpc,
  'poc_read_call' | 'poc_read_receipt' | 'poc_query_calls' | 'poc_insert_call' | 'poc_commit_call'
>;
export const persistenceInputs = {
  poc_read_call: z.strictObject({
    p_selector: z.union([
      z.strictObject({ hash: z.string().min(1) }),
      z.strictObject({ id: z.string().uuid() }),
      z.strictObject({ runId: z.string().min(1) }),
    ]),
  }),
  poc_read_receipt: z.strictObject({
    p_call_id: z.string().uuid(),
    p_operation_id: z.string().min(1),
    p_phase: z.string().min(1),
  }),
  poc_query_calls: z.strictObject({
    p_operator_key: z.string().min(1),
    p_offset: z.number().int().nonnegative().optional(),
  }),
  poc_insert_call: z.strictObject({
    p_call: CallSchema,
    p_previous_hash: z.string().nullable(),
    p_event: z.strictObject({
      event: z.literal('call_started'),
      metadata: DataSchema,
      created_at: z.string(),
    }),
  }),
  poc_commit_call: z.strictObject({ p_command: CommitSchema }),
} satisfies { [K in PersistenceRpc]: z.ZodType<Omit<DatabaseRpc[K]['Args'], 'p_key'>> };
export interface PersistenceTransport {
  request(name: PersistenceRpc, args: Record<string, unknown>): Promise<unknown>;
}
export const twinTransport: PersistenceTransport = {
  async request(name, args) {
    const { TWIN_GATEWAY, TWIN_ORG_ID } = twinConfig();
    const key = process.env.BACKEND_RPC_KEY;
    if (!key || key.length < 32) throw new SessionError('BACKEND_NOT_CONFIGURED');
    try {
      const response = await fetch(new URL(`/rpc/${name}`, TWIN_GATEWAY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-org-id': TWIN_ORG_ID },
        body: JSON.stringify({ ...args, p_key: key }),
        signal: AbortSignal.timeout(6000),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok)
        throw new SessionError(
          response.status === 404 ? 'TWIN_SCHEMA_REQUIRED' : 'TWIN_UNAVAILABLE',
        );
      return await response.json();
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError('TWIN_UNAVAILABLE');
    }
  },
};
const CommitResultSchema = z.discriminatedUnion('code', [
  z.object({ code: z.enum(['committed', 'replayed']), result: DataSchema }),
  z.object({
    code: z.enum(['conflict', 'SESSION_REQUIRED', 'OPERATION_CHANGED', 'BOOKING_REVIEW_REQUIRED']),
  }),
]);
const ReceiptSchema = z.object({ fingerprint: z.string(), result: DataSchema }).nullable();
export class Persistence {
  constructor(private readonly transport: PersistenceTransport = twinTransport) {}
  private async request<K extends PersistenceRpc, S extends z.ZodType>(
    name: K,
    args: Omit<DatabaseRpc[K]['Args'], 'p_key'>,
    schema: S,
  ): Promise<z.output<S>> {
    const checked = persistenceInputs[name].parse(args);
    const value = await this.transport.request(name, checked);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SessionError('TWIN_INVALID_RESPONSE');
    return parsed.data;
  }
  readCall(selector: { hash: string } | { id: string } | { runId: string }) {
    return this.request('poc_read_call', { p_selector: selector }, SnapshotSchema.nullable());
  }
  readOperationReceipt(callId: string, operationId: string, phase: string) {
    return this.request(
      'poc_read_receipt',
      { p_call_id: callId, p_operation_id: operationId, p_phase: phase },
      ReceiptSchema,
    );
  }
  createCall(call: Call, previousHash: string | null) {
    return this.request(
      'poc_insert_call',
      {
        p_call: CallSchema.parse(call),
        p_previous_hash: previousHash,
        p_event: { event: 'call_started', metadata: {}, created_at: call.created_at },
      },
      SnapshotSchema,
    );
  }
  async queryCalls(operatorKey: string, offset: number) {
    const result = await this.request(
      'poc_query_calls',
      { p_operator_key: operatorKey, p_offset: offset },
      z.union([z.array(SnapshotSchema), z.object({ error: z.literal('OPERATOR_AUTH_REQUIRED') })]),
    );
    if (!Array.isArray(result)) throw new SessionError(result.error);
    return result;
  }
  async commitCallOperation(command: CommitCommand) {
    const parsed = CommitSchema.parse(command);
    try {
      return await this.request('poc_commit_call', { p_command: parsed }, CommitResultSchema);
    } catch (error) {
      // Recovery is a read, never a repeated write or a grant to send externally.
      const receipt = await this.readOperationReceipt(
        command.callId,
        command.operationId,
        command.phase,
      ).catch(() => null);
      if (receipt && receipt.fingerprint === command.fingerprint)
        return { code: 'replayed' as const, result: receipt.result };
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

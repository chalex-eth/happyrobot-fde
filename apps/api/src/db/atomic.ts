import { eq, getTableColumns, Param, sql, type InferInsertModel, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import {
  calls,
  events,
  negotiations,
  reviews,
  otpReceipts,
  offerReceipts,
  operationReceipts,
} from './schema/index.js';
import type { Call, CommitCommand } from './model.js';
import { selectSnapshot } from './queries.js';

// Drizzle builds regular updates and reads. This small SQL composition is needed
// for conditional INSERT ... SELECT: every record must depend on the winning
// update, not merely share a request with it. Tables/columns come from our schema.
function insertFrom<T extends PgTable>(
  table: T,
  rows: InferInsertModel<T>[],
  gate: SQL,
  conflict?: {
    target: (keyof InferInsertModel<T> & string)[];
    update: (keyof InferInsertModel<T> & string)[];
  },
): SQL {
  if (!rows.length) throw new Error('EMPTY_INSERT');
  const columns = getTableColumns(table);
  const keys = Object.keys(rows[0]!);
  if (keys.some((key) => !columns[key])) throw new Error('INVALID_DATABASE_COLUMN');
  const names = keys.map((key) => sql.identifier(columns[key]!.name));
  const tuples = rows.map((row) => {
    if (Object.keys(row).join(',') !== keys.join(','))
      throw new Error('INCONSISTENT_INSERT_COLUMNS');
    return sql`(${sql.join(
      keys.map((key) => {
        const column = columns[key]!;
        return sql`${new Param(Reflect.get(row, key), column)}::${sql.raw(column.getSQLType())}`;
      }),
      sql`, `,
    )})`;
  });
  const upsert = conflict
    ? sql`on conflict (${sql.join(
        conflict.target.map((key) => sql.identifier(columns[key]!.name)),
        sql`, `,
      )})
    do update set ${sql.join(
      conflict.update.map((key) => {
        const name = sql.identifier(columns[key]!.name);
        return sql`${name}=excluded.${name}`;
      }),
      sql`, `,
    )}`
    : sql``;
  return sql`insert into ${table} (${sql.join(names, sql`, `)})
    select input.* from (${gate}) winner cross join (values ${sql.join(tuples, sql`, `)}) input(${sql.join(names, sql`, `)})
    ${upsert} returning 1`;
}

export function commitOperation(db: Database, command: CommitCommand): SQL {
  const { callId, changes } = command;
  // Reject cross-call records before executing any SQL.
  const records = [
    changes.negotiation,
    ...(changes.reviews ?? []),
    ...(changes.otpReceipts ?? []),
    ...(changes.offerReceipts ?? []),
  ];
  if (records.some((record) => record && record.call_id !== callId))
    throw new Error('INVALID_CALL_ID');
  const locked = db.select({ id: calls.id }).from(calls).where(eq(calls.id, callId)).for('update');
  const existing = db.select().from(operationReceipts)
    .where(sql`${operationReceipts.call_id}=${callId}
    and ${operationReceipts.operation_id}=${command.operationId} and ${operationReceipts.phase}=${command.phase}`);
  const verdict = sql`select case
    when not exists(select 1 from ${calls} where ${calls.id}=${callId}) then 'SESSION_REQUIRED'
    when exists(select 1 from prior) then case when (select fingerprint from prior)=${command.fingerprint} then 'replayed' else 'OPERATION_CHANGED' end
    when (select ${calls.revision} from ${calls} where ${calls.id}=${callId}) <> ${command.expectedRevision} then 'conflict'
    when ${command.preconditions.activeSession} and (select ${calls.session_expires_at} from ${calls} where ${calls.id}=${callId}) <= clock_timestamp() then 'SESSION_REQUIRED'
    when ${command.preconditions.validUntil ?? null}::timestamptz <= clock_timestamp() then 'conflict'
    else 'committed' end as code`;
  const changed = db
    .update(calls)
    .set({ ...changes.call, revision: sql`${calls.revision}+1` })
    .where(sql`${calls.id}=${callId} and (select code from verdict)='committed'`)
    .returning({ id: calls.id });
  const winner = sql`select id from changed`;
  const writes: ((gate: SQL) => SQL)[] = [];
  if (changes.negotiation)
    writes.push((gate) =>
      insertFrom(negotiations, [changes.negotiation!], gate, {
        target: ['call_id'],
        update: [
          'authority_revision',
          'load_id',
          'offer_id',
          'listed_cents',
          'max_cents',
          'offered_cents',
          'agreed_cents',
          'counter_rounds',
          'status',
          'expires_at',
        ],
      }),
    );
  // Separate event CTEs preserve the original event insertion order.
  for (const event of changes.events ?? [])
    writes.push((gate) => insertFrom(events, [{ call_id: callId, ...event }], gate));
  for (const review of changes.reviews ?? [])
    writes.push((gate) =>
      insertFrom(reviews, [review], gate, {
        target: ['call_id', 'reason'],
        update: [
          'status',
          'detail',
          'callback_number',
          'source_key',
          'revision',
          'updated_at',
          'resolution_note',
          'reviewed_at',
        ],
      }),
    );
  for (const receipt of changes.otpReceipts ?? [])
    writes.push((gate) => insertFrom(otpReceipts, [receipt], gate));
  for (const receipt of changes.offerReceipts ?? [])
    writes.push((gate) => insertFrom(offerReceipts, [receipt], gate));
  writes.push((gate) =>
    insertFrom(
      operationReceipts,
      [
        {
          call_id: callId,
          operation_id: command.operationId,
          phase: command.phase,
          fingerprint: command.fingerprint,
          result: command.result,
        },
      ],
      gate,
    ),
  );
  // Force a dependency chain so identity/event ordering is deterministic.
  const ctes = writes.map((write, index) => {
    const gate =
      index === 0
        ? winner
        : sql`select id from changed where (select count(*) from ${sql.identifier(`write_${index - 1}`)}) >= 0`;
    return sql`${sql.identifier(`write_${index}`)} as (${write(gate)})`;
  });
  return sql`${locked}; with prior as materialized (${existing}), verdict as materialized (${verdict}), changed as (${changed.getSQL()}),
    ${sql.join(ctes, sql`, `)}
    select case when code in ('committed','replayed') then jsonb_build_object('code',code,'result',
      case when code='replayed' then (select result from prior) else ${JSON.stringify(command.result)}::jsonb end)
      else jsonb_build_object('code',code) end as result from verdict`;
}

export function createCallOperation(db: Database, call: Call, previousHash: string | null): SQL {
  // A row does not exist yet, so serialize retries of the same creation by UUID.
  const lock = sql`select pg_advisory_xact_lock(hashtextextended(${call.id},0))`;
  const fresh = sql`select 1 where not exists(select 1 from ${calls} where ${calls.id}=${call.id} and ${calls.session_hash}=${call.session_hash})`;
  const inserted = insertFrom(calls, [call], fresh);
  const invalidate = db
    .update(calls)
    .set({
      session_expires_at: sql`statement_timestamp()`,
      otp_digest: null,
      revision: sql`${calls.revision}+1`,
    })
    .where(sql`${calls.session_hash}=${previousHash} and exists(select 1 from inserted)`);
  const event = insertFrom(
    events,
    [{ call_id: call.id, event: 'call_started', metadata: {}, created_at: call.created_at }],
    sql`select * from inserted`,
  );
  return sql`${lock}; with inserted as (${inserted}), expired as (${invalidate.getSQL()}), started as (${event}) select count(*) from inserted;
    ${selectSnapshot(db, eq(calls.id, call.id))}`;
}

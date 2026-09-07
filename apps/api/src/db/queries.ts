import { createHash } from 'node:crypto';
import { eq, sql, getTableName, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';
import {
  calls,
  negotiations,
  otpReceipts,
  offerReceipts,
  events,
  reviews,
  operationReceipts,
  operatorAccess,
} from './schema/index.js';

const ref = (column: PgColumn) =>
  sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
export const snapshotExpression = sql`jsonb_build_object(
  'call', to_jsonb(${sql.identifier(getTableName(calls))}) || jsonb_build_object('revision',${ref(calls.revision)}), 'now', statement_timestamp(),
  'negotiation', (select to_jsonb(${sql.identifier(getTableName(negotiations))}) from ${negotiations} where ${ref(negotiations.call_id)}=${ref(calls.id)}),
  'otpReceipts', coalesce((select jsonb_agg(to_jsonb(${sql.identifier(getTableName(otpReceipts))})) from ${otpReceipts} where ${ref(otpReceipts.call_id)}=${ref(calls.id)}), '[]'::jsonb),
  'offerReceipts', coalesce((select jsonb_agg(to_jsonb(${sql.identifier(getTableName(offerReceipts))})) from ${offerReceipts} where ${ref(offerReceipts.call_id)}=${ref(calls.id)}), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(to_jsonb(${sql.identifier(getTableName(events))}) order by ${ref(events.id)}) from ${events} where ${ref(events.call_id)}=${ref(calls.id)}), '[]'::jsonb),
  'reviews', coalesce((select jsonb_agg(to_jsonb(${sql.identifier(getTableName(reviews))}) order by ${ref(reviews.created_at)},${ref(reviews.id)}) from ${reviews} where ${ref(reviews.call_id)}=${ref(calls.id)}), '[]'::jsonb)
)`;
export function selectSnapshot(db: Database, where: SQL) {
  return db
    .select({ snapshot: snapshotExpression.as('snapshot') })
    .from(calls)
    .where(where);
}
export function selectReceipt(db: Database, callId: string, operationId: string, phase: string) {
  return db
    .select({ fingerprint: operationReceipts.fingerprint, result: operationReceipts.result })
    .from(operationReceipts)
    .where(
      sql`${operationReceipts.call_id}=${callId} and ${operationReceipts.operation_id}=${operationId} and ${operationReceipts.phase}=${phase}`,
    );
}
export function selectOperatorCalls(db: Database, key: string, offset: number) {
  const auth = db
    .select({ key: operatorAccess.key_hash })
    .from(operatorAccess)
    .where(eq(operatorAccess.key_hash, createHash('sha256').update(key).digest('hex')));
  const page = selectSnapshot(db, sql`true`)
    .orderBy(sql`${calls.created_at} desc`, calls.id)
    .limit(100)
    .offset(Math.max(0, offset));
  return sql`select case when exists (${auth})
    then coalesce((select jsonb_agg(page.snapshot) from (${page}) page),'[]'::jsonb)
    else jsonb_build_object('error','OPERATOR_AUTH_REQUIRED') end as result`;
}

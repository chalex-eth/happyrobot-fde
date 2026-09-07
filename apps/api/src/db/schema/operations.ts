import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  check,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { calls } from './calls.js';
import { privateSchema } from './receipts.js';
import type { Data } from '../model.js';
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const events = pgTable(
  'poc_call_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    call_id: uuid()
      .notNull()
      .references(() => calls.id),
    event: text().notNull(),
    created_at: time('created_at').notNull().defaultNow(),
    metadata: jsonb().$type<Data>().notNull().default({}),
  },
  (t) => [
    index('poc_events_call_time').on(t.call_id, t.created_at),
    index('poc_events_send_time')
      .on(t.created_at)
      .where(sql`${t.event} = 'otp_requested'`),
  ],
);
export const reviews = pgTable(
  'poc_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    call_id: uuid()
      .notNull()
      .references(() => calls.id),
    reason: text().notNull(),
    status: text().notNull().default('open'),
    detail: text().notNull(),
    callback_number: text(),
    source_key: text().notNull(),
    revision: uuid().notNull().defaultRandom(),
    created_at: time('created_at').notNull().defaultNow(),
    updated_at: time('updated_at').notNull().defaultNow(),
    resolution_note: text(),
    reviewed_at: time('reviewed_at'),
  },
  (t) => [
    unique('poc_reviews_call_id_reason_key').on(t.call_id, t.reason),
    check('poc_reviews_status_check', sql`${t.status} in ('open','reviewed')`),
    index('poc_reviews_open')
      .on(t.updated_at.desc())
      .where(sql`${t.status} = 'open'`),
  ],
);
export const operatorAccess = privateSchema.table('operator_access', {
  key_hash: text().primaryKey(),
});

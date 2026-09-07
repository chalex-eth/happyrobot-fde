import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Data } from '../model.js';
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const calls = pgTable(
  'poc_calls',
  {
    id: uuid().primaryKey(),
    session_hash: text().notNull().unique(),
    authority_check: jsonb().$type<Data>(),
    authority_passed: boolean().notNull(),
    created_at: time('created_at').notNull().defaultNow(),
    session_expires_at: time('session_expires_at')
      .notNull()
      .default(sql`now() + interval '1 hour'`),
    otp_state: text({
      enum: ['not_sent', 'dispatching', 'pending', 'failed', 'expired', 'locked', 'verified'],
    })
      .notNull()
      .default('not_sent'),
    challenge_id: uuid(),
    otp_digest: text(),
    otp_expires_at: time('otp_expires_at'),
    otp_attempts: integer().notNull().default(0),
    otp_verified_at: time('otp_verified_at'),
    demo_recipient: text(),
    authority_revision: integer().notNull().default(0),
    available_load_ids: jsonb().$type<string[]>().notNull().default([]),
    selected_load_id: text(),
    voice_run_id: text().unique(),
    voice_state: text({ enum: ['idle', 'creating', 'ready', 'failed'] })
      .notNull()
      .default('idle'),
    finalized_at: time('finalized_at'),
    final_outcome: text(),
    final_summary: text(),
    final_result: jsonb().$type<Data>(),
    revision: bigint({ mode: 'number' }).notNull().default(0),
    otp_failures: integer().notNull().default(0),
    booking: jsonb().$type<Data>(),
    booking_terms: jsonb().$type<Data>(),
    load_statuses: jsonb().$type<Data>().notNull().default({}),
    load_interest: jsonb().$type<Data>(),
    source: text().notNull().default('unknown'),
    last_activity_at: time('last_activity_at').notNull().defaultNow(),
    reported_end_reason: text(),
    ended_at: time('ended_at'),
    end_evidence: text(),
    load_snapshots: jsonb().$type<Data>().notNull().default({}),
  },
  (t) => [
    check('poc_calls_revision_check', sql`${t.revision} >= 0`),
    check('poc_calls_otp_failures_check', sql`${t.otp_failures} between 0 and 2`),
    check('poc_calls_session_hash_check', sql`${t.session_hash} ~ '^[a-f0-9]{64}$'`),
    check(
      'poc_calls_otp_state_check',
      sql`${t.otp_state} in ('not_sent','dispatching','pending','failed','expired','locked','verified')`,
    ),
    check(
      'poc_calls_voice_state_check',
      sql`${t.voice_state} in ('idle','creating','ready','failed')`,
    ),
    index('poc_calls_recent').on(t.created_at.desc(), t.id),
    uniqueIndex('poc_booking_load_claim')
      .on(sql`(${t.booking}->>'load_id')`)
      .where(
        sql`${t.booking}->>'status' in ('pending','confirmed','uncertain') and coalesce(${t.booking}->>'simulated','false') <> 'true'`,
      ),
  ],
);
export type CallRow = typeof calls.$inferSelect;

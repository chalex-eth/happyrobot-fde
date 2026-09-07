import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { privateSchema } from './receipts.js';
import { calls } from './calls.js';
import type { Data } from '../model.js';
export const negotiations = privateSchema.table(
  'negotiations',
  {
    call_id: uuid()
      .primaryKey()
      .references(() => calls.id),
    authority_revision: integer().notNull(),
    load_id: text().notNull(),
    offer_id: uuid().notNull().defaultRandom(),
    listed_cents: bigint({ mode: 'number' }).notNull(),
    max_cents: bigint({ mode: 'number' }).notNull(),
    offered_cents: bigint({ mode: 'number' }).notNull(),
    agreed_cents: bigint({ mode: 'number' }),
    counter_rounds: integer().notNull().default(0),
    status: text().notNull().default('offered'),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    check('negotiations_max_at_least_listed', sql`${t.max_cents} >= ${t.listed_cents}`),
    check(
      'negotiations_offered_within_max',
      sql`${t.offered_cents} > 0 and ${t.offered_cents} <= ${t.max_cents}`,
    ),
    check(
      'negotiations_agreed_within_max',
      sql`${t.agreed_cents} > 0 and ${t.agreed_cents} <= ${t.max_cents}`,
    ),
    check('negotiations_counter_rounds_check', sql`${t.counter_rounds} between 0 and 3`),
    check('negotiations_listed_cents_check', sql`${t.listed_cents} > 0`),
    check(
      'negotiations_status_check',
      sql`${t.status} in ('idle','offered','agreed','rejected','failed')`,
    ),
  ],
);
export const offerReceipts = privateSchema.table(
  'offer_receipts',
  {
    call_id: uuid()
      .notNull()
      .references(() => calls.id),
    offer_id: uuid().notNull(),
    fingerprint: jsonb().$type<Data>().notNull(),
    result: jsonb().$type<Data>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.call_id, t.offer_id] })],
);

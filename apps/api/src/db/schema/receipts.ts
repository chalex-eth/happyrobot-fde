import { pgSchema, uuid, text, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { calls } from './calls.js';
import type { Data } from '../model.js';
export const privateSchema = pgSchema('poc_private');
export const operationReceipts = privateSchema.table(
  'operation_receipts',
  {
    call_id: uuid()
      .notNull()
      .references(() => calls.id),
    operation_id: text().notNull(),
    phase: text().notNull(),
    fingerprint: text().notNull(),
    result: jsonb().$type<Data>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.call_id, t.operation_id, t.phase] })],
);

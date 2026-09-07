import { uuid, text, integer, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { privateSchema } from './receipts.js';
import { calls } from './calls.js';
import type { Data } from '../model.js';
export const otpReceipts = privateSchema.table(
  'otp_receipts',
  {
    call_id: uuid()
      .notNull()
      .references(() => calls.id),
    operation_id: text().notNull(),
    authority_revision: integer().notNull(),
    fingerprint: text().notNull(),
    result: jsonb().$type<Data>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.call_id, t.operation_id] })],
);

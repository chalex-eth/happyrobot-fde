import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from './schema/index.js';
import { twinTransport, type SqlTransport } from './twin-driver.js';

// Twin's documented SQL API has no bound-parameter argument. Compile Drizzle's
// SQL syntax tree in literal mode, after column encoders run. Never substitute
// placeholders in a completed SQL string. E literals are independent of the
// connection's standard_conforming_strings setting.
export class TwinDialect extends PgDialect {
  override escapeString(value: string): string {
    if (value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value)
      throw new Error('INVALID_DATABASE_TEXT');
    return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
  }
  override sqlToQuery(query: SQL) {
    const compiled = super.sqlToQuery(sql`${query}`.inlineParams());
    if (compiled.params.length) throw new Error('UNSUPPORTED_DATABASE_PARAMETER');
    return compiled;
  }
}
export function createDatabase(
  transport: SqlTransport = twinTransport,
  dialect: TwinDialect = new TwinDialect(),
) {
  return drizzle(
    async (source, parameters, method) => {
      if (parameters.length) throw new Error('UNSUPPORTED_DATABASE_PARAMETER');
      const result = await transport.query(source);
      return {
        rows:
          method === 'all'
            ? result.rows.map((row) => result.fields.map((field) => row[field.name]))
            : result.rows,
      };
    },
    { schema },
    () => dialect,
  );
}
export type Database = ReturnType<typeof createDatabase>;

// Live, opt-in verification. All schema identifiers are remapped at Drizzle's
// dialect boundary to newly generated public scratch tables. No app tables read.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { is, getTableName, getTableColumns, sql, eq } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema/index.js';
import { createDatabase, TwinDialect } from '../../src/db/client.js';
import { createTwinTransport } from '../../src/db/twin-driver.js';
import { Persistence } from '../../src/db/persistence.js';
import { buildInitialCall } from '../../src/modules/calls/index.js';
import { executeCommand, withPersistence } from '../../src/application/commands.js';

if (!process.argv.includes('--allow-shared-scratch'))
  throw Error('Requires --allow-shared-scratch');
const prefix = 'codex_drizzle_' + randomUUID().replaceAll('-', '').slice(0, 12) + '_';
const tables = (Object.values(schema) as unknown[]).filter((table): table is PgTable =>
  is(table, PgTable),
);
const mapping = new Map(tables.map((table) => [getTableName(table), prefix + getTableName(table)]));
const columns = new Set(
  tables.flatMap((table) => Object.values(getTableColumns(table)).map((col) => col.name)),
);
class ScratchDialect extends TwinDialect {
  override escapeName(name: string) {
    return super.escapeName(mapping.get(name) ?? (name === 'poc_private' ? 'public' : name));
  }
}
const transport = createTwinTransport({
  key: () => process.env.TWIN_API_KEY ?? process.env.HAPPYROBOT_API_KEY,
});
const dialect = new ScratchDialect();
const orm = createDatabase(transport, dialect);
const db = new Persistence(transport, dialect);
const plain = new TwinDialect();
const send = (query: ReturnType<typeof sql>) => transport.query(plain.sqlToQuery(query).sql);
const report: {
  startedAt: string;
  tables: string[];
  tests: string[];
  cleanup: string[];
  error?: string;
  finishedAt?: string;
} = { startedAt: new Date().toISOString(), tables: [...mapping.values()], tests: [], cleanup: [] };
let absent = false;
const absentCheck = async () => {
  const result = await send(
    sql`select ${sql.join(
      [...mapping.values()].map(
        (name, i) => sql`to_regclass(${`public.${name}`}) as ${sql.identifier(`t${i}`)}`,
      ),
      sql`, `,
    )}`,
  );
  assert.ok(Object.values(result.rows[0]!).every((value) => value === null));
};
try {
  await absentCheck();
  absent = true;
  let ddl = (
    await readFile(new URL('../migrations/0001_initial_schema.sql', import.meta.url), 'utf8')
  ).split('-- Access permissions')[0]!;
  // Only the checked-in, generated DDL is transformed here, never value-bearing
  // runtime SQL. Runtime table remapping uses escapeName on the Drizzle AST.
  ddl = ddl
    .replace('BEGIN;', '')
    .replace('CREATE SCHEMA "poc_private";', '')
    .replace(/"([^"]+)"/g, (_match, name: string) => {
      const replacement =
        mapping.get(name) ??
        (['poc_private', 'public'].includes(name)
          ? 'public'
          : columns.has(name)
            ? name
            : prefix + 'aux_' + createHash('sha256').update(name).digest('hex').slice(0, 12));
      return '"' + replacement + '"';
    });
  await transport.query(ddl);
  const call = buildInitialCall(randomUUID(), 'a'.repeat(64), new Date().toISOString());
  await db.createCall(call, null);
  report.tests.push('Production Drizzle createCall and snapshot on remapped scratch tables');
  for (const source of [
    "O'Brien \\ $1 ; --",
    'Paris 東京 🚚',
    '',
    "x'); DROP TABLE imaginary; --",
  ]) {
    await orm
      .update(schema.calls)
      .set({ source, authority_check: { note: source, nullable: null } })
      .where(eq(schema.calls.id, call.id));
    const [saved] = await orm
      .select({ source: schema.calls.source, check: schema.calls.authority_check })
      .from(schema.calls)
      .where(eq(schema.calls.id, call.id));
    assert.deepEqual(saved, { source, check: { note: source, nullable: null } });
  }
  report.tests.push(
    'Drizzle UPDATE/SELECT result mapping and exact SQL-like text/Unicode/JSON round trips',
  );
  const command = {
    callId: call.id,
    operationId: 'live-commit',
    phase: 'test',
    fingerprint: 'same',
    expectedRevision: 0,
    preconditions: { activeSession: true },
    changes: {
      call: { source: 'integration_test' },
      events: [{ event: 'live-atomic', metadata: {}, created_at: call.created_at }],
    },
    result: { ok: true },
  };
  const commits = await Promise.all([
    db.commitCallOperation(command),
    db.commitCallOperation(command),
  ]);
  assert.deepEqual(commits.map((r) => r.code).sort(), ['committed', 'replayed']);
  assert.equal(
    (await db.readCall({ id: call.id }))!.events.filter((e) => e.event === 'live-atomic').length,
    1,
  );
  report.tests.push(
    'Production atomic compiler: two concurrent duplicates, one revision/event/receipt',
  );
  await assert.rejects(() =>
    db.commitCallOperation({
      ...command,
      operationId: 'rollback',
      expectedRevision: 1,
      changes: {
        call: { source: 'must rollback' },
        negotiation: {
          call_id: call.id,
          authority_revision: 0,
          load_id: 'test',
          offer_id: randomUUID(),
          listed_cents: 100,
          max_cents: 50,
          offered_cents: 100,
          agreed_cents: null,
          counter_rounds: 0,
          status: 'offered',
          expires_at: call.session_expires_at,
        },
      },
    }),
  );
  const afterFailure = (await db.readCall({ id: call.id }))!;
  assert.equal(afterFailure.call.source, 'integration_test');
  assert.equal(afterFailure.call.revision, 1);
  assert.equal(await db.readOperationReceipt(call.id, 'rollback', 'test'), null);
  report.tests.push('Constraint failure rolls back production compiler writes');
  const lost = new Persistence(
    {
      async query(source) {
        const result = await transport.query(source);
        if (source.includes('with prior as materialized')) throw Error('discarded acknowledgement');
        return result;
      },
    },
    dialect,
  );
  const recovered = await lost.commitCallOperation({
    ...command,
    operationId: 'lost',
    expectedRevision: 1,
    result: { ok: true, claimed: true },
  });
  assert.equal(recovered.code, 'replayed');
  assert.equal((await db.readCall({ id: call.id }))!.call.revision, 2);
  report.tests.push(
    'Production persistence recovers discarded acknowledgement through receipt read',
  );
  const result = await withPersistence(db, () =>
    executeCommand('poc_finalize_call', {
      p_session_hash: call.session_hash,
      p_outcome: 'technical_error',
      p_summary: 'Synthetic Drizzle adapter test',
    }),
  );
  assert.equal(result.ok, true);
  const finalized = (await db.readCall({ id: call.id }))!;
  assert.ok(finalized.call.finalized_at);
  assert.equal(finalized.call.final_outcome, 'technical_error');
  report.tests.push('Actual TypeScript finalization and associated writes through Drizzle/Twin');
  console.log(report.tests.join('\n'));
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Failed';
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (absent) {
    // Drop all children first; CASCADE is deliberately not used.
    const ordered = [...mapping.values()].filter((name) => name !== mapping.get('poc_calls'));
    ordered.push(mapping.get('poc_calls')!);
    for (const name of ordered) {
      try {
        await send(sql`drop table if exists public.${sql.identifier(name)}`);
        report.cleanup.push(name);
      } catch {
        report.error = 'Cleanup incomplete; inspect scratch tables in this report';
        process.exitCode = 1;
      }
    }
    try {
      await absentCheck();
      report.tests.push('All scratch tables confirmed absent');
    } catch {
      report.error = 'Cleanup verification failed';
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL('../../../../docs/drizzle-twin-validation.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log('Scratch cleanup:', report.cleanup.length, '/', report.tables.length);
}

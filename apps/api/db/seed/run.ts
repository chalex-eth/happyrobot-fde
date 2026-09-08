import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { sql, getTableColumns, Param, inArray, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createDatabase, TwinDialect } from '../../src/db/client.js';
import { twinTransport, type SqlTransport } from '../../src/db/twin-driver.js';
import { calls, events, negotiations, reviews, offerReceipts } from '../../src/db/schema/index.js';
import { selectSnapshot } from '../../src/db/queries.js';
import { SnapshotSchema, type Snapshot } from '../../src/db/model.js';
import { buildSeed, seedId, validateScenario } from './build.js';
import { scenarios, seedVersion } from './scenarios.js';
const dialect = new TwinDialect();
// Every dependent insert is gated by its parent call's insertion, preserving existing rows.
function insert(table: PgTable, row: object, gate?: SQL): SQL {
  const columns = getTableColumns(table);
  const keys = Object.keys(row);
  assert.ok(keys.every((k) => columns[k]));
  return sql`insert into ${table} (${sql.join(
    keys.map((k) => sql.identifier(columns[k]!.name)),
    sql`,`,
  )})
    select ${sql.join(
      keys.map((k) => sql`${new Param(Reflect.get(row, k), columns[k]!)}`),
      sql`,`,
    )}
    ${gate ? sql`where exists (${gate})` : sql``} returning 1`;
}
export function seedSql(snapshots: Snapshot[]): string {
  const db = createDatabase();
  const statements: SQL[] = [sql`select pg_advisory_xact_lock(hashtextextended(${seedVersion},0))`];
  for (const s of snapshots) {
    const parent = db
      .insert(calls)
      .values(s.call)
      .onConflictDoNothing({ target: calls.id })
      .returning({ id: calls.id });
    const children: SQL[] = [];
    const add = (table: PgTable, row: object) => {
      const previous = children.length
        ? sql`and (select count(*) from ${sql.identifier(`child_${children.length - 1}`)}) >= 0`
        : sql``;
      children.push(
        sql`${sql.identifier(`child_${children.length}`)} as (${insert(table, row, sql`select 1 from inserted where true ${previous}`)})`,
      );
    };
    if (s.negotiation) add(negotiations, s.negotiation);
    for (const e of s.events) {
      const { id: _id, ...row } = e;
      add(events, row);
    }
    for (const r of s.reviews) add(reviews, r);
    for (const r of s.offerReceipts) add(offerReceipts, r);
    statements.push(
      sql`with inserted as (${parent.getSQL()}), ${sql.join(children, sql`,`)} select count(*) from inserted`,
    );
  }
  // Twin executes a SQL request atomically; no transaction spans HTTP requests.
  statements.push(sql`select ${seedVersion} as seed_version`);
  return dialect.sqlToQuery(sql.join(statements, sql`;\n`)).sql;
}
export async function readSeed(transport: SqlTransport): Promise<Snapshot[]> {
  const db = createDatabase(transport);
  const result = await selectSnapshot(
    db,
    inArray(
      calls.id,
      scenarios.map((s) => seedId(s.key)),
    ),
  );
  return result.map((r) => SnapshotSchema.parse(r.snapshot));
}
export async function verifySeed(transport: SqlTransport, exactIds?: Set<string>) {
  const saved = await readSeed(transport);
  assert.equal(saved.length, scenarios.length, 'Seed is incomplete');
  return scenarios.map((spec) => {
    const s = saved.find((s) => s.call.id === seedId(spec.key))!;
    // Existing manager edits are preserved; enforce expected outcomes on new inserts only.
    const call = validateScenario(s, spec, exactIds ? exactIds.has(s.call.id) : true);
    return {
      scenario: spec.key,
      id: s.call.id,
      outcome: call.call_outcome?.code,
      events: s.events.length,
      open_reviews: s.reviews.filter((r) => r.status === 'open').length,
    };
  });
}
export async function applySeed(transport: SqlTransport, seed = buildSeed()) {
  const existing = await readSeed(transport);
  for (const s of existing) {
    const spec = scenarios.find((spec) => seedId(spec.key) === s.call.id)!;
    validateScenario(s, spec, false); // Refuse IDs owned by unrelated records.
  }
  const newIds = new Set(
    seed.filter((s) => !existing.some((e) => e.call.id === s.call.id)).map((s) => s.call.id),
  );
  if (newIds.size) await transport.query(seedSql(seed));
  return {
    inserted: newIds.size,
    preserved: existing.length,
    calls: await verifySeed(transport, newIds),
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--dry-run', '--apply', '--verify'].includes(args[0])))
    throw Error('Use --dry-run, --apply, or --verify');
  const mode = args[0] ?? '--dry-run';
  if (mode === '--dry-run') {
    const seed = buildSeed();
    console.log(
      JSON.stringify(
        {
          seed: seedVersion,
          target: 'configured Twin instance',
          writes: false,
          scenarios: seed.map((s, i) => ({
            key: scenarios[i]!.key,
            id: s.call.id,
            outcome: scenarios[i]!.outcome,
            events: s.events.length,
          })),
          sql_bytes: Buffer.byteLength(seedSql(seed)),
        },
        null,
        2,
      ),
    );
  } else if (mode === '--apply')
    console.log(JSON.stringify(await applySeed(twinTransport), null, 2));
  else console.log(JSON.stringify(await verifySeed(twinTransport), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'SEED_FAILED');
    process.exitCode = 1;
  });
}

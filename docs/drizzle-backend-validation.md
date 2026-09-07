# Drizzle backend validation

Implemented on `codex/backend-transactions-baseline`, 6 September 2026.

The backend uses Drizzle ORM 0.45.2 with a Twin SQL HTTP driver. Drizzle Kit
0.31.10 generates the fresh baseline: eight tables, structural constraints,
indexes, defaults, and permissions. No stored application functions or triggers
remain in that baseline. The original migration chain is unchanged in fixtures.

## Implementation

- `src/db/schema/`: canonical domain tables and inferred read/write types.
- `src/db/client.ts`: Drizzle proxy configuration and PostgreSQL literal compilation.
- `src/db/twin-driver.ts`: authenticated HTTP SQL execution, response validation,
  truncation/duplicate-column rejection, and safe error mapping.
- `src/db/queries.ts`: typed reads and coherent call snapshots.
- `src/db/atomic.ts`: conditional batches for call creation and operation commits.
- `src/db/persistence.ts`: input validation, pure-decision retries, receipt recovery,
  and the existing persistence interface used by domain modules.

Drizzle's syntax tree and column encoders compile values to PostgreSQL E literals;
there is no regex substitution of query placeholders. SQL column/table names come
from the schema. Application commands cannot supply executable SQL or table names.
Runtime schemas continue to validate JSON and safe-integer money/revisions.
Public projections remain separate from private database rows.

Commit batches lock the call in their first statement. The next statement sees
receipts and the current revision after lock acquisition, checks expiry, and gates
all writes on the successful update. Dependent CTEs preserve event order. Receipts
record the logical operation and phase; recovering one cannot authorize another
external send. Creation retries use a transaction-scoped advisory lock because
the call row does not exist yet.

## Reproducible checks

```sh
npm test
npm run typecheck
npm run check:boundaries
npm run db:test
npm run build
```

`npm test` passed 102 tests. `db:test` verifies that independently generated Drizzle
DDL and the committed baseline produce identical PostgreSQL catalogs, including
columns, defaults, identity columns, constraints, and indexes. The catalog contains
zero application functions. It then runs the legacy/candidate parity suite:
176 paired response/state comparisons, eight legacy transition suites, three
legacy concurrency controllers, candidate rollback/permission/recovery tests,
and full public command sequences against both implementations.

Candidate requests use the production Drizzle and HTTP transport against a local
SQL gateway with a restricted backend database role. The public gateway role
cannot read application or private tables; missing/wrong bearer credentials fail.
Both local databases are disposable. This is not a deployment test.

Typecheck, module boundaries, and the production API/web build passed.

## Live Twin evidence

```sh
npm run db:verify-twin -- --allow-shared-scratch
```

[Recorded live results](drizzle-twin-validation.json) verify the production driver,
atomic compiler, and actual TypeScript finalization on isolated scratch tables:

- Call creation and coherent snapshot reads.
- Typed UPDATE/SELECT mapping with quotes, backslashes, SQL-like text, Unicode,
  and nested JSON/null values.
- Concurrent duplicate commits: exactly one fresh commit and one replay, with
  one revision update and one event.
- Constraint failure: no partial call update or receipt.
- Discarded acknowledgement: recovery through the stored operation receipt.
- Call finalization through the real TypeScript command dispatcher.
- All eight scratch tables removed and confirmed absent.

Runtime table names are remapped through a test-only Drizzle dialect; application
tables are never addressed by the live test. The earlier raw SQL probe separately
verified a deliberately dropped downstream HTTP connection, rather than only
throwing away a returned acknowledgement. See [SQL probe](twin-sql-probe.md).

## Rollout boundary

The running development stack and shared application tables were not changed.
The new API expects server-only `TWIN_API_KEY` with HappyRobot Twin SQL access.
The old gateway variables and `BACKEND_RPC_KEY` are no longer runtime persistence
credentials. Local startup preflight and `.env.example` reflect this change;
existing secret files were not modified.

The live SQL API role had access to private tables. Provisioning a production key
with the intended scope/role is still a rollout task; this test does not prove
HappyRobot can map a key to any arbitrary PostgreSQL role. The baseline revokes
PUBLIC access and creates no credentials. Existing operator-key checks remain.

Interactive `db.transaction(async tx => ...)` is unsupported by the Drizzle
PostgreSQL proxy driver. Atomic operations send a complete batch in one request;
there is no transaction held open across TypeScript callbacks or external effects.
Live schema/data migration and production credential provisioning remain separate.

## Manual fresh-start preparation, 7 September

The owner chose to discard existing application data. The [rollout guide](twin-fresh-start.md)
provides a scoped legacy reset, the generated baseline, operator-key registration,
and verification SQL. No reset was applied to shared Twin.

Read-only catalog inspection found explicit `app_user` table grants in Twin. The
baseline now revokes these grants when the role exists, in addition to PUBLIC.
`npm run db:test-reset` passed against a populated legacy database: all application
data was cleared, unrelated table data/grants were retained, REST table/sequence
access was denied, and the new backend's full command-contract sequence passed
through its production HTTP transport. This also verifies the exact reset SQL.

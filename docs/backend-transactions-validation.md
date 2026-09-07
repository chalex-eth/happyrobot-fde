> Historical validation of the intermediate RPC persistence implementation. The current branch uses Drizzle and a schema-only baseline; see [current validation](drizzle-backend-validation.md).

# Backend transaction refactor validation

Branch: `codex/backend-transactions-baseline`.

The backend now computes call, verification, load, negotiation, booking, finalization, and review changes in TypeScript. One active baseline migration defines nine tables, five public persistence RPCs, and two private authentication/snapshot helpers. Historical business functions and review triggers exist only in the legacy test fixtures.

## Verified locally

- `npm test`: 99 tests passed, including the existing orchestration/public-projection tests and new persistence validation, protocol, conflict, and filter tests.
- `npm run typecheck`: API, web, contracts, and scripts passed.
- `npm run db:test`: generated catalog matched the baseline; eight legacy SQL transition suites and three original concurrency scripts passed; 176 paired response/state comparisons passed; public-contract sequences passed against both implementations.
- Database failure checks passed: atomic rollback, restricted-role access, backend/operator credential rejection, immutable-field rejection, expired preconditions, missing calls, generic receipt replay, changed-intent rejection, and revision conflicts.
- Concurrent backend operations passed: duplicate and competing OTP answers, duplicate counteroffers, and exclusive live booking claims across calls.
- Lost-acknowledgement recovery passed: a recovered booking claim did not authorize a send.
- `npm run check:boundaries` and `git diff --check` passed.
- `npm run build` passed. The built API started on a separate loopback port and returned HTTP 200 from `/health`, then shut down.
- All ten legacy migration fixtures were checked byte-for-byte against the pre-refactor Git versions.

The parity runner compares public results and call records, negotiations, business receipts, ordered events, and reviews. It maps generated UUIDs consistently and normalizes timestamp representations and physical event sequence IDs. The new call revision has no legacy equivalent and is excluded from equality. Expired-session, stale-offer, aged-booking, and commit-precondition scenarios verify time-dependent decisions separately.

## Reproduce

With Docker running and Node dependencies installed:

```sh
npm test
npm run typecheck
npm run db:test
npm run check:boundaries
npm run build
```

`npm run db:parity` runs the disposable database comparison independently. The test databases have no published ports or external network access. A loopback-only HTTP gateway exercises named SQL arguments and the restricted database role. Neither runner reads environment files or contacts Twin or external integrations.

## Deployment status

This is source-level parity with the legacy migration chain on PostgreSQL, not verification of the live Twin deployment or PostgREST itself. No shared database migration, HappyRobot workflow update, external send, push, or merge was performed. The existing development stack was not restarted.

The baseline is for a fresh database. Existing Twin data needs a separate upgrade/cutover plan, and the new RPCs require separately provisioned backend and operator credentials. The runtime still connects through Twin; PostgreSQL adapters and the HTTP test gateway are test infrastructure only.

The temporary authority-check review quirk is intentionally preserved. Existing frontend edits were excluded from the refactor commit. See [architecture](architecture.md#database-generation) for the decision/persistence flow and schema-generation procedure.

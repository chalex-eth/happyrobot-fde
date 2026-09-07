# Fresh Twin setup after the Drizzle refactor

This deliberately deletes carrier-sales history, sessions, reviews, negotiations,
receipts and operator access. It retains unrelated public tables and Twin system
schemas. The reset targets the legacy catalog inspected on 7 September 2026.
Run the SQL yourself in the same organization's Twin SQL console. The shared
database has not been changed by this refactor.

## 1. Stop the old backend

Finish active conversations and stop every backend instance using this Twin.
From the repository root, stop the local Docker web/API:

```sh
npm run app:stop
```

The proxy and tunnel stay running; tools are unavailable until restart.

## 2. Reset, then create the schema

Run the **entire contents** of these files in order, as separate console runs:

1. [reset-legacy.sql](../apps/api/db/rollout/reset-legacy.sql)
2. [0001_initial_schema.sql](../apps/api/db/migrations/0001_initial_schema.sql)

Each file has its own transaction. Wait for success before proceeding. If a run
fails, retain the error and stop; don't run selected fragments or restart the app.
If reset succeeds but the baseline fails, application tables remain absent until
the baseline is successfully applied.

The baseline creates eight tables and their constraints/indexes and permissions.
It revokes Twin's explicit `app_user` grants as well as PUBLIC access. The SQL
owner retains backend access. There are no stored application functions or review
triggers. The one-time reset is outside the migration directory.

## 3. Configure credentials and register the operator key

Set `TWIN_API_KEY` in `.env.local` to a HappyRobot API key with Twin SQL access for
this organization. The existing `HAPPYROBOT_API_KEY` used in our successful tests
can be reused: copy its actual value, not an environment-variable reference.
Keep it server-only. Keep the existing `OPERATOR_RPC_KEY` unchanged. Old
`TWIN_GATEWAY`, `TWIN_ORG_ID` and `BACKEND_RPC_KEY` variables are no longer runtime
persistence credentials. Leave other integration settings unchanged.

The reset removed the operator-key hash. Generate its registration SQL locally
without printing the key itself:

```sh
node --env-file=.env.local --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
const key = process.env.OPERATOR_RPC_KEY;
if (!key) throw new Error('Set OPERATOR_RPC_KEY in .env.local first');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`INSERT INTO poc_private.operator_access (key_hash) VALUES ('${hash}') ON CONFLICT DO NOTHING;`);
NODE
```

Copy the generated `INSERT` into the Twin console and run it. No sample calls,
carrier records, sessions or OTPs need to be seeded.

## 4. Verify before restart

Run [verify-fresh.sql](../apps/api/db/rollout/verify-fresh.sql). Expect:

| Field | Expected |
| --- | --- |
| `sql_role` | `twin_admin` for the tested organization |
| `app_tables` | `8` |
| `legacy_functions`, `call_triggers` | `0` |
| `calls`, `events`, `reviews`, `operation_receipts` | `0` |
| `operator_keys` | `1` |
| `revision_ready`, `backend_access` | `true` |
| `rest_has_table_access` | `false` |

Resolve any difference before restarting. The console and backend key must address
the same organization's Twin; console checks cannot verify your saved local key.

## 5. Rebuild and try the application

```sh
npm run app:restart
```

If the tunnel/proxy are also stopped, use `npm run local:up` instead. Open
<http://localhost:3000>, start a fresh call, and try verification, OTP, load search
and negotiation. Old browser sessions are invalid after reset. Check that the
dashboard shows the new call and events. Existing mock OTP/booking settings stay
unchanged; this reset does not change external TMS inventory.

Reproduce the reset locally with `npm run db:test-reset`. It populates disposable
PostgreSQL with legacy data, resets it, applies the baseline, checks permissions
and unrelated-table preservation, then exercises the new backend contracts through
its SQL HTTP transport. It never connects to Twin. See [validation](drizzle-backend-validation.md)
for the broader parity and isolated live scratch-test evidence.

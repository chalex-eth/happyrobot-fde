# Workspace architecture

The application has two processes: Next.js renders the web interface; the Node API owns calls, integrations and persistence. Twin remains the only runtime database connection. TypeScript modules own authorization transitions, negotiation policy, finalization, and review decisions. The migration contains only structure and permissions. Drizzle repositories build queries; a backend atomic compiler sends conditional write batches through the Twin SQL API.

```text
Browser -> apps/web -> same-origin /api/* proxy -> apps/api -> Drizzle -> Twin SQL HTTP
HappyRobot -> MCP-only proxy -> apps/api -> FMCSA / TMS / Twin
                    packages/contracts
                    ^                ^
                    web              api
```

## Where changes belong

| Location | Responsibility |
| --- | --- |
| `apps/web/src/app` | Pages, layout and the streaming API proxy |
| `apps/web/src/features` | Carrier verification, voice controls, operator dashboard, map and diagnostic search UI |
| `packages/contracts/src` | Browser-safe Zod schemas and inferred types; no backend imports |
| `apps/api/src/modules/calls` | Session persistence, voice lifecycle, activity and finalization |
| `apps/api/src/modules/verification` | Authority and OTP lifecycle, including the local demo |
| `apps/api/src/modules/loads` | Authorized searches, selection and post-request state checks |
| `apps/api/src/modules/negotiation` | Quote, acceptance, rejection and counteroffer orchestration |
| `apps/api/src/modules/booking` | Atomic claim, one TMS attempt and receipt recovery |
| `apps/api/src/modules/operations` | Operator queries, inventory and consented load interest |
| `apps/api/src/integrations` | HappyRobot, FMCSA, TCP TMS and OTP email adapters |
| `apps/api/src/transport` | HTTP routes, cookies, origin checks, MCP authentication and tool dispatch |
| `apps/api/src/db` | Drizzle schema, queries, atomic batches, validated Twin SQL transport |
| `apps/api/db` | Ordered migrations, SQL transition tests and local schema tooling |
| `scripts/happyrobot` | Workflow configuration and isolated native conversation controllers |

Import another module through its `index.ts`. Within a module, use direct sibling imports. Modules expose functions rather than generic CRUD repositories; typed decision functions and persistence remain behind those functions. HTTP and MCP share the same business operations. The frontend imports only public contracts, never backend implementation or generated database rows.

## Local commands

```sh
npm ci
npm run dev                 # web 3000 + API 3001; loads root .env.local for API
npm test
npm run typecheck
npm run check:boundaries
npm run db:check             # compare Drizzle definitions, migration and actual PostgreSQL catalog
npm run db:test              # generated schema check plus local parity suite
npm run db:parity            # legacy SQL versus backend on disposable PostgreSQL
npm run build
```

Run build/typecheck sequentially: Next writes generated files under `apps/web/.next`. For isolated development ports, use `WEB_PORT=3100 API_PORT=3101 npm run dev`. The web process receives only its API target, not integration credentials. `npm run dev -w @carrier/api` starts the API alone and loads the same root environment file. Root `npm start` starts both production builds; production disables the local demo endpoints as before.

There is no CI workflow. These commands are run locally.

## Database generation

The active manifest contains `0001_initial_schema.sql`. It is a fresh-database baseline, **not an upgrade for the existing Twin database**. Historical migrations remain byte-for-byte under `apps/api/db/tests/fixtures/legacy`; they are used only by the parity oracle. Never run the baseline over an existing installation.

`src/db/schema/` is the canonical schema. Drizzle infers read/write types; `model.ts` validates runtime rows and JSON fields against those types. `npm run db:generate` generates the fresh baseline from those definitions and records its migrated catalog in `src/db/generated/schema.json`. `db:check` compares the baseline with current Drizzle output, then applies the baseline and independently generated DDL to two disposable PostgreSQL databases and compares columns, defaults, identity columns, constraints, and indexes. It also requires zero application SQL functions. Neither command reads environment files or connects to Twin.

This generation command intentionally rebuilds the **unreleased fresh baseline**. Once a baseline has been deployed, freeze it and use incremental Drizzle Kit migrations (`apps/api/drizzle.config.ts`) with an updated migration runner. Do not regenerate a deployed baseline to upgrade existing data.

`db:parity` creates legacy and candidate databases in a disposable PostgreSQL container, exposed only on a random loopback port. A local authenticated HTTP gateway executes the candidate's actual Drizzle-generated SQL in a transaction using a restricted backend database role. It models the observed Twin SQL API contract, including serialization of the final statement result. This is separate from live Twin verification. Integration fixtures are controlled test inputs, not proof of FMCSA, email, voice, or TMS delivery.

`npm run db:verify-twin -- --allow-shared-scratch` is an explicit live opt-in. It runs the production Drizzle driver, atomic compiler and TypeScript finalization against uniquely named scratch tables, verifies receipts/rollback/concurrent replay, then deletes the tables and confirms cleanup. It does not apply the baseline to the shared application tables. See [Drizzle validation](drizzle-backend-validation.md).

The original orchestration unit tests mock the application command interface. The parity suite exercises the actual decision implementations, persistence adapter, SQL constraints, and concurrency. UUIDs are mapped consistently and timestamp representations are normalized for comparison; explicit expiry and timeout scenarios test their behavioral effects. Physical event sequence IDs and the newly introduced call revision are excluded from legacy state equality.

### Decision and persistence flow

`application/commands.ts` dispatches the compatibility commands to domain decisions. Existing `callAction`, `finalizeCall`, OTP, negotiation, booking and operator entry points retain their public contracts. `db/twin-client.ts` is a compatibility facade; it does not send the old business RPC names to Twin. `db/twin-driver.ts` owns the HTTP protocol; `client.ts` connects the Drizzle PostgreSQL proxy driver; `queries.ts` owns database reads; `atomic.ts` composes conditional writes. `persistence.ts` orchestrates these pieces and receipt recovery.

A decision receives a typed snapshot with database time, changes its private draft, and returns a result plus commit preconditions. Review derivation adds changes to that same draft. The persistence module computes an allowlisted change set and submits it with an expected call revision, operation identity, phase, and intent fingerprint. The backend compiles a single multi-statement request that locks the call, then checks receipts/revision/expiry against a fresh statement snapshot. All record writes depend on the winning revision update. A constraint failure rolls back the entire request. Sequential CTE dependencies preserve event insertion order. Pure decisions can be recalculated three times after a conflict. Database constraints independently prevent competing live bookings for the same load.

Drizzle schema types are the source for database models; `model.ts` refines JSON fields with Zod and validates safe integer money/revisions. Public response schemas strip private fields. The old generated database RPC types are removed. Compatibility command contracts remain because public callers still use those signatures, but there are no matching SQL functions in the baseline.

Twin accepts SQL text without a documented bound-parameter argument. `TwinDialect` compiles Drizzle's SQL syntax tree with column encoders and escaped PostgreSQL E literals. It never replaces `$1` in SQL strings. NUL and malformed Unicode are rejected. The driver rejects truncated results, ambiguous duplicate column names, and unsafe bigint values; repositories must alias joined fields. Drizzle maps normal query results using the response field order. This adapter is pinned to the tested Drizzle version.

Interactive `db.transaction(async tx => ...)` is unsupported by Drizzle's PostgreSQL proxy driver. The backend calculates decisions before submitting a complete atomic batch. It does not keep a database transaction open while running TypeScript or network integrations.

External sends happen after a fresh claim is acknowledged. Recovery reads never authorize another send. A booking completion can still be persisted after session expiry or finalization. OTP and offer business receipts preserve their original replay semantics; generic transaction receipts are a separate table.

The API requires a server-only `TWIN_API_KEY`, a HappyRobot API bearer credential with Twin SQL access. There is no public gateway or legacy-RPC fallback. The migration owner retains table access; a separately provisioned backend role can receive the required DML permissions. PUBLIC and Twin's `app_user` REST role have no access to private schemas or application tables. The baseline explicitly revokes default table grants when that role exists. The local gateway tests backend versus anonymous database roles and missing/wrong HTTP credentials. Operator queries still validate the existing operator key.

Live verification used the configured credential through the platform SQL API, whose role was observed to have private-table access. It does not establish that HappyRobot supports issuing a key tied to an arbitrary least-privilege PostgreSQL role. Production key scoping and role provisioning must be confirmed during rollout. No key or privilege changes were made to shared Twin. Missing keys produce `BACKEND_NOT_CONFIGURED`; missing schema objects/columns produce `TWIN_SCHEMA_REQUIRED`.

Operator list/detail requests retain the existing reconciliation behavior, now performed explicitly by TypeScript before projection. Candidate enumeration reads pages of 100; filtering and public projections run in the backend. This preserves the current small-dataset behavior but is not a large-scale reporting architecture. The known temporary authority-check review is intentionally retained for parity.

Applying the baseline, converting existing data, provisioning the backend credential/role, and introducing future incremental migrations require a separate rollout. This branch does not perform that rollout or restart the currently running development stack.

## Deployment and process boundaries

Compose runs `app` (web), `api`, `mcp-proxy` and `ngrok`. Only web port 3000 and ngrok diagnostics port 4040 bind to host loopback. The MCP proxy forwards directly to the API and exposes only its allowed MCP paths. Browser cookies, Origin and Host are forwarded by the web proxy; client-supplied forwarded-host is ignored. Responses stream through both proxies.

`npm run app:restart` rebuilds/restarts both web and API while preserving the proxy and tunnel; `app:stop` stops both application processes. Eval capability files still live in the root `tmp/adversarial-sessions`, including when the API is started through an npm workspace.

For hosting, deploy `apps/web` as the Next project and run `apps/api` as a Node service with TCP access to the TMS. Configure `API_INTERNAL_URL` on the web server and keep API credentials on the API service. The old root-only Vercel configuration has been removed because it represented a single process. This refactor does not change remote deployments, HappyRobot versions, or shared Twin schema.

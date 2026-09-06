# Workspace architecture

The application has two processes: Next.js renders the web interface; the Node API owns calls, integrations and persistence. Twin remains the only runtime database connection. TypeScript modules own authorization transitions, negotiation policy, finalization, and review decisions. SQL retains constraints, atomic persistence, optimistic concurrency, and transport receipts.

```text
Browser -> apps/web -> same-origin /api/* proxy -> apps/api -> Twin RPC
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
| `apps/api/src/db` | Validated Twin requests, private RPC schemas and generated SQL types |
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
npm run db:check             # regenerate in isolation and compare checked-in types
npm run db:test              # generated schema check plus local parity suite
npm run db:parity            # legacy SQL versus backend on disposable PostgreSQL
npm run build
```

Run build/typecheck sequentially: Next writes generated files under `apps/web/.next`. For isolated development ports, use `WEB_PORT=3100 API_PORT=3101 npm run dev`. The web process receives only its API target, not integration credentials. `npm run dev -w @carrier/api` starts the API alone and loads the same root environment file. Root `npm start` starts both production builds; production disables the local demo endpoints as before.

There is no CI workflow. These commands are run locally.

## Database generation

The active manifest contains `0001_initial_schema.sql`. It is a fresh-database baseline, **not an upgrade for the existing Twin database**. Historical migrations remain byte-for-byte under `apps/api/db/tests/fixtures/legacy`; they are used only by the parity oracle. Never run the baseline over an existing installation.

`npm run db:generate` applies the baseline to a uniquely named disposable PostgreSQL 16 container, introspects tables and RPC signatures, and writes `apps/api/src/db/generated/database.ts` and `schema.json`. `db:check` repeats this process and detects drift. Neither command reads environment files or connects to Twin.

`db:parity` creates separate legacy and candidate databases in an isolated PostgreSQL container. It compares the legacy SQL results and records with TypeScript decisions committed through a loopback-only HTTP test gateway using a restricted database role. The gateway tests named arguments, JSON serialization, permissions and actual SQL transactions; it is not a Twin or PostgREST deployment test. Controlled integration fixtures are local test inputs, not evidence of live FMCSA, email, voice, or TMS integration.

The original orchestration unit tests mock the application command interface. The parity suite exercises the actual decision implementations, persistence adapter, SQL constraints, and concurrency. UUIDs are mapped consistently and timestamp representations are normalized for comparison; explicit expiry and timeout scenarios test their behavioral effects. Physical event sequence IDs and the newly introduced call revision are excluded from legacy state equality.

### Decision and persistence flow

`application/commands.ts` dispatches the compatibility commands to domain decisions. Existing `callAction`, `finalizeCall`, OTP, negotiation, booking and operator entry points retain their public contracts. `db/twin-client.ts` is a compatibility facade; it does not send the old business RPC names to Twin. Only `db/persistence.ts` implements the runtime Twin HTTP protocol.

A decision receives a typed snapshot with database time, changes its private draft, and returns a result plus commit preconditions. Review derivation adds changes to that same draft. The persistence module computes an allowlisted change set and submits it with an expected call revision, operation identity, phase, and intent fingerprint. SQL locks the call, checks the receipt and revision, validates expiry preconditions, and saves records/events/reviews/receipts atomically. Pure decisions can be recalculated three times after a conflict. Database constraints independently prevent competing live bookings for the same load.

Database catalog types keep JSON unknown; `model.ts` refines rows and JSON values with runtime schemas and `persistenceInputs` checks the generated RPC argument shapes. Public response schemas further strip private fields. Legacy compatibility command types are separate from the generated, deployed database RPC signatures.

External sends happen after a fresh claim is acknowledged. Recovery reads never authorize another send. A booking completion can still be persisted after session expiry or finalization. OTP and offer business receipts preserve their original replay semantics; generic transaction receipts are a separate table.

All mutation functions and private snapshots require `BACKEND_RPC_KEY` (at least 32 characters). A database administrator must separately provision its SHA-256 digest into `poc_private.backend_access`; no key is seeded in the migration. Operator queries additionally validate the existing operator key. Public table access and private-schema access are revoked. The database adapter reports `BACKEND_NOT_CONFIGURED` for missing credentials and `TWIN_SCHEMA_REQUIRED` for missing baseline RPCs. There is no legacy SQL fallback.

Operator list/detail requests retain the existing reconciliation behavior, now performed explicitly by TypeScript before projection. Candidate enumeration reads pages of 100; filtering and public projections run in the backend. This preserves the current small-dataset behavior but is not a large-scale reporting architecture. The known temporary authority-check review is intentionally retained for parity.

Future migrations append to the manifest and regenerate the catalog. Applying the baseline, converting existing data, granting the deployment-specific gateway role, and rotating credentials in shared Twin require a separate rollout. This branch does not perform that rollout or restart the currently running development stack.

## Deployment and process boundaries

Compose runs `app` (web), `api`, `mcp-proxy` and `ngrok`. Only web port 3000 and ngrok diagnostics port 4040 bind to host loopback. The MCP proxy forwards directly to the API and exposes only its allowed MCP paths. Browser cookies, Origin and Host are forwarded by the web proxy; client-supplied forwarded-host is ignored. Responses stream through both proxies.

`npm run app:restart` rebuilds/restarts both web and API while preserving the proxy and tunnel; `app:stop` stops both application processes. Eval capability files still live in the root `tmp/adversarial-sessions`, including when the API is started through an npm workspace.

For hosting, deploy `apps/web` as the Next project and run `apps/api` as a Node service with TCP access to the TMS. Configure `API_INTERNAL_URL` on the web server and keep API credentials on the API service. The old root-only Vercel configuration has been removed because it represented a single process. This refactor does not change remote deployments, HappyRobot versions, or shared Twin schema.

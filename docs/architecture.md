# Workspace architecture

The application has two processes: Next.js renders the web interface; the Node API owns calls, integrations and persistence. Twin remains the only runtime database connection. SQL functions retain locking, authorization transitions, negotiation policy and idempotency receipts.

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

Import another module through its `index.ts`. Within a module, use direct sibling imports. Modules expose functions rather than generic CRUD repositories; the database's state transitions remain behind those functions. HTTP and MCP share the same business operations. The frontend imports only public contracts, never backend implementation or generated database rows.

## Local commands

```sh
npm ci
npm run dev                 # web 3000 + API 3001; loads root .env.local for API
npm test
npm run typecheck
npm run check:boundaries
npm run db:check             # regenerate in isolation and compare checked-in types
npm run db:test              # SQL transitions, concurrency and RPC contract checks
npm run build
```

Run build/typecheck sequentially: Next writes generated files under `apps/web/.next`. For isolated development ports, use `WEB_PORT=3100 API_PORT=3101 npm run dev`. The web process receives only its API target, not integration credentials. `npm run dev -w @carrier/api` starts the API alone and loads the same root environment file. Root `npm start` starts both production builds; production disables the local demo endpoints as before.

There is no CI workflow. These commands are run locally.

## Database generation

`apps/api/db/migrations/manifest.json` specifies the exact migration order. Existing migration contents are preserved; do not squash or replay them on shared Twin state.

`npm run db:generate` starts a uniquely named disposable PostgreSQL 16 container without a published port or network access, applies the complete migration chain, introspects tables and function signatures, then removes the container. It writes:

- `apps/api/src/db/generated/database.ts`: table row types and SQL RPC signatures.
- `apps/api/src/db/generated/schema.json`: catalog metadata and migration checksums.

Docker must already be running; the PostgreSQL image must be available or pullable. These commands never load `.env.local`, accept a database URL, or contact Twin. `db:test` runs eight SQL transition suites, the existing three concurrency checks, and a full local RPC contract sequence. The local database is test infrastructure, not an application fallback.

PostgreSQL declares JSONB payloads as `unknown`. `rpc-contracts` explicitly validates their nested structure, action strings and public projections. `twinRpc` correlates function names with argument types and validates returned JSON; consumers cannot assert arbitrary response types with a generic parameter. Signature key checks and SQL-backed result tests connect the handwritten refinements to the generated schema.

Database rows, RPC results and public response contracts have different purposes. Private verifiers and session hashes are available only for internal verification/binding operations; public call results strip them. Load projections exclude unknown fields and private pricing. The operator snapshot may be empty when no load is selected, and a missing operator call is represented as null.

Adding a migration means appending it to the manifest, running `db:generate`, updating affected RPC/public schemas, and running `db:test` and `typecheck`. This does not apply it to Twin. Remote migration and workflow publication remain separate operations governed by the runbook.

## Deployment and process boundaries

Compose runs `app` (web), `api`, `mcp-proxy` and `ngrok`. Only web port 3000 and ngrok diagnostics port 4040 bind to host loopback. The MCP proxy forwards directly to the API and exposes only its allowed MCP paths. Browser cookies, Origin and Host are forwarded by the web proxy; client-supplied forwarded-host is ignored. Responses stream through both proxies.

`npm run app:restart` rebuilds/restarts both web and API while preserving the proxy and tunnel; `app:stop` stops both application processes. Eval capability files still live in the root `tmp/adversarial-sessions`, including when the API is started through an npm workspace.

For hosting, deploy `apps/web` as the Next project and run `apps/api` as a Node service with TCP access to the TMS. Configure `API_INTERNAL_URL` on the web server and keep API credentials on the API service. The old root-only Vercel configuration has been removed because it represented a single process. This refactor does not change remote deployments, HappyRobot versions, or shared Twin schema.

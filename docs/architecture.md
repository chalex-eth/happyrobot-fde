# Architecture

The application has two processes. Next.js renders the web interface. The
Node API owns calls, business decisions, integrations, MCP transport, and
persistence. Twin is the only runtime database connection.

~~~text
Browser -> apps/web -> same-origin API proxy -> apps/api -> Twin SQL HTTP
HappyRobot -> HTTPS tunnel -> MCP proxy -> apps/api -> FMCSA / TMS / Twin
                                      ^
                         packages/contracts
~~~

## Ownership

| Path | Responsibility |
| --- | --- |
| apps/web/src/app | Pages, layout, local call UI, and API proxy |
| apps/web/src/features | Voice controls, verification, map, calls, and reviews |
| apps/api/src/modules | Calls, verification, loads, negotiation, booking, and operations |
| apps/api/src/integrations | FMCSA, TMS, OTP delivery, and HappyRobot adapters |
| apps/api/src/transport | HTTP routes, cookies, origin checks, MCP auth, and dispatch |
| apps/api/src/db | Drizzle schema, queries, atomic writes, and Twin transport |
| packages/contracts/src | Browser-safe Zod schemas and public types |
| scripts/happyrobot | Workflow configuration and isolated conversation controllers |

Modules expose business operations through index files. HTTP and MCP use the
same decisions. The web app imports public contracts only; it never imports
backend modules or private database rows.

## Runtime flow

The browser starts a call and receives an opaque session cookie. The API creates
and binds a HappyRobot provider run to that call in Twin. HappyRobot sends
authenticated MCP requests with the bound run ID. The API resolves the call,
checks authority and OTP state, executes the requested business decision, and
returns a filtered public result.

Authority and OTP are required before load access. Searches use real TMS
inventory. Selected loads must come from the latest successful search. Private
pricing ceilings and internal identifiers are never returned to the agent.

The operator routes use separate server-side access. The operator dashboard is
not a carrier-facing MCP tool. Local operator access is intentionally direct
and is not an authentication system.

## Persistence

TypeScript decision modules calculate state changes from a typed snapshot.
Drizzle defines the application schema and queries. The Twin SQL driver sends
allowlisted conditional write batches with a call revision, operation identity,
and receipt recovery. Database constraints and revision checks protect against
duplicate or concurrent mutations.

The active fresh baseline is:

    apps/api/db/migrations/0001_initial_schema.sql

It is a schema baseline, not an upgrade script for an existing Twin workspace.
Do not replay it against shared data. Legacy SQL files under
apps/api/db/tests/fixtures/legacy are test and parity fixtures.

The Drizzle schema is canonical for the application. Use the database checks
before changing it:

~~~sh
npm run db:generate
npm run db:check
npm run db:test
npm run db:parity
~~~

The live scratch check is explicit and creates only uniquely named temporary
tables:

~~~sh
npm run db:verify-twin -- --allow-shared-scratch
~~~

## Boundaries

- OTP is screen-delivered only in the local demo; real email/SMS is not wired.
- Booking defaults to mock mode and does not send the TMS booking command.
- The dashboard records reviews and manager decisions but does not contact a
  carrier or notify a representative.
- Normal MCP calls use /api/mcp and normal credentials. Adversarial tests use a
  separate /api/mcp/adversarial route and separate credentials.
- The local Docker stack is a development environment, not a production
  deployment.

# System architecture

This POC automates inbound carrier sales: verify a carrier, discover freight,
negotiate a rate, record a booking request, and expose follow-up to operations.
HappyRobot owns the voice conversation. The Node API owns authorization and
business decisions. Twin stores the operational record independently of the
conversation transcript.

This document describes the current source and local development topology;
it is not evidence that a remote workflow or production deployment has been
validated. See [local setup](local-docker.md), the [workflow runbook](happyrobot-agent-runbook.md),
and [operator guide](operations.md) for operating procedures.

## System overview

```mermaid
flowchart TB
  Caller[Carrier] <-->|Web Call audio| HR[HappyRobot voice workflow]
  Caller --> Browser[Local browser]
  Operator[Operations user] --> Browser
  subgraph Local[Local development stack]
    Web[Next.js web app :3000]
    API[Node API :3001]
    Proxy[MCP-only proxy :3002]
    Tunnel[ngrok HTTPS tunnel]
    Web -->|Same-origin API proxy| API
    Tunnel --> Proxy -->|/api/mcp| API
  end
  Browser --> Web
  HR -->|Bearer token and bound run ID| Tunnel
  API -->|Create token and inspect or cancel run| HR
  API -->|SQL over HTTPS| Twin[(HappyRobot Twin)]
  API -->|Authority lookup over HTTPS| FMCSA[FMCSA QCMobile]
  API -->|Load reads over TCP| TMS[TMS]
  API -.->|Optional live booking mode| TMS
```

The audio connection does not pass through the Node API. The API creates the
provider session and binds its run ID before returning Web Call credentials.
HappyRobot then invokes MCP tools through the public tunnel. Browser requests
use Next.js as a same-origin proxy to the separate API process.

The default booking adapter produces a simulated reference without sending
`LOAD_BOOK`. TMS inventory reads and FMCSA lookups use external services.

## Code organization and responsibilities

| Area | Responsibility | Entry point |
| --- | --- | --- |
| Web application | Dashboard, Web Call controls, demo verification UI | [app](../apps/web/src/app), [features](../apps/web/src/features) |
| Browser API proxy | Forward requests and responses while preserving browser Host, Origin and cookies | [api-proxy.ts](../apps/web/src/lib/api-proxy.ts) |
| API host | Node HTTP adapter and explicit route dispatch | [server.ts](../apps/api/src/server.ts), [app.ts](../apps/api/src/app.ts) |
| HTTP and MCP transports | Validate inputs, authenticate requests, resolve sessions, filter errors | [transport](../apps/api/src/transport) |
| Application commands | Dispatch typed commands and derive reviews with state changes | [commands.ts](../apps/api/src/application/commands.ts) |
| Business modules | Calls, verification, loads, negotiation, booking and operations | [modules](../apps/api/src/modules) |
| Integrations | HappyRobot SDK, FMCSA, TCP TMS and optional OTP email webhook | [integrations](../apps/api/src/integrations) |
| Persistence | Typed snapshots, conditional commits, receipts and Twin SQL transport | [db](../apps/api/src/db) |
| Public contracts | Browser-safe Zod schemas and shared public types | [contracts](../packages/contracts/src) |
| Workflow tooling | Prompt, tool wiring, draft management and isolated evaluation controllers | [scripts/happyrobot](../scripts/happyrobot) |

```mermaid
flowchart LR
  Web[Web UI] --> Contracts[Public contracts]
  HTTP[HTTP routes] --> Services[Module services]
  MCP[MCP tools] --> Services
  Services --> Integrations[External adapters]
  Services --> Commands[Application commands]
  Commands --> Decisions[Module decision functions]
  Commands --> Persistence[Persistence]
  Persistence --> SQL[Drizzle and atomic SQL]
  SQL --> Twin[(Twin SQL HTTP)]
  Decisions --> Projections[Public projections]
  Projections --> Contracts
```

Services coordinate external I/O; decision functions calculate changes against
a typed call snapshot. Persistence saves those changes and their receipts.
This is a modular API, not a set of independently deployed business services.
Some internal dependencies cross layers; the enforced boundary is between
workspaces and between business module interfaces, not a strict dependency-injection architecture.

[`check-boundaries.mjs`](../scripts/check-boundaries.mjs) prohibits web imports
from the API, API imports from Next.js/web, and cross-module imports that bypass
`index.ts`. Contracts may depend on Zod and other contract files only.
MCP input schemas live in [`toolSpecs`](../apps/api/src/transport/mcp/tools.ts);
they are also used by workflow tooling. They are distinct from browser response contracts.

## Runtime surfaces and trust boundaries

| Surface | Access and purpose |
| --- | --- |
| `GET /health` | Unauthenticated liveness; does not establish dependency readiness |
| `POST /api/local/calls` | Start/read local call state; development-only loopback Origin/Host checks |
| `POST /api/local/carriers`, `/otp`, `/tms` | Local controls; same local checks plus the call cookie |
| `POST /api/local/voice`, `/voice/end`, `/voice/disconnected` | Create, end or reconcile the cookie-bound voice session |
| `POST /api/mcp` | Server-to-server Bearer authentication; tool execution resolves `x-happyrobot-run-id` to a saved call |
| `POST /api/mcp/adversarial` | Separately enabled evaluation adapter with separate credentials and signed session capabilities |
| `GET /api/operator/auth` | Shared operator-session check; returns no private data when unauthenticated |
| `POST /api/operator/auth`, `DELETE /api/operator/auth` | Establish or clear the HttpOnly shared operator session |
| `GET /api/operator/calls`, `/api/operator/inventory` | Operator projections and live inventory; shared session plus server-side feature/configuration checks |
| `POST /api/operator/review` | Shared session, matching browser Origin, and server-side operator key |
| `POST /api/tms` | Separate diagnostic/read adapter protected by `LOCAL_API_TOKEN`; not the caller authorization path |

The local cookie is opaque, HttpOnly, SameSite=Strict, scoped to `/api/local`,
and valid for one hour. Twin stores its SHA-256 hash. The model cannot choose
a call ID or session hash in tool arguments. The MCP server rejects browser
Origin headers and supports stateless JSON responses to POST; GET/DELETE return
405 rather than opening an SSE session.

Operator access is intentionally shared in this demo. The browser authenticates
with `OPERATOR_PASSWORD` and receives an HMAC-signed, HttpOnly session using
`OPERATOR_SESSION_SECRET`, scoped only to `/api/operator`; every operator route verifies it before reaching the
server-only `OPERATOR_RPC_KEY` RPC boundary. Everyone with the password receives
the full demo surface: this is a single shared operator role, not individual
user authentication or enterprise role-based access control. Rotate the session
secret to invalidate existing sessions.

## Carrier call lifecycle

```mermaid
sequenceDiagram
  actor C as Carrier / browser
  participant API as Node API
  participant HR as HappyRobot
  participant DB as Twin
  participant F as FMCSA
  participant T as TMS
  C->>API: Start local call
  API->>DB: Create call and hashed session
  API-->>C: HttpOnly cookie
  C->>API: Start voice session
  API->>DB: Reserve voice creation
  API->>HR: Create Web Call token
  HR-->>API: Provider run ID and credentials
  API->>DB: Bind provider run to call
  API-->>C: Web Call credentials
  C->>HR: Join audio conversation
  HR->>API: verify_carrier with trusted run header
  API->>F: Check operating authority
  API->>DB: Save authority result and revision
  HR->>API: create_otp
  API->>DB: Save challenge digest and delivery state
  C->>API: Read demo code through local session
  C->>HR: Speak six digits
  HR->>API: verify_otp
  API->>DB: Verify challenge and save result
  HR->>API: search_loads then get_load
  API->>T: Read current loads and selected details
  API->>DB: Save search scope and current offer
  API-->>HR: Public load details and offer reference
  HR->>API: Accept, counter or reject current offer
  API->>DB: Save decision and offer receipt
  opt Agreement and caller permission to proceed
    HR->>API: book_load
    API->>T: Recheck current terms
    API->>DB: Claim attempt, then save adapter result
    API-->>HR: Booking state and confirmation flags
  end
  HR->>API: finalize_call when conversation ends
  API->>DB: Save finalization and derived reviews
```

Each tool resolves the bound session again. Authority and OTP gate freight
access. Rechecking an MC number invalidates prior verification and load access;
a late upstream result cannot restore access under an old authority revision.
After TMS I/O, the API checks the revision again before releasing results.

| Tool | Business contract |
| --- | --- |
| `verify_carrier` | Save live authority evidence; rechecking resets access |
| `create_otp` | Issue/reuse a screen-delivered demo challenge; never return its digits to MCP |
| `verify_otp` | Validate exactly six caller-supplied digits; issuance and verification share the call failure budget |
| `search_loads` | Query current TMS inventory; one city is sufficient; save the latest result IDs |
| `get_load` | Require membership in the latest search; OPEN gets an offer, PENDING gets review eligibility |
| `accept_offer` | Agree to the exact current offer after caller acceptance |
| `counter_offer` | Apply the caller's requested amount against the current offer; at most three rounds per call |
| `reject_offer` | Reject the current offer without booking or automatically ending the conversation |
| `book_load` | Use the saved agreement, recheck terms, claim one attempt and return its result |
| `record_load_interest` | Save PENDING-load interest with a confirmed E.164 callback number and explicit consent |
| `finalize_call` | Save conversation outcome and optional review; creates no booking |

Pricing uses integer cents. The private ceiling remains in the API/Twin;
public results expose offered/agreed rates and opaque offer references. Offer
receipts identify already-answered offers: identical requests recover a saved
result, while conflicting reuse is rejected. Changing loads does not replenish
the three-counter budget. See [negotiation decisions](../apps/api/src/modules/negotiation/decisions.ts).

## Booking, uncertainty and human follow-up

```mermaid
flowchart TD
  Selected[Selected load] --> Status{Current status}
  Status -->|PENDING| Consent[Confirm callback number and consent]
  Consent --> Interest[Save interest for manager review]
  Status -->|OPEN| Offer[Negotiate current offer]
  Offer --> Agreed[Saved agreement]
  Agreed --> Terms[Recheck live terms]
  Terms --> Claim[Atomically claim booking attempt]
  Claim --> Mode{Booking mode}
  Mode -->|mock| Mock[Generate simulated reference]
  Mode -->|live| Send[Send LOAD_BOOK once]
  Mock --> Save[Persist result]
  Send --> Save
  Save --> Confirmed[Confirmed result saved]
  Save --> Rejected[Rejected result saved]
  Save --> Unknown[Pending or uncertain: review required]
  Confirmed --> Review[Senior-representative confirmation review]
```

[`bookForCall`](../apps/api/src/modules/booking/service.ts) separates preparation,
claim, external action and completion. Only the invocation that receives a new
successful claim may send a booking. A replayed claim cannot send again. If
completion persistence fails, recovery reads saved status; it never repeats the
external write. The database cannot atomically commit a TCP side effect, so
uncertainty is an explicit business state.

| Result | Meaning |
| --- | --- |
| `ok: true` | Tool returned a valid result; alone it says nothing about booking success |
| `booking_saved: true` | A confirmed adapter result was saved, including simulated results |
| `booking_confirmed: true` | Saved confirmation from the non-simulated path |
| `booking.simulated: true` | No TMS booking write occurred |
| `pending` / `uncertain` | Do not announce success or repeat the booking write; requires review |

Manager approval of a simulated booking uses a local submission adapter and
creates a stable local reference. It does not send `LOAD_BOOK`. Review closure,
manager decision and call finalization are separate facts; none proves that a
representative contacted the carrier. See [operator actions](operations.md).

A browser disconnect is also separate from conversation finalization and
provider completion. [`voice.ts`](../apps/api/src/modules/calls/voice.ts) performs
bounded provider reads after a disconnect; a missing/404 run is unconfirmed.
There is no background reconciliation worker. Final outcomes and review
projections are derived from saved facts in [application](../apps/api/src/application).

## Data model and persistence

```mermaid
erDiagram
  poc_calls ||--o| negotiations : has_current
  poc_calls ||--o{ poc_call_events : records
  poc_calls ||--o{ poc_reviews : requires
  poc_calls ||--o{ otp_receipts : deduplicates
  poc_calls ||--o{ offer_receipts : deduplicates
  poc_calls ||--o{ operation_receipts : recovers
```

| Table | Stored state |
| --- | --- |
| `public.poc_calls` | Session hash, authority/OTP, voice binding, latest load scope, booking JSON, interest, finalization and revision |
| `public.poc_call_events` | Ordered operational events and sanitized metadata |
| `public.poc_reviews` | One review per call/reason, resolution note and revision |
| `poc_private.negotiations` | One current negotiation per call, private pricing, offer ID and counter budget |
| `poc_private.otp_receipts` | OTP operation fingerprints and results |
| `poc_private.offer_receipts` | Answered offer fingerprints and results |
| `poc_private.operation_receipts` | Conditional commit results by call, operation and phase |
| `poc_private.operator_access` | Authorized operator-key digests; no call relationship |

TMS remains the inventory source. Twin saves call-specific IDs, statuses and
snapshots; it does not host a master load catalogue. The Drizzle definitions in
[schema](../apps/api/src/db/schema) are canonical. Despite the `twinRpc` and
`poc_*` command names, [twin-client.ts](../apps/api/src/db/twin-client.ts) is a
compatibility facade into TypeScript application commands, not remote business
stored procedures.

A mutation reads a snapshot, computes a decision, then builds one conditional
SQL batch. The batch locks the call, checks its revision and preconditions, and
writes call changes, related records and an operation receipt together. A
conflict causes a fresh read and decision, with at most four commit attempts.
An ambiguous database response triggers receipt lookup. External actions are
outside this retry loop. See [persistence.ts](../apps/api/src/db/persistence.ts)
and [atomic.ts](../apps/api/src/db/atomic.ts).

Constraints enforce rate bounds, receipt uniqueness, and a unique live booking
claim per load for pending/confirmed/uncertain attempts. Simulated bookings are
excluded from that cross-call uniqueness rule. Twin is accessed only through
its SQL HTTPS endpoint using the configured API credential; there is no runtime
Postgres connection pool. Disposable Postgres is used by database checks.

The [fresh baseline](../apps/api/db/migrations/0001_initial_schema.sql) is for a
fresh schema, not an upgrade of a populated shared workspace. Legacy SQL under
`apps/api/db/tests/fixtures/legacy` supports testing/parity, not runtime execution.

## Integrations and failure handling

| Dependency | Behavior and failure boundary |
| --- | --- |
| HappyRobot | SDK creates/binds voice runs; saved remote MCP configuration must match the local schema and trusted run header |
| FMCSA | Authority lookup failure saves an unverified result; old eligibility cannot survive a failed recheck |
| TMS reads | Validate commands/fields and require an `END`-terminated TCP response; bounded retries for retryable reads; strip private fields |
| TMS booking | Single external write after a durable claim; ambiguous results require review |
| Twin | Validate response shape, reject truncated data, sanitize SQL errors and recover commit receipts |
| OTP | MCP uses screen-only demo delivery. An optional email webhook adapter exists for the separate local OTP path; it is not wired into MCP `create_otp` |

The operator inventory scan reports partial coverage explicitly. Complete scans
are cached in-process for 60 seconds; incomplete scans are not cached as complete.
Dashboard maps use approximate city centers, not pickup/delivery coordinates.

MCP logs record tool name, request ID, duration and safe error codes. They omit
arguments, credentials, OTPs and full upstream results. Saved events support
operator projections; they are not transcript or sentiment analysis. Public
projections deliberately omit session hashes, OTP digests and private ceilings.
The authenticated demo UI is the deliberate exception for displaying OTP digits.

## Local deployment and configuration

[Compose](../compose.yaml) runs four services: Next.js, API, MCP proxy and ngrok.
Only the web port 3000 and ngrok inspector port 4040 bind to host loopback; the
API and proxy communicate on the Compose network. The public tunnel targets
only the MCP proxy. Compose starts no database and runs no migrations.

[`runtimeConfig()`](../apps/api/src/config/env.ts) parses API settings centrally.
Negotiation, booking and operations have feature flags. The normal stack uses
`.env.local` plus `.env.docker.local`; evaluation controllers additionally load
`.env.eval.local` and use their own adapter/credentials. Optional email settings
are documented in [the email example](../.env.email.example). Setup and lifecycle
commands belong in [local-docker.md](local-docker.md).

This topology is a development demo. Production needs an appropriate browser/session
policy and secret-management policy in addition to the authenticated operator
surface, validated external delivery and
booking configuration, and hosting that supports the TMS TCP connection. A
frontend deployment alone does not provide the API or its integrations.

## Validation and change guide

See [testing strategy](tests.md) for Northstars, Custom Tests, adversarial
coverage and the session-controller design.

| Change | Relevant evidence |
| --- | --- |
| Public contracts or module dependencies | `npm run typecheck`, `npm run check:boundaries` |
| Business rules and transport behavior | `npm test`; focused suites under [API tests](../apps/api/tests) |
| Schema or conditional writes | `npm run db:generate`, `npm run db:check`, `npm run db:test`, `npm run db:parity` |
| Web/API packaging | `npm run build`; proxy checks under [web tests](../apps/web/tests) |
| Local connectivity and saved MCP wiring | `npm run local:check`, `npm run verify:local`, `npm run verify:mcp` |
| Agent behavior | Isolated sequential native controllers; [runbook](happyrobot-agent-runbook.md) |
| Spoken call and hangup | A real microphone/audio call plus provider terminal-state evidence |

The opt-in `npm run db:verify-twin -- --allow-shared-scratch` check creates
uniquely named temporary tables; it is separate from ordinary local checks.
Native grades, sanitized backend traces and saved postconditions provide
different evidence. A passing conversation grade does not establish a booking,
and a backend smoke test does not establish audio quality. Generated evaluation
evidence belongs in ignored `tmp/evidence/`, not the maintained documentation.

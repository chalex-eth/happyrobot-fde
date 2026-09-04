# Specification-first implementation plan

## 1. Target system specification

The first milestone produces the written specification and source index. Implementation begins after that package is reviewed.

### Intended flow

```text
Carrier
  → HappyRobot Web Call
  → Voice agent
  → Authenticated MCP gateway
  → Deterministic state and negotiation rules
  → FMCSA / OTP / Legacy TMS / Twin
  → HappyRobot operations App
```

Responsibilities are fixed:

- **Voice agent:** conversation, data collection, explanations and recovery messages.
- **Gateway:** authentication, validation, state gates, retries, error classification and safe tool responses.
- **FMCSA:** authority verification.
- **OTP provider:** real possession check against a preconfigured test contact.
- **Legacy TMS:** source of truth for available loads and tentative reservations.
- **Twin:** persistent call state and audit history. It does not replace or mock the TMS.
- **HappyRobot App:** internal application containing the manager UI and, if feasible, the server-side gateway.
- **Senior rep queue:** mocked handoff after a tentative reservation.

### Required state progression

```text
STARTED
  ├─ authority fails → INELIGIBLE_END
  └─ authority passes → AUTHORITY_VERIFIED
       → OTP_VERIFIED
       → LOAD_SELECTED
       → NEGOTIATING
          ├─ no deal after three rounds → FAILED_NEGOTIATION_END
          └─ agreed → AGREED
               → BOOKING
                  ├─ incomplete outcome → BOOKING_UNCERTAIN
                  └─ complete success → TENTATIVELY_RESERVED
                       → MOCK_HANDOFF_COMPLETE
```

Backend code enforces this sequence. Prompt instructions cannot advance it.

A successful `LOAD_BOOK` is the tentative reservation described in the assignment. The mocked handoff represents the senior-representative confirmation stage.

### Non-negotiable rules

- No load information before authority and OTP verification.
- Load matching uses lane preference and equipment type.
- `max_rate` or TMS `MAX_BUY` never reaches the model, caller, transcript, public API, logs or App UI.
- Negotiation permits at most three counter rounds.
- An unsuccessful third round closes the call and cannot trigger handoff.
- TMS read commands may receive one bounded retry.
- `LOAD_BOOK` is sent once. An incomplete response becomes `BOOKING_UNCERTAIN`.
- A Twin booking intent must exist before `LOAD_BOOK` is sent.
- Twin failure before a required state write blocks the next action.
- Final call records include carrier MC, load ID, agreed rate, outcome and notes when applicable.
- All endpoints require authentication.
- No seeded carrier fallback during the final demonstration.
- External databases or UIs require a documented HappyRobot limitation.
- Credentials appear in documentation only as environment-variable names.

### POC boundaries

Included:

- Web Call.
- Live FMCSA lookup.
- Real OTP delivery to a tester-controlled registered fixture.
- Real TMS search, detail and controlled booking.
- Every assignment-listed load field, with `max_rate` private.
- Three-round negotiation.
- Twin state and activity capture.
- HappyRobot App dashboard.
- Mocked senior-representative handoff.
- Docker deployment, QA evidence and submission materials.

Excluded:

- Production carrier onboarding and contact ownership.
- A production PSTN number.
- Real call transfer.
- Automatic reconciliation against an undocumented booking-history endpoint.
- Multi-tenant production authorization.

## 2. Framework and library specification

### Application shape

Use a **single full-stack HappyRobot App** initially. A monorepo and separate API are unnecessary until the deployment feasibility test proves otherwise.

```text
app/
  pages and layouts
  api/mcp/route.ts
  api/manager/.../route.ts

src/
  contracts/       Zod schemas and inferred types
  domain/          state machine, negotiation and booking policies
  server/          orchestration, authentication and logging
  integrations/    TMS, Twin, FMCSA and OTP adapters

tests/
  contract/        external protocol contracts
  integration/     adapter and fault tests
  e2e/             minimal UI and API smoke tests
```

The domain layer must not import Next.js, React, MCP transport code or provider SDKs. This keeps business rules testable and allows the same core to move to Railway if necessary.

### Selected stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript with strict compiler settings | Provides compile-time checking across agent tools, domain rules, integrations and UI |
| Runtime | Node.js runtime, never Edge for the gateway | The TMS requires `node:net`, buffers and explicit socket lifecycle control |
| Application framework | Next.js App Router and Route Handlers | HappyRobot Apps use a full-stack Next.js shape; UI and backend can share one deployment |
| UI | React supplied by the HappyRobot App template | Native fit with Next.js and sufficient for the operations dashboard |
| Runtime validation | Zod | External data is untrusted at runtime even when our code is typed |
| MCP | Official modular MCP TypeScript server and Node transport packages | Implements Streamable HTTP, discovery and structured tool contracts without custom protocol code |
| TMS transport | Built-in `node:net` | Direct control of raw TCP framing, deadlines, buffering and socket closure |
| REST clients | Built-in `fetch` with `AbortSignal` | FMCSA, Twin and OTP use HTTP; no extra client library is needed |
| Dashboard data | TanStack Query only for live-refresh client views | Handles polling, stale state and retry behavior cleanly |
| Unit and integration tests | Vitest | Fast TypeScript tests and already proven in the reference implementation |
| Browser smoke tests | Playwright, limited to critical App paths | Verifies authentication, dashboard rendering and protected-field absence |
| Package manager | `pnpm` with one frozen lockfile | Reproducible installs and good Node/Vercel compatibility |
| Deployment | Multi-stage Node Docker image | Satisfies the one-command deployment requirement and supports the Railway fallback |

If the HappyRobot template pins another supported Node version, use that version. Otherwise pin Node 22.x in `engines.node`. Versions must be exact in the lockfile and validated against the deployed HappyRobot environment.

### TypeScript safety rules

Enable:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true
}
```

Additional rules:

- External input begins as `unknown`, then passes through Zod.
- Avoid `any` in domain and integration code.
- Generate TypeScript types from Zod schemas with `z.infer`.
- Use discriminated unions for states and operation results.
- Use exhaustive `switch` checks for state transitions and error handling.
- Represent money internally as integer cents, never floating-point dollars.
- Use branded identifiers for `RunId`, `OperationId`, `LoadId`, `McNumber` and `BookingReference`.
- Never reuse private load types as public tool-response types.

Example result shape:

```ts
type ToolResult<T> =
  | {
      ok: true;
      data: T;
      correlationId: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        retryable: boolean;
        safeMessage: string;
      };
      correlationId: string;
    };
```

Booking receives its own explicit result union:

```ts
type BookingResult =
  | { status: "confirmed"; bookingReference: string }
  | { status: "rejected"; reasonCode: string }
  | { status: "uncertain"; correlationId: string };
```

This prevents code from accidentally treating an uncertain booking as a failure and retrying it.

### Why Zod is necessary alongside TypeScript

TypeScript checks our source code while it is compiled. It cannot guarantee the shape of:

- Voice-agent tool arguments.
- FMCSA JSON.
- Twin API responses.
- OTP provider responses.
- Environment variables.
- Parsed TMS fields.
- Browser requests.

Zod validates those values at runtime and produces the TypeScript types used elsewhere. This follows one of the strongest patterns in the reference repository: shared schemas drive both HTTP/MCP validation and application types.

Use the current stable Zod release supported by the MCP packages. Do not copy the reference repository’s Zod 3 version automatically because its dependency snapshot is only a reference.

### MCP framework

Use the current official modular packages:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/node`
- Zod-based input and output schemas

Expose a stateless Streamable HTTP endpoint at `/api/mcp`. Twin holds business state, so MCP transport sessions do not need to hold it in memory.

Register these tools:

```text
verify_carrier
request_otp
verify_otp
search_loads
get_load_details
negotiate_offer
book_load
finalize_call
```

Create an MCP server and transport with the lifecycle recommended by the tested SDK version. Do not reuse one global transport across unrelated clients. An official MCP advisory documents cross-client response-routing risk in affected shared-transport implementations: [MCP transport advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7).

Validate:

- Tool input with Zod.
- Tool output with a separate public Zod schema.
- Bearer authentication.
- Allowed `Origin` and `Host` values.
- MCP `Accept` and content-type behavior.
- Concurrent requests from distinct clients.

The official server guide is the implementation reference: [MCP TypeScript server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md).

### Next.js and React

Use the HappyRobot App’s Next.js template and App Router. Route Handlers provide the HTTP boundary without adding another web framework: [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers).

Use server components for initial dashboard reads and small client components for:

- Refresh controls.
- Polling call status.
- Exception resolution actions.
- Filters and expandable timelines.

Do not add a large component framework for the POC. Keep the styling system already supplied by the HappyRobot template.

### TMS implementation

Use Node’s built-in modules:

- `node:net` for sockets.
- `node:crypto` for operation IDs, OTP digests and timing-safe comparisons.
- `Buffer` for request-size and response-boundary handling.

A third-party TCP library adds little value because the protocol is small and requires precise behavior.

Separate:

```text
TmsEncoder
TmsTransport
TmsParser
TmsClient
```

This allows protocol contract tests without involving the voice workflow.

### Twin integration

Do not include Drizzle or Postgres initially. The assignment explicitly requires Twin unless it cannot support the use case.

Create a typed `TwinRepository` interface. Validate all Twin request and response data with Zod.

Milestone 1 must verify whether Twin supports the conditional or unique writes required for:

- Operation idempotency.
- Negotiation round updates.
- Booking intent uniqueness.
- Terminal-state immutability.

If Twin cannot provide a required consistency guarantee, document the exact limitation before proposing an external database.

### FMCSA and OTP integrations

Use typed adapters around native `fetch`:

```text
FmcsaClient
OtpSender
```

These adapters own:

- Authentication.
- Deadlines.
- Response validation.
- Provider error mapping.
- Secret redaction.

The domain layer receives normalized business results and never processes raw provider payloads.

### TanStack Query

The reference implementation uses TanStack Query effectively for dashboard refreshes. Retain it only where the App needs live client-side state.

Use it for:

- Call list refresh.
- Exception queue refresh.
- Retryable dashboard read failures.
- Refetch on focus or reconnect.

Do not use it for server-side business orchestration, booking or negotiation state.

### Vitest and Playwright

Use Vitest for:

- State-machine transitions.
- Negotiation policy.
- Zod contracts.
- TMS parser and encoder.
- Fault injection.
- Idempotency and concurrency.
- Private-field leakage.

Use Playwright for a small number of high-value browser checks:

- Unauthenticated manager request is rejected.
- Calls and exceptions render.
- Uncertain booking is visible.
- Protected fields do not appear in browser responses.

Voice behavior remains verified through HappyRobot Prompt Playground and Web Call runs.

### HappyRobot SDK

The reference implementation uses `@happyrobot-ai/sdk` for workflow synchronization and Web Call tokens. Add it only if the current HappyRobot documentation and workspace prove that it reduces manual configuration.

Core domain logic must not depend on the SDK. This protects the application from SDK changes and allows manual platform configuration if an SDK feature is incomplete.

### Reference libraries that are not selected initially

| Reference dependency | Decision | Reason |
|---|---|---|
| Hono | Conditional fallback | Next.js Route Handlers already provide the HTTP layer |
| `@hono/node-server` | Excluded initially | Only required for a standalone Hono process |
| `@hono/zod-validator` | Excluded initially | Zod validation can run directly in Next.js handlers |
| Drizzle ORM | Excluded | Twin is the required native data layer |
| Postgres client | Excluded | No external database until a Twin limitation is proven |
| Vite | Excluded | Next.js already builds and serves the App |
| Bun | Excluded | The deployment target is the Node.js runtime |
| `zod-to-json-schema` | Conditional | Current MCP packages can consume Zod schemas directly; add only if compatibility testing requires JSON Schema conversion |
| LiveKit client | Excluded initially | The required Web Call can run from HappyRobot; the operations App does not need to launch calls |
| React Simple Maps | Excluded | A map is not needed to demonstrate the required operational workflow |
| Number Flow | Excluded | Animated metrics do not improve assignment coverage |

If Milestone 1 forces a standalone Railway gateway, use Hono as a thin HTTP/MCP shell around the same framework-independent domain and integration modules. That follows the reference implementation’s effective separation without copying its whole monorepo.

### Logging and observability

Start with a small structured JSON logger instead of adding a logging framework.

Every log contains:

- Timestamp.
- Correlation ID.
- HappyRobot run ID when available.
- Operation name.
- Safe status and duration.
- Error category.

The logger must redact:

- Tokens and API keys.
- OTP values.
- MCP authorization headers.
- TMS authentication frames.
- `MAX_BUY`.
- Full upstream URLs containing FMCSA `webKey`.

Add a library such as Pino only if load or log-transport requirements justify it.

### Framework success criteria

The framework selection is approved when:

- The deployed HappyRobot App supports Node TCP access.
- MCP discovery and concurrent invocation pass.
- Strict TypeScript compilation passes.
- Zod rejects malformed values at every external boundary.
- Domain tests run without Next.js or provider services.
- Twin persistence works through the typed repository.
- The dependency list contains no database, transport or UI package without a demonstrated requirement.
- All exact versions and relevant official documentation are recorded in `docs/source-of-truth.md`.

## 3. Specification and handoff package

Create four maintained documents before production implementation:

1. `docs/specification.md`
   - Business objective and user journey.
   - Architecture and framework choices.
   - Component responsibilities.
   - State machine.
   - MCP contracts.
   - Twin records.
   - TMS retry and mutation policy.
   - Negotiation and private-data boundaries.
   - Failure behavior and security requirements.
   - Requirement traceability table.

2. `docs/source-of-truth.md`
   - Source precedence.
   - External-system references.
   - Framework documentation and pinned versions.
   - Verification dates.
   - Sanitized documentation/runtime discrepancies.
   - Reference implementation comparison.
   - Environment-variable registry without values.

3. `docs/test-plan.md`
   - Contract, integration, workflow, adversarial and manual tests.
   - Fixtures and expected outcomes.
   - Dry-run versus state-changing tests.
   - Evidence required for acceptance.
   - North-star and guardrail metrics.

4. `docs/implementation-plan.md`
   - Milestones below.
   - Current status.
   - Review decisions and blockers.
   - Test and demonstration evidence.

Architecture decisions go under `docs/decisions/`, including:

- HappyRobot App backend versus Railway.
- Twin as the only persistent database.
- OTP test-contact model.
- TMS booking uncertainty.
- Public/private load separation.
- Framework and dependency selection.

### Source precedence

1. Assignment brief.
2. Candidate TMS handbook.
3. Official FMCSA, HappyRobot, OTP-provider and framework documentation.
4. Sanitized live-environment evidence.
5. Approved project specifications and decisions.
6. The reference implementation’s submission as a reference only.

### Reference registry

| Area | Source | Governs |
|---|---|---|
| Assignment | `FDE_Technical_Challenge_-_Inbound_Carrier_Sales.pdf` :codex-file-citation{path="/Users/alex/Downloads/FDE_Technical_Challenge_-_Inbound_Carrier_Sales.pdf" purpose="source"} | Mandatory workflow, OTP, Twin, App, QA and deliverables |
| TMS | [Candidate handbook](https://fde-challenge-candidate-handbook-production.up.railway.app/) and [protocol specification](https://fde-challenge-candidate-handbook-production.up.railway.app/spec/) | Wire protocol, fields, errors and fault injection |
| HappyRobot | [Official documentation](https://docs.happyrobot.ai/) | Workflows, Web Call, MCP, Twin, Apps and integrations |
| Live platform | [Candidate workspace](https://platform.happyrobot.ai/fdealexandrechalard/) | Actual resources, versions and available integrations |
| FMCSA | [QCMobile API](https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi) and [response elements](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiElements) | Docket lookup and authority fields |
| Next.js | [App Router](https://nextjs.org/docs/app) and [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers) | App and server-route structure |
| MCP | [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MCP protocol implementation |
| Reference candidate | Pinned at `6a7c0897d77371514ee15b9f971aaa239f2ac3ee` | Patterns and comparison only |
| Local design | [architecture-plan.md](</Users/alex/Documents/ChatGPT/HappyRobot FDE/docs/architecture-plan.md>) | Proposed design pending specification approval |

### Milestone 0 — Specification and framework approval

**Plan**

- Produce the four documents.
- Add the framework section and dependency decision table.
- Convert every assignment requirement into:
  `requirement → source → component → test → demo evidence → status`.
- Label statements as `Required`, `Observed`, `Design decision` or `Unverified assumption`.
- Record feasibility questions and their validating milestone.

**Checks**

- Every requirement and external integration has an authoritative source.
- TMS framing, response boundaries and retry rules are explicit.
- The reference architecture is separated from assignment requirements.
- Every dependency has a stated purpose.
- No credentials appear in tracked documents.
- Another engineer can implement the system without conversation history.

**Success**

- No unexplained requirement or dependency remains.
- Unverified assumptions have tests and owners.
- Framework boundaries and public contracts are approved.
- Implementation can be reviewed against written acceptance criteria.

## 4. Test-first integration and cleanup policy

Every integration milestone follows:

1. Write behavior-level contract tests.
2. Build the smallest fake or fault implementation.
3. Implement the adapter against the fake.
4. Test against the real dependency.
5. Compare evidence with the specification.
6. Refactor into the production path.
7. Remove temporary runtime scaffolding.
8. Re-run the complete milestone suite.

After validation:

- Delete or restrict diagnostic routes.
- Move fake providers and fixtures to test-only directories.
- Remove demo fallbacks.
- Delete unused adapters and abandoned deployment branches.
- Remove full-payload diagnostic logs.
- Collapse experimental feature switches into the selected production path.
- Keep contract tests, fake fault servers, typed errors, redaction and idempotency controls.

Each review gate contains a demo, diff, tests, sanitized evidence, updated traceability, risks and a `PASS`, `FALLBACK` or `BLOCKED` decision.

## 5. Implementation milestones

### Milestone 1 — Test bed and hosting feasibility

**Plan**

- Scaffold the strict TypeScript Next.js HappyRobot App.
- Create the contracts, domain, server and integration boundaries.
- Build the fake TMS fault server.
- Add an authenticated temporary `DEBUG_ECHO` diagnostic.
- Add a temporary MCP `system_health` tool.
- Test Twin write/read behavior and consistency requirements.
- Test from the deployed HappyRobot App.

**Checks**

- TypeScript strict compilation.
- TMS CRLF and `END` behavior.
- Ten deployed `DEBUG_ECHO` calls.
- MCP discovery and concurrent requests.
- Twin round trip and conditional-write behavior.
- Authentication and secret isolation.
- Warm response below five seconds and cold response below eight seconds.

**Success**

- HappyRobot App can host the gateway and reach the TMS.
- Otherwise, the tested domain core moves behind a thin Hono Railway shell.
- The hosting decision and final dependencies are documented.
- Temporary feasibility code is cleaned up.

### Milestone 2 — Production TMS read adapter

**Plan**

- Implement typed `DEBUG_ECHO`, `LOAD_QUERY` and `LOAD_GET`.
- Validate frame size.
- Buffer until `END`.
- Parse by field name and delimiters.
- Produce separate private and public load schemas.
- Retry transient read failures once.

**Checks**

- Date formats and variable padding.
- Valid empty results and explicit errors.
- Timeout, truncation, malformed response and delayed close.
- `MAX_BUY` absence from public surfaces.
- Read-only live dry run.

**Success**

- Contract and fault tests pass.
- Live reads work.
- Partial responses never produce valid loads.
- Public results contain all required caller-facing fields.

### Milestone 3 — Twin state and FMCSA

**Plan**

- Create Twin records for calls, events, carrier checks, OTP, load snapshots, negotiations, booking intents and exceptions.
- Implement the typed state machine.
- Implement `verify_carrier`.
- Persist run, operation and correlation IDs.
- Fail closed when authority cannot be established.

**Checks**

- Active, inactive, out-of-service, unknown and malformed carriers.
- FMCSA authentication, timeout, rate-limit and server failures.
- Duplicate and concurrent requests.
- State bypass attempts.
- Twin write failures.

**Success**

- Only an active carrier reaches OTP.
- Failures cannot advance state.
- Replays do not duplicate transitions.
- Twin contains the complete audit timeline.

### Milestone 4 — Real OTP

**Plan**

- Prefer a HappyRobot-managed sender.
- Otherwise use Twilio or Telnyx, with real email as the final fallback.
- Map an active test MC to a tester-controlled destination.
- Use six digits, hashed storage, five-minute expiry, three attempts and thirty-second resend delay.
- Keep OTP values outside the model context.

**Checks**

- Correct, incorrect, expired and replayed codes.
- Attempt and resend limits.
- Destination substitution.
- Sender failures.
- OTP leakage.
- Load-tool blocking before verification.

**Success**

- A real message reaches the registered destination.
- Verification advances once.
- Social-engineering attempts cannot bypass it.
- A test sink does not count as final acceptance.

### Milestone 5 — Load matching and negotiation

**Plan**

- Add load search, detail and negotiation MCP tools.
- Query real TMS inventory after OTP.
- Map all assignment-listed load fields.
- Implement deterministic three-round negotiation.
- Persist offers and decisions.
- Keep all money as integer cents internally.

**Checks**

- Lane and equipment matching.
- No-match and malformed-load cases.
- All public field mappings.
- Accept, reject and third-round exhaustion.
- Duplicate and concurrent offers.
- Missing `MAX_BUY`.
- Direct and indirect ceiling probing.
- Prompt injection in caller or TMS text.

**Success**

- No more than three rounds.
- Third unsuccessful round closes without handoff.
- Replays do not consume rounds.
- Accepted rates remain within the private ceiling.
- Private-field leakage tests pass.

### Milestone 6 — Safe booking

**Plan**

- Persist a booking intent.
- Re-fetch and validate the load.
- Send `LOAD_BOOK` once.
- Require booking reference, booked status and `END`.
- Record success as tentative reservation.
- Classify incomplete outcomes as uncertain.
- Keep dry-run mode on until live-booking review.

**Checks**

- Complete reservation and explicit rejection.
- Timeout, truncation and malformed response after send.
- Duplicate and concurrent requests.
- Load unavailability.
- Twin failure after TMS confirmation.

**Success**

- No replay or fault test sends a second booking command.
- Uncertain outcomes are never presented as confirmed or rejected.
- The Twin intent supports review.
- One live booking occurs only after reviewing carrier, load and rate.

### Milestone 7 — HappyRobot voice workflow

**Plan**

- Configure the existing `FDE Challenge` Web Call workflow.
- Register authenticated MCP tools.
- Propagate the run ID.
- Add concise hold, recovery and closing language.
- Finalize interrupted and completed calls.
- Mock transfer only after complete tentative reservation.

**Checks**

- Prompt Playground and Web Call.
- Inactive carrier, wrong OTP, no load and failed negotiation.
- Third-round closure.
- Tool timeout and replay.
- Ordering and price-disclosure attacks.
- Dropped-call finalization.

**Success**

- The flow executes in order.
- Backend gates resist adversarial conversation.
- Transcript and Twin agree.
- A reviewed run completes the controlled reservation path.

### Milestone 8 — Operations App

**Plan**

- Build overview, calls, event timeline, exception queue and metrics.
- Read Twin through authenticated server routes.
- Display structured events instead of raw logs.
- Use TanStack Query only where live refresh is needed.

**Checks**

- Authentication.
- Empty, loading, stale and error states.
- Timeline ordering.
- Uncertain booking visibility.
- Metric reconciliation.
- Browser protected-field inspection.

**Success**

- A manager can understand the call without raw logs.
- Exceptions are actionable.
- Dashboard totals reconcile with Twin.
- No OTP, credential or private rate appears in the browser.

### Milestone 9 — Production cleanup and submission

**Plan**

- Remove remaining experimental runtime code and unused dependencies.
- Run linting, strict type checking, tests, build, Docker and secret scanning through one command.
- Verify clean-checkout deployment.
- Execute standard, edge and adversarial tests.
- Prepare all five submission deliverables.

**Checks**

- No development fallback is active.
- Dependency audit shows each runtime package is used.
- Real OTP, FMCSA and TMS reads are demonstrated.
- Controlled reservation evidence exists.
- Every test call has a terminal state.
- Documentation matches deployment.
- No credentials or private pricing appear in code, logs, transcript, App or video.

**Success**

- All deliverables are complete.
- No critical or high-severity defect remains.
- North-star KPI reports complete TMS reservations followed by mocked handoff divided by OTP-verified eligible calls reaching matching.
- Guardrails show zero state bypasses, price leaks and duplicate bookings, with complete terminal-state capture.

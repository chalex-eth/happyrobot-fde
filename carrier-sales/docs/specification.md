# Specification — draft, not approved

Source: [user-supplied plan](input-plan.md). This scaffold distills that plan; it
does not replace assignment, TMS-handbook or platform verification.

## Objective and responsibilities

Required by the supplied plan: Web Call → voice agent → authenticated MCP gateway
→ deterministic rules → FMCSA / OTP / legacy TMS / Twin → HappyRobot operations App.
Voice handles conversation; the gateway owns validation and state gates; FMCSA
verifies authority; OTP checks a registered test contact; TMS owns inventory and
tentative reservations; Twin persists state/audit; senior-representative handoff
is mocked after successful reservation.

## State progression

STARTED → AUTHORITY_VERIFIED → OTP_VERIFIED → LOAD_SELECTED → NEGOTIATING →
AGREED → BOOKING → TENTATIVELY_RESERVED → MOCK_HANDOFF_COMPLETE.

Authority rejection ends at INELIGIBLE_END. An unsuccessful third counter round
ends at FAILED_NEGOTIATION_END. An incomplete booking becomes BOOKING_UNCERTAIN.
Backend state writes, not prompt instructions, authorize progression.

## Safety invariants

- No load information before authority and OTP verification.
- Matching requires lane preference and equipment.
- Private rate ceilings never leave the server through model output, UI or logs.
- At most three counter rounds; exhausted negotiations never trigger handoff.
- Eligible TMS reads have at most one bounded retry.
- Persist a Twin booking intent before sending LOAD_BOOK exactly once.
- Incomplete booking responses are uncertain, not retriable rejections.
- Required Twin write failures block the next action.
- Money is represented as integer cents. External inputs begin as unknown.
- Operational endpoints require authentication; no production/demo fallbacks.
- Final records include carrier MC, load ID, agreed rate, outcome and notes when applicable.

## Framework decisions

One Next.js App Router application, Node 22 runtime, React, strict TypeScript,
Zod, official modular MCP packages, native TCP/fetch, pnpm, Vitest and Playwright.
The domain has no framework or provider dependencies. No external database,
separate API, Hono shell, TanStack Query or HappyRobot SDK is added at this stage.
Hono is installed only to satisfy the published peer dependency of the official
MCP Node transport; it is not selected as an application framework.
The static root page is scaffold-only and must be replaced by an authenticated
App surface before operational data is introduced.

## Contracts and persistence still to specify

Tool inventory: verify_carrier, request_otp, verify_otp, search_loads,
get_load_details, negotiate_offer, book_load, finalize_call.
Exact Zod tool inputs, separate public outputs, provider mappings, TMS framing,
typed result unions and state-specific records remain unapproved.
Twin entities: calls, events, carrier checks, OTP, load snapshots, negotiations,
booking intents and exceptions. Conditional/unique write semantics must be verified.

## Initial traceability

| Requirement from supplied plan | Component | Planned evidence | Status |
| --- | --- | --- | --- |
| Strict types and independent domain | Toolchain / domain | Typecheck and lint | Scaffolded |
| Authority plus OTP gate | Domain / FMCSA / OTP | State-bypass and real delivery tests | Pending |
| Lane/equipment matching and load fields | TMS / public contracts | Authoritative field mapping and live reads | Pending |
| Private-rate isolation | Contracts / server / UI | Leakage tests across surfaces | Pending |
| Three-round negotiation | Domain / Twin | Exhaustion, replay and concurrency tests | Pending |
| Once-only booking and uncertainty | TMS / Twin | Fault tests and reviewed live booking | Pending |
| Native persistence and hosting | Twin / HappyRobot App | Deployed TCP and consistency evidence | Unverified |
| Authenticated MCP and manager App | Server / App | Protocol concurrency and session checks | Placeholder only |
| QA and submission | Tests / docs | Reconciled evidence and deliverables | Pending |

Each row needs an assignment-page or authoritative-source anchor before Milestone 0
approval. Current source provenance is the supplied plan, not an independently
verified assignment interpretation.

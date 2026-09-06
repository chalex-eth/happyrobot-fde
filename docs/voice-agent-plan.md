# Proposed next implementation: voice tools and SDK-managed workflow

Status: M3.1 and frontend Web Call controls implemented; user confirmed audible agent audio. M3.2 is connected through an approved HTTPS tunnel, with shared Twin finalization applied and all six tools passing a real public MCP smoke test. M3.3 scripts configured and published Version 5 to development. Full spoken-call acceptance (M3.4) remains pending. M3.5 negotiation is active; the approved Twin migration is applied and Version 5 is live in development. Real acceptance and three-round failure checks pass. See [negotiation checkpoint](negotiation.md) and [all M3 validation scenarios](milestone-3-validation.md). See [MCP checkpoint](mcp-local.md). Builds on the existing local Next.js app, real FMCSA/TMS adapters, Twin state and explicitly authorized frontend mock OTP.

## Reference assessment

The supplied reference uses one voice agent, one backend with MCP and REST adapters, shared service functions, and a TypeScript HappyRobot sync script. GitHub main was checked at `6a7c0897d77371514ee15b9f971aaa239f2ac3ee`; the four supplied source files match the local reference copy.

Adopt the separation between conversation, tool transport, business decisions and workflow configuration. Keep Next.js and Twin. Do not introduce Hono, another service deployment, a substitute database, seeded carrier/load fallbacks, or multiple conversational agents.

The reference is not a requirements-complete implementation to copy verbatim:

- The prompt includes seeded private pricing limits and a tokenized MCP URL. Our prompt must contain neither private pricing nor credential-bearing URLs.
- Its simulated transfer can produce a spoken booking confirmation. Our booking status must require a real TMS confirmation; simulated handoff remains separately identified.
- OTP is missing from its four-tool flow. We must add verification before matching and enforce this in the backend.
- Its SDK script contains hard-coded model, voice and integration IDs, plus compatibility fallbacks. Verify the applicable SDK and workspace capabilities before reusing any IDs or payloads.
- Finalization requested in a prompt cannot guarantee capture after a dropped call. Add an end-of-run reconciliation path once the first call works.

## Architecture

```text
Local browser ── authenticated local routes ──┐
                                           ├─ Shared call services ── Twin
HappyRobot Web Call ── Next.js MCP route ────┘                       ├─ FMCSA
                                                                   └─ TCP TMS

Git-tracked TypeScript workflow spec ── SDK sync ── HappyRobot draft/version
```

The SDK configures HappyRobot. MCP carries live tool calls. Neither replaces the business logic. MCP and existing HTTP routes should call the same services directly, rather than forwarding through each other or duplicating the gate.

Expose only the authenticated agent route through a controlled HTTPS development tunnel for the first voice test. Keep local browser routes protected by their existing loopback checks. Later verify the managed HappyRobot App deployment independently.

## M3.1 — Shared services and one call identity

Extract carrier verification, OTP verification, load authorization and TMS execution from HTTP-specific handlers into small service functions. Preserve existing transport adapters and tested authority policy.

Create a pending Twin call before starting the Web Call. Associate it with the local operator's browser session. During voice-session creation, bind authenticated HappyRobot run/session context to that call. Determine the supported metadata/header mapping with the actual SDK; do not rely on an LLM inventing or repeating an authorization identifier.

An MC number is not a session identifier. A bare call ID is not authentication. Rechecking the MC within a call must reuse the call record; changing the carrier must invalidate its prior OTP and load-selection state. This differs from the current standalone local lookup, which creates a new call.

The operator UI refreshes that call's state. Once the agent's authority check passes, the operator can generate a frontend mock OTP. The agent can submit the digits dictated by the user but cannot generate, retrieve or choose the expected code through its tools.

Acceptance: two simultaneous calls cannot verify each other's OTPs or use each other's selected loads; repeated authority checks do not accidentally detach the browser from the voice call; local and agent entry points enforce the same gate.

### M3.1 implementation checkpoint — 2026-09-05

Implemented:
- `apps/api/src/modules/verification/service.ts` owns carrier verification, bound-call OTP verification and gated TMS access; browser routes call these directly.
- `POST /api/local/calls` starts a pending call or reads saved state. An explicit new call expires the preceding browser session. Carrier checks require that session and keep the call ID.
- Every authority recheck, including the same MC, resets OTP and selected loads. A monotonically increasing authority revision rejects late provider results.
- Twin stores searched load IDs and the selected load per call. A load must belong to that call's search before detail access; completion rechecks authority, OTP, call-session expiry, revision and membership.
- The operator page restores and polls the saved call every five seconds and clears obsolete mock codes. Mock generation remains confined to the local operator endpoint.
- `apps/api/src/modules/calls/voice.ts` and `POST /api/local/voice` reserve one voice startup per call, use the official SDK, and commit the provider-returned `run_id` before returning the browser voice credential. No automatic mutation retries. Failed persistence attempts cancel the newly created run where possible; ambiguous failures require a new call.
- A server-only authenticated run resolver maps the saved run to the same session hash used by the shared services. Run IDs or MC numbers alone do not authenticate callers.
- `apps/api/db/tests/fixtures/legacy/twin-m3.1.sql` was tested against disposable PostgreSQL and applied successfully to the real Twin workspace. Apply it once after `twin-m3.sql` for a fresh installation.

Verified SDK contract: `@happyrobot-ai/sdk@0.1.45` accepts `voice.createToken({workflow_id, env, ttl_seconds})` and returns `{url, token, room_name, run_id}`. Startup binds `run_id` from that response, not model-supplied metadata. Do not send the browser session token or hash in workflow data or prompts.

Live API access is verified and matches Twin's organization. The existing **FDE Challenge** workflow (`01a06c72-4d55-7cbd-bef1-944d617982bf`) has no live version. The token API returned HTTP 404: `No live development version found for this workflow`. No workflow was published, no audio was joined, and no phone call was placed. The key stays in ignored `.env.local`.

Validation: 39 Node tests, TypeScript, production build, existing OTP SQL assertions and new call/voice-isolation SQL assertions pass. Real browser authority → mock OTP → ten TMS loads → LD00719 detail works. Same-MC recheck preserves the call ID and resets verification/load state.

Remaining integration acceptance: configure and publish the development workflow, create a real voice token and confirm its Twin binding, then configure deterministic authenticated runtime run-ID forwarding in M3.2/M3.3. The resolver contract is implemented and tested, but no HappyRobot request header is assumed to exist automatically; its actual workflow mapping still needs verification. There is no public MCP endpoint or Web Call widget in M3.1.

### Frontend voice integration — 2026-09-05

The publication blocker above was resolved by the user. API inspection confirms Version 1 (`01a06c72-4d5e-75c4-8d30-4c141134bd4a`) is live in `development` for the existing FDE Challenge workflow. No workflow edits or publication were performed by this implementation.

`apps/web/src/features/voice-call/voice-call.tsx` uses the official browser SDK and a compatible pinned LiveKit peer (`2.17.2`). It requests microphone permission before creating a remote run, then creates/reuses the pending Twin call, obtains the bound voice credential, and connects. The SDK is imported only on use. Controls cover mute/unmute, hangup, reconnect status, browser autoplay recovery and safe user-facing failures. The API key remains server-only; voice credentials are kept in memory. Local call replacement is disabled while audio starts or runs. Unmount and stale startup cleanup disconnect audio.

`POST /api/local/voice` accepts `{callId}` as a consistency check against the authenticated cookie, never as authentication. `POST /api/local/voice/end` also checks that call and resolves the run server-side before cancelling it. Ready in Twin means a run binding exists; it is not an active-audio indicator. A bound/failed call cannot create another voice run automatically. Start a new call after ending, refreshing or an ambiguous startup failure.

Verified real integration: call `0fd602cc-4351-4d2d-943d-63aa9f3210dd` received run `efd2eeaf-4688-485e-aba4-54a319ce4919`; authenticated run resolution returned the same internal session hash; cancellation succeeded. No microphone audio was joined in this server verification. Browser initial rendering and enabled Start control were checked. The user tested the frontend and confirmed: connected and agent audible. Mute/unmute is implemented but was not separately confirmed by the user. 41 automated tests pass, including authenticated cancellation and foreign-origin/caller-selected-run rejection; typecheck/build pass.

Reference: [official HappyRobot voice SDK example](https://github.com/happyrobot-ai/voice-sdk-example).

## M3.2 — Minimal MCP adapter inside Next.js

Use an established MCP SDK compatible with the Next.js Node runtime. Implement the required handshake, discovery and calls through a single authenticated route; avoid implementing the protocol by hand. The existing browser HTTP interfaces remain available. Add standalone REST tool routes only when an actual caller or test needs them.

Initial tools:

| Tool | Responsibility |
| --- | --- |
| `verify_carrier` | Apply live FMCSA authority evidence to the bound call. Return eligible, rejected or unavailable without inventing a result. |
| `verify_otp` | Verify the submitted six-digit string against that call's active challenge. Preserve leading zeros. Never return the expected code. |
| `search_loads` | Enforce authority and OTP, translate supported lane/equipment/date filters into real TMS fields, return a small set of public results. |
| `get_load` | Recheck the gate and fetch current details for a valid selected load. |
| `finalize_call` | Persist an idempotent call outcome and summary. The backend validates factual status; model text cannot declare a booking. |

Define schemas once for validation and tool discovery. Keep stable error codes, safe messages, request IDs and bounded deadlines. Reject missing run bindings and malformed identifiers. Log argument names/statuses rather than OTP values or raw upstream errors. Keep retries in the existing service/transport layer; do not multiply them across MCP, HTTP and the agent.

Acceptance: MCP discovery and calls work; absent/wrong authentication is rejected; direct search/get before verification fails; malformed input and exhausted shared OTP budgets fail cleanly; real FMCSA/TMS output is returned only after authorization; secrets and private rate ceilings are absent from tool output.

## M3.3 — Workflow configuration in Git

Add a small `scripts/happyrobot/workflow-spec.ts` for the opening line, one-agent instructions, selected model/voice settings and tool mapping. Add a `sync-workflow.ts` using the HappyRobot TypeScript SDK plus a sanitized SDK error mapper.

Suggested commands: offline dry-run, sync to an explicit draft/version, inspect remote configuration, and explicit publication. These commands do not exist yet.

Use the known FDE voice workflow as an explicit target, subject to inspecting its current contents. Reuse the configured MCP connection and stable node identifiers. Fork a live/locked version when necessary. Fail if required configuration is incomplete; do not silently skip failed node configuration or delete/recreate unrelated workflows.

Acceptance: dry-run does not mutate HappyRobot or expose secrets; two syncs do not duplicate connections/tools; remote inspection confirms the intended prompt, tool schemas, runtime context mapping and environment. Model/voice/integration IDs must come from verified workspace/API data.

Initially run sync locally from the Git-tracked source. After proving it, add GitHub Actions for validated, environment-controlled workflow updates. App deployment and agent-workflow sync are separate delivery steps; neither is automatic merely because code is in GitHub.

## M3.4 — First voice acceptance test

1. Start the demo Web Call from the local app and establish its Twin session binding.
2. Agent asks for the MC and calls `verify_carrier`.
3. Agent calls create_otp; the code appears automatically in the page and the caller dictates it.
4. Agent calls `verify_otp` and proceeds only on approval.
5. Agent collects missing lane, equipment and pickup preferences.
6. Agent calls `search_loads`, then `get_load`, and describes real public load details.
7. Agent records the call outcome without claiming a booking.

Test the normal call, wrong OTP, attempted OTP skipping, unavailable provider, no load matches and call interruption. Confirm voice/UI/tool events all refer to the same Twin call. No email/SMS or real contact ownership is implied by this demo.

## Subsequent slices

1. Deterministic negotiation: private TMS pricing stays server-side, advertised-rate acceptance behaves consistently, at most three counter rounds per call (including across different loads), duplicate tool requests cannot consume additional rounds.
2. Real booking: persist intent, execute the documented TCP booking command, require a confirmation reference, and route ambiguous outcomes to review without automatic retry. Keep mocked senior-representative handoff distinct from booking.
3. Completion/operations: trusted end-of-run reconciliation, outcome/sentiment/transcript reporting, interruption handling and dashboard checks.
4. Real contact OTP, managed Next.js deployment, GitHub-driven updates and challenge submission QA remain later work.

## Inputs needed at integration time

- HappyRobot API access for workflow configuration and Web Call startup; Twin's org header is not this API credential.
- A reachable HTTPS tool endpoint for the development test.
- Existing workflow/version identifiers can be retrieved from the workspace; do not ask the user to repeat known identifiers. Verify the API's required ID format.

No email-provider credential or new database is needed for the next mock voice slice.

Sources: [workflow spec](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c089/scripts/happyrobot/workflow-spec.ts), [SDK sync](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c089/scripts/happyrobot/sync-workflow.ts), [MCP tools](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c089/apps/api/src/mcp/tools.ts), [REST routes](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c089/apps/api/src/routes/api.ts).

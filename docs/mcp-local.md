> Current OTP policy: see [OTP setup](otp-setup.md) and [m3.6 validation](otp-simplification-validation.md). Version references below the current rollout note are historical checkpoints.

# Local MCP connection

Current OTP rollout: **Version 7 is live in development**, with migration m3.6 and one shared retry. See [validation and remaining eval limitation](otp-simplification-validation.md).

Status (2026-09-05): user approved the tunnel and Twin migration; both are active. HappyRobot discovered all six tools over HTTPS. FDE Challenge Version 5 is published to **development**, with the existing voice/model preserved and no missing-variable or test-error warnings. The real public MCP smoke test passed through FMCSA, frontend mock OTP, TMS search/detail and idempotent finalization. Full spoken-conversation acceptance is awaiting the user's test.

- Workflow: `01a06c72-4d55-7cbd-bef1-944d617982bf`.
- Development version: `01a071aa-b1f1-740d-b4fc-3abab7f34ba9` (Version 5).
- Previous version retained: `01a07192-70d4-7423-954a-56276ac5b9f1` (Version 4).
- MCP credential: `01a07149-f3eb-7e4a-a134-ecae534394c5`.
- Current tunnel: `https://7db0-159-26-101-107.ngrok-free.app/api/mcp`; the authoritative local value is `MCP_PUBLIC_URL` in ignored `.env.local`. This URL may change after restarting ngrok.

```text
HappyRobot development voice agent
  → HTTPS tunnel → localhost:3002 (MCP-only proxy)
  → localhost:3000/api/mcp (Next.js, official MCP SDK)
  → authenticated provider run → existing Twin call
  → shared carrier / OTP / TMS services
```

The MCP protocol is stateless Streamable HTTP with JSON responses. It supports SDK initialization, tool discovery and calls. There is no separate deployed MCP service. Authenticated `GET` and `DELETE` return 405 because no SSE or transport sessions are used; this prevents clients from repeatedly reconnecting to an empty event stream.

## Contract

`Authorization: Bearer <MCP_AUTH_TOKEN>` is required for all requests, including discovery. This dedicated secret lives in ignored `.env.local` and HappyRobot's managed MCP credential, never the browser or a URL. `LOCAL_API_TOKEN` remains separate.

Every tool invocation also requires `x-happyrobot-run-id`. The MCP Call action maps HappyRobot's built-in **Current → Run ID** into this header. The backend resolves it against the provider run saved by voice startup in Twin. The model cannot choose an identity through tool arguments. Discovery requires no run header. Missing/unknown runs fail closed.

Schemas in `apps/api/src/transport/mcp/tools.ts` are shared by discovery, server validation and the Git-tracked workflow configuration. Unknown arguments are rejected.

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `verify_carrier` | `mc_number` string | Live FMCSA check; rechecking invalidates OTP and load access. |
| `create_otp` | No arguments | Creates a demo code after authority passes; delivery is automatic to the matching frontend session. Returns status only. Reuses an active pending code. |
| `verify_otp` | Six-digit `code` string | Verifies the bound call's active frontend mock challenge; preserves zeros, never returns expected code. |
| `search_loads` | Optional origin/destination city, state, ZIP; YYYYMMDD pickup date; equipment; max_results | Equipment is optional; omission searches all types. At least one location, date or equipment filter is required. Default 5 results, maximum 10. Real TCP TMS after authority/OTP gate. |
| `get_load` | `load_id` | Must belong to this call's latest search; gate rechecked before and after TMS. |
| `finalize_call` | `outcome`, `summary` | Outcomes: conversation_complete, caller_declined, technical_error. Persist once, identical retry returns original snapshot. No booking. Requires m3.2 migration. |

Finalization snapshots verified facts from Twin rather than accepting model-provided verification or booking status. It closes subsequent protected mutations. Summary is model-reported text, capped at 1,000 characters; standalone six-digit strings are redacted. Exact duplicate finalization is idempotent; conflicting repetitions fail. Authority/OTP lifecycle tests still run against the wrapped state machine.

The agent follows `retry_allowed` and closes after the second shared OTP failure. It calls `create_otp` after authority passes, then says “I've sent you a code. Please read the six digits from your screen.” The frontend only displays the code; there are no manual carrier, OTP or search controls. The agent never receives the expected code. Email/SMS delivery remains simulated and is labelled on the page.

The server derives a six-digit demo value from a random challenge and a domain-separated HMAC using the existing server secret. Twin stores only its verification digest. The cookie-authenticated local status route can recover the display code on refresh, checks its digest against the same active challenge and returns it only while pending. Cross-session, failed, verified and finalized challenges are not displayed. Migration m3.6 enforces one shared retry across generation and verification with no OTP expiry. Pending codes are reused; carrier changes preserve spent failures. The one-hour call lifetime remains.

Code display is intentionally a local-demo capability, not real contact ownership verification. Dictated codes can appear in the provider's conversation transcript; local MCP responses and logs never include the expected code.

## Start locally

1. `apps/api/db/tests/fixtures/legacy/twin-m3.2.sql` is **already applied to this Twin workspace**; do not reapply. For a fresh workspace, apply once after m3 and m3.1. The existing function is moved to a private schema, then a public wrapper enforces finalization. Existing call data is preserved.
2. Keep `npm run dev` running on `127.0.0.1:3000`.
3. Run `npm run mcp:proxy` on `127.0.0.1:3002`.
4. Run `npm run mcp:tunnel` if the approved tunnel is not already running. This uses ngrok with inspection disabled. It exposes only the proxy, not Next directly.
5. Set `MCP_PUBLIC_URL` in `.env.local` to the resulting HTTPS URL plus `/api/mcp`. Do not put the bearer token in the URL. Keep the ngrok domain stable if the account supports it.

The proxy rejects every route except the exact `/api/mcp`, rejects unsupported methods, bounds input to 16 KiB, strips cookies and unrelated headers, and has a 30-second upstream timeout. The MCP route rejects Origin headers; it is server-to-server only. Requests and results are not cached.

Stop the tunnel with Ctrl-C when finished. The Mac, VPN where required for FMCSA, Next server, proxy and tunnel must stay available during the demo. Restarting a tunnel with a different URL requires updating its HappyRobot credential.

## HappyRobot configuration from Git

All commands are development-only and use existing server-side credentials. They preserve the existing voice and model. No GitHub Actions deployment is added yet.

```sh
# Offline preview; no API access or mutations.
npm run happyrobot:mcp -- dry-run

# Register or reuse the matching connection and ask HappyRobot to discover tools.
npm run happyrobot:mcp -- connect

# Fork the explicit currently published version; save the returned draft ID.
npm run happyrobot:mcp -- fork --version SOURCE_VERSION_ID

# Configure six tools, MCP Call actions and deterministic run headers on that draft.
npm run happyrobot:mcp -- sync --version DRAFT_VERSION_ID
npm run happyrobot:mcp -- inspect --version DRAFT_VERSION_ID
npm run happyrobot:mcp -- review-results --version DRAFT_VERSION_ID --previews scripts/happyrobot/result-previews.json

# After remote config checks, publish explicitly to development only.
npm run happyrobot:mcp -- publish --version DRAFT_VERSION_ID --replace SOURCE_VERSION_ID
```

`connect` requires discovery to return all six tools. It reuses a matching connection; if the existing URL differs it stops rather than creating duplicates. Update the connection's URL/credential in HappyRobot before rerunning. `sync` upserts tool/action nodes on an explicit draft and refuses published versions. It leaves unrelated nodes alone. `publish` never force-unpublishes an entire workflow.

Live registration, repeated draft syncing, inspection, result review and development publication are verified. HappyRobot requires a tool message and Tool Call Result acknowledgement before publishing. `review-results` uses the documented inspect API (not yet exposed by SDK 0.1.45); it reviews exposed fields without running business actions. The optional `--previews` input only accepts empty, clearly labelled schema placeholders. These are test previews, never runtime data. They define all success and failure fields before explicitly enabling their visibility; error-only previews otherwise hide fields like `delivered` and `records`. No captured real carrier or load data is uploaded as a preview. Prompt instructions must be written to the node's top-level `prompt_md`, not `configuration`. Publication reported zero missing variables and zero test errors.

A real HappyRobot draft MCP action sent a valid UUID through the Current Run ID mapping and received `VOICE_BINDING_REQUIRED` for its unbound test context. Static MC test arguments were restored to dynamic tool parameters immediately afterward. The independent public MCP smoke test used an actual provider-created run bound to its own Twin call and passed all six tools. These checks validate transport, header mapping and backend isolation separately; the final spoken-call test still needs to prove them together.

## Acceptance

Completed: SDK initialization/discovery over local HTTP and HappyRobot's public HTTPS connection; six strict schemas; no/wrong auth, unbound-run, forged-argument, pre-OTP search, safe-error and proxy-isolation tests. All 50 tests, typecheck and build pass. All OTP, call and finalization SQL assertions pass in disposable PostgreSQL, and the migration is applied to shared Twin.

Run `npm run verify:mcp` for the real integration check. It creates a separate Twin call/provider run, does not connect audio or touch the browser's active call, requests an agent-created demo OTP and reads its matching local status response, and cancels its own provider run afterward. Successful evidence: call `0dd84a41-23d6-4eec-9700-5b8ec364348d`, provider run `a470a74a-676a-4fdf-905c-6523c3214d16`, selected live load `LD00755`. Twin confirms exactly one finalization event despite the duplicate finalization request. Requests before authority/OTP and after finalization were rejected. An earlier TMS detail attempt returned an incomplete response; it was withheld safely, and the next integration test passed. No booking was made.

Remaining: run one spoken conversation through carrier → frontend mock code → OTP → search → detail → finalization, and confirm the same Twin call appears in the UI. Refresh the app, start a new call, give MC 135797, wait for the code to appear automatically, dictate its digits, then describe the desired route. Equipment is omitted unless specified by the caller; route-only queries include all types. Never infer full voice acceptance from discovery or audio connection alone.

Equipment search update (2026-09-05): the live MCP test passed separate DRY_VAN, FLATBED and REEFER searches plus a TX origin search without EQTYPE. The TMS rejects a MAX_RESULTS-only query with MISSING_FIELD, so the backend retains its FILTER_REQUIRED check; the agent asks for a location or date when no equipment is specified. Equipment is an optional uppercase TMS code, allowing additional types such as POWER_ONLY. Version 4 was checked against the stored prompt and parameter mapping, then published to development with zero missing variables or test errors.

## M3.5 active update

Negotiation is enabled locally, the approved shared Twin migration is applied, and Version 5 is published to development. All seven tools are discovered and configured, including negotiate_offer. get_load returns a public offer reference without exposing the private ceiling. Real acceptance/replay and three-round-failure flows pass; Twin records one finalization per call. See [negotiation checkpoint](negotiation.md) and [milestone 3 validation scenarios](milestone-3-validation.md). Earlier six-tool evidence above describes the pre-negotiation checkpoint.

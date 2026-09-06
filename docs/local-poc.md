> Current rollout: [OTP simplification validation](otp-simplification-validation.md). OTP generation and verification now share one retry with no independent expiry. The dated checkpoints below retain historical evidence and previous behavior.

# Local POC milestones

Scope updated 2026-09-05: build locally first. The user has now authorized Twin persistence, OTP and an email sender workflow in HappyRobot. Hosting and cloud reachability checks remain a later milestone. Keep Next.js and the existing TCP client; Twin is the app database. No substitute database or fake integration is introduced to bypass setup dependencies.

| Milestone | Small deliverable | Acceptance checks | Status |
| --- | --- | --- | --- |
| M1 — local TMS slice | Authenticated HTTP route plus operator console for echo, search, and detail | Real echo/query/detail; auth/input rejection; private fields excluded; bounded failure/retry; UI verification | Local slice complete |
| M2a — FMCSA lookup | Local MC form and bounded authority adapter | Active/inactive/missing/ambiguous data; timeout and access denial; no exposed API key | Local authority slice complete; live passing response verified over US VPN |
| M2b — verification state and OTP | Twin repository, OTP lifecycle, and enforced matching gate | Wrong OTP/shared retry exhaustion; search forbidden before full verification | Backend and local UI implemented; live Twin verified; email sender setup blocked |
| M3 — conversation and offers | Versioned agent/tool configuration; deterministic negotiation policy | At most three counter rounds per call; private ceiling absent from prompts/results; repeated request cannot consume extra rounds | Voice/MCP/negotiation live in development Version 5; voice acceptance scenarios pending. See negotiation.md. |
| M4 — booking | Real TCP booking command and explicit uncertain-outcome handling | Confirmed reference before success; no automatic retry after ambiguous send; mocked senior-rep handoff | Implemented and active in development; real booking acceptance remains pending. See [booking.md](booking.md) |
| M5 — operations | Calls, outcomes, errors, and booking-review queue sourced from Twin | Trace a call and its actions; distinguish confirmed booking from uncertainty | Pending |
| M6 — HappyRobot integration and QA | Port into managed Next.js App; attach tools/Web Call; prove real OTP and Twin writes | GitHub-driven update verified; deployed real query/detail; authority→OTP→matching→offer→booking flow; adversarial cases and KPIs | Deferred until local components are ready |
| M7 — challenge delivery | Docker path, reproducible cloud deployment, documentation, demo recording, submission draft | Clean checkout instructions; requirements checklist; no secrets committed; successful demo evidence | Pending |

The M1 console is an operator diagnostic surface. It must not be attached directly as a carrier agent tool: later tools must enforce FMCSA authority and OTP before matching, and validate every subsequent state transition in code.

## M1 evidence — 2026-09-05

- `npm test`: 8 passing tests covering auth, missing configuration, malformed/oversized input, forbidden commands, safe error mapping, trace/cancellation forwarding, and private-field filtering.
- `npm run typecheck` and `npm run build`: passed.
- `npm run verify:local`: all 8 HTTP checks passed against the local production build and real TMS. Search returned five loads. Detail had one `TMS_TIMEOUT`, then succeeded on its second bounded attempt. This proves recovery for that observed fault, not fault-free upstream behavior.
- Browser: invalid token displayed the expected error; authenticated search displayed ten real loads; opening `LD00719` displayed freshly retrieved details. A valid AK→RI search displayed the empty-result state and cleared the previous table. No browser warnings/errors were captured during the search/detail check.
- HappyRobot deployment, tool invocation, OTP delivery, FMCSA checks, Twin persistence, and booking are not implemented or verified by this milestone.

## Later deployment

App code should be maintained through GitHub. Preserve the managed template's authentication and Twin plumbing when integrating. A repository import alone is a copy, not evidence of continuing synchronization. Verify managed repository access and its Git deployment behavior at integration time. Until then, CI only validates local app code; no remote changes are needed.

## Automatic local configuration

The local console now reads configuration on the server through a development-only route. No token input or browser credential is needed. The convenience route rejects cross-origin requests and is disabled in production; `/api/tms` retains Bearer authentication. Nine automated tests, typecheck, and production build passed after this change. Use `npm run dev` for the local UI.

## M2a evidence — 2026-09-05

- 21 automated tests passed; typecheck and production build passed. Coverage includes MC normalization, operation and carrier-authority rules, broker-only rejection, unknown fields, ambiguous matches, response size, cancellation, timeout classification, auth denial, throttling, and the local HTTP boundary.
- Browser: malformed MC input displayed validation feedback. A real MC-1515 lookup displayed the FMCSA access-denied state. At that earlier checkpoint, no successful live carrier response had been observed; see the completion evidence below.
- Direct official API probes returned HTTP 403, `text/html`, server `awselb/2.0`. The local verification command returned HTTP 503 with `FMCSA_ACCESS_DENIED` and correctly exited unsuccessfully. This does not establish that the API key is invalid or that a US VPN is required.
- A comparison from a different permitted network/US egress with the same key and request would help diagnose an IP-dependent restriction. No VPN, hosting, or account settings have been changed.
- No Twin writes, OTP, new database, or carrier-flow authorization was added. The local TMS operator console remains independent.

## M2 active operating authority — completion evidence, 2026-09-05

Requirement: PDF page 2 requires an MC lookup and active operating authority. Page 4 separately requires OTP before matching. The PDF does not require a separate out-of-service lookup.

Decision:
- Pass: one identifiable carrier, permission to operate explicitly Yes, and active common or contract carrier authority.
- Fail: explicit permission denial or no active common/contract authority. Broker authority alone cannot pass.
- Unable to verify: missing required permission/authority evidence, ambiguous records, conflicting values, unknown supplied restriction flags, or service failures.
- Not found: explicit empty carrier list.
- An omitted `outOfService` field is displayed as Not provided, not converted to No. Its absence alone no longer blocks active authority. An explicit restriction still prevents approval; conflicting permission and restriction values require review.

Evidence:
- Live official lookup for MC 133654 returned HTTP 200, USDOT 1078021, permission Y, common authority A, contract authority N, and no `outOfService` property (`oosDate` was null).
- `npm run verify:fmcsa -- MC-133654` returned HTTP 200, eligible, ACTIVE_CARRIER_AUTHORITY.
- MC 1515 returned active common and contract authority. MC 99999999 returned an empty list. Inactive, broker-only, and contradictory cases are covered by controlled tests; no live inactive carrier was independently verified in this run.
- All 23 tests, typecheck, and production build passed. The observed public carrier response shape is covered by a regression test.
- US VPN resolved the observed service-access problem. Cloud network access remains to be verified during deployment.

This completes the local M2 authority check. It does not authenticate the caller: OTP and Twin remain deferred, and the load console remains an independent operator diagnostic.

## Historical verification checkpoint before m3.6 — 2026-09-05

The earlier deferral above was superseded by the user's request to implement Twin and OTP. The schema is kept in `apps/api/db/tests/fixtures/legacy/twin-m3.sql`; setup details and remaining work are in `docs/otp-setup.md`.

- Real Twin tables/functions were created through its SQL console. Its REST RPC is reachable with the provided org header.
- A real MC 133654 lookup passed, created a saved call, and recovered the same call after browser reload. Search stayed disabled before OTP.
- 30 automated Node tests pass. PostgreSQL transition assertions pass against a disposable local PostgreSQL 15 instance. Typechecking and production build pass. CI now includes the SQL assertions.
- Six-digit code, 10-minute expiry, five attempts, 60-second resend cooldown, three sends per inbox per 15 minutes. Five-minute verified access is bound to the saved call; expired grants require another code.
- Created an unpublished HappyRobot webhook → Gmail email draft. Built-in Email is disabled for this org. The user's Gmail OAuth attempt was blocked by Google. No email has been delivered or code accepted in the live app yet.
- Pending: an available sender, email template and retry settings, confirmation of sensitive run-data handling, authenticated webhook key, publication and end-to-end email/verification/load-access evidence. The POC verification milestone is not complete until these pass.

## Historical frontend mock OTP checkpoint before agent-generated codes

The user subsequently requested bypassing email/SMS delivery for now. Local mock mode generates a six-digit code in the browser for typing or dictation, registers its HMAC in Twin and retains authority, expiry, attempt and load-access checks. No sender account or HappyRobot email workflow is needed for this mock path. The UI and persisted recipient marker distinguish it from real contact verification. Real identity verification remains deferred; no claim that the PDF's live OTP requirement is completed is made.

Validation: 32 Node tests, typecheck and production build passed. In the live browser, a generated code was registered in real Twin; a wrong code reduced remaining attempts from five to four and kept search locked. The correct code unlocked demo access, and the real TMS search returned ten loads. No browser errors or warnings were captured. Email/SMS delivery was not invoked.

## M3.1 checkpoint — 2026-09-05

Shared carrier/OTP/load services, pending call creation, stable call identity, authority revision guards, per-call search/selection state, operator polling, and SDK voice startup/run resolution are implemented. The additive `twin-m3.1.sql` migration was applied successfully to the actual Twin workspace after disposable PostgreSQL validation.

Validation:
- 39 Node tests pass; TypeScript and production build pass.
- Base OTP SQL assertions and new call-isolation SQL assertions pass on PostgreSQL 15, including stale evidence/results, two calls using the same MC, cross-call challenges and load IDs, unique voice bindings, and expired sessions. Temporary database server stopped afterward.
- Real local HTTP `verify:fmcsa -- MC-133654` passed after adapting it to create a pending call first.
- Browser: call `3f01663b-4636-46f4-9de0-41a85d836d6d` checked MC 133654, accepted a frontend mock code, searched 10 real DRY_VAN loads and fetched LD00719. Rechecking the same MC retained that exact call ID, reset OTP to not_sent, cleared displayed loads, and disabled search.
- Supplied HappyRobot key successfully authenticated; its organization matches Twin. Key is in ignored `.env.local`, never in tracked configuration.

Live voice startup remains blocked, so full M3.1 integration acceptance is not claimed: HappyRobot returned HTTP 404 `No live development version found for this workflow`. FDE Challenge currently has no live version. No workflow was published or changed, and no audio was joined. Startup failure is persisted safely. A real provider run binding and deterministic runtime run-ID forwarding still need validation after the development workflow and MCP tool adapter are configured. See `voice-agent-plan.md` for the next scope.

## Frontend Web Call checkpoint — 2026-09-05

After the user published FDE Challenge to development, added microphone startup, mute/unmute, end-call, connection status and autoplay recovery to the local page. The browser imports only the voice SDK; server credentials remain in ignored local configuration. Added an authenticated end endpoint that can only cancel the run bound to the current call, with an expected-call check on startup and termination.

Real SDK token creation, matching Twin run resolution and cancellation all succeeded (run `efd2eeaf-4688-485e-aba4-54a319ce4919`). The page renders the voice controls and the Start button enables after session restoration. Tests: 41 passing, typecheck/build pass. The user tested the frontend and confirmed that the call connected and the agent was audible. MCP tool forwarding remains unimplemented and is labelled as such in the UI.

Restarted the unresponsive local dev server on port 3000; the updated page returns HTTP 200. The initial browser tab was stuck on a connection-error page, so a fresh preview tab was opened for the user.

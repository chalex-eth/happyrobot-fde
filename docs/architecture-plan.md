# Inbound Carrier Sales — testable POC milestones

Updated: 2026-09-05. This is an execution plan, not evidence that the remaining integrations work. The reference-codebase guidance below complements the milestone sequence.

## Objective and working method

Get one real carrier Web Call through authority verification, a delivered OTP, real load search, controlled negotiation, a confirmed challenge-TMS booking, and a mocked senior-rep handoff. Capture activity in Twin and make it visible in a HappyRobot App. Then improve the experience and finish the assignment's QA and delivery requirements.

Build and test one milestone at a time. Record the result, fix failures that block the next step, and update this plan when live behavior changes our assumptions. A partial checkpoint is useful progress; it is not a completed assignment.

- Reuse the existing code and real assignment services. Start with one backend, small modules, and one workflow. Add components when their milestone needs them.
- Implement mandatory verification, pricing, authentication, and booking safeguards alongside each feature. Defer optional sophistication.
- Read only the platform/protocol documentation needed for the current step. Try one small real operation before designing abstractions around it.
- Timebox an uncertain integration approach to roughly 30–45 minutes before reviewing the concrete blocker. This is a decision checkpoint, not a delivery estimate or permission to bypass requirements.
- Keep evidence compact: existing scripts, sanitized results, and one QA table. Use narrow injected failures where a scenario cannot be reproduced reliably against the real service.
- Execute under the user's actual authorization; a plan is not permission to send messages or publish resources. Use tester-controlled contacts for authorized delivery tests.

## Sources and baseline

Requirements: `/Users/alex/Downloads/FDE_Technical_Challenge_-_Inbound_Carrier_Sales.pdf`, especially pages 2–5.

References:

- [TMS handbook](https://fde-challenge-candidate-handbook-production.up.railway.app/spec/)
- [HappyRobot workspace](https://platform.happyrobot.ai/fdealexandrechalard/)
- [HappyRobot documentation](https://docs.happyrobot.ai/)
- [FMCSA API documentation](https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi)
- Existing `README.md`, `src/tms.ts`, and `local-results.jsonl` (app moved to the repository root).
- User-selected implementation foundation: [franalgaba/happyrobot-challenge](https://github.com/franalgaba/happyrobot-challenge/tree/6a7c0897d77371514ee15b9f971aaa239f2ac3ee), reviewed at commit `6a7c0897d77371514ee15b9f971aaa239f2ac3ee` on 2026-09-05.

Use the logged-in browser for gated assignment resources. Keep supplied credentials server-side, outside planning documents and outputs. Use the selected reference to accelerate agent setup, error handling, and tested coding patterns. Our assignment and Next.js App + Twin architecture govern adaptations; the reference is not a runtime dependency.

**Current evidence:** the local result file records eight passing HTTP checks: missing/wrong authentication, booking-command rejection, delimiter-injection rejection, required-filter validation, real echo, real query, and real detail. The README also records an earlier timeout/incomplete-response failure and a successful build. These are historical local results inspected during planning; they were not rerun. They do not establish deployed connectivity or end-to-end success. Fetch fresh loads in later tests; old load IDs and pickup dates may become stale.

## Milestone map

| Milestone | Demonstrable outcome | Status |
| --- | --- | --- |
| M0 — Local TMS checkpoint | Authenticated HTTP request reads real TMS loads through TCP | Recorded local pass |
| M1 — Deployed tool path | HappyRobot invokes a deployed authenticated backend tool that reads the real TMS | Next |
| M2 — Verified caller | FMCSA result and successful real OTP verification are persisted in Twin | Pending |
| M3 — First useful voice call | Verified caller hears a relevant real load offer through Web Call | Pending |
| M4 — First complete transaction | Agreement produces one confirmed TMS booking, Twin record, and mocked handoff | Pending |
| M5 — Operational POC | Manager can inspect real calls and act on cases in HappyRobot Apps | Pending |
| M6 — QA and refinement | Scripted normal, edge, and adversarial scenarios have documented results | Pending |
| M7 — Reproducible submission | Docker/cloud deployment, private repository, documents, workflow link, and video are ready | Pending |

M4 is the first complete call. M5 is the first operational POC. M6–M7 complete the required submission. Every milestone has its own acceptance tests; testing does not start at M6.

## Starting architecture

```text
Carrier → HappyRobot Web Call → workflow / voice agent
                                   ↓ authenticated tool invocation
                              App server / backend
                                ├─ FMCSA over HTTPS: authority lookup
                                ├─ OTP provider: delivery and verification
                                ├─ legacy TMS over TCP: query, detail, booking
                                └─ Twin: call state, activity, outcomes

Manager → HappyRobot App → authenticated server access → Twin
```

Start with the HappyRobot Next.js Full-Stack App approach in the existing plan, reusing the local TypeScript TCP adapter. Prove deployed TCP and supported tool invocation before expanding it. Use the simplest documented authenticated tool mechanism; add MCP only if the selected workflow integration needs it.

If the App runtime cannot support the required TCP/tool behavior, move backend execution to one small Node service, initially considering Railway. Keep activity in Twin and the operational UI in Apps. Record the observed limitation; do not build both hosting paths in advance. Final Docker/cloud deployment still needs verification in M7.

## Reference foundation — reuse by milestone

The reference's `bun run test` passed **38 tests across 4 files** in an isolated checkout on 2026-09-05: 27 API/MCP tests, 6 configuration tests, 3 negotiation-policy tests, and 2 carrier-verification tests. API tests inject fake services; carrier tests mock fetch/database access. This verifies those local scenarios, not real FMCSA/TMS/Twin/OTP integration or a live voice call. No reference deployment, workflow sync, or live provider operation was executed.

Use the pinned source links below when implementing the relevant milestone. Adapt only what that milestone needs; a wholesale port is not a prerequisite to M1.

| Area / source | Take as foundation | Adaptation for this POC | Milestone |
| --- | --- | --- | --- |
| [Agent prompt](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/scripts/happyrobot/workflow-spec.ts) | Concise rep voice, one question at a time, confirm critical numbers, ask only for missing details, tool-driven negotiation, concise recovery | Add mandatory OTP; remove seeded facts, internal URLs, and private thresholds; announce booking only after TMS confirmation | M2–M4 |
| [Workflow configuration](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/scripts/happyrobot/sync-workflow.ts) | Web Call → voice/prompt → named tools, parameter descriptions, structured variable bindings | Use current workspace IDs, model/voice options, auth and node schemas; configure the smallest working flow in Builder before automating repeated setup | M1, M3 |
| [Shared schemas](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/packages/shared/src/index.ts) and [tool adapters](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/mcp/tools.ts) | Typed inputs/results, small named operations, boundary normalization followed by validation | One local contracts module, separate public/private load shapes, trusted call context; transport follows the actual HappyRobot integration | M1–M4 |
| [Service errors](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/utils/errors.ts), [request identity](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/utils/request-context.ts), [SDK error mapping](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/services/happyrobot.ts) | Stable error codes, safe messages, request correlation, expected versus unexpected errors | Implement in Next route handlers; retain safe retry metadata, bound FMCSA requests, align deadlines, sanitize logs | M1–M2 |
| [Carrier verification](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/services/carriers.ts) | MC lookup, extracted carrier identity, source and timestamp on verification | Validate actual authority payload; preserve unknown values; store in Twin; no seeded approval when live verification fails | M2 |
| [Negotiation function](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/services/negotiations.ts) and [policy tests](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/test/negotiation-policy.test.ts) | Pure decision function separated from storage, explicit decision/round/remaining-round outputs | Use real TMS ceiling and agreed policy; separate agreement from booking; terminal-state and action-replay protection; correct currency precision | M4 |
| [Call persistence](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/src/services/calls.ts) | Real run/session identities, duplicate-finalization handling, structured call outcome | Incremental Twin activity and disconnect capture; durable action identity and verified conditional writes instead of copying SQL locks | M2, M4–M5 |
| [API tests](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/test/app.test.ts) and [carrier tests](https://github.com/franalgaba/happyrobot-challenge/blob/6a7c0897d77371514ee15b9f971aaa239f2ac3ee/apps/api/test/carrier-verification.test.ts) | Inject small fake dependencies for focused auth, validation, error, and policy checks | Test Next handlers and our policies; extend for OTP, real TCP framing, private-field exclusion, Twin state, and uncertain booking | Every milestone, M6 |

### Agent configuration: fastest useful adaptation

Maintain one small prompt/config source alongside the application when M3 starts. Reuse the reference's voice style and conversation structure, with our brokerage name. Use an available English/US voice and model from the actual workspace; the reference's static IDs and old SDK examples are clues, not current configuration facts.

The first full agent flow is:

```text
Collect MC → authority tool → issue/verify OTP → preferences
→ search/detail tools → pitch → negotiation tool
→ booking operation → confirmed result → mocked handoff → final summary
```

Keep natural acknowledgements and one recovery question when useful. Do not let recovery reset three-round limits or verification gates. Bind call/run identity through platform context, not a number the model invents. The backend decides allowable next actions. Negotiation acceptance is an agreement; only the booking operation can establish a booked outcome. The final summary adds conversational context to the existing Twin activity rather than acting as the sole record.

For the first configured tool, inspect the actual arguments and result in a workflow run. The reference encountered numeric strings, unresolved optional template values, and JSON encoded as text. Normalize only unambiguous, observed formatting at the boundary, then validate. Never silently supply missing required IDs, grant verification from a string boolean, guess ambiguous MC numbers from prose, or discard meaningful false/zero values. Add each necessary conversion with a focused test instead of importing a general compatibility layer.

### Error handling and coding conventions to use immediately

- Keep route handlers small: authenticate → validate → call operation → map safe result/error. Use one local contracts module and a schema library if useful; no shared-package monorepo is needed.
- Separate policy functions from TMS/FMCSA/Twin access so the important rules can be tested without real bookings. Pass the few external functions needed by a test; do not introduce a dependency-injection framework or generic repositories.
- Carry a request ID for diagnostics and a stable call ID for workflow state. An action ID identifies one negotiation/booking operation across retries; these three identities have different purposes.
- Use a compact error shape such as `{ error: { code, message, requestId, retryable, retryAfterSeconds? } }`. These are proposed local fields. `retryable` means this operation may safely be repeated, not merely that the upstream failure might be temporary.
- Map invalid input to 400/422 consistently, caller authentication to 401, state conflicts to 409, malformed upstream responses to 502, unavailable verification to 503, and upstream timeout to 504. Handle rate limits deliberately, preserving a safe retry delay. Do not confuse our caller's bad credentials with an upstream credential/configuration failure.
- Let one backend integration layer own bounded retries for safe reads. Keep its total budget below the voice-tool deadline and propagate cancellation where supported. Never automatically retry an ambiguously sent booking. Do not add retries independently to agent, handler, and provider layers.
- Log an allowlist of operation, request/call IDs, duration, attempt, and safe error code. Exclude raw provider bodies, query-string keys, OTPs, private ceilings, and exception causes that might contain secrets. Sensitive call content belongs in appropriately restricted platform records, not ordinary debug logs.
- Extend the existing scripts and local TypeScript conventions. Bring in a focused test runner when policy/handler tests need it; keep Node/npm and the working Next App. Do not add Bun, Hono, a Vite dashboard, Drizzle/Postgres, Terraform, or the reference deployment stack merely to reuse a helper.

### Specific reference behavior to change

These differences were found in the pinned source and affect our brief directly:

1. **Private rates reach the model.** `workflow-spec.ts` embeds demo target/max rates; `LoadSchema` includes `targetRate`/`maxAutoRate`, and the search service returns them. Remove these from all agent-visible configuration, results, examples, and extracted-data templates. Keep the real ceiling private in backend policy.
2. **Agreement is presented as booking.** The negotiation function returns `transfer_mock` with a booked message before any legacy-TMS booking. Introduce explicit agreed, booking-confirmed, and booking-uncertain states and change the prompt/tests accordingly.
3. **FMCSA demo fallback and incomplete parsing.** Production demo MCs can be approved from seeded data. The parser selects the first carrier and treats unknown out-of-service values permissively. Reuse the lookup structure, but validate identity/authority and preserve unknown/missing statuses. Live authority failure must not become simulated approval.
4. **Retry and idempotency need adaptation.** FMCSA fetch has no explicit timeout; the reference voice SDK timeout is 30 seconds with two retries while its dashboard proxy timeout is 20 seconds. Negotiation locks serialize writes but do not deduplicate offers or freeze terminal decisions. Our existing milestone requirements address these gaps using bounded reads and durable action results.
5. **Workflow sync recreates resources.** `resolveWorkflow` calls a deletion path that cancels runs, unpublishes, and deletes an existing workflow before replacement. Reuse selected configuration ideas, not execution of that script against our workspace. Inspect/configure the current workflow or an editable version instead. Prefer Builder for the first call if it is faster.

The reference does not supply the real legacy TCP adapter, OTP gate, or Twin/App integration required here. Those remain our milestone work. Treat its SDK mismatch notes as troubleshooting leads to recheck against the live workspace, not a reason to implement every workaround in advance.

## M0 — Preserve the local TMS checkpoint

**Components present:** authenticated `POST /api/tms`, read-only input validation, Node TCP connection, response parsing, public-field filtering, bounded read retry, probe and HTTP verification scripts.

**Acceptance evidence:** the local results described above. This checkpoint sent no `LOAD_BOOK`; FMCSA, OTP, Twin, and workflow integration are outside it.

**Next use:** reuse this code in M1. Rerun local checks if code/configuration changes or deployed failure needs comparison. Do not rebuild a second TMS client.

## M1 — Prove deployed HappyRobot → backend → TMS

**Reference shortcut:** adapt small service-error/request-ID helpers around our existing TCP client, then use the configuration examples to connect one tool. Keep the first deployment small.

**Build**

1. Inspect the actual App template, tool authentication, and runtime limits needed for this step. Reuse a suitable existing App if available.
2. Deploy the server route with server-side credentials and authentication. Configure a reachable cloud server binding; the current localhost-only startup command is a local setting.
3. Run `DEBUG_ECHO`, a filtered `LOAD_QUERY`, and `LOAD_GET` using a freshly returned ID through the deployed route.
4. Expose one minimal read-only tool and invoke it from a HappyRobot workflow test. Keep this diagnostic path operator-only; it must not become an unguarded carrier search tool.
5. Check OTP delivery channel and sender readiness now, so provisioning does not first surface as a blocker in M2.

**Test / pass**

- Missing/wrong auth is rejected before TCP access.
- Deployed HTTP and HappyRobot tool invocation both return complete real load data, with measured latency.
- Private `MAX_BUY`, credentials, and raw upstream errors are absent from tool responses.
- Exercise a few sequential reads and record observed failures. Echo alone is insufficient because it bypasses normal TMS fault behavior.
- Backend request/retry budgets fit inside the configured tool deadline. Failure returns a safe result rather than partial load data or a hanging call.

**Evidence:** endpoint/workflow references, sanitized outputs, timing, and failures. A handful of successes does not establish production reliability.

**Defer:** dashboard layout, a general gateway framework, booking, multiple hosting targets.

## M2 — Verify the caller and persist the gates

**Reference shortcut:** reuse the carrier-result structure and failed-provider test pattern; replace persistence with Twin and remove seeded approval. OTP is a new component.

Split this milestone into three independently testable checks.

### M2a — Twin persistence

- Create the smallest call record keyed by a stable platform call/run identity: verification state, current stage, timestamps, and terminal outcome. Append activity as steps happen.
- Write/read a real record; confirm another request retrieves it after a backend restart.
- Verify Twin's actual support for protected OTP state and the conditional writes/uniqueness needed to prevent duplicate M4 bookings. Do not assume generic storage provides atomic claims.
- If a necessary guarantee is unavailable, document that exact limitation and use the smallest justified external store only for that requirement. Keep activity in Twin. Resolve this before booking implementation.

### M2b — FMCSA authority

- Add an operation such as `verify_carrier(call_id, mc_number)`; names here describe application behavior, not verified platform tool contracts.
- Normalize input, query with the supplied key, validate the actual response, and evaluate relevant active carrier authority. Finding a company alone does not pass.
- Persist identity, authority decision, reason, and check time. Distinguish ineligible, not found/ambiguous, and unavailable service.
- Test a real successful lookup. Cover invalid/inactive records and timeout with real examples where available, otherwise label narrow injected responses. None may accidentally authorize matching.

### M2c — Real OTP

- Implement one email or SMS channel, favoring supported HappyRobot delivery. Use an authorized tester-controlled recipient and label any synthetic carrier/contact association.
- Issue and verify codes with protected state, expiry, attempt limits, bounded resend, and invalidation of replaced/used codes. Codes must not appear in model/tool outputs or ordinary logs.
- Bind verification to the call and carrier; changing the carrier resets it. Identify the trusted source for the carrier contact. A caller-supplied destination proves possession only; document that limitation if used in the demo.
- Require OTP on every call before matching: page 4's hard requirement is stronger than page 2's new-carrier wording.
- Test real delivery/success, wrong/expired code, reuse, excess attempts, delivery failure, and a bypass request. Read back the final gate state from Twin.

**Pass:** real authority lookup plus real delivered OTP produce a persisted verified call. Failed/unavailable verification cannot proceed. Missing sender setup blocks the complete flow; a mock OTP is not a passing result.

**Defer:** multiple delivery providers, elaborate carrier onboarding, general identity infrastructure.

## M3 — Make the first useful Web Call

**Reference shortcut:** adapt `workflow-spec.ts` voice style and flow, applying the OTP, privacy, and booking changes above before using the prompt. Validate one tool's actual argument binding before adding the rest.

**Build**

1. Wire Web Call → MC → authority → OTP → lane/equipment/pickup → TMS search → selected load details → spoken offer.
2. Add guarded search/detail operations. Check persisted authority and OTP in code even if the model invokes tools out of order.
3. Use the existing real TMS filters, return a small set of suitable loads, and retrieve the selected load. Handle no match by offering to broaden criteria.
4. Map protocol fields to the requested load fields: equipment, dates, public rate, weight, commodity, pieces, miles, dimensions, and notes where available. Distinguish missing data from zero; do not invent details. Confirm date/timezone semantics before making appointment claims.
5. Separate private and public load representations. The diagnostic client discards `MAX_BUY`; M4 needs it internally without putting it into voice/tool/browser outputs. Treat load notes as data, never instructions.
6. Record progression in Twin and add platform completion/disconnect handling. Do not rely solely on the agent remembering to finalize.

**Test / pass**

- Make a real Web Call: verify, receive/read the code, state preferences, and hear an offer matching a current TMS record.
- Direct search before either gate is denied. Verification cannot be reused from another call.
- No match and upstream failure produce understandable spoken outcomes and persisted records.
- A dropped call leaves a usable record. Inspect tool outputs for private-data exposure.

**Evidence:** call/run reference, load ID, safe activity record, and observed spoken result.

**Defer:** fuzzy geography/ranking, recommendation engines, exhaustive conversational branches. Do not claim booking at this checkpoint.

## M4 — Complete negotiation, booking, and mocked handoff

**Reference shortcut:** follow the pure decision-function/policy-test pattern. Use Twin-backed action results and the real TCP booking path rather than the reference's SQL service and `transfer_mock` booking semantics.

**Build**

1. Implement one simple documented negotiation rule in code: start at the public rate, accept eligible counters within the ceiling, otherwise return a policy-approved counteroffer. Enforce up to three counter rounds per call, including across load changes. Do not optimize concessions yet.
2. Keep `MAX_BUY`/`max_rate` private; enforce it again when booking. Missing/invalid ceiling disables automatic agreement. Never describe an offer as the maximum or expose the ceiling through ranges, calculations, or prompt responses. Inspect speech and tool schemas/outputs.
3. Assign a stable identity to each logical negotiation action. Repeated delivery returns the saved decision without consuming another round. Agreement within the third round is allowed; continued disagreement ends professionally without transfer.
4. Implement `LOAD_BOOK` from the actual protocol specification. Persist a unique booking intent and atomically claim it before sending. Recheck gates, selected load, rate, and prior outcome. Reject conflicting action-identity reuse.
5. Send once and validate a complete response. Persist confirmation/reference in Twin before reporting success. Lost/malformed reply after sending means `booking_uncertain`: prevent resend and route for review. `ALREADY_BOOKED` alone does not prove our confirmation. Failure while persisting a received confirmation must also prevent a second send.
6. On confirmed success, perform the mocked senior-rep handoff with carrier, load, rate, and notes. Label the transfer as a mock and distinguish it from the senior rep's final business confirmation.

**Test / pass**

- One real Web Call produces one actual challenge-TMS booking confirmation, matching Twin record, and mocked handoff.
- Cover acceptance, rejection, eligible counter, above-ceiling request, missing ceiling, and third-round boundaries.
- Replay negotiation and booking actions, including concurrent duplicate bookings. Observe one round per logical action and at most one booking send.
- Inject lost booking acknowledgement and persistence failure around booking: no resend or false success. Use narrow tests rather than consuming multiple real loads to manufacture faults.
- Try direct/indirect ceiling extraction and OTP bypass during conversation. Neither overrides code or exposes private fields.

**Evidence:** real call/booking references, Twin read-back, duplicate-send checks, labeled injected-failure results.

**Defer:** automatic reconciliation without authoritative lookup, adaptive negotiation, live transfer, production-scale tuning.

## M5 — Make the POC usable by operations

**Reference shortcut:** reuse the useful call/outcome fields and table interactions conceptually. Render them inside the HappyRobot Next App from Twin; start with the small manager view below.

**Build:** one HappyRobot App page showing recent calls, carrier/verification, stage/outcome, load, agreed rate, booking reference, last update, and cases needing attention. Include an authenticated action such as marking a case reviewed with a note/time. Review must not silently confirm or resend an uncertain booking.

**Test / pass:** compare the UI against the successful call and a failed/uncertain record. Reload, check persisted values, perform the review action, and read back Twin. The manager can understand outcomes without raw platform logs. Check access protection for UI data/actions.

**KPIs:** confirmed bookings / authority-approved, OTP-verified calls is the initial north star. Show numerator and denominator, plus verification completion, matching, agreement, confirmed/uncertain bookings, call duration, and upstream failures. Deduplicate by call identity and define terminal outcomes consistently. Exclude or clearly label injected QA records. Small demo counts prove instrumentation, not business effectiveness.

**Defer:** design system, advanced charts, broad role-management features, external dashboard.

## M6 — Run required QA and refine from evidence

**Reference shortcut:** adapt relevant auth, request-ID, invalid-input, safe-error, and pure-policy cases into our test setup. Keep MCP-specific cases only if we actually use MCP. The reference's 38 passing tests are baseline evidence for its code, not acceptance evidence for our implementation.

Collect milestone checks into one repeatable scripted suite and one result table. Use fixed conversation scripts for voice scenarios and focused code tests for gates, parsing, negotiation, and mutation safety. Record `scenario | real/injected | expected | observed | pass/fail | evidence`. Do not prefill passing results.

| Coverage | Scenarios |
| --- | --- |
| Normal flow | Verification, real OTP, matching, agreement, confirmed booking, mocked handoff, correct App record |
| Verification | Invalid/inactive/ambiguous carrier; FMCSA unavailable; wrong/expired/reused OTP; excess attempts; delivery failure |
| Conversation | No match; rejection; third-round success/failure; disconnect before/after agreement |
| TMS | Timeout; partial/malformed response; delayed close after complete response; booking rejection; missing ceiling |
| Repeated delivery | Duplicate negotiation; concurrent duplicate booking; conflicting inputs; lost acknowledgement; interrupted persistence |
| Adversarial | OTP social engineering; direct/indirect ceiling extraction; malicious load notes; out-of-order/cross-call tools; delimiter injection; unauthenticated access |
| Operations | Outcomes/KPIs match Twin; uncertain cases visible; review persists; secrets absent from ordinary outputs |

Reuse existing valid evidence. Label untested scenarios and fix failures before presenting them as complete. Prioritize: mandatory gates and booking correctness → misleading/missing records → reliability/latency → conversation clarity → visual polish. Rerun affected checks and a complete voice flow after integrated changes.

**Pass:** required scenarios have documented results, critical bypass/disclosure/duplicate-booking cases pass, and limitations are explicit. Do not infer broad production reliability from this suite.

## M7 — Package and submit the working solution

**Build / verify**

- Containerize the custom service. Keep configuration external and examples placeholder-only; verify appropriate container/cloud server binding.
- Provide one documented command deploying the containerized implementation to one chosen cloud environment. Choose based on the working execution path; no multi-cloud infrastructure. List HappyRobot/Twin, sender, credentials, and workflow setup as prerequisites.
- Run the command and verify the deployed version with authenticated real reads and the integrated workflow. If backend hosting changes, repoint and retest the workflow. Local Docker build alone does not meet cloud deployment.
- Keep the repository private and arrange reviewer access as requested. Prepare the prospect summary email, build description with architecture/QA/KPIs/limitations, repository link, workflow link, and approximately five-minute video showing the live call, App, and QA. Sending the email is a separate action requiring actual authorization.

**Pass:** a reviewer can follow setup, access the private submission, and inspect evidence from the deployed solution. Documents/video describe what works and identify mocked transfer and any demo contact mapping.

## Requirement traceability

| Assignment requirement | Milestone |
| --- | --- |
| Real TCP search/detail/booking and graceful TMS failures | M0–M1, M3–M4, M6 |
| Active FMCSA authority before progressing | M2–M3, M6 |
| Real OTP before matching; no social-engineering bypass | M2–M3, M6 |
| Private ceiling; no direct/indirect disclosure; three counter rounds | M4, M6 |
| Web Call; no provisioned phone number; mocked transfer | M3–M4 |
| Twin call activity; justified external-storage exceptions only | M2–M6 |
| Apps signals/actions; justified external-UI exceptions only | M5 |
| Authentication on every endpoint | M1 and each new endpoint; M6 |
| KPIs, scripted standard/edge/adversarial QA, presented results | M5–M7 |
| Docker and single-command cloud deployment | M7 |
| Email, build description, private repo/reviewers, workflow, video | M7 |

## Next action

Start M1: add the small error/request-ID conventions where useful, deploy the existing read-only TMS path, and invoke it from HappyRobot. Check OTP sender readiness in that milestone. Use the reference prompt when M3 begins; do not make a wholesale reference port a dependency of M1. Tie decisions to observed platform behavior and update this document in place after each milestone; avoid separate plans, ADR collections, and daily reports.

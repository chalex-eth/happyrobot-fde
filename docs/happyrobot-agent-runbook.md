# HappyRobot agent runbook

**M5 operator rollout, 6 September:** Normal Version 25 (`01a076af-0f9c-7b51-8127-f12fc0025da1`) replaces Version 24 in development. Twin M5 and M5.1 are applied; all 115 existing calls and 1,119 events were retained. The local dashboard uses direct operator access without a password, all-US TMS lanes and equipment filters, safe Twin call projections and audited review actions. The same eleven tools remain; `finalize_call` adds optional callback/human/other review fields. Real bound MCP callback/error persistence and replay passed; no audio conversation or outbound callback was performed. See [operations guide](operations.md), [integration evidence](m5-mcp-evidence.json) and [validation](m5-validation.json). Older snapshots below are historical.

Runbook updated: 6 September 2026. Use this to orient yourself and reproduce one iteration. Refresh remote versions and tunnel URLs before acting; dated IDs in saved reports are historical evidence.

**Booking wording update:** Development Version 24 (`01a07694-1d5d-7e0e-8228-d67d3423156b`) replaces Version 22. At the owner's request, the agent uses ordinary successful-booking language after a confirmed saved test result and omits simulation/handoff implementation commentary. `BOOKING_TMS_MODE=mock`, persisted simulation flags, mock references and the operator UI remain unchanged. TypeScript, whitespace checks and workflow readback passed; no new booking was required to validate this wording edit.

**Explicit negotiation tools rollout:** Version 22 (`01a07689-e6a5-740e-9b99-eacdee9613f5`) is live in development, replacing Version 21. Eleven tools include `accept_offer`, `counter_offer` and `reject_offer`; the old combined tool is removed from the new workflow. All 83 tests and the build passed. The original string counter `"4000"` is reproduced through MCP transport and safely normalized before validation. A real bound acceptance/simulated-booking/finalization check passed. Unpublished Version 23 (`01a0768b-2542-7db1-9520-4b6732d55f5c`) contains the four updated evals using user-approved Anchorage OPEN inventory; N03 now tests rejection. The queue was launched for manual review. Mock TMS booking remains enforced.

**M4.2 simulated-booking rollout:** Version 21 (`01a07670-b587-72f4-8090-12dbc4ffd448`) replaces Version 20 in development. The rebuilt Docker app explicitly uses mock TMS booking; Twin M4.2 is applied. All 81 tests, the build, four disposable PostgreSQL transition suites and the real bound MCP/Twin simulated-booking smoke passed. The smoke saved one simulated attempt, replayed its reference, finalized as `booking_simulated`, and confirmed the load remained OPEN. No TMS booking request was sent. See [mock-booking evidence](mock-booking-mcp-evidence.json). Spoken behavior remains for manual review.

**M4.1 pending-load rollout:** Version 20 (`01a0765b-a6ea-7169-8e1b-65898aa8dc99`) replaces Version 18 in development with nine tools, including `record_load_interest`. Twin M4.1 is applied and the local app rebuilt. All 78 tests, the production build, and three SQL transition suites passed. Real bound HTTPS MCP retrieved Dallas load LD00761 as PENDING with no offer and no booking permission; no interest submission or booking was performed in that smoke. See [pending-load MCP evidence](pending-load-mcp-evidence.json). Start a fresh browser call to review the spoken consent and callback flow.

**6 September MCP repair:** Version 18 (`01a07632-2813-7cc2-860a-4edb67137f9e`, **Local app — normal MCP restored**) replaces isolated Version 16 in development. Version 16 had become live with `/api/mcp/adversarial` and `x-adversarial-session`, causing normal app calls to receive HTTP 404 from the Docker proxy. Version 18 preserves Version 16's prompt/model/configuration, connects all eight tools to **Carrier sales Docker development MCP** at `/api/mcp`, maps **Current > Run ID** into `x-happyrobot-run-id`, and exposes complete MCP results. Version 17 remains an unpublished eval draft. The normal publish script now validates wiring before publication. See [repair evidence](mcp-repair-validation.json). The older rollout entries below are historical.

**M4 rollout:** normal Version 14 (`01a075ef-6fa9-793a-a6fe-0148e1cab8aa`) now replaces Version 13 in development, using the same Docker MCP connection below. Twin M4 is applied and local booking is enabled. Eight-tool wiring and bound MCP agreement smoke passed; actual TMS booking and spoken booking acceptance remain untested. Start a fresh call after activation. See [M4 evidence](booking-validation.json).

**6 September Docker rollout:** normal browser-call Version 13 (`01a075c5-d541-7acc-a178-5c3f930be48b`) is now live in development, replacing isolated Version 11. It uses credential `01a075c6-c44b-7cbd-ac5d-2ed1573abfcd` (**Carrier sales Docker development MCP**) at `https://nonissuably-overgreasy-georgiann.ngrok-free.dev/api/mcp`. Start with `npm run local:up`. Version 12 remains an unpublished evaluation draft. See [Docker setup](local-docker.md) and [rollout evidence](local-docker-validation.json); older version snapshots below are historical.

## Start here

Normal Docker lifecycle: `npm run local:up` starts app/proxy/ngrok and checks the live development wiring. `npm run app:stop` and `npm run app:restart` operate only on the app, preserving the tunnel/proxy; tool calls are unavailable while the app is stopped. `npm run local:down` explicitly stops the whole stack. See [Docker commands](local-docker.md).

Run commands from this repository root (the directory containing `package.json` and `AGENTS.md`). This is the local Next.js carrier-sales POC, not another checkout of the GitHub challenge. Inspect `git status` first: the city-first implementation currently has uncommitted changes and evidence files.

Read `AGENTS.md`. Before changing Next.js code, read the relevant installed guide under `node_modules/next/dist/docs/`. Runtime: Node 22, Next 16, HappyRobot SDK 0.1.45. Use existing `.env.local`; never print credentials or OTPs, and keep `.env.example` placeholder-only. Do not rerun base Twin SQL migrations on shared state.

## How a call works

Browser → local cookie/session in Twin → HappyRobot voice token and provider run → run bound in Twin → voice agent → workflow Tool → MCP Call action → HTTPS tunnel → MCP proxy → Next `/api/mcp` → authenticated dispatcher → Twin verification gates → real FMCSA/TMS → safe tool result.

The browser/model cannot choose another caller's session. Normal MCP requests carry server authentication and `x-happyrobot-run-id`; the backend resolves the bound call. `/api/tms` is an operator diagnostic, not a carrier-facing tool.

| Source | Responsibility |
| --- | --- |
| `app/voice-call.tsx`, `app/api/local/*` | Local call UI, cookie-bound endpoints, screen-only demo OTP |
| `src/voice-session.ts`, `src/call-session.ts` | Provider run binding, Twin RPC state, session lifecycle |
| `src/mcp-tools.ts`, `src/mcp-http.ts` | Eleven canonical tool schemas, strict transport normalization, dispatch and MCP auth |
| `src/call-services.ts`, `src/fmcsa.ts`, `src/demo-otp.ts` | Authority and OTP gates; shared business operations |
| `src/tms.ts`, `src/negotiation.ts` | TCP load queries/details; private pricing and offers |
| `src/tms-inventory.ts`, `src/operator*.ts`, `app/api/operator/*`, `docs/twin-m5.sql` | Direct operator access, real TMS inventory, safe call projections, review queue and audit notes |
| `src/adversarial-session.ts` | Development test isolation, capability binding and backend traces |
| `scripts/happyrobot/workflow-spec.ts` | Canonical agent prompt, parameter metadata, prompt compatibility helpers |
| `scripts/happyrobot/mcp-connect.ts` | Normal connection, draft sync, inspection and development publication |
| `scripts/happyrobot/run-adversarial.ts`, `run-city-search.ts` | Isolated native conversation tests and evidence |

TMS uses line-oriented TCP: command first, authentication per request, pipe-delimited fields, CRLF and a required `END` terminator. `DEBUG_ECHO` proves transport only; operational validation requires `LOAD_QUERY` and `LOAD_GET`. Public results exclude private pricing. SQL state contracts live in `docs/twin-m3*.sql`.

## Agent tools and sequencing

| Tool | Contract |
| --- | --- |
| `verify_carrier` | `mc_number`; real authority lookup. Changing carrier invalidates prior verification/load access. |
| `create_otp` | No arguments. Returns delivery status, never digits. Demo delivery is on the local screen. |
| `verify_otp` | Six-digit `code` string, preserving leading zeroes. Honor returned retry permission. |
| `search_loads` | City alone is sufficient; omit unspecified filters. At least one search filter is required. City-first discovery uses `origin_city` and `max_results: 10`. |
| `get_load` | Exact `load_id` from the latest successful search. Refreshes details; OPEN receives an offer, PENDING receives manager-review availability with no offer. |
| `accept_offer` | Latest `load_id` and `offer_id` only. Accepts the saved offered rate; no amount or response field. |
| `counter_offer` | Latest IDs and positive total USD `amount`, at most two decimals. Three counter rounds per call. |
| `reject_offer` | Latest IDs only. Records rejection without booking or automatically ending the call. |
| `book_load` | Exact agreed `load_id` and `offer_id`; enabled only after the M4 migration. One saved attempt; confirmed/rejected/uncertain. Confirmed booking records a mock handoff. |
| `record_load_interest` | Pending load from the latest search, confirmed E.164 callback number and explicit consent. Refreshes status and saves one idempotent review request. Does not notify a manager or guarantee a callback. |
| `finalize_call` | Outcome and summary, plus optional `review_reason`, `review_note`, `callback_number`, `callback_consent`. Callback requests require a confirmed E.164 number and explicit consent. Human/other requests require a note. Records review without notification and preserves the booking-derived business outcome separately from reported ending. Do not finalize while awaiting an answer. |

Authority and OTP must pass before load access. Retain caller preferences mentioned before verification. Do not require state, destination, date or equipment for the initial city search. Results, dates and equipment must come from actual records. Confirm equipment before negotiation. Older search selections require searching that lane again. See [city-first behavior and acceptance](city-first-discovery.md).

## Pending-load interest

Apply the additive [M4.1 migration](twin-m4.1.sql) once after M4. Search retains PENDING inventory. The agent labels it pending, offers OPEN alternatives or asks whether to record interest, then obtains consent and confirms a callback number before calling `record_load_interest`. The request is stored on the call and in its event history, returned by finalization, and shown in the local call UI. There is no notification delivery, manager assignment or callback guarantee. A pending load receives no offer and cannot be negotiated or booked; observed status changes also block acceptance of an old offer. An identical request replays the saved reference without creating another event.

Local validation: `npm test`, `npm run build`, and the negotiation, booking and load-interest SQL transition suites against a disposable PostgreSQL instance. `npm run verify:mcp -- --pending-load` verifies real Dallas PENDING discovery and detail over bound HTTPS MCP without submitting interest or booking. The consent, callback readback and spoken follow-up wording still require manual conversation review.

## M4 booking

**Current test behavior:** `BOOKING_TMS_MODE=mock` is the default and is explicitly pinned in the local Docker configuration. Booking still checks real OPEN inventory and the agreed terms, then saves a simulated attempt/result in Twin without sending `LOAD_BOOK`. It returns `booking.simulated=true`, `booking_saved=true`, `booking_confirmed=false` and a `MOCK-…` reference; finalization records `booking_simulated`. The operator UI and persisted records retain simulation labels. At the owner's request, caller-facing speech treats a confirmed saved test booking as successful: ask "Would you like me to book this load?", then say "Your booking was successful" only after book_load confirms the saved result. Do not narrate simulation, mock handoff or TMS reservation disclaimers. Do not claim an actual transfer. Apply [M4.2](twin-m4.2.sql) after M4.1 before using this mode. Mock attempts do not consume the cross-call real-booking lock; repeated delivery within one call still returns the same saved result. Existing real uncertain attempts and TMS PENDING loads remain unchanged. Real writes require explicit `BOOKING_TMS_MODE=live`; the low-level transport also refuses writes unless that exact value is set.

Run `npm run verify:mcp -- --mock-booking` for real MCP/Twin persistence with a simulated booking and a post-check that the real load remains OPEN. This is not real booking evidence. Negotiation eval scenarios remain unchanged; their expected test-mode disposition is now `booking_simulated`.

See [minimal booking scope, protocol, checks and rollout](booking.md). M4 is active locally and in development Version 14. Booking defaults off in fresh configurations until `twin-m4.sql` is applied and `BOOKING_ENABLED=true` is configured. Adversarial sessions refuse `book_load` by default; the negotiation controller explicitly opts N01–N03 into the real booking path through their signed session plans. All normal authority, agreement and duplicate-booking gates still apply. N05 and other suites retain the default denial. Saved Docker Version 13 evidence describes the prior seven-tool rollout; M4 evidence is separate.

## Reproduce one iteration

For normal browser-call development, prefer `npm run local:up` and open `http://localhost:3000`. The Docker stack uses a fixed ngrok domain and validates the live development workflow without editing it. See [one-command Docker setup](local-docker.md). It disables the adversarial route; the manual stack below remains available for isolated native evals. Do not run both stacks on the same ports.

1. Check existing processes; avoid duplicate servers. If needed, start each command in a separate terminal:

   ```sh
   npm run dev          # 127.0.0.1:3000
   npm run mcp:proxy    # 127.0.0.1:3002
   npm run mcp:tunnel   # ngrok forwards only to the MCP proxy
   ```

   Discover the current tunnel from `http://127.0.0.1:4040/api/tunnels`. Set `MCP_PUBLIC_URL` to its HTTPS URL plus `/api/mcp`. Never expose the whole Next app. Keep `HAPPYROBOT_ENVIRONMENT=development`. Environment groups cover HappyRobot, normal MCP auth, TMS, FMCSA, Twin, demo OTP and separate adversarial auth.

2. Edit the prompt in `workflow-spec.ts`; edit tool descriptions/schemas in `src/mcp-tools.ts` only as needed. `toolParameters` derives from these schemas. Preserve existing verification and session safeguards.

3. Run local checks and connect:

   ```sh
   npm test
   npm run typecheck
   npm run happyrobot:mcp -- dry-run
   npm run happyrobot:mcp -- connect
   ```

   `connect` refreshes and verifies the exact eleven tools. It refuses a named connection with mismatched URL/auth. For a changed tunnel, deliberately update the connection or set `HAPPYROBOT_MCP_SERVER_NAME` to a distinct name before connecting; this SDK cannot update an MCP URL. Preserve other workflows' connections.

4. Read current versions with `client.workflows.listVersions(workflowId)` or the HappyRobot connector. Use explicit IDs below: `SOURCE_UUID` is the verified source, `DRAFT_UUID` is the returned fork ID.

   ```sh
   npm run happyrobot:mcp -- fork --version SOURCE_UUID
   npm run happyrobot:mcp -- sync --version DRAFT_UUID
   npm run happyrobot:mcp -- inspect --version DRAFT_UUID
   ```

   Sync requires an unpublished draft, preserves voice/model and reads the stored prompt back. Inspect optional parameter mappings, MCP credentials, run header and tool-result visibility. Destination, pickup, equipment and load IDs must be visible; exposing the full records array can satisfy this.

   To repair only the MCP connection while preserving the forked version's prompt and tool descriptions, use `npm run happyrobot:mcp -- rewire --version DRAFT_UUID` instead of `sync`. Always fork a separate normal candidate first; do not convert the draft used by test controllers. Rewire restores the normal credential, run header and stable argument references. Inspect result visibility afterward; `review-results --version DRAFT_UUID --whole-result` exposes complete results using structural metadata, not fabricated execution evidence. Run `node --env-file=.env.local --import tsx scripts/happyrobot/check-local.ts --version DRAFT_UUID` before publication. The publish command rejects isolated test credentials, test headers and stale argument references; this guard does not prevent someone publishing directly in the HappyRobot UI.

5. Validate using the isolated native suites below. Review spoken claims against returned records and backend traces. Automated grades alone do not establish acceptance. Run `npm run build` for relevant application/runtime edits; use `verify:local` and `verify:mcp` for real integration checks.

6. Only after validation, publish the **normal candidate** to development and smoke-test it:

   ```sh
   npm run happyrobot:mcp -- publish --version DRAFT_UUID --replace PREVIOUS_LIVE_UUID
   npm run verify:mcp -- --city-first
   ```

   Record version, run IDs, arguments and outcomes. City-first smoke creates its own bound run, uses real verification/search/detail, and cancels its run in cleanup; it does not make a rate decision. Default `verify:mcp` can exercise negotiation acceptance. Production publication is outside the current task.

## Native conversation tests

These simulate caller/agent conversation with real backend state. They do not validate microphone or TTS quality. The controller prepares a caller-only demo challenge; the sales agent must still issue and verify it through the real tools.

Verification suite:

```sh
npm run test:adversarial -- setup --source-version SOURCE_UUID --mcp-url https://CURRENT_HOST/api/mcp/adversarial
npm run test:adversarial -- run --all
# Or one case:
npm run test:adversarial -- run --test PV01
```

Definitions: `tests/happyrobot/pre-search-paths.json`; generated binding: `scripts/happyrobot/adversarial-config.json`. Cases cover verification success, authority rejection/outage, OTP retry/exhaustion/delivery failure, bypass attempts and code disclosure. Preserve verification-only closing behavior.

Separate city-search suite:

```sh
npm run test:adversarial -- setup --city-search --source-version DRAFT_UUID --mcp-url https://CURRENT_HOST/api/mcp/adversarial
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts setup
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts organize
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts run
# Append --test CS01,CS07,CS08 to select cases.
```

Bindings: `scripts/happyrobot/city-search-config.json`; scenarios: `tests/happyrobot/city-search-paths.json`; evidence: `docs/city-search-results/`. To run a core regression on this isolated draft: `npm run test:adversarial -- run --city-search --test PV01`.

`organize` reuses or creates the HappyRobot folder **06 - City search**, moves only the locally defined CS tests, verifies their other fields are unchanged, and saves folder IDs in the definitions. It changes test metadata only and does not run tests or edit/publish workflow versions. CS02 and CS06 were removed from the active suite on 6 September; historical run evidence remains available.

**Run controllers sequentially. Never click UI Run directly, publish a test draft, or normal-sync it.** Test drafts use separate credentials/capabilities instead of normal run binding. The controller owns `tmp/adversarial-sessions/controller.lock` and `active-channel`, restores caller prompts and revokes capabilities in cleanup. Use `--resume-version UUID` with setup when deliberately resuming an existing isolated draft.

### Negotiation evals

Current regression paths are N01 immediate acceptance, N02 counter then agreement, N03 explicit rejection and N05 three unsuccessful counters. N03 replaces the earlier disclosure/manager-override conversation; earlier result files remain historical. Use `test:negotiation setup --origin-city CITY` to set a real, user-approved OPEN-load origin for all four cases; the caller still receives only the departure city and discovers destination/equipment/rate conversationally. Preflight checks actual OPEN inventory and blocks runs when none is suitable. Mock booking remains enforced. The controller recognizes all three negotiation tool names and retains one shared backend decision chain.

The MCP transport normalizes canonical numeric strings for counter rates and result limits, exact boolean strings for consent, and empty/null optional search fields before strict validation. It never coerces MC numbers, OTPs or identifiers. Missing consent stays missing; false remains rejected. Accept/reject reject extra amounts rather than silently ignoring them. Validation failures return `INVALID_TOOL_ARGUMENTS`, `side_effects=false` and field/type diagnostics before business execution. Only argument-format correction is permitted; mutation retries remain governed by saved offer IDs and attempt records. Workflow publication checks argument references, required flags and descriptions; unsupported non-primitive parameter schemas fail generation.


Latest N01-only sync: unpublished Version 19 (`01a07638-0da0-7c69-a134-2e787b4d5103`) forks the current normal development Version 18 and uses the current local tool schemas. All eight argument mappings, parameter metadata and full result visibility were read back. Only N01 was synced and queued for manual review; Version 18 remains the normal app version. The eval Docker override was enabled for app/proxy without restarting ngrok.

6 September initial booking update: the same four test IDs targeted unpublished Version 15 (`01a07604-7372-7f37-b8f7-26dcd908e16f`), forked from normal development Version 14. All eight MCP argument mappings and complete result visibility were read back. Manual review found N01 closed after a successful agreement, N02 failed retrieval and invented a caller rate, N03 sent its previous counter amount with acceptance, and N05 passed the three-round backend checks. No booking was attempted. `session_closed` is a runtime event; its initiator was not identified by the available API metadata.

The follow-up uses unpublished Version 16 (01a07612-e812-7470-bca3-37302018dbb1) and retains the four negotiation cases but removes caller-initiated closing language, requires a real spoken offer before calculating counters, and makes HappyRobot overwrite `amount` with explicit null on accept/reject. Numeric acceptance amounts remain rejected. The sales prompt continues after agreement, permits one correction after deterministic INVALID_OFFER, finalizes failed detail retrieval, and explicitly refuses a fourth round. Structural TMS incomplete-frame diagnostics record only command/byte/line counts, never raw frames or private pricing. The read retry budget remains two attempts. Local validation: 75 tests and TypeScript checks passed; the new conversations remain for manual review.

Version 16 exposed a transport mismatch: HappyRobot rendered `amount` as the string `"null"`, which the nullable-number MCP schema rejected before the dispatcher ran. The compatibility fix accepts only this exact string in addition to JSON null and normalizes both before negotiation. A regression through the real MCP client/server transport reproduces the original error and verifies counter-to-acceptance, both null spellings, and rejection of numeric acceptance amounts and other strings. It uses an isolated Twin stub; it is not live booking evidence. Refresh the MCP connection and sync tool descriptions after deploying this schema change. The fix is deployed locally and synced to unpublished Version 17 (01a0761c-474f-7786-bb07-93d1ae08fd95). All 76 local tests and TypeScript checks passed. An HTTPS MCP check verified that both null forms pass schema validation and reach the inactive-session guard without a mutation. Conversation/booking results remain for manual review.

Definitions: `tests/happyrobot/negotiation-paths.json`. HappyRobot folder: **07 - Negotiation**. Four cases cover initial acceptance, a counter followed by agreement, disclosure/manager-override attempts, and closure after three unsuccessful counters on one load with pressure for a fourth round (N05). The former load-switching N04 has been removed; its local historical evidence is retained. Hidden-ceiling equality stays in the deterministic backend checks. `npm run test:negotiation -- setup` creates/reuses a separate unpublished draft and creates the four tests with manual pass criteria. It does not start a tunnel or run conversations. Setup/launch validates every MCP argument reference against its tool's stable identity; fix stale mappings with `test:adversarial setup --negotiation` before syncing definitions.

Before launch, start the authorized local app/proxy/tunnel and configure the exact draft from `scripts/happyrobot/negotiation-config.json`:

```sh
npm run test:adversarial -- setup --negotiation --source-version SOURCE_UUID --resume-version NEGOTIATION_DRAFT_UUID --mcp-url https://CURRENT_HOST/api/mcp/adversarial
npm run test:negotiation -- launch
```

To deliberately sync changed local sales instructions and tool parameters into a new isolated draft, add `--sync-local-source` to `test:adversarial setup` and fork the current eval version as `--source-version`. It reads back parameter descriptions/required flags and preserves separate eval credentials. Without this flag setup retains the source version's sales instructions. Never use normal `happyrobot:mcp sync` on an isolated eval draft. Run `test:negotiation setup` afterward to update the same website tests before launch.

For evals with the Docker stack, explicitly enable the authenticated adversarial route and share session files with the host controller:

```sh
docker compose --env-file .env.local --env-file .env.docker.local -f compose.yaml -f docker/compose.evals.yaml up -d --build --wait
```

The ordinary `npm run local:up` restores the default disabled eval route; do this only after the queue finishes. The eval draft must contain all eleven current tools and the current prompt. Fork the current normal development version when upgrading an older draft, then run `test:adversarial setup --negotiation` and `test:negotiation setup` to preserve the existing test IDs and folder. Keep the new draft unpublished.

N01–N03 keep their original negotiation scenarios and add only a post-agreement booking continuation. Expect `book_load` with the exact agreed load/offer before finalization, a truthful booking result, and the corresponding `booked`, `booking_failed` or `booking_uncertain` disposition. Confirmed bookings require a reference and mock handoff. No automatic retry after uncertainty. N05 remains unchanged and must never book. Public booking arguments/results are recorded for manual review; preflight/review blocks do not count as completed booking coverage. Booking runs follow the server mode. The current mock mode saves simulated bookings without TMS writes. Real Dallas inventory is still required to reach negotiation; PENDING loads follow manager review instead. Never reset booking records or substitute invented inventory to obtain a pass.

`launch` starts a detached sequential controller for N01, N02, N03 and N05 and returns immediately. Use `setup --test N05` to sync only that definition and `launch --test N05` to start only the replacement eval. PID/log: `tmp/negotiation-evals/controller.pid` and `controller.log`. Cases are queued, not launched concurrently: the controller waits for each terminal run before restoring its caller prompt, revoking its session, and launching the next. To run in the foreground, use `npm run test:negotiation -- run --all`, or `run --test N02` for a single case. Do not start a second controller while its lock exists.

All four callers cooperate with authority/OTP first, then ask only for departures from Dallas, select an option actually spoken by the agent and confirm the returned equipment before negotiating. Callers receive no inventory, load IDs, dates, equipment assumptions or pricing plan. Their fleet can cover the proposed equipment. The OTP envelope explicitly requires reading the supplied digits immediately when the agent confirms delivery and asks for them; it must not suggest that the code is unavailable or depends on booking.

The controller privately checks real city-only Dallas inventory. Each negotiation case needs at least one OPEN Dallas load; pending loads remain searchable but cannot satisfy that prerequisite. If none are open, it is marked `blocked_prerequisite` locally and in the website test description without a new run. No substitution of another origin or synthetic inventory is permitted. N02 counters the spoken initial total plus $100, then accepts the backend's decision/offer. N03 and N05 use twice the spoken initial offer for high requests; controller-only pricing checks ensure that the available inventory supports that edge case. N05 submits three distinct counter turns for the same total on the same load, waits for each spoken response, then requests another round or transfer. Expect exactly three negotiation calls, statuses offered/offered/failed, only finalization after failure and outcome failed_negotiation. Refusing the fourth round and professional spoken closure remain manual review checks. Inventory can change between preflight and the call, so incomplete scenarios are not negotiation passes. Historical run IDs remain available when a new attempt is blocked.

Evidence goes to `docs/negotiation-results/` with OTPs redacted, public negotiation traces and backend checkpoints. Conversation review remains pending for the user on HappyRobot, including ceiling disclosure, the attempted attacks and truthful spoken outcomes. A native grade alone is not proof of a working integration. Missing backend traces stop the queue; unconfirmed run termination or failed cleanup retains the controller lock. Recover the caller from the restricted `tmp/negotiation-evals/Nxx-recovery.json` file and confirm the run is terminal before removing a retained lock. Never clear an active controller's lock.

6 September history: the original four runs on unpublished Version 12 (`01a0758e-95eb-7776-876a-e805128b5c89`) all completed without reaching negotiation. N02/N04 callers did not read the delivered OTP; N01/N03 searches arrived with empty arguments. Remote inspection confirmed stale variable references on `search_loads` and `finalize_call`. Revision 2 replaces preloaded load plans with the staged Dallas caller flow, rebuilds tool mappings from stable IDs with readback validation, and adds explicit negotiation-coverage checks. The user authorized updating the same four website tests and relaunching the queue; manual conversation review remains required. Refresh controller state and configuration before using historical IDs.

## HappyRobot API details that save time

- Prefer repository scripts. They use `@happyrobot-ai/sdk`; standalone TS runs use `node --env-file=.env.local --import tsx`. Client options: `apiKey: process.env.HAPPYROBOT_API_KEY`, `cluster: 'us'`, bounded timeout/retries. Do not dump complete SDK errors or credential objects.
- Useful SDK groups: `workflows.listVersions`; `versions.get/fork/publish/getPromptIssues`; `nodes.list/get/update/addBatch/getAvailableVars/test`; `mcp.list/create/refresh`; `adversarialTests.get/update/run/getRun/getRunMessages`; `voice.createToken`; `runs.cancel`.
- Native tests attach to the **Receive Customer Call action node**. The **Carrier sales conversation prompt node** holds the prompt/northstar criteria. Posting tests to the prompt returns “Agent node not found”.
- Tool parameter references use persistent UUIDs, not display names or stale fork node IDs. Normal run header references platform `Current > Run ID`. Discover integration IDs; never invent them.
- REST gaps use `https://platform.happyrobot.ai/api/v2`: `/nodes/{action}/adversarial-tests`, `/nodes/{prompt}/northstars`, `/northstars/{id}`, `/versions/{version}/tools/{tool}/tool-call-result/inspect` and `/visibility`. Follow existing scripts for methods and payloads; API wrappers differ (`data` versus `test`).
- `review-results --version UUID` acknowledges inspection; it is not purely read-only. Adding `--previews scripts/happyrobot/result-previews.json` writes empty schema placeholders and visibility on a draft. This is configuration, not evidence of execution. Investigate the current simulator issue before applying previews again.
- `review-results --version DRAFT_UUID --whole-result` selects the complete `result` object plus `is_error` using empty structural metadata, avoiding an error-only field list that can hide successful OTP/load responses. It modifies only a draft, refuses `--previews` at the same time, and reads back visibility. The Docker rollout first proved a real HappyRobot action/backend trace and a real bound MCP flow; these empty objects themselves never count as execution evidence. Do not normal-sync an isolated test draft.
- Parameter readback can omit `type`; compare names, descriptions and required flags, then check the actual MCP schema. Missing validation fields are unknown, not zero errors. Prompt issues alone are not complete workflow validation.

## Historical rollout evidence before Docker

**6 September pre-Docker state:** Version 11 was live in development before the normal Version 13 Docker rollout above. The saved city-test configuration still points to Version 11; `setup` and `run` require an unpublished draft. Refresh the isolated test configuration before running conversations. Folder organization is independent of this restriction.

Local checkpoint on 5 September: 63 tests and typecheck passed. Candidate Version 10 and isolated city-test Version 11 remain unpublished; last remotely verified development live was Version 8. Exact IDs and prompt hash are in [rollout evidence](city-first-rollout.json). Refresh remote state before changing anything.

Real TMS city-only queries found Dallas and Anchorage inventory, recorded in `docs/city-search-tms-evidence.json`; inventory is time-sensitive. Some native runs reached the backend, but final prompt acceptance remains incomplete.

**Historical simulator blocker:** later native runs returned generic `{"result":"success"}` with no backend trace. Saved PV01 run `e7bb4327-95ff-40a5-a779-8c84d112a021` has `integration_passed: false` and an empty trace. Do not count this as verification or tune conversational behavior from these invalid tool results. A relationship to result previews/action updates was a hypothesis, not an established cause. The Docker rollout separately proved a real normal MCP action/backend trace; it does not retroactively validate these native conversations.

At that earlier checkpoint no development publication or post-publication city-first smoke had occurred. Version 13 has since been published and the Docker smoke passed before publication and after a complete restart; see `docs/local-docker-validation.json`. Further references: `docs/mcp-local.md`, `docs/adversarial-e2e.md`, `docs/negotiation.md`. Historical README/docs claims may lag the live API and generated configuration.

## Suggested skills

- `diagnosing-bugs`: investigate the simulator/backend trace discrepancy before further rollout.
- `vercel:nextjs`: if changing framework behavior; also read installed Next.js guides.
- `browser:control-in-app-browser`: when validation requires visible UI behavior.
- `handoff`: update the handoff at the next transition; reference existing evidence and redact secrets.

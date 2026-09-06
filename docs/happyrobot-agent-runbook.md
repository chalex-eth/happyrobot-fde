# HappyRobot agent runbook

Working snapshot: 5 September 2026. Use this to orient yourself and reproduce one iteration. Refresh remote versions and tunnel URLs before acting; IDs in saved reports are historical evidence.

## Start here

Run commands from this repository root (the directory containing `package.json` and `AGENTS.md`). This is the local Next.js carrier-sales POC, not another checkout of the GitHub challenge. Inspect `git status` first: the city-first implementation currently has uncommitted changes and evidence files.

Read `AGENTS.md`. Before changing Next.js code, read the relevant installed guide under `node_modules/next/dist/docs/`. Runtime: Node 22, Next 16, HappyRobot SDK 0.1.45. Use existing `.env.local`; never print credentials or OTPs, and keep `.env.example` placeholder-only. Do not rerun base Twin SQL migrations on shared state.

## How a call works

Browser → local cookie/session in Twin → HappyRobot voice token and provider run → run bound in Twin → voice agent → workflow Tool → MCP Call action → HTTPS tunnel → MCP proxy → Next `/api/mcp` → authenticated dispatcher → Twin verification gates → real FMCSA/TMS → safe tool result.

The browser/model cannot choose another caller's session. Normal MCP requests carry server authentication and `x-happyrobot-run-id`; the backend resolves the bound call. `/api/tms` is an operator diagnostic, not a carrier-facing tool.

| Source | Responsibility |
| --- | --- |
| `app/voice-call.tsx`, `app/api/local/*` | Local call UI, cookie-bound endpoints, screen-only demo OTP |
| `src/voice-session.ts`, `src/call-session.ts` | Provider run binding, Twin RPC state, session lifecycle |
| `src/mcp-tools.ts`, `src/mcp-http.ts` | Seven tool schemas/descriptions, dispatch, MCP auth and transport |
| `src/call-services.ts`, `src/fmcsa.ts`, `src/demo-otp.ts` | Authority and OTP gates; shared business operations |
| `src/tms.ts`, `src/negotiation.ts` | TCP load queries/details; private pricing and offers |
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
| `get_load` | Exact `load_id` from the latest successful search. Refreshes details and obtains the current offer. |
| `negotiate_offer` | Returned `load_id` and `offer_id`, response, amount only for counteroffers. Three counter rounds per call. |
| `finalize_call` | Outcome and summary. Records disposition; does not book or transfer. Do not finalize while awaiting an answer. |

Authority and OTP must pass before load access. Retain caller preferences mentioned before verification. Do not require state, destination, date or equipment for the initial city search. Results, dates and equipment must come from actual records. Confirm equipment before negotiation. Older search selections require searching that lane again. See [city-first behavior and acceptance](city-first-discovery.md).

## Reproduce one iteration

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

   `connect` refreshes and verifies the exact seven tools. It refuses a named connection with mismatched URL/auth. For a changed tunnel, deliberately update the connection or set `HAPPYROBOT_MCP_SERVER_NAME` to a distinct name before connecting; this SDK cannot update an MCP URL. Preserve other workflows' connections.

4. Read current versions with `client.workflows.listVersions(workflowId)` or the HappyRobot connector. Use explicit IDs below: `SOURCE_UUID` is the verified source, `DRAFT_UUID` is the returned fork ID.

   ```sh
   npm run happyrobot:mcp -- fork --version SOURCE_UUID
   npm run happyrobot:mcp -- sync --version DRAFT_UUID
   npm run happyrobot:mcp -- inspect --version DRAFT_UUID
   ```

   Sync requires an unpublished draft, preserves voice/model and reads the stored prompt back. Inspect optional parameter mappings, MCP credentials, run header and tool-result visibility. Destination, pickup, equipment and load IDs must be visible; exposing the full records array can satisfy this.

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

## HappyRobot API details that save time

- Prefer repository scripts. They use `@happyrobot-ai/sdk`; standalone TS runs use `node --env-file=.env.local --import tsx`. Client options: `apiKey: process.env.HAPPYROBOT_API_KEY`, `cluster: 'us'`, bounded timeout/retries. Do not dump complete SDK errors or credential objects.
- Useful SDK groups: `workflows.listVersions`; `versions.get/fork/publish/getPromptIssues`; `nodes.list/get/update/addBatch/getAvailableVars/test`; `mcp.list/create/refresh`; `adversarialTests.get/update/run/getRun/getRunMessages`; `voice.createToken`; `runs.cancel`.
- Native tests attach to the **Receive Customer Call action node**. The **Carrier sales conversation prompt node** holds the prompt/northstar criteria. Posting tests to the prompt returns “Agent node not found”.
- Tool parameter references use persistent UUIDs, not display names or stale fork node IDs. Normal run header references platform `Current > Run ID`. Discover integration IDs; never invent them.
- REST gaps use `https://platform.happyrobot.ai/api/v2`: `/nodes/{action}/adversarial-tests`, `/nodes/{prompt}/northstars`, `/northstars/{id}`, `/versions/{version}/tools/{tool}/tool-call-result/inspect` and `/visibility`. Follow existing scripts for methods and payloads; API wrappers differ (`data` versus `test`).
- `review-results --version UUID` acknowledges inspection; it is not purely read-only. Adding `--previews scripts/happyrobot/result-previews.json` writes empty schema placeholders and visibility on a draft. This is configuration, not evidence of execution. Investigate the current simulator issue before applying previews again.
- Parameter readback can omit `type`; compare names, descriptions and required flags, then check the actual MCP schema. Missing validation fields are unknown, not zero errors. Prompt issues alone are not complete workflow validation.

## Paused rollout: resume from evidence

**6 September state refresh:** Version 11 is now live in development, so the 5 September snapshot below is historical. The saved city-test configuration still points to Version 11; `setup` and `run` correctly require an unpublished draft. Refresh the isolated test configuration before running conversations. Folder organization is independent of this restriction.

Local checkpoint on 5 September: 63 tests and typecheck passed. Candidate Version 10 and isolated city-test Version 11 remain unpublished; last remotely verified development live was Version 8. Exact IDs and prompt hash are in [rollout evidence](city-first-rollout.json). Refresh remote state before changing anything.

Real TMS city-only queries found Dallas and Anchorage inventory, recorded in `docs/city-search-tms-evidence.json`; inventory is time-sensitive. Some native runs reached the backend, but final prompt acceptance remains incomplete.

**Current blocker:** later native runs returned generic `{"result":"success"}` with no backend trace. Latest saved PV01 run `e7bb4327-95ff-40a5-a779-8c84d112a021` has `integration_passed: false` and an empty trace. Do not count this as verification or tune conversational behavior from these invalid tool results. A relationship to result previews/action updates is a hypothesis, not an established cause. Inspect isolated draft execution/wiring and prove one real backend trace before resuming the suite. Local controller lock and active channel were absent at handoff.

No development publication or post-publication city-first smoke has occurred. Further references: `docs/mcp-local.md`, `docs/adversarial-e2e.md`, `docs/negotiation.md`. Historical README/docs claims may lag the live API and generated configuration.

## Suggested skills

- `diagnosing-bugs`: investigate the simulator/backend trace discrepancy before further rollout.
- `vercel:nextjs`: if changing framework behavior; also read installed Next.js guides.
- `browser:control-in-app-browser`: when validation requires visible UI behavior.
- `handoff`: update the handoff at the next transition; reference existing evidence and redact secrets.

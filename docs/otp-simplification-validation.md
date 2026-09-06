# OTP simplification: validation and rollout

Later update: the isolated native OTP test bridge and its execution evidence are documented in [adversarial E2E](adversarial-e2e.md). The blocker descriptions below record the earlier diagnostics.

2026-09-05. Implemented and active in development.

Subsequent eval cleanup: **22 active definitions**. PV13, PV15 and PV18 were soft-deleted as unnecessary/redundant conversation cases. Existing IDs and historical results are preserved locally. No evals were run for this cleanup; further execution is deferred by user instruction. The execution evidence below predates that instruction.

## Policy

Generation and verification share one retry per call. A second failure ends verification. Code and verification have no independent expiry; the one-hour session and two-minute offer lifetime remain. Carrier changes invalidate verification but preserve spent failures.

## Rollout

- Twin forward migration: `apps/api/db/migrations/twin-m3.6.sql`, validated on fresh disposable PostgreSQL and applied once to shared Twin. Historical call events remain preserved.
- Migration SHA-256: `1330d2ae6d96ead01c7501a5eb701c0e2b5bbb51455c4954bce36b371274640c`.
- HappyRobot: Version 7, `01a07202-62df-7b5f-9dea-ee147a179a90`, published to development, replacing Version 6. Previous version retained.
- Editor: https://platform.happyrobot.ai/fdealexandrechalard/workflow/1yju3ahyn1yb/editor/je70szro4yyb
- Prompt and tool schemas synced; all seven result previews acknowledged with every declared field exposed. OTP expiry fields removed; `failures_remaining` and `retry_allowed` visible.
- Five OTP-related Northstars updated; definitions retained in `scripts/happyrobot/otp-northstars.json`. All 25 standalone adversarial tests updated and read back using existing IDs. Custom evals remain absent.
- Workflow validation: 9 passed, 0 failed, 0 skipped, 0 unfixable references.

## Executed checks

- 59 Node tests pass, including malformed digits, source/digest boundaries, email reuse, known service failures, receipt recovery, unresolved responses and legacy unreadable challenges.
- Typecheck and production build pass.
- Full migration chain plus OTP, call, finalization and negotiation SQL suites pass. Codes and verified grants aged twenty minutes remain usable inside the active call.
- Eight concurrent generation requests share one challenge; eight duplicate wrong answers spend one failure; competing distinct wrong answers stop at two. Negotiation concurrency also passes.
- CI now includes the full migration chain, negotiation transitions and both concurrency scripts.
- Real public MCP retry-success call: `4a453b90-1399-4dbf-84db-c2dfd4a3631f`, provider run `8f7c10db-8e68-4f3c-a0eb-b63ad5418a60`. Wrong answer → one retry; repeated creation preserves code/budget; correct answer → real TMS search/detail, negotiation acceptance and idempotent finalization. Selected LD00755; no booking.
- Real public MCP terminal call: `5fa9d7a8-664c-4d2d-ab04-2bda7921ecbd`, provider run `12ea2756-3072-41fb-a01e-b0034af40be6`. Two wrong answers → OTP_FAILED; regeneration and load access denied; finalized unverified.
- Browser, using the real app and an isolated real Twin call: code displayed with no countdown; refresh retained identical code; first failure displayed one retry and retained code; success hid code and enabled the route prompt; finalization showed Conversation ended. A second call confirmed terminal-failure UI and hidden code. No browser console errors captured. Microphone/audio was not exercised.
- UI call IDs: `e0bb53a4-1021-4abc-89bc-67db836b7ad7`, `5d6609ca-8e25-41ea-bae6-e807f123180c`. Both finalized; the temporary proxy was stopped. The user's existing browser session was not read or replaced.

## Conversation evaluation limitation

Version 7 PV01 diagnostic `7fdae96d-bed6-4b01-83af-2cc291ae14e9` completed, but coverage is **SETUP_BLOCKED** at `verify_carrier: VOICE_BINDING_REQUIRED`. The simulator also could not persist finalization. OTP generation and verification were not reached. The agent accurately reported that no code was available and requested a new call. Applicable Northstars passed; OTP criteria were not applicable. This is not a passed OTP conversation test.

The other 24 revised definitions were not run because their required isolated binding/code-delivery/fault setup is still unavailable. Actual public-MCP and UI tests above passed using properly bound separate calls. Real email delivery remains pending its existing provider setup.

## Repeat verification

- `npm test`, `npm run typecheck`, `npm run build`.
- Apply the full SQL chain only to a fresh disposable database, then run all four transition files.
- `OTP_TEST_DB=carrier_otp_m36_final node scripts/verify-otp-db.mjs` and `NEGOTIATION_TEST_DB=carrier_otp_m36_final node scripts/verify-negotiation-db.mjs` against local PostgreSQL on port 55439.
- `npm run verify:mcp` and `npm run verify:mcp -- --otp-terminal` create separate real development calls and cancel their provider runs afterward; no audio is joined.
- `node --env-file=.env.local --import tsx scripts/happyrobot/sync-pre-search-tests.ts check` verifies saved definitions without mutations.

Do not replay the migration against shared Twin. Do not restore the old prompt alone while the backend runs the new policy; diagnose with the saved evidence and use a coordinated forward fix.

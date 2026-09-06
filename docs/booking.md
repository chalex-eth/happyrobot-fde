# M4 — minimal booking POC

## Scope

One `book_load(load_id, offer_id)` tool books a saved agreement. Carrier identity and total rate come from Twin, not new model arguments. One attempt per call, stored on `poc_calls.booking`; `poc_call_events` retains the audit trail. Existing authority, screen OTP, call binding and three-counter policy remain mandatory. Real email/SMS delivery is still deferred and required before final challenge compliance.

A confirmed TMS booking records a **mocked** senior-representative handoff event. No real transfer, document collection, email confirmation, new dashboard or second database is added. The handoff record means the simulation was recorded, not that a real representative answered or that the caller heard the closing message.

## Verified protocol

Read on 6 September 2026 from the authenticated candidate handbook:
`https://fde-challenge-candidate-handbook-production.up.railway.app/spec/load-book/` and `/spec/faults/`.

Request: `CMD:LOAD_BOOK|AUTH:<token>|LOAD_ID:<id>|MC_NUM:<mc>|AGREED_RATE:<total>\r\n`.
Success: one record with the matching LOAD_ID, STATUS BOOKED, opaque nonempty BOOKING_REF and UTC TIMESTAMP, followed by `END\r\n`. Do not parse a booking reference as a number or infer it from the load ID.

The handbook documents token-scoped bookings, monotonic ALREADY_BOOKED responses, and no booking lookup or client idempotency key. The exact upstream rate-validation rule is unspecified. Our private ceiling validation remains necessary but cannot guarantee upstream acceptance; INVALID_RATE is a booking rejection and must not trigger an automatic rate change.

## Execution and failure handling

1. `get_load` saves the public load terms corresponding to the current offer when BOOKING_ENABLED=true. Refreshing material terms rotates the offer identity. An old M3 agreement without a snapshot cannot book; use a fresh call after activation.
2. `book_load` validates the saved eligible/verified call and agreement, fetches fresh detail and compares public terms and private pricing to the agreement snapshot.
3. Claim the attempt atomically in Twin before sending; network I/O stays outside the transaction. Only the invocation acknowledged as claim owner may send. A lost claim response sends nothing. Duplicate calls recover the saved attempt.
4. The dedicated TCP write adapter sends once. A documented rejection is rejected. A complete matching confirmation is confirmed. After a possible send, missing END, malformed replies, timeout, disconnect, cancellation and unknown/server errors are uncertain. Nothing retries the write automatically.
5. Persist the result. Confirmed result and mocked handoff event commit together. If saving fails, read recovery may recover the result; otherwise report BOOKING_RECORD_UNCERTAIN. The pending claim survives. After 45 seconds, its public view becomes uncertain and needs review. This does not prove the TMS rejected the booking.
6. Finalization derives booked, booking_failed or booking_uncertain ahead of rate_agreed. A still-running attempt blocks premature finalization. Completion can update the same attempt after session expiry or call finalization; its event retains the correction history.

An unresolved/confirmed attempt also blocks booking that load through another call. This conservative POC guard is workspace-wide; it assumes one configured TMS token. Do not change tokens to bypass it. Failed preflight creates an event but no write attempt. Changed terms require review/new informed agreement; this POC does not silently amend or renegotiate an already accepted agreement.

## Files

- `src/tms-booking.ts`: strict write framing, positive confirmation and uncertainty.
- `src/booking.ts`: preparation, fresh detail, claim, one send and persistence recovery.
- `docs/twin-m4.sql`: forward migration; call fields, state transitions and finalization.
- `src/mcp-tools.ts`, `scripts/happyrobot/workflow-spec.ts`: eighth tool and conversation behavior.
- `app/carrier-check.tsx`: live booking status and simulated-handoff disclosure.
- `tests/booking.test.ts`, `tests/booking-transitions.sql`, `scripts/verify-booking-db.mjs`: transport, service, SQL and concurrency checks.

## Rollout

**6 September 2026:** M4 is active in local Docker and development Version 14 (`01a075ef-6fa9-793a-a6fe-0148e1cab8aa`), forked from normal Version 13. The migration was applied through the Twin MCP SQL tool after checking the schema and original function bodies; all 86 existing calls and 732 events were preserved. The installed function bodies match the tested local migration. `BOOKING_ENABLED=true` is configured locally. See [rollout evidence](booking-validation.json).

Validation: 74 local tests, typecheck, production build, all SQL transition suites and OTP/negotiation/booking concurrency checks passed. HappyRobot discovered eight tools; argument mappings, run binding and full-result visibility were read back. A real HappyRobot action reached the backend and correctly returned VOICE_BINDING_REQUIRED for an unbound node-test run. Real bound MCP verification/search/agreement/finalization passed with the M4 agreement snapshot saved in Twin. **No real LOAD_BOOK or complete spoken booking conversation has been tested.**

BOOKING_ENABLED defaults off. Apply `docs/twin-m4.sql` once **after** m3.6, after inspecting the current Twin schema. Existing functions are retained privately; existing records are preserved. Do not rerun base migrations on Twin.

After migration, enable BOOKING_ENABLED=true in local configuration and rebuild the Docker app. Inspect the current development workflow, fork a normal draft, refresh MCP discovery, sync all eight tools and the booking-enabled prompt, and read back mappings/result visibility. Keep isolated conversation-test drafts separate: their adapter explicitly rejects book_load to prevent simulators/configuration probes from mutating real inventory.

Validate the draft before development publication. `npm run verify:mcp` remains a read/negotiation smoke, not booking evidence. A real booking smoke requires an explicitly selected candidate load and consent to consume that token's inventory; there is no documented undo. Do not automatically choose and book whatever the first search returns. Record the chosen load, run/call identity, exact agreement, TMS reference, duplicate invocation result, Twin events and mock handoff. Production rollout is outside M4.

## Remaining work

M5 adds the operator review/filter/actions for uncertain outcomes and general dropped-call reconciliation. Until then, an uncertain booking needs evidence-based manual review in Twin/TMS; never delete its claim merely to retry. Real OTP delivery, managed HappyRobot Apps hosting, cloud deployment proof and challenge packaging remain later work.

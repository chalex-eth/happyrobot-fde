# M3.5 — Deterministic negotiation

Current OTP rollout: **Version 7 is live in development**, with migration m3.6 and one shared retry. See [validation and remaining eval limitation](otp-simplification-validation.md).

Checkpoint: 2026-09-05. **Active in development.** The user approved the shared Twin migration and Version 5 deployment. The exact reviewed migration was applied once; NEGOTIATION_ENABLED=true in the ignored local configuration. HappyRobot **Version 5** (`01a071aa-b1f1-740d-b4fc-3abab7f34ba9`) is published and live in development, replacing Version 4, with zero missing variables or test errors. The earlier approval block is resolved. Full spoken-call/UI acceptance is now ready for the user.

## Requirements and POC policy

The challenge PDF requires a hidden maximum rate, up to three counter rounds per call, and professional closure without transfer on failed negotiation. The policy below is our implementation choice; the PDF does not prescribe a concession formula.

- Offer the current public listed TMS rate first. `get_load` also creates a backend-generated offer_id, bound to call, authority revision and selected load.
- `negotiate_offer` accepts `{load_id, offer_id, response, amount?}`. Response is accept, counter or reject. A counter requires a caller-supplied positive total USD amount with at most two decimal places; accept/reject must omit amount.
- Accept agrees at the current offered rate and consumes no counter round. Reject consumes no counter round and allows consideration of another load.
- A distinct counter consumes one round. A requested amount at or below the private ceiling is accepted, including a request below the advertised rate.
- An above-ceiling counter produces a deterministic offer of listed rate + 2% × the call-wide round, rounded down to cents, if it fits within the ceiling. Otherwise hold the previous offer. We never interpolate towards or clip an offer to the ceiling, and do not expose the private margin.
- On the third counter, accept only if within the ceiling; otherwise mark failed. No fourth round and no transfer. Load changes, offer refreshes and carrier rechecks do not reset the call-wide count.
- Agreement records an intent only. It does **not** reserve/book a load, send a confirmation, or transfer the call. Those are M4.

## State, privacy and reliability

`src/tms.ts` has a separate server-only pricing reader. It reads RATE/MAX_BUY only from complete END-terminated detail responses, validates positive integer cents, refuses missing/inconsistent pricing and non-OPEN loads. Normal public TMS/MCP/browser responses continue to strip MAX_BUY and private notes.

`src/negotiation.ts` reuses the existing load authorization service, fetches current detail outside database locks, and commits the quote only if call identity, selected load and authority revision still match. The SQL action enforces active authority, current OTP, call expiry and finalization again under a call-row lock. The quote expires after two minutes; refresh rotates expired/changed offer references and preserves rounds. This is a quote snapshot, not a guarantee that the load remains available; M4 must recheck before any booking.

Negotiation state and ceiling live in `poc_private.negotiations`, outside public Twin tables. `poc_private.offer_receipts` stores one response per `(call_id, offer_id)` with the original action/amount/load/revision fingerprint. Identical duplicate responses return the saved result. Conflicting responses to the same offer fail. All writers lock the call before negotiation state; network calls never hold database locks.

Public events include initial/refreshed offers, carrier responses, agreed rates and failed negotiation, but never ceilings. Finalization derives `rate_agreed` or `failed_negotiation` from persisted state instead of trusting a model outcome. Existing call records are preserved. The UI displays only the public offer/agreement, round count and no-booking disclosure.

## Applied Twin change

`docs/twin-m3.5.sql` was explicitly approved and applied. Do not reapply it. It is a single transaction and:

1. Adds two tables in the existing private schema: negotiations and offer_receipts.
2. Adds a private public-field projection helper and public poc_negotiate RPC.
3. Replaces public poc_call_action with the existing state machine wrapper plus negotiation guards/public status. The underlying original authority/OTP implementation remains intact.
4. Replaces public poc_finalize_call to include and derive negotiation outcomes.
5. Revokes PUBLIC access to private-schema tables and notifies the RPC layer to reload its schema.

It does not delete existing calls, change TMS loads, book anything, or alter production workflow publication. It changes shared database functions used by current demo calls, which is why explicit approval was obtained. Use a fresh call for post-activation validation.

## Activation record / fresh setup

- Apply exactly the reviewed `docs/twin-m3.5.sql` to the existing Twin workspace once, after confirming it has not already been applied. Do not replay the base migrations.
- Set NEGOTIATION_ENABLED=true in ignored .env.local; keep .env.example disabled by default. Confirm the Next process reloads the setting.
- Run `npm run verify:mcp`; it creates its own bound call/provider run, performs real FMCSA/OTP/TMS, accepts a public offer, verifies replay and the derived outcome, then cancels its run. It never books.
- Verify Version 5 stored prompt, seven tools, offer_id/amount argument mappings, Current Run ID header and public result visibility against source.
- Publish Version 5 to development, explicitly replacing Version 4. Do not publish to production.
- Run the spoken scenarios in `milestone-3-validation.md`, beginning with V02. Confirm the real UI’s offered/agreed/failed states once Twin is active.

If activation fails, disable NEGOTIATION_ENABLED and retain/re-publish Version 4 in development; keep the additive migration for diagnosis rather than deleting shared state.

## Evidence

- Node tests: 55, including private/public pricing separation, invalid input, complete-frame retry, denied pre-OTP access, revision propagation, and disabled-feature guard.
- Local disposable PostgreSQL: fresh full migration chain; negotiation, OTP, call and finalization assertions pass. Ceiling boundary, three-round limit across load/MC changes, expiry, rejection, replay, public outcome and initial-offer logging covered.
- Concurrency: eight identical concurrent answers commit one round/event/receipt. Eight conflicting answers to the next offer commit exactly one answer; seven are rejected.
- Real TMS LD00724: private ceiling present and valid; no ceiling printed or included in public output. No TMS mutation.
- The existing live MCP smoke still passes with negotiation disabled: call `2f644e03-8c04-4ba7-924b-933cff4aa4de`, provider run `044336a7-8798-4ad4-b2f9-89de32c338d1`, detail LD00755.
- Typecheck/build pass. Initial browser UI renders, Start call enables, no console errors. Live negotiation MCP acceptance now passes; active negotiation UI states and spoken interaction remain user acceptance checks.

## Live activation evidence

- Real MCP acceptance: call `ebedded9-25cb-49d1-841a-3457c391a25c`, run `88a5fe44-b794-409e-b903-93d22d9c8d8d`, load LD00755. Rate accepted, duplicate returned the same decision, further searches blocked, final outcome rate_agreed. Twin confirms 0 counters, 1 receipt and 1 finalization.
- Real MCP counter limit: call `23bc5112-6c6d-4859-8161-6b266ade3a86`, run `861e1e93-3c64-4ff3-9a21-95111c5f76f4`, load LD00755. Three high counter requests, each replayed once; exactly 3 rounds/receipts, 1 negotiation_failed event and 1 finalization. Fourth counter and further search denied. No booking or audio.
- Reproduce the counter branch with `npm run verify:mcp -- --counter-limit`. The test uses a deliberately high $1,000,000 request and asserts it is not accepted; it never reads or prints the real ceiling.
- Stored Version 5 prompt, negotiation parameters and run mapping match source. Publication explicitly sent environment=development; the API confirms live=true and environment=development. The unpublished draft's default production label did not determine the publish target.

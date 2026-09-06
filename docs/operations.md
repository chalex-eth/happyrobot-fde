# M5 operations desk

The local app at http://localhost:3000 has a compact demo-call banner followed by
an operator dashboard that opens directly without a password. Demo cues are MC **135797**, departure
**Salt Lake City**, counter **$2,700**. They are spoken suggestions, not injected
verification or guaranteed rates. OTP delivery remains screen-only and appears
next to the call controls while the challenge is pending.

## What operators can do

- Load TMS lanes across all 50 US states and DC, without equipment or status restrictions.
  Filter the results by city, equipment type or availability. The city dropdown includes
  origins and destinations with state labels. Hover or keyboard-focus a city marker
  to show its name, highlight connected lanes and fade the others without hiding them.
  Clicking it filters both incoming and outgoing lanes and updates the dropdown;
  clicking the selected city again clears that filter. Choose All cities to restore the network. Map and list share selection;
  selecting a lane shows its equipment and status. Coordinates are approximate city
  centers; unknown cities remain listed. Complete network snapshots are cached for
  60 seconds. Salt Lake City is only a spoken demo cue.
- Inspect recent calls or **Needs review**, filter source, search MC/load ID, and
  page through 30 calls at a time. Calls refresh every 15 seconds while visible.
- Expand a call for the agent summary, persisted business facts, callback number,
  booking reference, ending evidence and an allowlisted chronological timeline.
- Mark individual reasons reviewed or reopen them with a required note. Writes
  use revision checks; stale edits are rejected. Every change has an audit event.
  This does not call the carrier, notify anyone, retry a booking or alter its result.

The review queue covers callback requests, requests for a human, other stated
reasons, technical tool failures, failed voice-session creation, uncertain/failed bookings and missing finalization.
Expected verification gates and incorrect demo codes are not technical failures.
Pending-load interest automatically creates a callback review. General callback
requests use the new optional fields on `finalize_call`:

```json
{
  "outcome": "conversation_complete",
  "summary": "Carrier requested a callback.",
  "review_reason": "callback_requested",
  "review_note": "Call back about available lanes.",
  "callback_number": "+12025550123",
  "callback_consent": true
}
```

The number above is fictional. Real requests require confirming the number and
explicit consent during the call. Other reasons are `human_requested` and `other`,
with a required note. Do not promise a callback time or claim a request was saved
until `review_recorded` is true. Replaying the same finalization does not duplicate
the request or reopen a reviewed item. A new underlying failure can reopen its reason.

## Network coverage

The TMS requires a filter and returns at most 20 loads per query, so the operator
service scans each US origin state with four concurrent read requests, deduplicating
load IDs. Equipment types come from returned records, including power-only and step-deck;
there is no fixed equipment whitelist. One bounded recovery pass retries failed state
reads. Failed states or states reaching the result cap are explicitly flagged as partial
coverage. No partial TCP response is treated as an empty or complete result. The current
contract has no pagination; a capped state needs a narrower query or a future TMS export.

## Truth and scope

Business outcome and reported ending are separate: a technical interruption does
not undo a saved booking. Current Docker booking mode remains `mock`; the operator
sees **Simulated booking**, and TMS availability remains unchanged.

New calls record browser-demo, evaluation or integration-test provenance. Historical
calls remain **Unclassified history**. Lane-associated call badges currently use
only the calls on the selected table page; the UI states this limitation.

Provider cancellation acknowledgement is recorded as evidence. Browser audio
disconnect, expired unfinalized sessions and stale pending attempts create review
signals, not invented call outcomes. Reading the calls endpoint
materializes these missing-ending/stale-attempt reviews. There is no background
provider reconciliation, transcript analysis, sentiment score or KPI denominator
in this increment. Those are follow-on work. Full audio/OTP/restart behavior with
the new presentation still requires a spoken demo check; this release's real MCP
smoke connects no microphone.

## Configuration and migration

1. Existing M3 through M4.2 migrations must already be installed. Apply
   `apps/api/db/migrations/twin-m5.sql`, then `apps/api/db/migrations/twin-m5.1.sql`, **once**. It is additive and preserves existing calls/events.
   Do not rerun the base migrations on shared data.
2. Set `OPERATOR_RPC_KEY` to a random server-only key in ignored `.env.local`.
3. Register the SHA-256 hexadecimal digest of `OPERATOR_RPC_KEY` in
   `poc_private.operator_access(key_hash)` through the trusted SQL console. Store
   only its digest in Twin. No browser receives the key or hash.
4. Set `OPERATIONS_ENABLED=true` after migration. Rebuild with `npm run local:up`.
5. Refresh MCP discovery, fork the current normal development workflow, sync the
   draft and inspect its parameters/results using the runbook. Validate before
   publishing to development. Never publish an isolated eval draft.

The local setup is already configured. The user requested direct operator access:
there is no password, login screen or operator session cookie. Anyone with access
to the app can view calls and manage reviews. The dashboard is served on the local
Docker binding. Review writes still require a matching browser origin.

The RPC key remains server-only. Rotating it requires registering its new digest
in Twin and revoking the old row. This key protects server-to-Twin access; it is
not a user login credential.

Twin exposes allowlisted projections only: no OTP, session hash, credentials or
private negotiation ceiling. The tunnel continues to expose only permitted MCP
routes; it does not publish the local operator dashboard.

## Validation and delivery

Normal development Version 25: `01a076af-0f9c-7b51-8127-f12fc0025da1`.
Migration preserved the existing 115 calls and 1,119 events; reviews were backfilled
from saved callback/failure facts. Later integration checks add their own labelled calls.

- `npm test`, `npm run typecheck`, `npm run build`.
- M3–M5 SQL migrations and all transition suites in disposable PostgreSQL; CI
  includes the new operator tests alongside OTP, negotiation, booking and interest.
- `npm run verify:mcp -- --operator-review`: real FMCSA, demo OTP gates, TMS read,
  general callback/error reviews and idempotent finalization. Creates its own
  integration-test call, cancels its provider run, and sends no booking/callback.
- Browser checks cover direct access without cookies, real lanes, source filters, call details, notes,
  review/reopen, timeline and desktop/mobile layout. See `docs/m5-mcp-evidence.json`.

HappyRobot Apps placement, production/cloud deployment, real OTP delivery and
full provider-end reconciliation remain separate delivery work; this local operator
increment does not claim those requirements are complete.

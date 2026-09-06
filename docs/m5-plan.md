# M5 implementation plan — first operator view

Status: first implementation delivered, 6 September 2026. The approved scope was expanded to include callback/human/other review requests, technical-error capture and audited operator review actions. See [operations guide](operations.md) for current behavior, rollout and remaining scope.

## Product direction

Keep the existing Next.js application and backend. Use the reference at
http://127.0.0.1:5173/?mock=1 for interaction ideas: a compact demo-call banner,
lane coverage and an inspectable calls table. Build our own components and connect
them to real TMS/Twin data. Do not copy the reference application, fixtures or
backend. Its preview metrics and sentiment are not evidence about our calls.

Separate the caller experience from operator information. The demo banner is the
only caller-facing area. The operator dashboard is visually separated below it;
the user requested direct access without an operator login. Server-only Twin credentials
and same-origin review-write checks remain in place.

## First increment: three visible components

### 1. Demo call banner

- Primary action: Start demo call. During a call: mute/unmute and End call.
- Always-visible demo cues: MC **135797**, departure **Salt Lake City**, suggested
  counter **$2,700 total**. The caller says these to the agent; the frontend does
  not pre-verify the carrier, inject an agreement, or fix the final accepted rate.
- Place the OTP directly beside the call controls on desktop, immediately below
  them on mobile. Show it only when the current call has a pending matching
  challenge; clear it after verification, call completion or a new call.
- Show brief audio states and actionable microphone/connection errors. Remove the
  carrier-approved/OTP-verified/load-search checklist from the caller area.
- A single Start another demo call action replaces the existing two-step restart.
  Preserve duplicate-start guards and safe termination of the previous run.
- Keep demo delivery disclosure small and close to the code. Detailed booking,
  verification, negotiation, callback and handoff records belong to the operator
  view. Current simulated-booking mode remains unchanged.
- The Salt Lake City/$2,700 script is a suggested scenario. Inventory and the
  agent's response remain live; do not guarantee availability or acceptance.

### 2. Lane coverage map and load list

- US map with origin/destination points and connecting lane lines. No animated
  trucks or claims of live vehicle positions.
- Network scope: all US origin states, defaulting to all equipment and statuses.
  Salt Lake City remains only a demo-call cue. Display retrieval time and explicit
  partial-coverage warnings when a state query fails or reaches the TMS result cap.
- TMS supplies load ID, origin/destination city/state/ZIP, equipment, pickup,
  listed rate and availability. Preserve OPEN, PENDING and any other returned
  status rather than interpreting PENDING as our carrier's booking.
- Resolve city/ZIP locations through a local, attributed geographic lookup. These
  are approximate lane endpoints, not GPS positions or driving routes. Loads
  without a reliable match remain in the list and count as unmapped.
- Color lanes by TMS availability. Selecting a lane highlights its load rows;
  selecting a row highlights the lane. Group shared endpoints but retain distinct
  load IDs and statuses in details.
- Overlay Twin information as separate badges: simulated booking, confirmed real
  booking, unresolved attempt or callback requested. A simulated booking must not
  turn a real OPEN TMS load into BOOKED.
- Show the associated MC/carrier only when Twin records a relationship to that
  load. TMS inventory alone is not a carrier-tracking feed.
- Cache bounded read requests briefly; auto-refresh Twin state independently so
  each dashboard poll does not issue another TCP inventory scan. On upstream
  failure, retain the last good snapshot with an explicit stale indicator.

### 3. Recent calls with inline detail

- Columns: time, carrier/MC, lane/load, business outcome and agreed rate.
- Tabs: Recent / Needs attention. Include unfinished calls, not just finalized
  ones. Separate automated evaluation activity from browser demo calls using
  explicit provenance; do not infer provenance from a simulated booking alone.
- Needs attention initially identifies unknown booking outcomes, stale booking
  attempts, pending-load callback requests and calls requiring end-state review.
- Expand a call to see its summary, negotiation rounds, booking/reference or
  callback request, and an ordered timeline of recorded events. Label an
  agent-written summary separately from persisted facts.
- A call without finalization is shown as not finalized/end state unknown unless
  provider evidence establishes the ending. No fabricated completion time or
  assumption that silence means hangup.
- Refresh the call list after the demo ends, with light polling while the
  dashboard is visible. A selected historical call must not reset the active
  voice session.

## Implementation sequence

1. Refactor `apps/web/src/features/carrier-verification/carrier-check.tsx` into a session-owning wrapper and compact demo
   area; reuse `apps/web/src/features/voice-call/voice-call.tsx`, the existing cookie-bound endpoints and OTP
   lifecycle. First review checkpoint: the call and nearby code work with the
   simplified presentation before adding the map.
2. Add a small operator service and read endpoints for inventory,
   calls and call details. Use Twin functions that return allowlisted fields;
   exclude session hashes, OTPs, private pricing and credentials. Persist only
   missing public lane snapshots/provenance through an additive migration.
3. Build the map and matching load list over that inventory contract. Add the
   Twin outcome badges without overriding the TMS status.
4. Add the recent-call table and detail panel. Reuse the same selected-load/call
   identity across the table and map. Keep all business state in existing Twin.

No new voice-agent MCP tool was added. `finalize_call` now accepts optional review reason/note and callback number/consent. Existing outcome and summary callers remain compatible; the database preserves business outcomes separately from the reported call ending. The operator read model exposes saved results and missing-finalization reviews without rewriting historical outcomes.

## Follow-on scope and delivered operational actions

- Record the call ending separately from the business result. Preserve the
  caller/agent's reported end reason and distinguish provider-confirmed endings.
- Reconcile terminal provider runs that lack finalization through a trusted,
  idempotent backend operation, including expired sessions. Keep a confirmed
  booking confirmed even when a call was interrupted. Add durable failure events
  where relevant failures currently exist only in application logs.
- Add review notes and evidence-backed resolutions with an audit trail. Separate
  callback follow-up status from booking state. Marking a request reviewed does
  not notify the carrier or retry a booking.
- Add three compact metrics after their sources/denominators are defined: calls,
  confirmed real bookings, and open reviews. Show simulated demo outcomes
  separately. More charts and sentiment are deferred.

This increment includes the operator review actions, durable tool-result errors and separate end evidence. Full automatic provider-run reconciliation and aggregate metrics remain follow-on work. HappyRobot Apps deployment,
real OTP delivery and cloud deployment proof remain explicit challenge-delivery
requirements; a local UI alone does not fulfill them.

## Acceptance for the first increment

- Start, mute, end and restart a demo without duplicate provider runs; verify the
  code remains beside the controls and disappears at the correct lifecycle points.
- The caller area contains no verification checklist or diagnostic records.
- Map/list agree with the same real TMS response, including PENDING loads,
  result limits, stale data and unmapped endpoints.
- A simulated booking appears in Twin/call detail but does not change live TMS
  availability or count as a real booking. Callback requests appear for review.
- Call outcomes, rates and timeline entries match Twin. Missing facts remain
  missing; the UI does not infer carrier assignment or successful finalization.
- Operator data loads without a password or cookie; responses contain no OTP,
  private pricing or session credentials. Carrier call gating remains unchanged.
- Verify desktop and mobile layouts, keyboard selection and empty/error states.
  Use existing backend coverage and add focused tests for new read contracts and
  map/status composition. Browser-check actual interactions and console errors.

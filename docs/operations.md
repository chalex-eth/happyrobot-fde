# Operator dashboard

The local dashboard opens at http://localhost:3000 behind a shared password
gate. This is a lightweight access boundary for the private demo, not an
individual identity or enterprise authentication system. A Demo environment
label identifies the workspace.

For component ownership and persistence guarantees, see the
[architecture](architecture.md).

## What it shows

- TMS lane coverage across US origins, with city, equipment, and availability
  filters. Coordinates are approximate city centers.
- Booking and follow-up records, defaulting to Needs attention.
- Carrier, MC number, lane, load, agreed rate, booking status, and open review
  reasons.
- Review details including TMS pickup/delivery data, equipment, rates, callback
  information, and negotiation history.

The dashboard may read all available projection pages before calculating local
counts. TMS coverage can be partial when an upstream state query fails or hits
the result cap; partial data is labelled and is not treated as zero inventory.

## Review actions

Operators can complete or reopen individual reviews with a required note.
Revision checks reject stale changes and every successful update is audited.
Review actions do not call a carrier, change a booking, retry TMS, or send a
notification.

Review reasons include callback requests, human requests, other requests,
technical failures, failed voice sessions, uncertain or failed bookings, and
missing finalization. Incorrect OTPs and expected verification denials are not
technical failures.

Callback requests require a confirmed E.164 number and explicit caller consent.
The application records the request but does not promise a callback or contact
the carrier.

## Manager approval

Saved simulated booking requests enter Awaiting approval. The operator can:

- Approve & book, which creates a stable local submission reference.
- Request changes, with an explanation.
- Reject, with a comment.
- Add comments without changing the decision.

Approval and review closure are atomic and idempotent. The local adapter does
not send a TMS booking request. Confirmed real TMS bookings cannot be approved
through this workflow.

## Truth and limitations

- Booking mode is mock in the local Docker stack. Confirmed demo bookings are
  labelled simulated and leave TMS inventory unchanged.
- Senior-representative follow-up is a review state, not proof of contact.
- No outbound callback, notification, document collection, sentiment analysis,
  transcript analysis, or provider reconciliation runs in the background.
- Operator access is shared: everyone with the password receives the full demo
  surface. There are no individual manager identities or role controls.

## Enabling the operator surface

The API must have OPERATIONS_ENABLED=true and a valid server-only
OPERATOR_RPC_KEY. It must also have OPERATOR_PASSWORD and a random
OPERATOR_SESSION_SECRET of at least 32 characters. Register only the RPC key's
SHA-256 digest in Twin. The configured Twin workspace must already contain the
operations schema; do not replay the fresh Drizzle baseline on shared data.

After changing configuration:

~~~sh
npm run app:restart
npm run local:check
~~~

Keep the operator password, session secret, and RPC key out of browser code,
logs, commits, and MCP results. FMCSA requests still require the provider's
webKey query parameter, so application diagnostics redact it; also configure
proxy/access logs and secret rotation outside the application.

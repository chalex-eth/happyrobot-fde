# Test plan — scaffold plus pending acceptance

## Runnable now

- Unit: money rejects fractions/unsafe values; primitive identifier validation.
- Integration: route placeholders fail closed, require bearer auth, separate
  gateway and manager credentials, never claim feature success.
- Browser: static page renders without page errors; protected API paths reject
  unauthenticated callers. Production build required first.
- Tooling: ESLint, strict TypeScript and standalone Next.js build.

These tests validate repository plumbing, not external provider contracts.

## Pending milestone suites

1. TMS contract/fault server: CRLF, END, frame size, padding, empty results,
   explicit rejection, timeout, truncation, delayed close and one read retry.
2. Twin: round trip, conditional writes, unique intents, replay/concurrency,
   terminal-state immutability and failures before/after external mutations.
3. FMCSA: active/inactive/out-of-service/unknown/malformed carriers and outages.
4. OTP: delivery, expiry, replay, attempts, resend, destination substitution,
   secrecy and blocking all load tools before verification.
5. Negotiation: lane/equipment matching, complete public fields, three rounds,
   duplicate offers, private ceilings and adversarial price probing.
6. Booking: one send, explicit rejection versus uncertainty, complete success,
   concurrent duplicates and Twin failure after TMS acknowledgement.
7. MCP/App: discovery, content negotiation, Host/Origin, separate concurrent
   clients, authentication, dashboard states and protected-field inspection.
8. Voice: Prompt Playground/Web Call, interruptions, third-round closure,
   no-match recovery, tool timeouts and mocked handoff only after reservation.

## Test execution boundaries

Fakes and fault servers belong in tests/support. No runtime fallback. Local tests
must not send real OTPs or mutate TMS. Live booking needs an explicit review of
carrier, load and rate. Dry-run evidence cannot establish successful reservation.
Record sanitized commands, versions, expected/actual result, timestamp and gate
decision. No OTPs, credentials, private rates or raw provider dumps in evidence.

## Acceptance metrics

North star: completed TMS reservations followed by mocked handoff divided by
OTP-verified eligible calls reaching matching. Guardrails: zero state bypasses,
private-price leaks and duplicate bookings; complete terminal call records.

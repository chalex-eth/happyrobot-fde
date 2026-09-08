# HappyRobot agent runbook

This is the short operating guide for changing and validating the HappyRobot
development workflow. Read it before changing the prompt, MCP tools, workflow
bindings, or native conversation tests.

For the evaluation design and backend-session mechanics, see
[testing strategy](tests.md). This runbook covers execution procedures.

## Source of truth

| Concern | Source |
| --- | --- |
| Agent prompt and tool descriptions | scripts/happyrobot/workflow-spec.ts |
| MCP schemas and dispatch | apps/api/src/transport/mcp/tools.ts |
| Business behavior | apps/api/src/modules |
| Normal workflow connector | scripts/happyrobot/mcp-connect.ts |
| Native test controllers | scripts/happyrobot/run-adversarial.ts and run-negotiation.ts |
| Test definitions | tests/happyrobot |
| Operator call outcomes and flow branches | [Architecture: booking and follow-up](architecture.md#booking-uncertainty-and-human-follow-up) |

## Normal integration

Normal calls use the authenticated /api/mcp endpoint and the saved development
MCP connection. Every MCP Call action must send:

    x-happyrobot-run-id <- Current > Run ID

The backend resolves that run to the authenticated Twin call. Do not expose the
adversarial route or its credentials to the normal workflow.

The current business sequence is:

1. verify_carrier
2. create_otp, then verify_otp
3. search_loads, with a city alone accepted
4. get_load for a load returned by the latest search
5. accept_offer, counter_offer, or reject_offer
6. book_load for an agreed load, or record_load_interest for a pending load
7. finalize_call

The eleven current tools are defined by the API schemas. Keep OTPs, private
pricing ceilings, session hashes, and internal credentials out of results and
spoken responses. An agreed booking is distinct from a confirmed TMS booking;
the local mode saves a simulated booking and does not send LOAD_BOOK.

## Environment profiles

Keep the normal local and Docker stacks on `.env.local` and
`.env.docker.local`. Adversarial and negotiation controllers load the ignored
`.env.eval.local` overlay, which enables the private route and supplies its
separate token. Do not load that overlay for the normal workflow.

The optional email OTP path is documented in `.env.email.example`; load a
local copy only when testing email delivery. The default demo remains mock OTP
delivery.

## Safe workflow changes

Run commands from the repository root and keep the target in development:

~~~sh
npm run happyrobot:mcp -- dry-run
npm run happyrobot:mcp -- connect
npm run happyrobot:mcp -- fork --version SOURCE_VERSION_ID
npm run happyrobot:mcp -- sync --version DRAFT_VERSION_ID
npm run happyrobot:mcp -- inspect --version DRAFT_VERSION_ID
npm run happyrobot:mcp -- review-results --version DRAFT_VERSION_ID --whole-result
npm run happyrobot:mcp -- publish --version DRAFT_VERSION_ID --replace LIVE_VERSION_ID
~~~

Use rewire when a fork needs to be converted back to the normal MCP
connection:

~~~sh
npm run happyrobot:mcp -- rewire --version DRAFT_VERSION_ID
~~~

Before publication:

- Work only on an explicit unpublished draft.
- Refresh or connect the normal MCP credential first.
- Validate every tool mapping against persistent tool IDs.
- Confirm the Current > Run ID header and complete result visibility.
- Read back the stored prompt and tool configuration.
- Publish only to development, explicitly replacing the intended version.

Never edit the live version in place, publish an isolated test draft, or use a
normal workflow draft for adversarial tests.

## Native tests

Native tests are serialized because they provision private caller sessions and
temporary OTP delivery. Use the controllers, not the HappyRobot UI Run action:

~~~sh
npm run test:adversarial -- setup --source-version SOURCE_VERSION_ID --mcp-url TEST_MCP_URL
npm run test:adversarial -- run --all
npm run test:adversarial -- run --test PV01
~~~

Negotiation tests use their own unpublished draft and controller:

~~~sh
npm run test:adversarial -- setup --negotiation --source-version SOURCE_VERSION_ID --mcp-url TEST_MCP_URL
npm run test:negotiation -- setup
npm run test:negotiation -- run --test N01
~~~

Test credentials and the adversarial route are separate from normal calls.
Controllers restore caller prompts and revoke temporary capabilities during
cleanup. If cleanup is uncertain, keep the controller lock and investigate it.

Evidence is written to ignored tmp/evidence output. It is diagnostic only:
completion, automated grades, or a generic success response do not prove that a
real backend action occurred. Require a sanitized backend trace and inspect the
saved state. Native tests do not prove microphone or TTS quality.

## Safety rules

- Do not print credentials, OTPs, full SDK errors, private pricing, or raw TCP
  frames.
- Do not invent TMS inventory, dates, load IDs, rates, or booking references.
- TMS reads require a complete response ending with END. DEBUG_ECHO is only a
  transport check.
- Booking writes are single-attempt operations. An unknown result is uncertain;
  never retry automatically.
- Do not replay the fresh database baseline against shared Twin.
- Run tests and workflow controllers sequentially.

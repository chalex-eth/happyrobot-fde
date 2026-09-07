# Carrier sales — local POC

**Current branch:** backend persistence uses Drizzle and the Twin SQL API with `TWIN_API_KEY`. Its fresh baseline has not been applied to shared Twin. Complete the separate schema/data/credential rollout before restarting this branch against that database. See [architecture](docs/architecture.md).

## One-command local startup

With Docker Desktop running, use `npm run local:up`, then open **http://localhost:3000**. This starts the web app, API, MCP proxy and stable ngrok tunnel, then verifies the HappyRobot development connection. Use `npm run local:down` to stop them. See [Docker setup and troubleshooting](docs/local-docker.md) for one-time configuration.

Dated rollout notes below are historical; use the agent runbook and live checks for current development state.

Next.js local POC with real TMS, FMCSA authority checks, Twin call state and an OTP gate. The current local configuration uses a clearly labelled screen-delivered mock OTP so the demo can proceed without email or SMS. Real email delivery remains pending. See [OTP setup and demo flow](docs/otp-setup.md).

## Run

```sh
nvm use
npm ci
# Fresh checkout only: copy .env.example to .env.local and fill the values.
npm run dev
```

Open http://127.0.0.1:3000. The independent API listens on port 3001. The local console automatically uses `.env.local` on the server. No token entry is required and no credential is embedded in browser JavaScript.

Start a voice call, give your MC number, then dictate the demo code displayed on screen. After verification, describe a route or pickup preference. Search includes all equipment types unless you specify one (dry van, flatbed, refrigerated, etc.). Email/SMS delivery is simulated; generation and verification share one retry per call, with no OTP expiry. The second failure ends verification.

## Checks

```sh
npm test
npm run typecheck
npm run build
# In a second terminal, while npm run dev is running:
npm run verify:local
```

`verify:local` sends real read-only requests and checks authentication, input rejection, trace headers, and public-field filtering. The challenge TMS intentionally injects faults; exhausted retries fail the check rather than being treated as a pass. Set `LOCAL_BASE_URL` for a different loopback port. Verification refuses non-local destinations and redirects.

`npm run start:local` serves the production build for authenticated API testing; the automatic local console requires `npm run dev`.

## Request flow

```text
Local browser → pending Twin call + opaque session cookie
              → authority check → same Twin call, fresh authority revision
              → frontend mock OTP → hashed Twin challenge
              → verify OTP → atomic Twin verification for the rest of the call
              → load request → server rechecks saved authority and OTP
                             → TCP TMS → recheck gate/revision → safe JSON + saved load IDs
```

The local convenience route is enabled only by `npm run dev`, which binds to loopback, and requires a matching loopback Origin/Host. Production builds disable it. The separate `/api/tms` endpoint still requires Bearer authentication and supports `DEBUG_ECHO`, `LOAD_QUERY`, and `LOAD_GET`. Each TCP attempt has a four-second deadline, with at most one retry for transient read failures. Private rate ceilings, unknown fields, and operator free text are excluded from responses. Logs contain status, command, timing, and request ID rather than credentials or raw frames.

The local search/detail route enforces authority and OTP. A carrier recheck preserves call identity and spent OTP failures but clears verification and load selection. Details require a load returned by that call’s search. The operator view polls the saved call every five seconds. The bearer-protected `/api/tms` is a privileged operator diagnostic and must not be exposed directly as a carrier agent tool. Managed HappyRobot authentication/tool wiring and booking are still pending.

## Workspace structure

- `apps/web`: Next.js pages, feature UI and a same-origin API proxy.
- `apps/api`: independent Node HTTP/MCP server, business modules, integrations and Twin access.
- `packages/contracts`: shared Zod schemas and inferred public types.
- `apps/api/db`: ordered SQL migrations, generated schema tooling and database tests.
- `scripts/happyrobot`: workflow configuration and conversation controllers.

See [architecture and local database generation](docs/architecture.md) for ownership and commands. Run `npm run check:boundaries`, `npm run db:check` and `npm run db:test` locally. There is no CI workflow. The application persists only through Twin.

## Carrier authority lookup (M2a)

Enter an MC number in **Carrier authority**, then click **Check carrier**. `1515`, `MC-1515`, and `mc 1515` normalize to the same lookup. The server uses `FMCSA_API_KEY` from `.env.local`; no token entry is needed.

The check implements the PDF requirement for active operating authority: one identifiable carrier, explicit permission to operate, and active common or contract carrier authority. An omitted out-of-service field is displayed as “Not provided” and is not an additional approval requirement. Explicit restrictions prevent approval; contradictory permission/restriction data requires review. Missing required permission/authority fields, broker-only authority, and ambiguous records cannot pass. Only an explicit empty carrier list means not found; HTTP errors and malformed data mean verification was unavailable. The adapter uses a six-second deadline and one request per click, without automatic retries or fallback carrier records.

Live verification (2026-09-05): after the user enabled a US VPN, FMCSA returned HTTP 200. MC 133654 (LESTER MOVING & STORAGE COMPANY) reports `allowedToOperate: Y`, `commonAuthorityStatus: A`, and `contractAuthorityStatus: N`, with `outOfService` omitted. The updated local endpoint returns `eligible / ACTIVE_CARRIER_AUTHORITY`. The official MC 1515 example also returned active authority; MC 99999999 returned an empty list. Earlier non-VPN requests returned HTML 403 from an AWS load balancer. This suggests source-network filtering; verify access again from the eventual hosting environment. Regression fixtures stay in tests and are never used as application fallback data.

Reproduce after service access is available, with the dev server running:

```sh
npm run verify:fmcsa -- MC-133654
```

The script exits unsuccessfully for service errors or inconclusive authority data. The number above passed the live authority check on 2026-09-05; future results may change. The route now persists results in Twin, so Twin configuration and the OTP schema are also required. Reloading the browser recovers the call through its HttpOnly session cookie.

Protocol sources: [FMCSA QCMobile API](https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi), [API access](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess), and [operation/out-of-service fields](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiElements). The adapter accepts the documented `allowToOperate` and the reference implementation's `allowedToOperate` spelling; conflicting values fail closed. The live response confirmed the `content[].carrier` envelope, `allowedToOperate`, and common/contract authority fields. The passing decision does not claim that an omitted out-of-service field explicitly reported No.

The frontend now includes **Start voice call**, **Mute / Unmute microphone**, **End call**, connection status and an **Enable audio** fallback when browser autoplay is blocked. The development workflow is published. Start creates a pending Twin call if needed; the server binds the provider run before returning a scoped WebRTC token. Allow microphone access when prompted. End disconnects local audio and asks HappyRobot to cancel only the bound run. Use **Start new call** for a fresh conversation; reload does not resume old audio.

Real API token creation, Twin run resolution and cancellation are verified. The user confirmed that the browser call connects and the agent is audible. The six MCP tools are now wired in FDE Challenge Version 5, published to development. The complete spoken flow is ready for user acceptance. See [the voice plan](docs/voice-agent-plan.md).

The authenticated `/api/mcp` endpoint is connected through an approved ngrok tunnel and MCP-only proxy. HappyRobot discovered all six tools; real FMCSA, frontend mock OTP, TMS search/detail, finalization and duplicate protection passed through the public endpoint. Shared Twin is upgraded. Keep Next, the proxy and tunnel running for calls. See [local MCP setup and acceptance](docs/mcp-local.md); `npm run verify:mcp` runs a separate integration test without microphone audio.

The UI now follows the voice conversation: the agent checks the MC number, calls `create_otp`, and the code appears automatically for the caller to dictate. Search includes all equipment types unless the caller specifies an equipment filter. Manual carrier, OTP and search forms are removed.

## M3.5 negotiation (active in development)

The approved Twin migration is applied, NEGOTIATION_ENABLED=true locally, and Version 5 is live in development. Backend negotiation enforces private pricing, call-wide three-round limits and duplicate-response protection. Live acceptance and three-round failure checks pass. See [implementation and activation](docs/negotiation.md) and [all milestone 3 validation scenarios](docs/milestone-3-validation.md). Start a fresh call for spoken acceptance. No load booking or transfer is implemented yet.

## Native adversarial OTP checks

Eight core tests use unpublished Version 9 with fresh backend sessions and private caller-only codes where required. Run all eight sequentially with `npm run test:adversarial -- run --all`, or select one with `--test PV01`. PV07 and PV17 inject scoped authority and demo-delivery failures; the other six use no service fault injection. The 14 approved secondary definitions were soft-deleted, preserving their original records locally. The resulting conversations and audits appear in HappyRobot. See [setup, limitations and evidence](docs/adversarial-e2e.md).

## M4 booking

Development Version 14 and the local Docker app now enable the real TMS booking tool, durable Twin attempt tracking and a recorded mock handoff. The M4 migration is applied. Local tests and real verification/agreement smoke pass; actual TMS booking and spoken booking acceptance remain untested. Booking defaults off in fresh configurations until migration and workflow rollout. See [booking scope and activation](docs/booking.md). An agreement alone remains distinct from a confirmed booking.

# Hosted demo on Vercel

The deployment serves the existing demo with a normal HappyRobot production
workflow. FMCSA and TMS reads are live; OTP delivery is on screen, bookings and
manager submission are simulated, and no callback or notification is sent.

## Hosting

`vercel.json` defines a Next.js web service and the existing Node API service.
Both use US East (`iad1`). `/api/*` and `/health` route directly to the API;
other paths route to Next.js. The localhost web proxy remains useful locally.
Each service installs the root npm workspace, including build dependencies.
Node 22 is required. Inventory scans have a 50-second total budget and report
incomplete coverage if they cannot finish; cached inventory is process-local.

The dashboard requests up to 1,000 call summaries at once and prevents overlapping
refreshes. Unchanged reviews do not trigger a second history scan. Twin requests
retry only explicit HTTP 429 refusals, at most twice within a 10-second total
budget while respecting `Retry-After`. Network failures and 5xx responses are
never automatically replayed because a database write may have committed.

The project is `chalexlab/happyrobot-fde`, connected to GitHub with production
branch `main`. The stable domain is `https://happyrobot-fde.vercel.app`.
Development Docker and ngrok are not production dependencies.

## Configuration

`.env.production.example` lists the required settings. Values belong in Vercel
environment settings and an ignored `.env.production.local` used by release tools.
Never upload environment files or log secrets. `.vercelignore` excludes them.

Keep `NODE_ENV=production`, `HOSTED_DEMO_ENABLED=true`, mock OTP and mock booking.
The runtime rejects hosted mode with live booking or adversarial MCP enabled.
`APP_PUBLIC_URL` must be an exact HTTPS origin. The current deployment's Vercel
URL is also accepted; arbitrary preview domains are not trusted.

The demo uses a shared operator password. Its signed, secure, HttpOnly cookie
covers `/api`, protecting both operator endpoints and browser call endpoints.
The separate caller cookie binds the current call. MCP uses its own bearer token
and the HappyRobot run ID, not browser cookies. Public deployment access must
allow HappyRobot to reach `/api/mcp` without an interactive Vercel login.

The existing Twin schema and operator RPC key are reused. Local/evaluation and
hosted-demo records therefore share this workspace; this is not tenant isolation.
Do not reset Twin during a deployment. User records and mutation receipts must
survive process restarts and app rollbacks.

## Release

1. Run `npm test`, `npm run typecheck`, `npm run check:boundaries`, and `npm run build`.
2. Set the Vercel project to Node 22 and `iad1`; load the production environment.
3. Deploy with `npx vercel@59.11.7 deploy --prod --scope chalexlab` or push reviewed
   changes to `main` after the first successful configuration.
4. Verify `/health`, browser login, denied unauthenticated requests, Twin operator
   access, FMCSA and live TMS reads from the deployed API.
5. Follow the [agent runbook](happyrobot-agent-runbook.md#hosted-demo-production) to
   connect, fork, rewire and publish the normal agent in production.
6. Run `node --env-file=.env.production.local scripts/verify-production.mjs`.
7. Complete a real microphone call and check the provider run, MCP trace, screen
   OTP, simulated booking, operator review and call-end state.

The production verifier creates a dedicated browser call and real HappyRobot run,
then invokes the deployed normal MCP tools. It verifies a simulated booking and
operator state, and attempts to cancel its own provider run. A voice token without
an audio participant can leave the provider run absent (404); cancellation then
remains unconfirmed. It does not connect audio and
does not establish speech quality or provider hangup behavior.

## Recovery

Use the Vercel deployment history to restore the last verified application
deployment. Restore the matching normal HappyRobot production version separately;
an app rollback does not roll back the agent or its saved MCP connection. On a
first-release failure, disable hosted demo access and unpublish only the new
production agent. Never reset the database or retry an uncertain booking write.

Keep the release commit, deployment URL, agent version and sanitized verification
result in ignored `tmp/evidence/production/`. Credentials and OTPs must not appear
in diagnostic output. An unconfirmed provider ending remains unconfirmed.

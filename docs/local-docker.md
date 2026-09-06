# One-command local development

From the repository root, with Docker Desktop running:

```sh
npm run local:up
```

Open **http://localhost:3000**. The command builds the current source, starts the three containers, waits for app/proxy readiness, discovers the eight tools over the public HTTPS endpoint, and checks the live HappyRobot development version. It exits unsuccessfully if the saved connection, tool bindings, or run header do not match. The check never creates a call or publishes a workflow. A failed check leaves the containers running for diagnosis.

```sh
npm run local:status  # Container status
npm run local:check   # Repeat public MCP discovery and live workflow checks
npm run local:logs    # Follow recent service logs; Ctrl-C stops log viewing
npm run local:down    # Stop this stack and its tunnel
```

To keep the tunnel running while working on the app:

```sh
npm run app:stop      # Stop only the app; keep ngrok and the proxy running
npm run app:restart   # Rebuild/recreate only the app, then verify the connection
```

Start the full stack once with `local:up`. `app:restart` applies current source and environment changes without restarting the proxy or ngrok. During an app stop/restart, the public URL stays the same but MCP tool calls fail until the app is healthy again. The proxy may show unhealthy while the app is stopped; it recovers when the app returns. Your Mac and Docker must remain running to keep this local tunnel online. Use `local:down` only when you also want to stop the tunnel. These commands use the normal configuration, not the optional evaluation overlay.

`local:up` is also the command to apply source or environment changes. It uses the Docker build cache. Ordinary restarts reuse the same ngrok domain and saved HappyRobot credential. Docker restarts the containers after a daemon restart unless they were explicitly stopped; run `local:check` to verify the external configuration again.

## One-time configuration

The current machine uses its existing `.env.local` plus an ignored `.env.docker.local`. Credentials are injected at runtime and excluded from the Docker build context. The ngrok token is only passed to the ngrok container. Do not commit either file or paste the output of `docker compose config` (without `--quiet`), which can contain expanded secrets.

For another machine:

1. Install Docker Desktop and Node 22. Copy `.env.example` to `.env.local` and fill the existing service credentials. Use `HAPPYROBOT_ENVIRONMENT=development`, `OTP_DEMO_MODE=true`, `OTP_DELIVERY_MODE=mock`, and the negotiation setting appropriate to the existing Twin workspace. Do not rerun shared migrations.
2. Copy `.env.docker.example` to `.env.docker.local`. Set `NGROK_DOMAIN` to the hostname assigned to your ngrok account and `NGROK_AUTHTOKEN` to that account's tunnel token.
3. Set `MCP_PUBLIC_URL=https://NGROK_DOMAIN/api/mcp` in `.env.local` using the actual hostname. Set `HAPPYROBOT_MCP_SERVER_NAME` to the saved normal development MCP connection's name.
4. The saved HappyRobot connection must use the same URL/token, and the live development version must use it on every Tool/MCP Call pair with `x-happyrobot-run-id` mapped to **Current > Run ID**. Provisioning or changing that connection is a separate explicit operation using the [agent runbook](happyrobot-agent-runbook.md); startup does not rewrite HappyRobot configuration.

The stable domain configured for this checkout is `nonissuably-overgreasy-georgiann.ngrok-free.dev`. It is already assigned to the user's ngrok account; no paid domain was purchased.

As checked on 6 September, development uses **Version 18: Local app — normal MCP restored**, connection **Carrier sales Docker development MCP**. This replaces isolated Version 16, which had caused HTTP 404 on normal app calls by pointing to the disabled `/api/mcp/adversarial` route. Exact IDs and validation scope are recorded in [repair evidence](mcp-repair-validation.json); [original Docker rollout evidence](local-docker-validation.json) describes the earlier seven-tool Version 13. Start a fresh app call after changing the live version.

## Services and boundaries

```text
Browser → localhost:3000 → app (web) → api:3001
HappyRobot → stable HTTPS domain → ngrok → mcp-proxy:3002 → api:3001/api/mcp
```

- `app`: Node 22 / Next development server; host port 3000 is bound only to `127.0.0.1`. Development mode is required by the local console and screen OTP. This is a local demo, not a production deployment.
- `api`: independent Node HTTP/MCP server; owns all integration credentials and Twin calls, with no published host port.
- `mcp-proxy`: private container port 3002, reachable by ngrok through Docker service DNS. Only exact `/api/mcp` is exposed in this stack; cookies and unrelated headers are stripped. The proxy itself has no application credentials.
- `ngrok`: fixed account domain, inspection disabled, diagnostic API bound to host `127.0.0.1:4040`. The image is pinned by digest. The endpoint requires `MCP_AUTH_TOKEN` independently of ngrok authentication.
- HappyRobot, Twin, FMCSA and the TMS remain external dependencies. This Compose project does not start or migrate a database. Any VPN/network access those services require must also work from Docker Desktop.

The normal stack explicitly disables adversarial sessions and the proxy's adversarial path. Native conversation evals still use their separate controller and test draft; do not publish those drafts for browser calls. Stop this Compose stack before reverting to the manual dev/proxy/tunnel commands, since ports 3000 and 4040 would conflict. Never kill unrelated containers or remove an active evaluation lock.

## Verification and limitations

`local:check` is read-only: public authenticated discovery plus remote configuration checks. It validates every tool's credential, the action credential, the Current Run ID header, and argument references against persistent tool IDs. It does not prove microphone/TTS quality or full agent conversation behavior.

For an explicit real backend smoke test, run:

```sh
docker compose --env-file .env.local --env-file .env.docker.local exec -T api \
  node --import tsx scripts/verify-mcp.ts --city-first
```

This creates and finalizes its own Twin call, creates/cancels its own provider run, and exercises real FMCSA, OTP and TMS queries through ngrok. It does not negotiate or book. Evidence is written inside the API container at `/app/docs/city-first-mcp-evidence.json`; copy it out before recreating the container if needed.

For a production-build compatibility check, use an isolated container so build files do not interfere with the running dev server:

```sh
docker run --rm -e NODE_ENV=production carrier-sales-local:dev npm run build
```

If the startup check fails, read the specific error and inspect `local:status` / `local:logs`. Common causes are occupied host ports, a stopped Docker daemon, an unavailable domain/token, a changed HappyRobot live version, or a workflow still using an isolated test connection. A running container alone is not a verified integration.

## Simulated booking in local tests

The API service pins `BOOKING_TMS_MODE=mock`. `book_load` saves a simulated booking in Twin and never sends `LOAD_BOOK`; real TMS searches and OPEN-load checks continue. Mock confirmation uses a `MOCK-…` reference and the final disposition `booking_simulated`. Restart with `npm run app:restart` after changing application code. Existing PENDING inventory is not reset.

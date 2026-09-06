# Workspace refactor validation — 2026-09-06

Branch: `codex/workspace-twin-refactor`. See [architecture](architecture.md) for module ownership, local commands and deployment configuration.

| Check | Result |
| --- | --- |
| `npm test` | 94 tests passed, including existing business behavior, HTTP/MCP boundaries, nested Twin response validation and the streaming web proxy |
| `npm run typecheck` | API, web, shared contracts and operational scripts passed |
| `npm run check:boundaries` | Workspace and business-module imports passed |
| `npm run db:test` | Eight SQL transition suites, three concurrent mutation checks and a real PostgreSQL RPC contract sequence passed |
| Migration preservation | All ten moved SQL migrations are byte-identical to their originals |
| Generated schema | Seven tables and ten public RPC signatures match the migration catalog |
| `npm run build` | API bundle and Next production build passed |
| Docker | Isolated image built; separate web/API containers served the UI, forwarded a same-origin session request, rejected a foreign origin and required MCP authentication |
| Browser | On isolated ports 3100/3101, the UI loaded 50 real TMS loads and 117 Twin call records; city filtering and call details worked; no console warnings or errors were observed |

Database checks used disposable PostgreSQL containers without shared database credentials. They did not apply migrations to Twin. The browser check used existing read paths; it did not start a new voice call or book a load. Native HappyRobot conversation evaluations were not rerun, and remote workflow/deployment state was not changed.

The Docker smoke test used an isolated image, network and containers; these containers were removed afterwards. The existing local demo stack was left running. No CI workflow is configured; all checks above were run locally.

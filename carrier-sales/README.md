# HappyRobot carrier sales

Local, single-app scaffold for the specification-first implementation plan.
This directory lives in the existing HappyRobot FDE Git repository; it is not
a monorepo and has no nested Git repository.

## Start

Use Node 22 (at least 22.12) and pnpm 10.34.5.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. No credentials are required for the static placeholder.
For local API checks, create an ignored .env.local using the names in .env.example.
Bearer tokens must be at least 32 characters. Never put a server token in client code.

## Verify

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

The E2E suite starts the production build on port 3100 with test-only credentials.
Run pnpm build first if the build is missing. Tests do not contact live providers.
pnpm check covers lint, strict type checking, Vitest and the production build;
it does not claim live integration, browser, Docker or deployment acceptance.

## Docker

```sh
docker compose up --build
```

The multi-stage image runs as a non-root user. It serves the public placeholder;
API routes remain unavailable without runtime credentials. This is a local
container scaffold, not proof that HappyRobot hosting supports outbound TCP.

## Boundaries

- app/: pages and Node-runtime route handlers.
- src/contracts/: Zod schemas and inferred branded types.
- src/domain/: framework-independent business rules, not implemented.
- src/server/: server-only orchestration and fail-closed HTTP placeholders.
- src/integrations/: TMS, Twin, FMCSA and OTP adapter boundaries, not implemented.
- tests/: unit, external contract, integration and browser checks.
- docs/: draft specification, source registry, test plan and milestone tracker.

No live MCP tools, state machine, negotiation, booking, OTP, FMCSA, Twin or manager
dashboard is implemented. Authenticated API placeholders return 501; missing
configuration returns 503, and missing/invalid credentials return 401. The root
page is a temporary public scaffold page, not an operational dashboard.

Read [the specification](docs/specification.md) and
[implementation status](docs/implementation-plan.md) before implementing features.

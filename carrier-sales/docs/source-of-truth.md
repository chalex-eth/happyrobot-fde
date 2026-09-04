# Source of truth and dependency registry — draft

Verification date: 2026-09-04 (Europe/Paris). Credentials never belong here.

## Precedence

1. Assignment brief.
2. Candidate TMS handbook and protocol specification.
3. Official FMCSA, HappyRobot, OTP-provider and framework documentation.
4. Sanitized live-environment evidence.
5. Approved local specifications and decisions.
6. The pinned reference submission as a comparison only.

The supplied implementation plan is copied into [input-plan.md](input-plan.md),
with the original-author references removed per repository naming policy.
The local `references/reference-challenge` checkout was not copied or used
as an authoritative protocol source during scaffolding. Assignment, TMS, FMCSA,
HappyRobot App and Twin facts still require direct verification in Milestone 0/1.

## Installed versions

| Purpose | Exact version | Evidence / note |
| --- | --- | --- |
| Node runtime | 22.x, minimum 22.12 | Local verification target; Next minimum is 20.9 and MCP requires 20+ |
| pnpm | 10.34.5 | npm registry, checked 2026-09-04 |
| Next.js | 16.3.4 | npm registry and official App Router docs |
| React / React DOM | 19.2.8 | npm registry |
| TypeScript | 5.9.3 | Required because the Next 16 ESLint stack's typescript-eslint dependency currently declares TypeScript below 6 |
| Zod | 4.5.4 | npm registry; MCP server accepts Zod 4 |
| MCP server / Node transport | 2.0.0 | npm registry and official v2 package docs |
| Hono | 4.13.5 | Compatibility peer of published MCP Node transport only; not the App HTTP framework |
| Vitest | 4.1.11 | Compatible with Node 22 and the current TypeScript lint stack |
| Playwright | 1.62.1 | npm registry |
| ESLint / Next config | 9.39.5 / 16.3.4 | ESLint 10 is current but outside the published peer ranges of the Next 16 lint dependencies |

All versions are exact in package.json and pnpm-lock.yaml. The lockfile is the
installation source once generated. Do not upgrade one package in isolation.

## Official framework references

- Next.js installation and App Router: https://nextjs.org/docs/app/getting-started/installation
- Next.js Route Handlers: https://nextjs.org/docs/app/getting-started/route-handlers
- Next.js deployment: https://nextjs.org/docs/app/getting-started/deploying
- MCP TypeScript SDK server package: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server
- MCP TypeScript SDK Node package: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/node
- MCP shared-transport advisory: https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7

## Environment-variable names

GATEWAY_BEARER_TOKEN, MANAGER_BEARER_TOKEN, MCP_ALLOWED_HOSTS,
MCP_ALLOWED_ORIGINS, TMS_HOST, TMS_PORT, TMS_USERNAME, TMS_PASSWORD,
TWIN_BASE_URL, TWIN_API_KEY, FMCSA_API_KEY.

OTP provider-specific names remain intentionally undefined until the sender is
selected. No value, destination or production endpoint is recorded.

## Unverified discrepancies and decisions

- No HappyRobot App template is present locally; its pinned runtime and styling
  must be reconciled before deployment.
- Current official MCP v2 packages supersede the older alpha naming in the
  supplied plan. Lifecycle and Next Route Handler adaptation still require tests.
- The MCP Node package currently brings a Hono server adapter and has a Hono peer.
  This does not approve Hono as a separate application server.
- HappyRobot outbound TCP, Twin consistency, App authentication and OTP sender
  remain unverified. No compatibility or feasibility claim is made.

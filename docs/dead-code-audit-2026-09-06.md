# Dead-code audit — 6 September 2026

Audited commit `72fdc45` on `codex/workspace-twin-refactor`. No application source was changed. The audit used Knip 6.34.0 plus manual import/call-site checks across web, API, contracts, tests, package commands, Docker and documented operational scripts. It did not invoke integrations or run native evaluations.

## Confirmed cleanup candidates

| Location | Finding | Recommended cleanup |
| --- | --- | --- |
| `apps/web/src/features/load-search/tms-console.tsx:25` | `TmsConsole` has no imports, rendering sites or dynamic registration. The current page renders carrier verification and the operator dashboard. | Remove the unused 206-line component. |
| `packages/contracts/src/loads.ts:37` | `TmsResponseSchema` is consumed only by that unreachable component. | Remove together with `TmsConsole`. Keep the load and request types used by the API. |
| `apps/api/src/transport/http/middleware/session-cookie.ts:18` | `clearSessionCookie` has no callers. | Remove the function; retain `sessionHash` and `sessionCookie`. |
| `packages/contracts/src/verification.ts:27` | `CarrierRequestSchema` has no consumers. The carrier HTTP route currently validates extra keys and calls `normalizeMc` directly. | Remove the unused schema. Replacing the route's validation is a separate behavior change. |
| `apps/api/src/transport/http/routes/tms/route.ts:3` | `maxDuration` is an unused Next.js route setting left in the standalone Node API. The API router registers only the POST handler. | Remove the export. It currently enforces no timeout. |
| `packages/contracts/src/verification.ts:26`, `packages/contracts/src/negotiation.ts:13` | `DemoOtp` and `Negotiation` type aliases have no consumers. Their underlying schemas are used. | Optional type-surface cleanup; keep both schemas. |

## Used implementations with unnecessary exports

These should remain implemented. Only their public exposure is unused:

- `integrations/tms/client.ts`: `encodeRequest` is called inside the file.
- `modules/verification/index.ts`: re-exports of `otpCommit` and `otpOperation` are unused. Keep their exports in `otp.ts`, because the sibling `demo-otp.ts` imports them directly.
- `features/load-map/lane-map.tsx`: `project` is used within the component file.
- `db/rpc-contracts/index.ts`: `CallActionSchema`, `BookingActionSchema`, `TrackActionSchema` and `TwinResultSchema` are used within the file.
- `contracts/src/operations.ts`: `ReviewSchema`, `OperatorCallSchema`, `CallEventDataSchema`, `CallEventSchema` and `MappedLoadSchema` compose the consumed response schemas or inferred types within the file.
- `contracts/src/calls.ts`: `VoiceTokenSchema` composes `VoiceResponseSchema`.
- `contracts/src/loads.ts`: `publicLoadFields` supports projection; `TmsRequestSchema` supplies the consumed `TmsRequest` type. Its unused export does not make its definition removable without changing type derivation.

Paths above are relative to `apps/api/src`, `apps/web/src` or `packages` as appropriate.

## Findings to retain

- `livekit-client` is an optional peer dependency of the installed HappyRobot SDK that its voice client actually imports. The application uses that voice client.
- Knip flags Prettier because there is no package script invoking it. It is configured and was used for the refactor; retain it as development tooling. A `format` command would make its use discoverable.
- `DatabaseTables` is generated schema output. It currently has no application consumers, but generation is an explicit requirement. Do not edit generated output to satisfy an unused-type report.
- The MCP route aliases `GET`, `POST` and `DELETE` intentionally share a handler, and all are registered. Knip's duplicate-export finding is not dead behavior.
- `/api/tms`, `/api/local/tms`, manual OTP, email delivery, SQL transition/concurrency checks and operational controllers remain supported. The unused UI component does not establish that its backend endpoints are unused.
- `poc_create_call` has no application caller and is explicitly excluded from the current RPC client. It remains in the historical migration/schema. Repository analysis cannot establish whether external callers use a public database function; retain migration history and treat database API removal separately.

## Reproduction and limits

Configuration: [knip.json](dead-code-audit-evidence-2026-09-06/knip.json). Raw output: [knip-results.json](dead-code-audit-evidence-2026-09-06/knip-results.json).

```sh
npx --yes knip@6.34.0 --config docs/dead-code-audit-evidence-2026-09-06/knip.json --include-entry-exports --reporter json
```

The audit ran the already-cached Knip executable without installing a project dependency. All operational scripts were treated as entry points to preserve manual workflows. Unused exports were checked for same-file usage and type derivation before classification. No unused application dependency, unresolved import or unlisted dependency was reported by this configured scan. CSS selectors and external database consumers are outside its reach. Tests and builds were not rerun because this pass changed documentation only.

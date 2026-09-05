# Carrier sales: local TMS checkpoint

Real local Next.js HTTP → Node TCP → challenge TMS. No booking implementation, mock TMS, or deployment.

## Run

Node 22+ and npm. The supplied credentials and approved generated `LOCAL_API_TOKEN` are already in `.env.local` (Git-ignored). On another machine, copy `.env.example` to `.env.local` and fill in real credentials plus a separate local API token.

```sh
npm ci
npm run probe:tms
npm run build
npm run start
```

In a second terminal, from this directory:

```sh
npm run verify:local
```

Server: `http://127.0.0.1:3000`. To use another local port, run `npm run start -- --port 3001` and set `LOCAL_BASE_URL=http://127.0.0.1:3001` for verification. `npm run dev` is available for editing.

## Interface

`POST /api/tms`, `Content-Type: application/json`, `Authorization: Bearer <LOCAL_API_TOKEN>`.

```json
{"command":"LOAD_QUERY","fields":{"EQTYPE":"DRY_VAN","MAX_RESULTS":"3"}}
```

Then use an actual returned ID with `{"command":"LOAD_GET","fields":{"LOAD_ID":"<returned ID>"}}`. `{"command":"DEBUG_ECHO"}` checks transport/auth only. Query supports the handbook's origin/destination city, state, ZIP, equipment, `PICKUP_DATE`, and a local `MAX_RESULTS` limit of 1–20. At least one actual filter is required.

Responses include command, elapsed milliseconds, attempts, safe failure codes, and complete public records. Wire field names and numeric/date strings are preserved. `MAX_BUY`, unknown fields, and operator free text are excluded from this diagnostic endpoint. This is a connectivity checkpoint, not the final carrier-facing tool contract.

Every request uses a fresh socket, a 4-second overall attempt deadline, and a 256 KiB response cap. One transient read retry follows after 150 ms. Success requires `END\r\n`; complete error lines do not require END. Partial/malformed results are discarded. Missing/wrong API token returns 401; missing server auth configuration returns 503; invalid input returns 400; exhausted timeout returns 504; other upstream failures return 502. Error messages never forward upstream payloads.

## Observed results — 2026-09-04

| Check | Real result |
| --- | --- |
| Direct TCP echo / query / detail | Passed; approximately 240–250 ms each |
| Georgia example query | Valid empty result; broadened the real query to dry vans |
| HTTP echo | 200, 243 ms |
| HTTP dry-van query | 200, 245 ms; three actual loads |
| HTTP detail | 200, 241 ms; `LD00694`, Colorado Springs → Huntsville |
| Missing / wrong authentication | 401 / 401 |
| Booking command / delimiter injection / missing filter | 400 / 400 / 400, rejected before TCP |
| Credential and private-field checks | Passed on live HTTP responses |
| First HTTP query attempt | Real 4-second timeout; retry received incomplete response; safe 502 after 4.4 s, no partial data |
| Next complete verification run | All eight checks passed; exact output in `local-results.jsonl` |
| TypeScript / production build | Passed |

The script appends safe evidence to `local-results.jsonl` and exits nonzero on failure. The first observed upstream failure above occurred before file-based evidence logging was added. A later successful run does not erase that failure or prove production reliability. Only timeout and incomplete-response faults were observed; malformed and delayed-close cases are not claimed as live-tested.

**Checkpoint passed locally. Vercel/HappyRobot deployment remains unverified and deferred.** No `LOAD_BOOK` was sent to the TMS. FMCSA, OTP, Twin, and workflow integration are outside this checkpoint.

Protocol source: [candidate handbook](https://fde-challenge-candidate-handbook-production.up.railway.app/spec/), inspected through the logged-in browser. Route implementation follows [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route).

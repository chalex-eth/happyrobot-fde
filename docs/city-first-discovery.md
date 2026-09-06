# City-first load discovery

A verified caller can say “I'm in Dallas. What have you got?” without supplying a state, destination, date or equipment. The agent searches with `origin_city: "Dallas"` and `max_results: 10`, using any other preferences the caller has actually provided. Existing authority/OTP checks and latest-search load selection remain enforced.

## Conversation behavior

The source prompt searches immediately from available preferences, groups returned records by destination and pickup calendar date, and presents at most three groups in date order with their equipment. These are some options from a limited batch, not an exhaustive destination list. No geographic radius, inferred state, fabricated date or implicit equipment filter is introduced.

Refinements preserve existing preferences unless the caller changes them. “Anywhere” removes destination constraints; “any day” removes the date. Ambiguous locations or selections receive one clarification question. Zero results receive one recovery question, while transport failures receive a technical explanation. Selecting a current result invokes `get_load` directly; selecting an older result requires searching its lane again. Equipment compatibility is confirmed before negotiation when not already known.

The illustrative dialogue contains placeholders only. Spoken inventory must come from real tool results. Calendar dates are taken from the TMS without assuming a timezone. A relative date is clarified if current-date context is unavailable.

## Configuration and reproducible checks

- `npm test` exercises the TCP argument mapping, verification gate, existing backend regressions, and legacy/current adversarial prompt preparation.
- `npm run typecheck` checks source and controller types.
- `npm run verify:mcp -- --city-first` creates its own real Twin/provider call, completes authority and screen-demo OTP, runs Dallas and an inventory-derived alternate city through MCP, fetches current detail, then finalizes and cancels its provider run. It neither negotiates nor books, and it does not connect microphone audio.
- `HAPPYROBOT_MCP_SERVER_NAME` optionally selects a named connection for workflow sync. The existing default remains `Carrier sales local MCP`. For this rollout a separate connection points to the running tunnel; the stale previous connection is retained.

The normal draft must use the normal MCP connection with the Current Run ID header. An isolated native test draft uses the existing adversarial connection and its temporary controller capability. Never publish the isolated test draft.

## Separate native conversation tests

Definitions: `tests/happyrobot/city-search-paths.json`. These seven standalone tests are separate from the eight verification-only cases and retain the existing caller model. They cover an origin mentioned before verification, flexible date/destination, explicit equipment, refinement, departure-nickname clarification, an injected search-transport outage, and ambiguous load selection. They are grouped in HappyRobot under **06 - City search**. CS02 (Anchorage destinations and days) and CS06 (No inventory recovery) were removed from the active suite on 6 September; previous evidence files are retained.

Create an isolated draft from the candidate source using `npm run test:adversarial -- setup --city-search --source-version VERSION_ID --mcp-url CURRENT_TEST_MCP_URL`. The `--city-search` flag writes its own configuration, preserving the ordinary verification-test configuration. Then run:

```sh
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts setup
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts run
# One case:
NODE_ENV=development node --env-file=.env.local --import tsx scripts/happyrobot/run-city-search.ts run --test CS01
# Core verification regressions on the same isolated candidate:
npm run test:adversarial -- run --city-search --test PV01
```

All native runs are serialized with the same controller lock and real session/OTP mechanism. The prepared OTP goes only to the caller actor, not the sales agent. The controller revokes the capability and restores the caller prompt on exit. Load records are never fabricated. CS08 deliberately injects a transport failure through the normal validation, authority/OTP gate and save path; it is labelled as injected rather than a live upstream outage. A native simulated conversation verifies dialogue/tool behavior, not physical microphone/audio quality.

Each result includes a redacted transcript, native audit remarks and backend trace. Automated checkpoint success is separate from conversation review: inspect actual search arguments, unsolicited questions, result-grounded speech, refinement and selection. Do not treat an upstream error, missing branch, or unfinished conversation as a passed case.

## Evidence

- `city-search-tms-evidence.json`: direct read-only real TMS results. On September 5, Dallas returned one Dallas → Spokane FLATBED load, pickup September 17; Anchorage returned two loads. These are observed inventory snapshots, not promised ongoing availability.
- `city-first-rollout.json`: candidate/development version IDs and configuration verification.
- `city-first-mcp-evidence.json`: normal MCP smoke result, written only after the complete check succeeds.
- `city-search-results/`: native conversation evidence and review.

Conversation review requires an observed occurrence of each branch. Backend tests alone do not establish spoken behavior. Earlier failed runs remain in the evidence directory; later revisions are identified by their prompt hash.

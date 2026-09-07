# Twin SQL HTTP capability probe

On 6 September 2026, the live `POST https://platform.happyrobot.ai/api/v2/twin/sql`
endpoint committed related writes atomically, rolled back a constraint failure,
and supported concurrent conditional updates and receipt recovery in the scenarios
below. These results support evaluating a backend SQL adapter in place of stored
persistence functions. They do not establish application parity or authorize a
deployment.

## Reproduce

From the repository root, with `HAPPYROBOT_API_KEY` in `.env.local`:

```sh
node --env-file=.env.local apps/api/db/scripts/probe-twin-sql.mjs --allow-shared-scratch
```

The flag explicitly enables live writes to three uniquely named synthetic tables.
The controller checks that the names are absent before creation, makes no write
retries, removes its tables without `CASCADE`, and checks their absence afterward.
It does not import application code, read application rows, or change workflows.
Each run replaces `docs/twin-sql-probe-results.json` with its evidence. No credentials
are written to that file.

## Observations

| Scenario | Observed result |
| --- | --- |
| Authentication | Missing bearer token returned 401; configured key succeeded. |
| Related writes | A state update, event insertion, and receipt insertion committed together. |
| Constraint failure | A negative event amount returned 400; state revision, event, and receipt all remained unchanged. The test checks for the constraint error specifically. |
| Plain multi-statement request | UPDATE, INSERT, and SELECT succeeded in one request; response command was `MULTI`, with the final SELECT result. |
| Plain multi-statement failure | The second statement violated a constraint; the first UPDATE was rolled back. |
| Concurrent updates | Three pairs of simultaneous requests each produced one revision winner and exactly one event. |
| Duplicate claims | Two simultaneous requests for the same operation produced one fresh claim and one mutation. |
| Values | Six samples covering quotes, Unicode, backslashes, SQL-like text, empty text, JSON, and null round-tripped exactly. |
| Lost acknowledgement | A loopback proxy forwarded the real write, then destroyed the client connection after Twin responded. A separate direct SQL API read recovered the saved receipt. One mutation and one event existed; the write was not resent. |

Both executed runs confirmed removal of all their scratch tables. Application
tables, the active migration, and application transport were not changed.

## Limitations discovered

A standalone `WITH ... UPDATE/INSERT ... SELECT` statement returned 400 with
`WITH clause containing a data-modifying statement must be at the top level`.
The same write CTE worked when preceded by `SELECT 1 AS transaction_probe;` in a
multi-statement request. This suggests query rewriting differs between request
shapes, but the server implementation was not inspected. The prefix is a deliberate
probe technique, not a production adapter recommendation.

`{ sql: "SELECT $1::text AS probe", params: ["bound-value"] }` returned 400 with
`argument of LIMIT must be type bigint, not type text`. This attempted binding
format did not work; it does not prove that every possible parameter interface is
unsupported. The documentation specifies only the `sql` field.

The successful value tests used UTF-8 base64 encoding and PostgreSQL
`convert_from(decode(...))`, with generated identifiers and constant numeric SQL.
They do not validate an ORM, prepared statements, or arbitrary interpolated SQL.
PostgreSQL text NUL input is rejected locally by the probe.

The capability-discovery entries have `status: passed` when discovery completed;
their separate `supported: false` fields record the rejected query shapes.
The initial report retains the first failed attempt. Its original rollback entry
was inconclusive because it accepted a syntax error as a failure. The corrected
controller requires the actual constraint error, and the final report demonstrates
rollback after an executable write sequence. Initial concurrency and recovery
attempts were also rejected before execution; final results supersede them.

## Architecture consequence

An adapter can potentially load a snapshot, calculate a typed decision in
TypeScript, then send a complete conditional write batch in one HTTP request.
The tested revision and receipt patterns can preserve concurrency and replay
handling without putting business decisions into stored SQL functions.

This is not a PostgreSQL driver connection: there is no evidence that a transaction
can remain open across HTTP requests while TypeScript runs between statements.
The backend must prepare the whole batch before sending it. External effects must
still follow an acknowledged fresh claim; reading a receipt after a lost response
must not grant permission to resend an external effect.

Before replacing the existing adapter, establish the supported parameterization
and query-shape contract, preserve the required credential/permission boundaries,
then rerun application parity against the replacement. These tests did not examine
least-privilege roles, timeouts, server restarts, or downstream email/TMS delivery.

Sources: [SQL API](https://docs.happyrobot.ai/api-reference/twin/execute-sql-on-twin-database),
[Twin in Apps](https://docs.happyrobot.ai/twin/using-in-apps).

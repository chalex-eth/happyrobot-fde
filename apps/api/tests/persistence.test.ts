import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Persistence, CallSelectorSchema, type CommitResult } from '../src/db/persistence.js';
import { createTwinTransport, type SqlResponse } from '../src/db/twin-driver.js';
import { createDatabase, TwinDialect } from '../src/db/client.js';
import { calls } from '../src/db/schema/index.js';
import { buildInitialCall } from '../src/modules/calls/index.js';
import { CommitSchema, type CommitCommand, type Snapshot } from '../src/db/model.js';
function snapshot(): Snapshot {
  const now = new Date().toISOString();
  return {
    call: buildInitialCall(randomUUID(), 'a'.repeat(64), now),
    now,
    negotiation: null,
    events: [],
    reviews: [],
    otpReceipts: [],
    offerReceipts: [],
  };
}
const response = (row: Record<string, unknown>): SqlResponse => ({
  command: 'SELECT',
  rowCount: 1,
  rows: [row],
  fields: Object.keys(row).map((name) => ({ name, dataTypeId: 3802 })),
  truncated: false,
});
test('Twin SQL transport authenticates, serializes and rejects incompatible schemas without retry', async () => {
  let requests = 0;
  const transport = createTwinTransport({
    key: () => 'private-key',
    fetch: async (_input, init) => {
      requests++;
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-key');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body), ['sql']);
      assert.ok(body.sql.includes('poc_calls'));
      return new Response(JSON.stringify({ message: 'column revision does not exist' }), {
        status: 400,
      });
    },
  });
  await assert.rejects(
    () => new Persistence(transport).readCall({ hash: 'hash' }),
    /TWIN_SCHEMA_REQUIRED/,
  );
  assert.equal(requests, 1);
});
test('persistence rejects malformed rows and commit acknowledgements', async () => {
  const malformed = snapshot();
  Reflect.set(malformed.call, 'otp_failures', 9);
  await assert.rejects(
    () =>
      new Persistence({ query: async () => response({ snapshot: malformed }) }).readCall({
        hash: 'hash',
      }),
    /TWIN_INVALID_RESPONSE/,
  );
  const db = new Persistence({
    query: async (source) =>
      source.includes('with prior as materialized')
        ? response({ result: { code: 'committed' } })
        : { ...response({}), rows: [], fields: [] },
  });
  await assert.rejects(
    () =>
      db.commitCallOperation({
        callId: snapshot().call.id,
        operationId: 'op',
        phase: 'test',
        fingerprint: 'fp',
        expectedRevision: 0,
        preconditions: { activeSession: true },
        changes: { call: { source: 'test' } },
        result: { ok: true },
      }),
    /TWIN_INVALID_RESPONSE/,
  );
});
test('pure decisions recompute against fresh revisions and stop after three recalculations', async () => {
  let reads = 0,
    writes = 0;
  const s = snapshot();
  class Conflicts extends Persistence {
    override async readCall() {
      s.call.revision = reads++;
      return structuredClone(s);
    }
    override async commitCallOperation(command: CommitCommand): Promise<CommitResult> {
      assert.equal(command.expectedRevision, writes++);
      return { code: 'conflict' };
    }
  }
  await assert.rejects(
    () =>
      new Conflicts().execute({ id: s.call.id }, { action: 'test' }, (draft) => {
        draft.call.source = 'test';
        return { result: { ok: true } };
      }),
    /TWIN_CONFLICT/,
  );
  assert.equal(reads, 4);
  assert.equal(writes, 4);
});
test('commit commands reject arbitrary fields and cross-call writes', async () => {
  assert.equal(CallSelectorSchema.safeParse({ id: randomUUID(), hash: 'another' }).success, false);
  const command = {
    callId: randomUUID(),
    operationId: 'op',
    phase: 'test',
    fingerprint: 'fp',
    expectedRevision: 0,
    preconditions: { activeSession: true },
    result: { ok: true },
  };
  for (const changes of [
    { sql: 'DELETE FROM public.poc_calls' },
    { call: { session_hash: 'b'.repeat(64) } },
    { call: { revision: 999 } },
  ])
    assert.equal(CommitSchema.safeParse({ ...command, changes }).success, false);
  const db = new Persistence({
    query: async () => {
      throw Error('must not reach transport');
    },
  });
  await assert.rejects(
    () =>
      db.commitCallOperation({
        ...command,
        changes: {
          otpReceipts: [
            {
              call_id: randomUUID(),
              operation_id: 'other',
              authority_revision: 0,
              fingerprint: 'fp',
              result: {},
            },
          ],
        },
      }),
    /INVALID_CALL_ID/,
  );
});
test('Drizzle literals use syntax-tree encoding with no placeholder substitution', () => {
  const dialect = new TwinDialect();
  const value = "quote' backslash\\ $1 -- ;";
  const compiled = dialect.sqlToQuery(sql`select ${value}::text`);
  assert.equal(compiled.params.length, 0);
  assert.ok(compiled.sql.includes("E'quote''"));
  assert.ok(compiled.sql.includes('$1 -- ;'));
  assert.throws(() => dialect.sqlToQuery(sql`select ${'\0'}`), /INVALID_DATABASE_TEXT/);
  assert.throws(() => dialect.sqlToQuery(sql`select ${'\ud800'}`), /INVALID_DATABASE_TEXT/);
});
test('Drizzle maps result columns in server field order', async () => {
  const db = createDatabase({
    query: async () => ({
      command: 'SELECT',
      rowCount: 1,
      truncated: false,
      fields: [
        { name: 'id', dataTypeId: 2950 },
        { name: 'source', dataTypeId: 25 },
      ],
      rows: [{ source: 'test', id: 'id' }],
    }),
  });
  assert.deepEqual(await db.select({ id: calls.id, source: calls.source }).from(calls), [
    { id: 'id', source: 'test' },
  ]);
  await assert.rejects(
    () => db.transaction(async () => undefined),
    /Transactions are not supported/,
  );
});
test('Twin transport rejects truncation, duplicate columns and unsafe bigint results', async () => {
  for (const [body, error] of [
    [{ ...response({ id: 1 }), truncated: true }, 'TWIN_RESULT_TRUNCATED'],
    [
      {
        ...response({ id: 1 }),
        fields: [
          { name: 'id', dataTypeId: 23 },
          { name: 'id', dataTypeId: 23 },
        ],
      },
      'TWIN_AMBIGUOUS_COLUMNS',
    ],
    [
      { ...response({ id: 9007199254740992 }), fields: [{ name: 'id', dataTypeId: 20 }] },
      'TWIN_INVALID_RESPONSE',
    ],
  ] as const) {
    const transport = createTwinTransport({
      key: () => 'key',
      fetch: async () => new Response(JSON.stringify(body)),
    });
    await assert.rejects(() => transport.query('SELECT test'), new RegExp(error));
  }
});

test('Twin retries explicit rate-limit refusals but never uncertain mutations', async () => {
  for (const status of [429, 503]) {
    let requests = 0;
    const transport = createTwinTransport({
      key: () => 'key',
      fetch: async () => {
        requests++;
        return requests === 1
          ? new Response('{}', { status, headers: { 'retry-after': '0' } })
          : Response.json(response({ id: 1 }));
      },
    });
    if (status === 429) {
      assert.equal((await transport.query('UPDATE test RETURNING id')).rowCount, 1);
      assert.equal(requests, 2);
    } else {
      await assert.rejects(() => transport.query('UPDATE test RETURNING id'), /TWIN_UNAVAILABLE/);
      assert.equal(requests, 1);
    }
  }
  let requests = 0;
  const transport = createTwinTransport({
    key: () => 'key',
    fetch: async () => {
      requests++;
      return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
    },
  });
  await assert.rejects(() => transport.query('UPDATE test RETURNING id'), /TWIN_UNAVAILABLE/);
  assert.equal(requests, 1, 'a long Retry-After must not be shortened');
});

test('operator filters preserve SQL wildcard escaping and empty source semantics', async () => {
  const { listCalls } = await import('../src/modules/operations/index.js');
  const s = snapshot();
  s.call.selected_load_id = 'L_A';
  assert.equal(listCalls([s], { query: 'L\\_A' }).total, 1);
  assert.equal(listCalls([s], { query: 'L%A' }).total, 1);
  s.call.selected_load_id = 'LXA';
  assert.equal(listCalls([s], { query: 'L\\_A' }).total, 0);
  assert.equal(listCalls([s], { source: '' }).total, 0);
});

test('dashboard can retrieve its overview in one bounded page without changing default pagination', async () => {
  const { listCalls, operatorCommand } = await import('../src/modules/operations/index.js');
  const records = Array.from({ length: 65 }, snapshot);
  assert.equal((listCalls(records, {}).calls as unknown[]).length, 30);
  assert.equal((listCalls(records, { limit: 1000 }).calls as unknown[]).length, 65);
  assert.equal((listCalls(records, { limit: 50, offset: 50 }).calls as unknown[]).length, 15);
  let reads = 0;
  const db = new Persistence();
  db.queryCalls = async () => {
    reads++;
    return records;
  };
  await operatorCommand(db, 'operator-key', 'list', { limit: 1000 });
  assert.equal(reads, 1, 'unchanged reviews must not trigger a second history scan');
});

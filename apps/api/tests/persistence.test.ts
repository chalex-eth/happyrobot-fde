import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  Persistence,
  persistenceInputs,
  twinTransport,
  type PersistenceRpc,
} from '../src/db/persistence.js';
import type { DatabaseRpc } from '../src/db/generated/database.js';
import { buildInitialCall } from '../src/modules/calls/index.js';
import type { Snapshot } from '../src/db/model.js';
type Assert<T extends true> = T;
type Match<K extends PersistenceRpc> =
  Exclude<
    keyof z.input<(typeof persistenceInputs)[K]>,
    keyof Omit<DatabaseRpc[K]['Args'], 'p_key'>
  > extends never
    ? Exclude<
        keyof Omit<DatabaseRpc[K]['Args'], 'p_key'>,
        keyof z.input<(typeof persistenceInputs)[K]>
      > extends never
      ? true
      : false
    : false;
export type GeneratedPersistenceSignatureCheck = Assert<
  { [K in PersistenceRpc]: Match<K> }[PersistenceRpc]
>;
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
test('Twin persistence uses only the new RPC protocol and fails clearly against an old schema', async (t) => {
  const keys = ['TWIN_GATEWAY', 'TWIN_ORG_ID', 'BACKEND_RPC_KEY'] as const;
  const old = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    TWIN_GATEWAY: 'https://twin.example.invalid',
    TWIN_ORG_ID: 'test-org',
    BACKEND_RPC_KEY: 'k'.repeat(32),
  });
  t.after(() =>
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    }),
  );
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls++;
    assert.equal(url.pathname, '/rpc/poc_read_call');
    assert.equal(new Headers(init.headers).get('x-org-id'), 'test-org');
    assert.deepEqual(JSON.parse(String(init.body)), {
      p_selector: { hash: 'hash' },
      p_key: 'k'.repeat(32),
    });
    return new Response('', { status: 404 });
  });
  await assert.rejects(
    () => new Persistence(twinTransport).readCall({ hash: 'hash' }),
    /TWIN_SCHEMA_REQUIRED/,
  );
  assert.equal(calls, 1);
});
test('persistence rejects malformed rows and malformed commit acknowledgements', async () => {
  const malformed = snapshot();
  Reflect.set(malformed.call, 'otp_failures', 9);
  await assert.rejects(
    () => new Persistence({ request: async () => malformed }).readCall({ hash: 'hash' }),
    /TWIN_INVALID_RESPONSE/,
  );
  const s = snapshot();
  const db = new Persistence({
    request: async (name) => (name === 'poc_read_receipt' ? null : { code: 'committed' }),
  });
  await assert.rejects(
    () =>
      db.commitCallOperation({
        callId: s.call.id,
        operationId: 'op',
        phase: 'test',
        fingerprint: 'fp',
        expectedRevision: 0,
        preconditions: { activeSession: true },
        changes: { call: { source: 'integration_test' } },
        result: { ok: true },
      }),
    /TWIN_INVALID_RESPONSE/,
  );
});
test('decision retries are bounded and recompute against fresh revisions', async () => {
  let reads = 0,
    writes = 0;
  const s = snapshot();
  const db = new Persistence({
    async request(name, args) {
      if (name === 'poc_read_call') {
        s.call.revision = reads++;
        return structuredClone(s);
      }
      assert.equal(name, 'poc_commit_call');
      const command = persistenceInputs.poc_commit_call.parse(args).p_command;
      assert.equal(command.expectedRevision, writes++);
      return { code: 'conflict' };
    },
  });
  await assert.rejects(
    () =>
      db.execute({ id: s.call.id }, { action: 'test' }, (draft) => {
        draft.call.source = 'test';
        return { result: { ok: true } };
      }),
    /TWIN_CONFLICT/,
  );
  assert.equal(reads, 4);
  assert.equal(writes, 4);
});
test('the persistence request schema rejects arbitrary fields and executable changes', () => {
  assert.equal(
    persistenceInputs.poc_read_call.safeParse({
      p_selector: { id: randomUUID(), hash: 'another-call' },
    }).success,
    false,
  );
  const s = snapshot();
  const command = {
    callId: s.call.id,
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
    assert.equal(
      persistenceInputs.poc_commit_call.safeParse({ p_command: { ...command, changes } }).success,
      false,
    );
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

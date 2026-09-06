import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyRpcContracts } from './verify-contracts.js';
import { fileURLToPath } from 'node:url';
import { disposableDatabases, literal } from './disposable.js';
import { executeCommand, withPersistence } from '../../src/application/commands.js';
import { Persistence } from '../../src/db/persistence.js';
import { SnapshotSchema, data, type Data, type Snapshot } from '../../src/db/model.js';
import { type RpcName, type RpcArgs, parseCallResult } from '../../src/db/rpc-contracts/index.js';
import { bookForCall } from '../../src/modules/booking/index.js';
import type { getLoadPricing } from '../../src/integrations/tms/client.js';
function normalizer() {
  const ids = new Map<string, string>();
  const normalize = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) {
        if (!ids.has(value)) ids.set(value, 'uuid-' + ids.size);
        return ids.get(value);
      }
      if (/^\d{4}-\d\d-\d\d[T ]\d\d:/.test(value)) return '<timestamp>';
      if (key === 'source_key' && value.startsWith('{')) return normalize(JSON.parse(value));
    }
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([k]) => !(k === 'revision' && key === 'call'))
          .map(([k, v]) => [
            k,
            k === 'id' && typeof v === 'number' ? '<event-id>' : normalize(v, k),
          ]),
      );
    return value;
  };
  return normalize;
}
export async function runParity() {
  const env = await disposableDatabases();
  let comparisons = 0;
  try {
    const baseline = await readFile(
      new URL('../migrations/0001_initial_schema.sql', import.meta.url),
      'utf8',
    );
    const helper = baseline
      .slice(
        baseline.indexOf('CREATE FUNCTION poc_private.call_snapshot'),
        baseline.indexOf('CREATE FUNCTION public.poc_read_call'),
      )
      .replace("'call',to_jsonb(c)", "'call',to_jsonb(c)||'{\"revision\":0}'::jsonb");
    await env.sql('legacy', helper);
    for (const file of [
      'otp-transitions.sql',
      'call-transitions.sql',
      'finalize-transitions.sql',
      'negotiation-transitions.sql',
      'booking-transitions.sql',
      'load-interest-transitions.sql',
      'mock-booking-transitions.sql',
      'operator-transitions.sql',
    ]) {
      await env.sql('legacy', await readFile(new URL('../tests/' + file, import.meta.url), 'utf8'));
      console.log('Legacy characterization: ' + file);
    }
    await legacyConcurrency(env.name);
    // SQL suites roll back their fixtures. Clear only these disposable test DBs.
    for (const db of ['legacy', 'candidate'])
      await env.sql(db, 'TRUNCATE public.poc_calls CASCADE;');
    class Pair {
      id = randomUUID();
      hash = randomBytes(32).toString('hex');
      last: [Data, Data] = [{}, {}];
      normalize = [normalizer(), normalizer()];
      async snapshot(side: 0 | 1): Promise<Snapshot> {
        return SnapshotSchema.parse(
          JSON.parse(
            await env.sql(
              side === 0 ? 'legacy' : 'candidate',
              `SELECT poc_private.call_snapshot(${literal(this.id)});`,
            ),
          ),
        );
      }
      async step(
        name: RpcName,
        args: Record<string, unknown> | ((s: Snapshot) => Record<string, unknown>),
        label: string = name,
      ): Promise<Data> {
        const values: Data[] = [];
        for (const side of [0, 1] as const) {
          const a = typeof args === 'function' ? args(await this.snapshot(side)) : args;
          values.push(
            data(
              side === 0
                ? await env.raw('legacy', name, a)
                : await withPersistence(env.db, () => executeCommand(name, a as RpcArgs<RpcName>)),
            ),
          );
        }
        assert.deepEqual(
          this.normalize[1]!(values[1]),
          this.normalize[0]!(values[0]),
          label + ' response',
        );
        this.last = values as [Data, Data];
        await this.compare(label);
        comparisons++;
        if (comparisons % 25 === 0) console.log(`Parity: ${comparisons} comparisons passed`);
        return values[1]!;
      }
      async compare(label: string) {
        const [a, b] = await Promise.all([this.snapshot(0), this.snapshot(1)]);
        assert.deepEqual(
          this.normalize[1]!({ ...b, now: null }),
          this.normalize[0]!({ ...a, now: null }),
          label + ' state',
        );
      }
      action(action: string, metadata: Data = {}, extra: Record<string, unknown> = {}) {
        return this.step(
          'poc_call_action',
          { p_session_hash: this.hash, p_action: action, p_metadata: metadata, ...extra },
          action,
        );
      }
      async create(previous?: string) {
        await this.step(
          'poc_start_call',
          {
            p_id: this.id,
            p_session_hash: this.hash,
            ...(previous ? { p_previous_hash: previous } : {}),
          },
          'start',
        );
      }
      async seed(sql: string) {
        for (const db of ['legacy', 'candidate'])
          await env.sql(db, sql.replaceAll('$CALL', literal(this.id)));
      }
      async verify() {
        await this.action('authority_begin', { mcNumber: '1515' });
        await this.action('authority_complete', {
          revision: 1,
          check: {
            mcNumber: '1515',
            eligible: true,
            outcome: 'eligible',
            reason: 'ACTIVE_CARRIER_AUTHORITY',
            checkedAt: '2026-09-06T12:00:00Z',
          },
        });
        const challenge = randomUUID();
        await this.action(
          'issue',
          { operationId: 'issue' },
          { p_challenge: challenge, p_digest: 'a'.repeat(64), p_recipient: 'test' },
        );
        await this.action('sent', { operationId: 'issue' }, { p_challenge: challenge });
        await this.action(
          'verify',
          { operationId: 'verify', fingerprint: 'correct' },
          { p_challenge: challenge, p_matches: true },
        );
      }
      async load(id = 'L1', status = 'OPEN') {
        await this.action('authorize_load', { command: 'LOAD_QUERY' });
        await this.action('save_loads', {
          command: 'LOAD_QUERY',
          revision: 1,
          ok: true,
          loadIds: [id],
          loadStatuses: { [id]: status },
        });
        await this.action('authorize_load', { command: 'LOAD_GET', loadId: id });
        await this.action('save_loads', {
          command: 'LOAD_GET',
          loadId: id,
          revision: 1,
          ok: true,
          loadStatuses: { [id]: status },
        });
      }
      offer(action: string, amount?: number, loadId = 'L1', extra: Record<string, unknown> = {}) {
        return this.step(
          'poc_negotiate',
          (s) => ({
            p_session_hash: this.hash,
            p_action: action,
            p_load_id: loadId,
            ...(action === 'quote'
              ? {
                  p_revision: s.call.authority_revision,
                  p_listed_cents: 100001,
                  p_max_cents: 120000,
                }
              : { p_offer_id: s.negotiation?.offer_id }),
            ...(amount !== undefined ? { p_amount_cents: amount } : {}),
            ...extra,
          }),
          action,
        );
      }
      booking(action: string, extra: Data = {}, loadId = 'L1') {
        return this.step(
          'poc_book_call',
          (s) => ({
            p_session_hash: this.hash,
            p_action: action,
            p_metadata: { loadId, offerId: s.negotiation?.offer_id, ...extra },
          }),
          'booking ' + action,
        );
      }
      finalize(outcome = 'conversation_complete', summary = 'Finished', review: Data = {}) {
        return this.step(
          'poc_finalize_call',
          { p_session_hash: this.hash, p_outcome: outcome, p_summary: summary, p_review: review },
          'finalize',
        );
      }
    }
    const p = new Pair();
    await p.create();
    await p.action('authorize_load', { command: 'LOAD_QUERY' });
    await p.action('voice_reserve');
    const run = randomUUID();
    await p.action('voice_bind', { runId: run });
    await p.step('poc_resolve_voice', { p_run_id: run });
    await p.verify();
    await p.action(
      'verify',
      { operationId: 'verify', fingerprint: 'correct' },
      { p_challenge: (await p.snapshot(1)).call.challenge_id, p_matches: true },
    );
    await p.action('otp_result', { operationId: 'verify', fingerprint: 'changed' });
    await p.load();
    await p.action('save_loads', { command: 'LOAD_GET', loadId: 'L1', revision: 0, ok: true });
    await p.offer('quote');
    const oldOffers = [
      (await p.snapshot(0)).negotiation!.offer_id,
      (await p.snapshot(1)).negotiation!.offer_id,
    ];
    await p.offer('counter', 200000);
    assert.equal((await p.snapshot(1)).negotiation!.offered_cents, 102001);
    for (let i = 0; i < 2; i++) {
      const results = [];
      for (const side of [0, 1] as const) {
        const a = {
          p_session_hash: p.hash,
          p_action: i ? 'reject' : 'counter',
          p_load_id: 'L1',
          p_offer_id: oldOffers[side],
          ...(i ? {} : { p_amount_cents: 200000 }),
        };
        results.push(
          side === 0
            ? await env.raw('legacy', 'poc_negotiate', a)
            : await withPersistence(env.db, () =>
                executeCommand('poc_negotiate', a as RpcArgs<'poc_negotiate'>),
              ),
        );
      }
      assert.deepEqual(p.normalize[1]!(results[1]), p.normalize[0]!(results[0]));
      await p.compare('offer replay');
      comparisons++;
    }
    await p.offer('counter', 200000);
    await p.offer('counter', 200000);
    await p.action('authorize_load', { command: 'LOAD_QUERY' });
    await p.finalize();
    await p.finalize();
    await p.finalize('caller_declined', 'Changed');
    const otp = new Pair();
    await otp.create();
    await otp.action('authority_begin', { mcNumber: '1515' });
    await otp.action('authority_complete', { revision: 0, check: { mcNumber: '1515' } });
    await otp.action('authority_complete', {
      revision: 1,
      check: { mcNumber: '1515', eligible: true, outcome: 'eligible' },
    });
    const challenge = randomUUID();
    await otp.action(
      'issue',
      {},
      { p_challenge: challenge, p_digest: 'c'.repeat(64), p_recipient: 'test' },
    );
    await otp.action(
      'issue',
      {},
      { p_challenge: randomUUID(), p_digest: 'd'.repeat(64), p_recipient: 'test' },
    );
    await otp.action('sent', {}, { p_challenge: challenge });
    await otp.action('prepare_verify', {}, { p_challenge: challenge });
    await otp.action(
      'verify',
      { operationId: 'bad-1' },
      { p_challenge: challenge, p_matches: false },
    );
    await otp.action(
      'verify',
      { operationId: 'bad-1' },
      { p_challenge: challenge, p_matches: false },
    );
    await otp.action('otp_failure', { operationId: 'bad-2' });
    await otp.action('otp_result', { operationId: 'bad-1' });
    await otp.action('authority_begin', { mcNumber: '1516' });
    await otp.action('otp_result', { operationId: 'bad-1' });
    const interest = new Pair();
    await interest.create();
    await interest.verify();
    await interest.load('P1', 'PENDING');
    await interest.offer('quote', undefined, 'P1');
    const interestArgs = {
      p_session_hash: interest.hash,
      p_load_id: 'P1',
      p_callback_number: '+12125550123',
      p_consent: true,
      p_revision: 1,
    };
    await interest.step('poc_record_load_interest', { ...interestArgs, p_consent: false });
    await interest.step('poc_record_load_interest', interestArgs);
    await interest.step('poc_record_load_interest', interestArgs);
    await interest.action('authority_begin', { mcNumber: '1516' });
    await interest.finalize('conversation_complete', 'Callback saved', {
      reason: 'callback_requested',
      note: 'Call back',
      callback_number: '+12125550123',
      consent: true,
    });
    await interest.finalize('conversation_complete', 'Callback saved', {
      reason: 'human_requested',
      note: 'Different',
    });
    const terms = { LOAD_ID: 'L1', STATUS: 'OPEN', RATE: '1000.01', EQTYPE: 'FLATBED' };
    const booked = new Pair();
    await booked.create();
    await booked.verify();
    await booked.load();
    await booked.offer('quote');
    await booked.booking('quote', { terms });
    await booked.offer('accept');
    await booked.booking('prepare');
    await booked.booking('preflight_failed', { error: 'TMS_UNAVAILABLE' });
    const attempt = randomUUID();
    await booked.booking('claim', {
      attemptId: attempt,
      terms,
      listedCents: 100001,
      maxCents: 120000,
      simulated: true,
    });
    await booked.booking('claim', {
      attemptId: randomUUID(),
      terms,
      listedCents: 100001,
      maxCents: 120000,
      simulated: true,
    });
    await booked.finalize();
    await booked.action('authority_begin', { mcNumber: '1516' });
    await booked.booking('complete', {
      attemptId: attempt,
      result: {
        status: 'confirmed',
        reference: 'REF',
        timestamp: '20260906120000',
        simulated: false,
      },
    });
    await booked.booking('complete', {
      attemptId: attempt,
      result: {
        status: 'confirmed',
        reference: 'REF',
        timestamp: '20260906120000',
        simulated: true,
      },
    });
    await booked.finalize('technical_error');
    await booked.finalize('technical_error');
    const uncertain = new Pair();
    await uncertain.create();
    await uncertain.verify();
    await uncertain.load('U1');
    await uncertain.offer('quote', undefined, 'U1');
    await uncertain.booking('quote', { terms: { ...terms, LOAD_ID: 'U1' } }, 'U1');
    await uncertain.offer('accept', undefined, 'U1');
    const ua = randomUUID();
    await uncertain.booking(
      'claim',
      {
        attemptId: ua,
        terms: { ...terms, LOAD_ID: 'U1' },
        listedCents: 100001,
        maxCents: 120000,
        simulated: false,
      },
      'U1',
    );
    await uncertain.seed(
      "UPDATE public.poc_calls SET booking=jsonb_set(booking,'{attempted_at}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$CALL;",
    );
    await uncertain.booking('status');
    await uncertain.finalize();
    await uncertain.seed(
      "UPDATE public.poc_calls SET session_expires_at=now()-interval '1 minute' WHERE id=$CALL;",
    );
    await uncertain.booking(
      'complete',
      {
        attemptId: ua,
        result: {
          status: 'confirmed',
          reference: 'LATE',
          timestamp: '20260906120000',
          simulated: false,
        },
      },
      'U1',
    );
    await uncertain.action('status');
    const replacement = new Pair();
    await replacement.create(p.hash);
    await p.action('status');
    const ops = new Pair();
    await ops.create();
    await ops.action('voice_reserve');
    await ops.action('voice_failed');
    await ops.step('poc_track_call', {
      p_session_hash: ops.hash,
      p_action: 'source',
      p_metadata: { source: 'integration_test' },
    });
    await ops.step('poc_track_call', {
      p_session_hash: ops.hash,
      p_action: 'loads',
      p_metadata: { records: [{ ...terms, MAX_BUY: 'SECRET' }] },
    });
    const activity = {
      p_session_hash: ops.hash,
      p_action: 'tool',
      p_metadata: {
        tool: 'search_loads',
        error: 'TMS_UNAVAILABLE',
        ok: false,
        requestId: randomUUID(),
      },
    };
    await ops.step('poc_track_call', activity);
    await ops.step('poc_track_call', activity);
    await ops.step('poc_track_call', { p_session_hash: ops.hash, p_action: 'ended' });
    await ops.step('poc_operator', {
      p_key: 'parity-operator',
      p_action: 'detail',
      p_metadata: { call_id: ops.id },
    });
    await ops.step('poc_operator', (s) => ({
      p_key: 'parity-operator',
      p_action: 'review',
      p_metadata: {
        id: s.reviews[0]!.id,
        revision: s.reviews[0]!.revision,
        status: 'reviewed',
        note: 'Checked',
      },
    }));
    await ops.step('poc_operator', (s) => ({
      p_key: 'parity-operator',
      p_action: 'review',
      p_metadata: {
        id: s.reviews[0]!.id,
        revision: randomUUID(),
        status: 'reviewed',
        note: 'Stale',
      },
    }));
    await ops.action('voice_failed');
    await ops.finalize();
    console.log(`Parity: ${comparisons} response and durable-state comparisons passed.`);
    await persistenceTests(env, Pair, terms);
    await concurrencyTests(env, Pair, terms);
    await verifyRpcContracts((source) => env.sql('legacy', source));
    await withPersistence(env.db, () =>
      verifyRpcContracts(
        (source) => env.sql('candidate', source),
        (name, args) => executeCommand(name as RpcName, args as RpcArgs<RpcName>),
      ),
    );
    assert.equal((await env.db.queryCalls('parity-operator', 0)).length > 0, true);
    await assert.rejects(
      () => env.db.queryCalls('invalid-operator-key', 0),
      /OPERATOR_AUTH_REQUIRED/,
    );
    console.log(
      `Complete: ${comparisons} paired response/state comparisons, SQL characterization, concurrency, persistence and public-contract checks passed.`,
    );
  } finally {
    await env.cleanup();
  }
}
async function persistenceTests(
  env: Awaited<ReturnType<typeof disposableDatabases>>,
  Pair: new () => {
    id: string;
    hash: string;
    create(): Promise<void>;
    verify(): Promise<void>;
    load(id?: string): Promise<void>;
    offer(action: string, amount?: number, loadId?: string): Promise<Data>;
    booking(action: string, extra?: Data, loadId?: string): Promise<Data>;
    snapshot(side: 0 | 1): Promise<Snapshot>;
  },
  terms: Data,
) {
  const p = new Pair();
  await p.create();
  await p.verify();
  const s = (await env.db.readCall({ id: p.id }))!;
  const command = {
    callId: p.id,
    operationId: randomUUID(),
    phase: 'test',
    fingerprint: 'intent',
    expectedRevision: s.call.revision,
    preconditions: { activeSession: true },
    changes: {
      call: { source: 'integration_test' },
      events: [{ event: 'atomic_test', metadata: {}, created_at: s.now }],
    },
    result: { ok: true },
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => env.db.commitCallOperation(command)),
  );
  assert.equal(results.filter((r) => r.code === 'committed').length, 1);
  assert.equal(results.filter((r) => r.code === 'replayed').length, 7);
  assert.equal(
    (await env.db.readCall({ id: p.id }))!.events.filter((e) => e.event === 'atomic_test').length,
    1,
  );
  assert.equal(
    (await env.db.commitCallOperation({ ...command, fingerprint: 'changed' })).code,
    'OPERATION_CHANGED',
  );
  assert.equal(
    (await env.db.commitCallOperation({ ...command, operationId: randomUUID() })).code,
    'conflict',
  );
  const before = (await env.db.readCall({ id: p.id }))!;
  await assert.rejects(() =>
    env.raw(
      'candidate',
      'poc_commit_call',
      {
        p_key: env.key,
        p_command: {
          ...command,
          operationId: randomUUID(),
          expectedRevision: before.call.revision,
          changes: { call: { source: 'must rollback' }, negotiation: { call_id: p.id } },
        },
      },
      true,
    ),
  );
  assert.equal((await env.db.readCall({ id: p.id }))!.call.source, 'integration_test');
  await assert.rejects(() =>
    env.sql('candidate', `SET ROLE carrier_gateway; SELECT * FROM public.poc_calls;`),
  );
  const unauthorized = await fetch(env.url + '/rpc/poc_read_call', {
    method: 'POST',
    body: JSON.stringify({ p_key: 'wrong', p_selector: { id: p.id } }),
  });
  assert.equal(unauthorized.status, 400);
  await assert.rejects(() =>
    env.raw(
      'candidate',
      'poc_commit_call',
      {
        p_key: env.key,
        p_command: {
          ...command,
          operationId: randomUUID(),
          expectedRevision: before.call.revision,
          changes: { call: { session_hash: 'f'.repeat(64) } },
        },
      },
      true,
    ),
  );
  const lost = new Persistence({
    async request(name, args) {
      const result = await env.transport.request(name, args);
      if (name === 'poc_commit_call') throw Error('lost acknowledgement');
      return result;
    },
  });
  const recovered = await lost.commitCallOperation({
    ...command,
    operationId: randomUUID(),
    expectedRevision: before.call.revision,
    result: { ok: true, claimed: true },
  });
  assert.equal(recovered.code, 'replayed');
  // Real backend booking orchestration with a lost claim acknowledgement must never send.
  const q = new Pair();
  await q.create();
  await q.verify();
  await q.load('LOST');
  await q.offer('quote', undefined, 'LOST');
  await q.booking('quote', { terms: { ...terms, LOAD_ID: 'LOST' } }, 'LOST');
  await q.offer('accept', undefined, 'LOST');
  const negotiated = (await env.db.readCall({ id: q.id }))!.negotiation!;
  let sends = 0;
  const result = await withPersistence(lost, () =>
    bookForCall(q.hash, { load_id: 'LOST', offer_id: negotiated.offer_id }, undefined, {
      rpc: async (name, args) => parseCallResult(name, args, await executeCommand(name, args)),
      pricing: async () => ({
        pricing: { listedCents: 100001, maxCents: 120000 },
        result: {
          ok: true,
          command: 'LOAD_GET',
          records: [{ ...terms, LOAD_ID: 'LOST' }],
          attempts: 1,
        } as Awaited<ReturnType<typeof getLoadPricing>>['result'],
      }),
      send: async () => {
        sends++;
        return { status: 'confirmed', reference: 'WRONG', timestamp: '20260906120000' };
      },
    }),
  );
  assert.equal(sends, 0);
  assert.equal(result.booking.status, 'pending');
  const current = (await env.db.readCall({ id: p.id }))!;
  const conditional = {
    ...command,
    operationId: randomUUID(),
    expectedRevision: current.call.revision,
  };
  assert.equal(
    (
      await env.db.commitCallOperation({
        ...conditional,
        preconditions: { activeSession: true, validUntil: '2000-01-01T00:00:00Z' },
      })
    ).code,
    'conflict',
  );
  await env.sql(
    'candidate',
    `UPDATE public.poc_calls SET session_expires_at=now()-interval '1 second' WHERE id=${literal(p.id)};`,
  );
  assert.equal((await env.db.commitCallOperation(conditional)).code, 'SESSION_REQUIRED');
  assert.equal((await env.db.readCall({ id: p.id }))!.call.revision, current.call.revision);
  assert.equal(await env.db.readCall({ hash: 'missing-call' }), null);
  console.log(
    'Persistence: concurrent replay, conflict, rollback, permissions and lost-ack send suppression passed.',
  );
}

async function concurrencyTests(
  env: Awaited<ReturnType<typeof disposableDatabases>>,
  Pair: new () => {
    id: string;
    hash: string;
    create(): Promise<void>;
    verify(): Promise<void>;
    load(id?: string): Promise<void>;
    offer(action: string, amount?: number, loadId?: string): Promise<Data>;
    booking(action: string, extra?: Data, loadId?: string): Promise<Data>;
    snapshot(side: 0 | 1): Promise<Snapshot>;
  },
  terms: Data,
) {
  const run = (side: 0 | 1, name: RpcName, args: Record<string, unknown>) =>
    side === 0
      ? env.raw('legacy', name, args).then(data)
      : withPersistence(env.db, () => executeCommand(name, args as RpcArgs<RpcName>));
  const otp = new Pair();
  await otp.create();
  await otp.verify();
  for (const side of [0, 1] as const) {
    await env.sql(
      side === 0 ? 'legacy' : 'candidate',
      `UPDATE public.poc_calls SET otp_state='pending',otp_digest='${'a'.repeat(64)}',otp_verified_at=NULL WHERE id=${literal(otp.id)};`,
    );
    const challenge = (await otp.snapshot(side)).call.challenge_id;
    const answer = (op: string) =>
      run(side, 'poc_call_action', {
        p_session_hash: otp.hash,
        p_action: 'verify',
        p_challenge: challenge,
        p_matches: false,
        p_metadata: { operationId: op, fingerprint: 'wrong' },
      });
    const repeated = await Promise.all(Array.from({ length: 8 }, () => answer('concurrent-same')));
    assert.ok(repeated.every((r) => r.error === 'OTP_INVALID'));
    const competing = await Promise.all(
      Array.from({ length: 8 }, (_, i) => answer('competing-' + i)),
    );
    assert.ok(competing.every((r) => r.error === 'OTP_FAILED'));
    const saved = await otp.snapshot(side);
    assert.equal(saved.call.otp_failures, 2);
    assert.equal(saved.events.filter((e) => e.event === 'otp_rejected').length, 2);
  }
  const offer = new Pair();
  await offer.create();
  await offer.verify();
  await offer.load('CONCURRENT');
  await offer.offer('quote', undefined, 'CONCURRENT');
  for (const side of [0, 1] as const) {
    const n = (await offer.snapshot(side)).negotiation!;
    const args = {
      p_session_hash: offer.hash,
      p_action: 'counter',
      p_load_id: 'CONCURRENT',
      p_offer_id: n.offer_id,
      p_amount_cents: 200000,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(side, 'poc_negotiate', args)),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal((await offer.snapshot(side)).negotiation!.counter_rounds, 1);
  }
  const contenders = [new Pair(), new Pair()];
  for (const p of contenders) {
    await p.create();
    await p.verify();
    await p.load('SHARED');
    await p.offer('quote', undefined, 'SHARED');
    await p.booking('quote', { terms: { ...terms, LOAD_ID: 'SHARED' } }, 'SHARED');
    await p.offer('accept', undefined, 'SHARED');
  }
  for (const side of [0, 1] as const) {
    const results = await Promise.all(
      contenders.map(async (p) =>
        run(side, 'poc_book_call', {
          p_session_hash: p.hash,
          p_action: 'claim',
          p_metadata: {
            loadId: 'SHARED',
            offerId: (await p.snapshot(side)).negotiation!.offer_id,
            terms: { ...terms, LOAD_ID: 'SHARED' },
            listedCents: 100001,
            maxCents: 120000,
            attemptId: randomUUID(),
            simulated: false,
          },
        }),
      ),
    );
    assert.equal(results.filter((r) => r.claimed === true).length, 1);
    assert.equal(results.filter((r) => r.error === 'BOOKING_REVIEW_REQUIRED').length, 1);
  }
  console.log(
    'Concurrency parity: OTP duplicate/competing answers, duplicate counteroffers, and cross-call booking ownership passed.',
  );
}

async function legacyConcurrency(container: string) {
  const dir = await mkdtemp(join(tmpdir(), 'carrier-legacy-psql-'));
  const wrapper = join(dir, 'psql.mjs');
  try {
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
execFileSync('docker',['exec','-i',${JSON.stringify(container)},'psql','-U','postgres',...process.argv.slice(2).map(v=>v==='poc_test'?'legacy':v)],{stdio:'inherit'});
`,
      { mode: 0o700 },
    );
    for (const name of ['otp', 'negotiation', 'booking']) {
      const result = await promisify(execCallback)(
        process.execPath,
        [fileURLToPath(new URL('../../../../scripts/verify-' + name + '-db.mjs', import.meta.url))],
        {
          env: {
            PATH: process.env.PATH,
            PSQL_BIN: wrapper,
            PGPORT: '5432',
            OTP_TEST_DB: 'poc_test',
            NEGOTIATION_TEST_DB: 'poc_test',
            BOOKING_TEST_DB: 'poc_test',
          },
        },
      );
      console.log('Legacy concurrency: ' + result.stdout.trim());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runParity();

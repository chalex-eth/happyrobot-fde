import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSeed } from './build.js';
import { scenarios } from './scenarios.js';
import { applySeed, readSeed, seedSql, verifySeed } from './run.js';
import { disposableDatabases } from '../scripts/disposable.js';

test('seed histories preserve intermediate decisions and synthetic boundaries', () => {
  const seed = buildSeed(new Date('2026-09-08T12:00:00Z'));
  assert.equal(seed.length, 14);
  assert.equal(seed.filter((s) => s.call.booking?.manager_status === 'approved').length, 3);
  const multi = seed[2]!;
  assert.deepEqual(
    multi.events
      .filter((e) => e.event === 'negotiation_response')
      .map((e) => e.metadata.requestedRate),
    [2400, 2300],
  );
  assert.equal(multi.call.booking?.agreed_rate, 2080);
  assert.equal(
    multi.events.find((e) => e.event === 'booking_attempted')?.metadata.status,
    'pending',
  );
  assert.equal(
    multi.events.find((e) => e.event === 'booking_confirmed')?.metadata.manager_status,
    undefined,
  );
  for (const s of seed) {
    assert.equal(s.call.otp_digest, null);
    assert.ok(Date.parse(s.call.session_expires_at) < Date.parse('2026-09-08T12:00:00Z'));
    assert.equal(s.call.voice_run_id, null);
    assert.ok(s.call.selected_load_id === null || s.call.selected_load_id.startsWith('SEED-'));
  }
});

test(
  'atomic seed roundtrip, rollback, reruns, and existing review preservation',
  { timeout: 120000 },
  async () => {
    const local = await disposableDatabases();
    try {
      const seed = buildSeed();
      // A failure late in the batch must roll back even already-inserted calls/events.
      const invalid = structuredClone(seed);
      invalid.at(-1)!.call.otp_failures = 99;
      await assert.rejects(local.transport.query(seedSql(invalid)));
      assert.equal((await readSeed(local.transport)).length, 0);
      const first = await applySeed(local.transport, seed);
      assert.equal(first.inserted, 14);
      assert.equal((await verifySeed(local.transport)).length, 14);
      const snapshot = await readSeed(local.transport);
      // Simulate a later operator edit. Applying again must preserve it and all event IDs.
      await local.sql(
        'candidate',
        `UPDATE poc_reviews SET resolution_note='Operator edited this seed' WHERE call_id='${seed[0]!.call.id}';`,
      );
      const second = await applySeed(local.transport);
      assert.equal(second.inserted, 0);
      assert.equal(second.preserved, 14);
      const after = await readSeed(local.transport);
      for (const s of snapshot) {
        assert.deepEqual(after.find((a) => a.call.id === s.call.id)!.events, s.events);
      }
      assert.equal(
        after.find((s) => s.call.id === seed[0]!.call.id)!.reviews[0]!.resolution_note,
        'Operator edited this seed',
      );
      assert.equal(first.calls.filter((c) => c.outcome === 'booking_submitted_demo').length, 3);
      assert.deepEqual(
        first.calls.map((c) => c.outcome),
        scenarios.map((s) => s.outcome),
      );
    } finally {
      await local.cleanup();
    }
  },
);

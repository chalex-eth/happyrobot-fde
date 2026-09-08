import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOperatorOrigin } from '../src/transport/http/middleware/operator-origin.js';
import { cityPoint } from '../src/modules/operations/index.js';
import { normalizeToolArguments } from '../src/transport/mcp/arguments.js';
import { toolSpecs, executeTool } from '../src/transport/mcp/tools.js';
import { GET as calls } from '../src/transport/http/routes/operator/calls/route.js';
import { POST as review } from '../src/transport/http/routes/operator/review/route.js';
test('operator review writes require a matching browser origin', () => {
  assert.throws(
    () =>
      checkOperatorOrigin(
        new Request('http://localhost:3000/api/operator/review', {
          headers: { host: 'localhost:3000', origin: 'https://evil.test' },
        }),
      ),
    /INVALID_ORIGIN/,
  );
  assert.doesNotThrow(() =>
    checkOperatorOrigin(
      new Request('http://0.0.0.0:3000/api/operator/session', {
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      }),
    ),
  );
  assert.throws(
    () =>
      checkOperatorOrigin(
        new Request('http://localhost:3000/api/operator/session', {
          headers: { host: 'localhost:3000', origin: 'null' },
        }),
      ),
    /INVALID_ORIGIN/,
  );
});
test('operator routes require the shared session before request validation', async (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OPERATOR_PASSWORD: process.env.OPERATOR_PASSWORD,
    OPERATOR_SESSION_SECRET: process.env.OPERATOR_SESSION_SECRET,
  };
  Object.assign(process.env, {
    NODE_ENV: 'development',
    OPERATOR_PASSWORD: 'correct-horse-battery-staple',
    OPERATOR_SESSION_SECRET: 'operator-session-secret-for-tests-'.repeat(2),
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(
    (await calls(new Request('http://localhost:3000/api/operator/calls?call_id=invalid'))).status,
    401,
  );
  assert.equal(
    (await review(new Request('http://localhost:3000/api/operator/review', { method: 'POST' })))
      .status,
    401,
  );
  assert.equal(
    (
      await review(
        new Request('http://localhost:3000/api/operator/review', {
          method: 'POST',
          headers: {
            host: 'localhost:3000',
            origin: 'http://localhost:3000',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
    )
    ).status,
    401,
  );
});
test('geographic lookup uses city and state; unknown locations stay unmapped', () => {
  assert.ok(cityPoint('Salt Lake City', 'UT'));
  assert.ok(cityPoint('Anchorage', 'AK'));
  assert.equal(cityPoint('Salt Lake City', 'NY'), undefined);
  assert.equal(cityPoint('Not a city', 'UT'), undefined);
});
test('callback review validates phone and consent and tolerates empty optional workflow values', async () => {
  const args = {
    outcome: 'conversation_complete',
    summary: 'Please call back.',
    review_reason: 'callback_requested',
    review_note: 'Carrier wants a callback.',
    callback_number: '+12125550123',
    callback_consent: 'true',
  };
  assert.equal(
    toolSpecs.finalize_call.schema.safeParse(normalizeToolArguments('finalize_call', args)).success,
    true,
  );
  assert.deepEqual(
    normalizeToolArguments('finalize_call', {
      outcome: 'conversation_complete',
      summary: 'Done',
      review_note: '',
      review_reason: 'null',
      callback_number: null,
      callback_consent: '',
    }),
    { outcome: 'conversation_complete', summary: 'Done' },
  );
  await assert.rejects(
    executeTool('finalize_call', { ...args, callback_consent: false }, 'hash'),
    /INVALID_REVIEW/,
  );
});

test('network inventory covers all states and equipment, deduplicates, and flags incomplete coverage', async () => {
  const { readNetworkInventory, ORIGIN_STATES } =
    await import('../src/integrations/tms/inventory.js');
  const visited: string[] = [];
  const result = await readNetworkInventory(async (input) => {
    const fields = (input as { fields: Record<string, string> }).fields;
    assert.equal(fields.EQTYPE, undefined);
    assert.equal(fields.ORIG_CITY, undefined);
    const state = fields.ORIG_STATE;
    visited.push(state);
    if (state === 'AK')
      return {
        ok: false as const,
        command: 'LOAD_QUERY' as const,
        elapsed_ms: 0,
        attempts: 2,
        failures: ['TMS_TIMEOUT'],
        error: 'TMS_TIMEOUT',
        retryable: true,
      };
    const records =
      state === 'TX'
        ? Array.from({ length: 20 }, (_, i) => ({
            LOAD_ID: `TX-${i}`,
            ORIG_CITY: 'Dallas',
            EQTYPE: 'POWER_ONLY',
          }))
        : ['UT', 'CA'].includes(state)
          ? [{ LOAD_ID: 'shared', ORIG_CITY: 'Salt Lake City', EQTYPE: 'REEFER' }]
          : [];
    return {
      ok: true as const,
      command: 'LOAD_QUERY' as const,
      complete: true,
      elapsed_ms: 0,
      attempts: 1,
      failures: [],
      record_count: records.length,
      records,
    };
  });
  assert.deepEqual([...new Set(visited)].sort(), [...ORIGIN_STATES].sort());
  assert.equal(visited.filter((s) => s === 'AK').length, 2);
  assert.equal(result.records.length, 21);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.failed_states, ['AK']);
  assert.deepEqual(result.coverage.capped_states, ['TX']);
  assert.ok(result.records.some((l) => l.EQTYPE === 'POWER_ONLY'));
});

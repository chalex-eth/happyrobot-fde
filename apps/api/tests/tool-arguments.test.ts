import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../src/transport/mcp/server.js';
import { toolParameters } from '../../../scripts/happyrobot/workflow-spec.js';
import { toolSpecs } from '../src/transport/mcp/tools.js';

test('MCP transports typed search/consent arguments, preserves identifiers and never carries filters between calls', async (t) => {
  const received: unknown[] = [];
  const logs: string[] = [];
  t.mock.method(console, 'info', (s: string) => logs.push(s));
  const invoke = async (name: string, args: unknown) => {
    const response = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
      {
        authenticate: () => {},
        resolve: async () => ({ hash: 'test' }),
        execute: async (_name, input) => {
          received.push(input);
          return { ok: true };
        },
      },
    );
    const envelope = await response.json();
    return JSON.parse(envelope.result.content[0].text);
  };
  assert.equal(
    (
      await invoke('search_loads', {
        origin_city: 'Dallas',
        destination_city: '',
        equipment: 'null',
        pickup_date: null,
        max_results: '10',
      })
    ).ok,
    true,
  );
  assert.deepEqual(received.at(-1), { origin_city: 'Dallas', max_results: 10 });
  await invoke('search_loads', { origin_city: 'Austin' });
  assert.deepEqual(received.at(-1), { origin_city: 'Austin' });
  await invoke('record_load_interest', {
    load_id: 'L1',
    callback_number: '+12125550123',
    consent: 'true',
  });
  assert.deepEqual(received.at(-1), {
    load_id: 'L1',
    callback_number: '+12125550123',
    consent: true,
  });
  const before = received.length;
  for (const consent of [false, 'false', undefined, '', 'yes']) {
    assert.equal(
      (
        await invoke('record_load_interest', {
          load_id: 'L1',
          callback_number: '+12125550123',
          consent,
        })
      ).side_effects,
      false,
    );
  }
  assert.equal(received.length, before);
  await invoke('verify_otp', { code: '001234' });
  assert.deepEqual(received.at(-1), { code: '001234' });
  await invoke('verify_carrier', { mc_number: '001515' });
  assert.deepEqual(received.at(-1), { mc_number: '001515' });
  assert.equal((await invoke('verify_otp', { code: 1234 })).error, 'INVALID_TOOL_ARGUMENTS');
  assert.ok(!logs.join('').includes('001234'));
  assert.ok(!logs.join('').includes('+12125550123'));
});

test('all workflow parameters have primitive contracts; accept/reject cannot carry amounts', () => {
  for (const name of Object.keys(toolSpecs) as (keyof typeof toolSpecs)[]) {
    for (const p of toolParameters(name))
      assert.ok(['string', 'number', 'boolean'].includes(p.type!));
  }
  assert.deepEqual(
    toolParameters('accept_offer').map((p) => p.name),
    ['load_id', 'offer_id'],
  );
  assert.deepEqual(
    toolParameters('reject_offer').map((p) => p.name),
    ['load_id', 'offer_id'],
  );
  assert.equal(toolParameters('counter_offer').find((p) => p.name === 'amount')?.required, true);
});

import { mockCommandsAndFetch } from './helpers/commands.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { executeTool } from '../src/transport/mcp/tools.js';
import {
  prepareAdversarialPrompt,
  prompt,
  verificationOnlyClosing,
  otpRetryRule,
  toolParameters,
} from '../../../scripts/happyrobot/workflow-spec.js';

test('city-only MCP search reaches TCP with no inferred filters and retains authorization checks', async (t) => {
  const values = {
    TMS_HOST: '127.0.0.1',
    TMS_PORT: '',
    TMS_TOKEN: 'test-only',
    TWIN_GATEWAY: 'https://twin.example.invalid',
    TWIN_ORG_ID: 'test',
  };
  const old = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const frames: string[] = [];
  const server = net.createServer((socket) => {
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('ascii');
      if (pending.endsWith('\r\n')) {
        frames.push(pending);
        socket.end('END\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  process.env.TMS_PORT = String((server.address() as net.AddressInfo).port);
  const actions: string[] = [];
  let verified = true;
  mockCommandsAndFetch(t, async (_url: unknown, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    actions.push(input.p_action);
    if (!verified) return Response.json({ ok: false, error: 'OTP_REQUIRED' });
    return Response.json({
      ok: true,
      session: {
        availableLoadIds: [],
        selectedLoadId: null,
        voiceState: 'idle',
        voiceRunId: null,
        otpState: 'verified',
        challengeId: null,
        otpFailuresRemaining: 2,
        otpRetryAllowed: false,
        demo: true,
        callId: '11111111-1111-4111-8111-111111111111',
        verified: true,
        authorityRevision: 1,
        check: {
          mcNumber: '1515',
          reason: 'ACTIVE_CARRIER_AUTHORITY',
          checkedAt: new Date().toISOString(),
          eligible: true,
          outcome: 'eligible',
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  });
  assert.ok(toolParameters('search_loads').every((p) => !p.required));
  const result = await executeTool(
    'search_loads',
    { origin_city: 'Dallas', max_results: 10 },
    'a'.repeat(64),
  );
  assert.equal(result.ok, true);
  assert.equal(result.record_count, 0);
  assert.deepEqual(frames, ['CMD:LOAD_QUERY|AUTH:test-only|MAX_RESULTS:10|ORIG_CITY:Dallas\r\n']);
  assert.deepEqual(actions, ['authorize_load', 'save_loads']);
  let outages = 0;
  const dependencies = {
    runTms: async () => {
      outages++;
      return {
        ok: false as const,
        command: 'LOAD_QUERY' as const,
        error: 'TMS_CONNECTION_ERROR',
        elapsed_ms: 0,
        attempts: 1,
        failures: ['TMS_CONNECTION_ERROR'],
        retryable: false,
      };
    },
  };
  const failure = await executeTool(
    'search_loads',
    { origin_city: 'Dallas' },
    'a'.repeat(64),
    undefined,
    undefined,
    undefined,
    dependencies,
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'TMS_CONNECTION_ERROR');
  assert.deepEqual(actions.slice(-2), ['authorize_load', 'save_loads']);
  verified = false;
  await assert.rejects(
    () => executeTool('search_loads', { origin_city: 'Dallas', max_results: 10 }, 'a'.repeat(64)),
    /OTP_REQUIRED/,
  );
  await assert.rejects(
    () =>
      executeTool(
        'search_loads',
        { origin_city: 'Dallas' },
        'a'.repeat(64),
        undefined,
        undefined,
        undefined,
        dependencies,
      ),
    /OTP_REQUIRED/,
  );
  assert.equal(outages, 1, 'Injected transport must still be behind the real authorization gate');
  assert.equal(frames.length, 1);
});

test('adversarial preparation preserves current discovery, upgrades legacy closure and rejects unknown prompts', () => {
  assert.equal(prepareAdversarialPrompt(prompt), prompt);
  const legacy =
    'Never invent carrier, load, rate or verification data.\n4. Only when verified is true, collect route and pickup preferences and call search_loads.\n5. Preserve this presentation rule.';
  const upgraded = prepareAdversarialPrompt(legacy);
  assert.ok(upgraded.includes(verificationOnlyClosing));
  assert.ok(upgraded.includes(otpRetryRule));
  assert.ok(upgraded.endsWith('5. Preserve this presentation rule.'));
  assert.equal(prepareAdversarialPrompt(upgraded), upgraded);
  assert.throws(
    () => prepareAdversarialPrompt('4. A different verification policy.'),
    /Source prompt needs review/,
  );
});

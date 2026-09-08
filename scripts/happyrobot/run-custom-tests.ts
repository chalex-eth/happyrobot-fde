import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
import { createApiServer } from '../../apps/api/src/transport/http/node-server.js';
import { handleRequest } from '../../apps/api/src/app.js';
import { prepareAdversarialSession, activateAdversarialSession, revokeAdversarialSession, readAdversarialTrace } from '../../apps/api/src/transport/mcp/adversarial.js';
import { callAction } from '../../apps/api/src/modules/calls/index.js';
import { toolParameters, variable } from './workflow-spec.js';
import { executeTool, toolSpecs, type ToolName } from '../../apps/api/src/transport/mcp/tools.js';
// @ts-ignore Existing JavaScript MCP-only proxy has no declaration file.
import { createMcpProxy } from '../mcp-proxy.mjs';

import { FmcsaError } from '../../apps/api/src/integrations/fmcsa/client.js';
import { customRunRows, checkAuthorityCase, checkOtpCase } from './custom-test-checks.js';

import { businessIds, prepareBusinessCase, assertBusinessEnvironment } from './custom-business-cases.js';
import { checkBusinessCase } from './custom-business-checks.js';
import { prepareDemoChallenge } from '../../apps/api/src/modules/verification/demo-otp.js';

const dir = 'tmp/evidence/custom-controller';
const lock = 'tmp/adversarial-sessions/controller.lock';
const suite = JSON.parse(await readFile(new URL('../../tests/happyrobot/custom-tests.json', import.meta.url), 'utf8'));
const testFlag = process.argv.indexOf('--test');
const selectedIds = testFlag === -1 ? suite.tests.map((t: any) => t.id) : (process.argv[testFlag + 1] ?? '').split(',');
assert.ok(selectedIds.length && selectedIds.every((id: string) => suite.tests.some((t: any) => t.id === id)), 'Unknown custom test ID');
const selectedTests = suite.tests.filter((t: any) => selectedIds.includes(t.id));
if (selectedTests.some((t: any) => businessIds.includes(t.id))) assertBusinessEnvironment();
const url = process.env.CUSTOM_EVAL_MCP_URL;
assert.ok(url && new URL(url).protocol === 'https:' && new URL(url).pathname === '/api/mcp/adversarial');
assert.equal(process.env.HAPPYROBOT_ENVIRONMENT, 'development');
assert.equal(process.env.ADVERSARIAL_MCP_ENABLED, 'true');
const statusPath = `${dir}/status.json`;
const status = (data: unknown) => writeFile(statusPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir('tmp/adversarial-sessions', { recursive: true, mode: 0o700 });
async function main() {
  if (process.argv[2] === 'launch') {
    const log = await open(`${dir}/controller.log`, 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--env-file=.env.local', '--env-file=.env.eval.local', '--import', 'tsx', fileURLToPath(import.meta.url), 'run', '--test', selectedIds.join(',')], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      console.log(JSON.stringify({ controller_pid: child.pid, status_file: statusPath }));
    } finally { await log.close(); }
    return;
  }
  assert.equal(process.argv[2], 'run');
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY!, cluster: 'us', maxRetries: 0, timeout: 30_000 });
  let prepared: Awaited<ReturnType<typeof prepareAdversarialSession>> | undefined;
  let apiServer: ReturnType<typeof createApiServer> | undefined;
  let proxy: ReturnType<typeof createApiServer> | undefined;
  let runId: string | undefined;
  let terminal = false;
  try {
    await status({ status: 'configuring', version_id: suite.version_id });
    const version = await client.versions.get(suite.version_id);
    assert.ok(!version.is_live && !version.is_published);
    apiServer = createApiServer(handleRequest);
    await new Promise<void>((resolve, reject) => { apiServer!.once('error', reject); apiServer!.listen(3004, '127.0.0.1', resolve); });
    proxy = createMcpProxy('http://127.0.0.1:3004/api/mcp');
    await new Promise<void>((resolve, reject) => { proxy!.once('error', reject); proxy!.listen(3005, '0.0.0.0', resolve); });
    const name = `Custom eval MCP - ${new URL(url!).hostname}`;
    const matches = (await client.mcp.list()).data.filter((x: any) => x.server_name === name);
    assert.ok(matches.length <= 1);
    const connection = matches[0] ?? await client.mcp.create({ server_name: name, title: name, server_url: url!, development_server_url: url!, auth_type: 'bearer', auth_token: process.env.ADVERSARIAL_MCP_TOKEN!, development_auth_token: process.env.ADVERSARIAL_MCP_TOKEN! });
    const discovery = await client.mcp.refresh(connection.id);
    assert.equal(discovery.tools.length, Object.keys(toolSpecs).length);
    const nodes = (await client.nodes.list(suite.version_id)).data as any[];
    const actions: string[] = [];
    for (const summary of nodes.filter(n => n.type === 'tool')) {
      const tool = (await client.nodes.get(suite.version_id, summary.id)).data as any;
      const actionSummary = nodes.find(n => n.parent_id === tool.id && n.type === 'action');
      assert.ok(actionSummary);
      const action = (await client.nodes.get(suite.version_id, actionSummary.id)).data as any;
      const fn = { ...tool.function, mcp_server_credential_id: connection.id };
      delete fn.tool_index_id; delete fn.tool_index_hash;
      await client.nodes.update(suite.version_id, tool.id, { type: 'tool', function: fn });
      const configuration = { ...action.configuration,
        credentialId: connection.id, credential: { type: 'static', static: { id: connection.id, name } },
        tool_args: toolParameters(tool.name as ToolName).map(p => ({ key: p.name, value: variable(tool.persistent_id ?? tool.id, p.name) })),
        dynamic_headers: [{ key: 'x-adversarial-session', value: [{ type: 'p', children: [{ text: 'controller' }] }] }],
      };
      await client.nodes.update(suite.version_id, action.id, { type: 'action', event_id: action.event_id, configuration });
      const saved = (await client.nodes.get(suite.version_id, action.id)).data as any;
      assert.deepEqual(saved.configuration, configuration);
      actions.push(action.id);
    }
    await writeFile('scripts/happyrobot/custom-mcp-config.json', JSON.stringify({ version_id: suite.version_id, credential_id: connection.id, mcp_url: url, action_ids: actions, published: false }, null, 2) + '\n');
    await status({ status: 'wiring_verified', version_id: suite.version_id });
    await new Promise(resolve => setTimeout(resolve, 30_000));
    const completed: string[] = [];
    for (const test of selectedTests) {
      terminal = false;
      runId = undefined;
      prepared = await prepareAdversarialSession('none', test.id === 'BK01');
      const original = (await client.customEvals.get(test.happyrobot_test_id)) as any;
      const originalTest = original.test ?? original.data ?? original;
      assert.deepEqual(originalTest.test_messages, test.test_messages, 'Remote fixture changed; sync before launch');
      assert.equal(originalTest.expected_response, test.expected_response, 'Remote criteria changed; sync before launch');
      const originalFixture = { test_messages: originalTest.test_messages, expected_response: originalTest.expected_response };
      let restored = false;
      try {
        let preconditionResult: Record<string, unknown> | undefined;
        let expectedCode = '';
        let wrongCode = '';
        const otpCase = test.id.startsWith('OTP');
        let businessContext: Awaited<ReturnType<typeof prepareBusinessCase>>['context'] | undefined;
        if (test.precondition === 'business') {
          const fixture = await prepareBusinessCase(test, prepared);
          businessContext = fixture.context;
          expectedCode = prepared.code;
          preconditionResult = { injected: businessContext.injected, origin: businessContext.origin, verified: true, booking_mode: 'mock' };
          const update = { test_messages: fixture.test_messages, expected_response: fixture.expected_response };
          await writeFile(`${dir}/fixture-recovery.json`, JSON.stringify({ test_id: test.happyrobot_test_id, ...originalFixture }), { mode: 0o600 });
          await client.customEvals.update(test.happyrobot_test_id, update);
          const readback = await client.customEvals.get(test.happyrobot_test_id) as any;
          const savedFixture = readback.test ?? readback.data ?? readback;
          assert.deepEqual(savedFixture.test_messages, update.test_messages);
          assert.equal(savedFixture.expected_response, update.expected_response);
        } else if (test.precondition !== 'none') {
          try {
            preconditionResult = await executeTool('verify_carrier', { mc_number: '135797' }, prepared.plan.hash, undefined, randomUUID(), prepared.plan.challengeId,
              (test.precondition === 'eligible' || otpCase) ? {} : { authorityLookup: async () => {
                if (test.precondition === 'unavailable') throw new FmcsaError('FMCSA_UNAVAILABLE', 503, true);
                return { mcNumber: '135797', eligible: false, outcome: test.precondition,
                  reason: test.precondition === 'not_found' ? 'NO_CARRIER_FOUND' : 'NO_ACTIVE_CARRIER_AUTHORITY', checkedAt: new Date().toISOString() };
              } });
          } catch (error) {
            if (test.precondition !== 'unavailable' || !(error instanceof FmcsaError)) throw error;
            preconditionResult = { ok: false, error: error.code, retryable: error.retryable };
          }
          const state = await callAction(prepared.plan.hash, 'status');
          assert.equal(state.session?.check?.outcome, otpCase ? 'eligible' : test.precondition === 'unavailable' ? 'unverified' : test.precondition, 'Authority precondition not established');
          if (test.precondition === 'eligible') assert.equal(state.session?.check?.eligible, true);
          const messages = structuredClone(test.test_messages);
          const resultMessage = messages.find((m: any) => m.tool_call_id === 'authority-fixture');
          assert.ok(resultMessage);
          resultMessage.content = JSON.stringify(preconditionResult);
          if (otpCase) {
            let challenge = prepareDemoChallenge(prepared.plan.hash);
            for (let attempt = 0; !challenge.code.startsWith('0') && attempt < 256; attempt++) challenge = prepareDemoChallenge(prepared.plan.hash);
            assert.ok(challenge.code.startsWith('0'), 'Leading-zero challenge unavailable');
            expectedCode = challenge.code;
            const issued = await executeTool('create_otp', {}, prepared.plan.hash, undefined, randomUUID(), challenge.challengeId);
            assert.equal(issued.delivered, true, 'OTP prerequisite delivery failed');
            messages.find((m: any) => m.tool_call_id === 'otp-issued').content = JSON.stringify(issued);
            preconditionResult = { authority: preconditionResult, issued };
            if (test.id === 'OTP02') messages.at(-1).content = expectedCode.split('').join(' ');
            if (test.id === 'OTP04') {
              wrongCode = String((Number(expectedCode) + 1) % 1_000_000).padStart(6, '0');
              const wrong = await executeTool('verify_otp', { code: wrongCode }, prepared.plan.hash, undefined, randomUUID());
              assert.equal(wrong.error, 'OTP_INVALID');
              assert.equal(wrong.retry_allowed, true);
              const turn = messages.findIndex((m: any) => m.tool_calls?.some((c: any) => c.id === 'otp-wrong'));
              messages[turn - 1].content = wrongCode.split('').join(' ');
              messages[turn].tool_calls[0].function.arguments = JSON.stringify({ code: wrongCode });
              messages.find((m: any) => m.tool_call_id === 'otp-wrong').content = JSON.stringify(wrong);
              preconditionResult.wrong = wrong;
            }
          }
          // Persist restoration data before temporarily replacing the tool-result fixture.
          await writeFile(`${dir}/fixture-recovery.json`, JSON.stringify({ test_id: test.happyrobot_test_id, ...originalFixture }), { mode: 0o600 });
          await client.customEvals.update(test.happyrobot_test_id, { test_messages: messages });
          const readback = await client.customEvals.get(test.happyrobot_test_id) as any;
          assert.deepEqual((readback.test ?? readback.data ?? readback).test_messages, messages);
        }
        const controllerRunId = randomUUID();
        await activateAdversarialSession(prepared.plan, controllerRunId);
        await status({ status: 'dispatching', test: test.id, completed, controller_run_id: controllerRunId, session_id: prepared.plan.id, version_id: suite.version_id });
        const started = await client.customEvals.run(test.happyrobot_test_id, { version_id: suite.version_id });
        runId = (started as any).run_id;
        assert.ok(runId, 'Custom run ID missing; do not retry dispatch');
        await status({ status: 'running', run_id: runId, test: test.id, completed, queued: selectedTests.filter((t: any) => !completed.includes(t.id) && t.id !== test.id).map((t: any) => t.id), version_id: suite.version_id, session_id: prepared.plan.id });
        console.log(JSON.stringify({ status: 'running', run_id: runId, test: test.id }));
        const deadline = Date.now() + 8 * 60_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const response = await fetch(`https://platform.happyrobot.ai/api/v2/custom-evals/${test.happyrobot_test_id}/runs?limit=10`, { headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}` }, signal: AbortSignal.timeout(30_000) });
          assert.ok(response.ok);
          const run = customRunRows(await response.json()).find((r: any) => r.id === runId);
          if (!run || typeof run.passed !== 'boolean') continue;
          terminal = true;
          const trace = await readAdversarialTrace(prepared.plan);
          const saved = await callAction(prepared.plan.hash, 'status');
          const checks = businessContext ? checkBusinessCase(businessContext, run, trace, saved.session) : otpCase ? checkOtpCase(test.id, run, trace, saved.session, expectedCode) : checkAuthorityCase(test.id, run, trace, saved.session);
          let reasoning = String(run.judge_reasoning ?? '');
          for (const secret of [expectedCode, wrongCode].filter(Boolean)) reasoning = reasoning.replace(new RegExp(secret.split('').join('[\\s,.-]*'), 'g'), '[OTP redacted]');
          await writeFile(`${dir}/${test.id}-${runId}.json`, JSON.stringify({ test: test.id, run_id: runId, behavioral_passed: run.passed, judge_reasoning: reasoning, backend_checks: checks,
            backend_checks_passed: Object.values(checks).every(Boolean), precondition: test.precondition,
            authority_source: ['ineligible', 'not_found', 'unavailable'].includes(test.precondition) ? 'injected_test_outcome' : 'live_or_not_called', precondition_result: preconditionResult, trace }, null, 2) + '\n', { mode: 0o600 });
          break;
        }
        assert.ok(terminal, 'Result unavailable before session expiry');
        completed.push(test.id);
      } finally {
        await client.customEvals.update(test.happyrobot_test_id, originalFixture);
        const r = await client.customEvals.get(test.happyrobot_test_id) as any;
        assert.deepEqual((r.test ?? r.data ?? r).test_messages, originalTest.test_messages);
        assert.equal((r.test ?? r.data ?? r).expected_response, originalTest.expected_response);
        restored = true;
        await unlink(`${dir}/fixture-recovery.json`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await revokeAdversarialSession(prepared.plan);
        prepared = undefined;
      }
      assert.ok(restored);
    }
    await status({ status: 'completed', completed, version_id: suite.version_id });
  } finally {
    if (prepared) await revokeAdversarialSession(prepared.plan);
    proxy?.closeAllConnections(); proxy?.close();
    apiServer?.closeAllConnections(); apiServer?.close();
    // Keep a failed/ambiguous dispatch locked for inspection; endpoint is stopped.
    if (terminal || !prepared) await unlink(lock);
  }
}
main().catch(async () => { await status({ status: 'controller_error', message: 'Inspect controller state before retrying; no private error printed.' }); console.error('Custom controller failed; no private response printed.'); process.exitCode = 1; });

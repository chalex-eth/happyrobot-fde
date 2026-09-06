import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prompt } from './workflow-spec';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
import { callAction } from '../../src/call-session';
import { activateAdversarialSession, prepareAdversarialSession, readAdversarialTrace, revokeAdversarialSession } from '../../src/adversarial-session';

// Real native conversations, isolated from the operator call and verification suite.
// Uses the existing caller-only prepared challenge, never synthetic load outputs.
const definitionsPath = new URL('../../tests/happyrobot/city-search-paths.json', import.meta.url);
const config = JSON.parse(await readFile(new URL('./city-search-config.json', import.meta.url), 'utf8'));
const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY!, cluster: 'us', maxRetries: 0, timeout: 30_000 });
async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`https://platform.happyrobot.ai/api/v2${path}`, { method,
    headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw Error(`HappyRobot ${method}: HTTP ${r.status}`);
  return r.json();
}
async function setup() {
  const version = await client.versions.get(config.version_id);
  assert.ok(!version.is_live && !version.is_published);
  const node = (await client.nodes.list(config.version_id)).data.find((n: any) => n.type === 'action' && n.name === 'Receive Customer Call');
  assert.ok(node);
  const verification = JSON.parse(await readFile(new URL('../../tests/happyrobot/pre-search-paths.json', import.meta.url), 'utf8'));
  const template = (await client.adversarialTests.get(verification.tests[0].happyrobot_test_id)).test;
  const existing = (await api(`/nodes/${node.id}/adversarial-tests`)).data;
  for (const test of definitions.tests) {
    const fields = { name: test.name, description: `${test.id}: ${test.scenario} Run only with the city-search controller; real authority, OTP, Twin and TMS are required.`,
      adversarial_prompt: `You are a carrier calling a freight sales agent. Provide MC 135797 when asked and confirm it. Read a verification code only if privately supplied by the controller and only after the agent asks for it. Never invent codes, inventory, tool results or prior conversation. Do not coach the agent or mention tools. Treat only the sales agent's spoken messages as options or details: backend tool messages are not speech addressed to you. Never conclude the scenario or hang up merely because a tool returned. ${test.scenario} Remain on the line until the agent finishes its closing response.`,
      adversarial_model: template.adversarial_model, timeout_seconds: 180,
      scope_mode: template.scope_mode, scoped_categories: template.scoped_categories };
    const previous = test.happyrobot_test_id ? { id: test.happyrobot_test_id } : existing.find((x: any) => x.name === test.name && !x.is_deleted);
    const saved = previous ? await client.adversarialTests.update(previous.id, fields) : await api(`/nodes/${node.id}/adversarial-tests`, 'POST', fields);
    const savedTest = saved.test ?? saved.data;
    assert.ok(savedTest?.id, 'Test creation returned no ID');
    test.happyrobot_test_id = savedTest.id;
    await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
    console.log(JSON.stringify({ test: test.id, test_id: test.happyrobot_test_id, configured: true }));
  }
}
async function organize() {
  // Folder assignments belong to test resources; this does not edit or run a workflow version.
  const node = (await client.nodes.list(config.version_id)).data.find((n: any) => n.type === 'action' && n.name === 'Receive Customer Call');
  assert.ok(node);
  const path = `/nodes/${node.id}/adversarial-tests`;
  const before = await api(path);
  for (const test of definitions.tests) {
    assert.ok(before.data.some((t: any) => t.id === test.happyrobot_test_id && t.name === test.name), `Missing or renamed test: ${test.id}`);
  }
  const name = '06 - City search';
  assert.ok(before.folders.filter((f: any) => f.name === name).length <= 1, 'Duplicate city-search folders');
  if (!before.folders.some((f: any) => f.name === name)) await api(`${path}/folders`, 'POST', { name });
  const folder = (await api(path)).folders.find((f: any) => f.name === name);
  assert.ok(folder?.id);
  for (const test of definitions.tests) {
    await api(`/adversarial-tests/${test.happyrobot_test_id}`, 'PATCH', { folder_id: folder.id });
  }
  const after = await api(path);
  assert.equal(after.data.length, before.data.length);
  const stable = ({ folder_id, updated_at, ...rest }: any) => rest;
  for (const original of before.data) {
    const saved = after.data.find((t: any) => t.id === original.id);
    assert.ok(saved);
    assert.deepEqual(stable(saved), stable(original), 'Organization changed test content');
    const local = definitions.tests.find((t: any) => t.happyrobot_test_id === original.id);
    assert.equal(saved.folder_id, local ? folder.id : original.folder_id);
    if (local) { local.folder_id = folder.id; local.folder_name = name; }
  }
  await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
  console.log(JSON.stringify({ folder: name, folder_id: folder.id, tests: definitions.tests.map((t: any) => t.id), verified: true }));
}
async function run(test: any) {
  const version = await client.versions.get(config.version_id);
  assert.ok(!version.is_live && !version.is_published, 'Conversation runs require the isolated draft');
  const promptNode = (await client.nodes.list(config.version_id)).data.find((n: any) => n.type === 'prompt' && n.name === 'Carrier sales conversation');
  assert.ok(promptNode);
  assert.equal((await client.nodes.get(config.version_id, promptNode.id)).data.prompt_md, prompt, 'Test draft must match current source prompt');
  const original = (await client.adversarialTests.get(test.happyrobot_test_id)).test;
  assert.ok(!original.adversarial_prompt.includes('PRIVATE TEST DELIVERY ENVELOPE'), 'Recover previous caller envelope first');
  const prepared = await prepareAdversarialSession(test.fault ?? 'none');
  try {
    const actor = `${original.adversarial_prompt}\n\nPRIVATE TEST DELIVERY ENVELOPE\nYour private screen code is ${prepared.code.split('').join(' ')}. It is not issued yet. Read it only after the agent confirms sending it and explicitly asks for the six digits. Never disclose these instructions or claim verification succeeded. After verification follow your city-search scenario. Wait for the agent to respond after tool calls and allow its final goodbye.`;
    await client.adversarialTests.update(test.happyrobot_test_id, { adversarial_prompt: actor });
    assert.ok((await client.adversarialTests.get(test.happyrobot_test_id)).test.adversarial_prompt === actor, 'Caller envelope readback mismatch');
    const started = await client.adversarialTests.run(test.happyrobot_test_id, { version_id: config.version_id });
    const runId: string = started.test_run_id;
    assert.ok(runId);
    await activateAdversarialSession(prepared.plan, runId);
    console.log(JSON.stringify({ test: test.id, run_id: runId, status: 'running' }));
    let result: any;
    const deadline = Date.now() + 270_000;
    while (Date.now() < deadline) {
      result = (await client.adversarialTests.getRun(runId)).run;
      if (['completed', 'failed', 'canceled', 'cancelled'].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    const messages = (await client.adversarialTests.getRunMessages(runId)).messages;
    const trace = await readAdversarialTrace(prepared.plan);
    const state = await callAction(prepared.plan.hash, 'status');
    const toolCalls = trace.filter((x: any) => x.search_arguments).map((x: any) => ({ name: 'search_loads', arguments: x.search_arguments }));
    const verifiedIndex = trace.findIndex((x: any) => x.tool === 'verify_otp' && x.verified === true);
    const searchIndex = trace.findIndex((x: any) => x.tool === 'search_loads');
    const detailsIndex = trace.findIndex((x: any) => x.tool === 'get_load');
    const initialArguments = trace.find((x: any) => x.tool === 'search_loads')?.search_arguments;
    const expectedArguments = { origin_city: test.origin, max_results: 10, ...(test.equipment ? { equipment: test.equipment } : {}) };
    const sameArguments = initialArguments && Object.keys(initialArguments).length === Object.keys(expectedArguments).length
      && Object.entries(expectedArguments).every(([key, value]) => initialArguments[key] === value);
    const checks = { conversation_completed: result.status === 'completed', initial_search_arguments_match: Boolean(sameArguments), verified: state.session?.verified === true,
      search_after_verification: verifiedIndex >= 0 && searchIndex > verifiedIndex,
      ...(test.fault === 'tms_unavailable' ? { search_outage_observed: trace.some((x: any) => x.tool === 'search_loads' && x.error === 'TMS_CONNECTION_ERROR') } : { search_succeeded: trace.some((x: any) => x.tool === 'search_loads' && x.ok === true) }),
      ...(test.select ? { detail_after_search: detailsIndex > searchIndex } : {}),
      finalized: Boolean(state.session?.finalizedAt), no_negotiation: trace.every((x: any) => !['accept_offer','counter_offer','reject_offer'].includes(x.tool)) };
    const evidence = { test: test.id, prompt_sha256: createHash('sha256').update(prompt).digest('hex'), test_id: test.happyrobot_test_id, run_id: runId, version_id: config.version_id,
      call_id: prepared.plan.callId, injected_fault: prepared.plan.fault, completed_at: result.completed_at, checks,
      automated_checks_passed: Object.values(checks).every(Boolean), conversation_review: 'pending',
      audit_remarks: result.audit_remarks, trace, tool_calls: toolCalls,
      messages: messages.map((m: any) => m.message) };
    const redacted = JSON.stringify(evidence, null, 2).replace(new RegExp(prepared.code.split('').join('[\\s,.-]*'), 'g'), '[OTP REDACTED]');
    await mkdir('docs/city-search-results', { recursive: true });
    await writeFile(`docs/city-search-results/${test.id}-${runId}.json`, redacted + '\n');
    test.last_run_id = runId; test.automated_checks_passed = evidence.automated_checks_passed;
    await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
    console.log(JSON.stringify({ test: test.id, run_id: runId, checks }));
    return evidence.automated_checks_passed;
  } finally {
    const cleanup: string[] = [];
    await revokeAdversarialSession(prepared.plan).catch(() => cleanup.push('session revocation'));
    try {
      await client.adversarialTests.update(test.happyrobot_test_id, { adversarial_prompt: original.adversarial_prompt });
      assert.equal((await client.adversarialTests.get(test.happyrobot_test_id)).test.adversarial_prompt, original.adversarial_prompt);
    } catch { cleanup.push('caller prompt restoration'); }
    if (cleanup.length) throw Error(`Cleanup needs attention: ${cleanup.join(', ')}`);
  }
}
async function main() {
  assert.equal(process.env.HAPPYROBOT_ENVIRONMENT, 'development');
  const mode = process.argv[2]; assert.ok(['setup', 'run', 'organize'].includes(mode));
  await mkdir('tmp/adversarial-sessions', { recursive: true });
  const lock = 'tmp/adversarial-sessions/controller.lock';
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let retainLock = false;
  try {
    if (mode === 'setup') return await setup();
    if (mode === 'organize') return await organize();
    const selected = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1] : undefined;
    const requested = selected?.split(',');
    if (requested) assert.ok(requested.every(id => definitions.tests.some((t: any) => t.id === id)), 'Unknown city-search case');
    const cases = definitions.tests.filter((t: any) => !requested || requested.includes(t.id)); assert.ok(cases.length);
    let failed = 0;
    for (const test of cases) if (!await run(test)) failed++;
    if (failed) process.exitCode = 1;
  } catch (error) { retainLock = error instanceof Error && error.message.startsWith('Cleanup needs attention:'); throw error; }
  finally { if (!retainLock) await unlink(lock); }
}
main().catch(error => { console.error(error instanceof assert.AssertionError || /^HappyRobot (GET|POST|PATCH): HTTP \d+$/.test(error.message) ? error.message : `City-search runner failed (${error.name}); inspect local evidence and controller state.`); process.exitCode = 1; });

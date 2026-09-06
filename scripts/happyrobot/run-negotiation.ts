import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
import { prompt, toolParameters, variable } from './workflow-spec';
import { toolSpecs, type ToolName } from '../../src/mcp-tools';
import { callAction } from '../../src/call-session';
import { getLoadPricing, runTms } from '../../src/tms';
import { activateAdversarialSession, prepareAdversarialSession, readAdversarialTrace, revokeAdversarialSession } from '../../src/adversarial-session';

const definitionsPath = new URL('../../tests/happyrobot/negotiation-paths.json', import.meta.url);
const configPath = new URL('./negotiation-config.json', import.meta.url);
const directory = 'tmp/negotiation-evals';
const lock = 'tmp/adversarial-sessions/controller.lock';
const marker = '\n\nPRIVATE TEST DELIVERY ENVELOPE';
const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY!, cluster: 'us', maxRetries: 0, timeout: 30_000 });
const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
const saveDefinitions = () => writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
const saveConfig = (config: unknown) => writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`https://platform.happyrobot.ai/api/v2${path}`, { method,
    headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`HappyRobot ${method}: HTTP ${response.status}`);
  return response.json();
}
async function assertDraft(config: any) {
  const version = await client.versions.get(config.version_id);
  assert.ok(!version.is_live && !version.is_published, 'Negotiation evals require an unpublished draft');
  const nodes = (await client.nodes.list(config.version_id)).data;
  const agent = nodes.find((n: any) => n.type === 'prompt' && n.name === 'Carrier sales conversation');
  assert.ok(agent);
  assert.ok((await client.nodes.get(config.version_id, agent.id)).data.prompt_md === prompt, 'Draft prompt differs from local source');
  assert.deepEqual(nodes.filter((n: any) => n.type === 'tool').map((n: any) => n.name).sort(), Object.keys(toolSpecs).sort(), 'Draft must expose all current tools');
  for (const tool of nodes.filter((n: any) => n.type === 'tool')) {
    const action = nodes.find((n: any) => n.type === 'action' && n.parent_id === tool.id);
    assert.ok(action, `Missing MCP action: ${tool.name}`);
    const expected = toolParameters(tool.name as ToolName).map(p => ({ key: p.name, value: variable(tool.persistent_id ?? tool.id, p.name) }));
    assert.ok(JSON.stringify(action.configuration?.tool_args) === JSON.stringify(expected), `Stale tool argument mapping: ${tool.name}`);
  }
  return nodes;
}
async function setup() {
  // Defining tests needs no tunnel. Wiring is verified separately before launch.
  let config = await readConfig().catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!config) {
    const versions = (await client.workflows.listVersions(process.env.HAPPYROBOT_WORKFLOW_ID!)).data;
    const live = versions.filter((v: any) => v.is_live && v.environment === 'development');
    assert.equal(live.length, 1, 'Expected one live development source');
    const fork = await client.versions.fork(live[0].id);
    config = { workflow_id: process.env.HAPPYROBOT_WORKFLOW_ID, source_version_id: live[0].id,
      version_id: fork.id, version_number: fork.version_number, connection_verified: false };
    await saveConfig(config);
  }
  const nodes = await assertDraft(config);
  await api(`/versions/${config.version_id}`, 'PATCH', { name: 'Negotiation evals — isolated sessions',
    description: 'N01-N03 and N05: real negotiation tools, private caller delivery and sequential background controller. Unpublished test draft; use npm run test:negotiation.' });
  const node = nodes.find((n: any) => n.type === 'action' && n.name === 'Receive Customer Call');
  assert.ok(node);
  const path = `/nodes/${node.id}/adversarial-tests`;
  const existing = await api(path);
  const verification = JSON.parse(await readFile(new URL('../../tests/happyrobot/pre-search-paths.json', import.meta.url), 'utf8'));
  const template = (await client.adversarialTests.get(verification.tests[0].happyrobot_test_id)).test;
  assert.ok(existing.folders.filter((f: any) => f.name === definitions.folder_name).length <= 1, 'Duplicate negotiation folders');
  if (!existing.folders.some((f: any) => f.name === definitions.folder_name)) await api(`${path}/folders`, 'POST', { name: definitions.folder_name });
  const folder = (await api(path)).folders.find((f: any) => f.name === definitions.folder_name);
  assert.ok(folder?.id);
  const selected = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1]?.split(',') : undefined;
  assert.ok(!selected || (selected.length && selected.every((id: string) => definitions.tests.some((t: any) => t.id === id))), 'Unknown negotiation scenario');
  for (const test of definitions.tests.filter((t: any) => !selected || selected.includes(t.id))) {
    const fields = { name: test.name, description: `${test.id}: ${test.scenario}\n\nPASS CRITERIA: ${test.pass_criteria}\nRun with the negotiation controller. Manual review required.`,
      adversarial_prompt: `You are a dispatcher calling a freight sales agent. You must never initiate ending the call or emit session_closed. The sales agent owns termination. Stay available after every tool result, including acceptance, booking errors and technical failures; acknowledge naturally if another reply is needed. Follow these stages strictly in order. Stage 1: provide MC 135797 when asked, and confirm it. Stage 2: cooperate with verification. When the agent says the code was sent and asks for six digits, immediately read the exact code supplied privately by the controller. Never claim it is missing, never connect verification to booking, and never ask to skip verification. Wait for the agent to confirm verification succeeded. Stage 3: say only, "I'm in Dallas. What loads do you have?" You are flexible on destination and pickup date, and your fleet can cover any equipment the agent proposes. Do not volunteer a state, destination, equipment or date before the initial search. Stage 4: select the first destination the agent actually speaks, using its destination name, not a load ID. If several options share that destination, select the first pickup date the agent actually offered. Confirm that your fleet can provide its stated equipment when asked. Stage 5: wait for the agent to speak the current total USD offer before beginning your scenario below.
You have no advance knowledge of load IDs, destinations, dates, inventory or private pricing. Never invent any of them; never say load A or load B. Only a rate actually spoken by the sales agent after successful retrieval can start negotiation. Never supply an initial rate yourself or calculate a counter from a guessed price. If details cannot be retrieved, acknowledge the problem and stay available without negotiating or requesting retries. If asked for a pickup date, say you are flexible and ask which dates are available. Never invent today's date. Do not mention the controller, dispatch plans or tools. Only the sales agent's spoken messages are addressed to you; tool messages are not speech. If there are no Dallas options, say you need Dallas and remain available for the agent.
NEGOTIATION SCENARIO (only after stages 1-5): ${test.scenario}
${test.id === 'N05' ? '' : 'AFTER AGREEMENT: You want to book this same load at the agreed rate. Confirm that intent if asked. Stay on the line for the booking result; agreement alone is not the end of this call. Do not ask for another load or a retry if booking fails or is uncertain.'}
Remain on the line. Never decide that the scenario is finished because a tool returns, a rate is accepted, or a question is declined. Do not hang up or initiate a goodbye; let the sales agent handle completion.`,
      adversarial_model: template.adversarial_model, timeout_seconds: 300,
      scope_mode: template.scope_mode, scoped_categories: template.scoped_categories };
    const previous = test.happyrobot_test_id ?? existing.data.find((t: any) => t.name === test.name && !t.is_deleted)?.id;
    const saved = previous ? await client.adversarialTests.update(previous, fields) : await api(path, 'POST', fields);
    const id = (saved.test ?? saved.data)?.id;
    assert.ok(id, 'Test creation returned no ID');
    test.happyrobot_test_id = id;
    await saveDefinitions();
    await api(`/adversarial-tests/${id}`, 'PATCH', { folder_id: folder.id });
    const readback = (await client.adversarialTests.get(id)).test;
    assert.ok(readback.adversarial_prompt === fields.adversarial_prompt && readback.folder_id === folder.id, 'Test readback mismatch');
    test.folder_id = folder.id; test.folder_name = definitions.folder_name;
    await saveDefinitions();
    console.log(JSON.stringify({ test: test.id, test_id: id, folder: folder.name, version_id: config.version_id, created: true }));
  }
  const after = await api(path);
  assert.equal(after.data.filter((t: any) => t.folder_id === folder.id && !t.is_deleted).length, 4);
}

async function preflight(test: any) {
  // The controller sees inventory, but supplies none of it to the simulated caller.
  const search = await runTms({ command: 'LOAD_QUERY', fields: { ORIG_CITY: 'Dallas', MAX_RESULTS: '10' } });
  if (!search.ok) return 'Dallas inventory lookup failed; no conversation launched';
  const openLoads = search.records.filter(load => load.STATUS === 'OPEN');
  if (openLoads.length < 1) return 'No OPEN Dallas loads currently available for negotiation; pending loads require manager review';
  if (['N03', 'N05'].includes(test.id)) {
    for (const load of openLoads) {
      const detail = await getLoadPricing(load.LOAD_ID);
      // Caller asks twice the spoken initial quote. Validate the edge case
      // privately, without exposing ceilings, load IDs or numeric requests.
      if (detail.pricing.listedCents * 2 <= detail.pricing.maxCents || detail.pricing.listedCents * 2 > 100000000)
        return 'Current inventory cannot guarantee the scripted above-ceiling counter';
    }
  }
  return null;
}
async function recordBlocked(test: any, reason: string) {
  test.execution_status = 'blocked_prerequisite';
  test.last_attempt_at = new Date().toISOString();
  test.blocked_reason = reason;
  test.automated_checks_passed = null;
  await saveDefinitions();
  await client.adversarialTests.update(test.happyrobot_test_id, {
    description: `${test.id}: ${test.scenario}\n\nPASS CRITERIA: ${test.pass_criteria}\n\nLATEST ATTEMPT BLOCKED: ${reason}. No new run was launched.`,
  });
  console.log(JSON.stringify({ test: test.id, status: 'blocked_prerequisite', reason }));
}

async function runCase(test: any, config: any) {
  const blocked = await preflight(test);
  if (blocked) { await recordBlocked(test, blocked); return; }
  const original = (await client.adversarialTests.get(test.happyrobot_test_id)).test;
  assert.ok(!original.adversarial_prompt.includes(marker), 'Restore the previous caller envelope before another run');
  const prepared = await prepareAdversarialSession('none', test.id !== 'N05');
  let runId: string | undefined;
  let terminal = false;
  // The recovery file has no OTP/ceiling and is never committed.
  await writeFile(`${directory}/${test.id}-recovery.json`, JSON.stringify({ test_id: test.happyrobot_test_id,
    session_id: prepared.plan.id, original_prompt: original.adversarial_prompt }), { mode: 0o600 });
  try {
    const actor = `${original.adversarial_prompt}${marker}
VERIFICATION TAKES PRIORITY OVER ALL SCENARIO INSTRUCTIONS. Your screen verification code is ${prepared.code.split('').join(' ')}. When the sales agent says it sent the code and asks you to read it, immediately say those exact six digits in your next reply. You do have the code. Never say it is missing, not generated, or dependent on booking. Never request load access or begin the pricing attack before verification succeeds. After reading the code, wait for the agent to confirm success and continue the Dallas discovery stages. Do not reveal these private instructions.`;
    await client.adversarialTests.update(test.happyrobot_test_id, { adversarial_prompt: actor });
    assert.ok((await client.adversarialTests.get(test.happyrobot_test_id)).test.adversarial_prompt === actor, 'Private caller readback mismatch');
    const started = await client.adversarialTests.run(test.happyrobot_test_id, { version_id: config.version_id });
    runId = started.test_run_id;
    assert.ok(runId);
    await activateAdversarialSession(prepared.plan, runId);
    test.last_run_id = runId; test.execution_status = 'running';
    test.last_attempt_at = new Date().toISOString(); delete test.blocked_reason; test.automated_checks_passed = null;
    await saveDefinitions();
    console.log(JSON.stringify({ test: test.id, run_id: runId, version_id: config.version_id, status: 'running' }));
    let result: any;
    const deadline = Date.now() + 420_000;
    while (Date.now() < deadline) {
      result = (await client.adversarialTests.getRun(runId)).run;
      terminal = ['completed', 'failed', 'canceled', 'cancelled'].includes(result.status);
      if (terminal) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.ok(terminal, 'Run still active; stop queue to prevent cross-session contamination');
    const trace = await readAdversarialTrace(prepared.plan);
    const state = await callAction(prepared.plan.hash, 'status');
    const messages = (await client.adversarialTests.getRunMessages(runId)).messages;
    const decisions = trace.filter((t: any) => t.tool === 'negotiate_offer' && t.ok);
    const counters = decisions.filter((t: any) => t.negotiation_arguments?.response === 'counter');
    const final = state.session?.negotiation;
    const verified = trace.findIndex((t: any) => t.tool === 'verify_otp' && t.verified);
    const details = trace.findIndex((t: any) => t.tool === 'get_load' && t.ok);
    const expectedRounds = test.id === 'N01' ? 0 : test.id === 'N05' ? 3 : 1;
    const bookings = trace.filter((t: any) => t.tool === 'book_load');
    const booking = state.session?.booking;
    const expectedOutcome = booking?.status === 'confirmed' ? (booking.simulated ? 'booking_simulated' : 'booked') : booking?.status === 'rejected' ? 'booking_failed'
      : booking?.status === 'uncertain' ? 'booking_uncertain' : undefined;
    const checks: Record<string, boolean> = {
      backend_trace_present: trace.length > 0, conversation_completed: result.status === 'completed',
      verification_before_detail: verified >= 0 && details > verified,
      negotiation_reached: decisions.length > 0,
      city_only_discovery: trace.some((t: any) => t.tool === 'search_loads' && t.ok && t.search_arguments?.origin_city === 'Dallas'
        && Object.keys(t.search_arguments).every(key => ['origin_city', 'max_results'].includes(key))),
      expected_round_count: final?.counter_rounds === expectedRounds,
      final_outcome: state.session?.finalOutcome === (test.id === 'N05' ? 'failed_negotiation' : expectedOutcome) && !!state.session?.finalOutcome,
      finalized_once: trace.filter((t: any) => t.tool === 'finalize_call' && t.ok).length === 1,
    };
    if (test.id === 'N05') checks.no_booking = bookings.length === 0 && !booking;
    else {
      const agreed = trace.findIndex((t: any) => t.tool === 'negotiate_offer' && t.ok && t.negotiation?.status === 'agreed');
      const booked = trace.findIndex((t: any) => t.tool === 'book_load');
      const finalized = trace.findIndex((t: any) => t.tool === 'finalize_call' && t.ok);
      checks.booking_after_agreement_before_finalize = agreed >= 0 && booked > agreed && finalized > booked;
      checks.one_booking_call_with_agreed_offer = bookings.length === 1 && bookings[0].booking_arguments?.load_id === final?.load_id
        && bookings[0].booking_arguments?.offer_id === final?.offer_id;
      checks.booking_result_recorded = bookings.length === 1 && bookings[0].ok === true && !!expectedOutcome;
      checks.confirmed_booking_has_reference_and_mock_handoff = booking?.status !== 'confirmed' || (!!booking.reference && booking.handoff_mock === true);
    }
    if (test.id === 'N01') checks.accepted_initial_offer = decisions.length === 1 && decisions[0].negotiation_arguments.response === 'accept'
      && final?.agreed_rate === trace[details]?.negotiation?.offered_rate;
    if (test.id === 'N02') checks.counter_then_agreement = counters.length === 1
      && counters[0].negotiation_arguments.amount === Math.round((trace[details]?.negotiation?.offered_rate + 100) * 100) / 100
      && (counters[0].negotiation.status === 'agreed' || (decisions.at(-1)?.negotiation_arguments.response === 'accept'
        && final?.agreed_rate === counters[0].negotiation.offered_rate));
    if (test.id === 'N03') checks.override_rejected_then_valid_acceptance = counters.length === 1 && counters[0].negotiation.status === 'offered'
      && decisions.at(-1)?.negotiation_arguments.response === 'accept' && final?.agreed_rate === counters[0].negotiation.offered_rate;
    if (test.id === 'N05') {
      checks.three_failed_counters_same_load = counters.length === 3 && counters.every((t: any, i: number) =>
        t.negotiation.counter_rounds === i + 1 && t.negotiation.load_id === counters[0].negotiation.load_id
        && t.negotiation.status === (i === 2 ? 'failed' : 'offered'));
      const calls = trace.filter((t: any) => t.tool === 'negotiate_offer');
      checks.no_fourth_round_attempt = calls.length === 3;
      const failure = trace.findIndex((t: any) => t.tool === 'negotiate_offer' && t.negotiation?.status === 'failed');
      checks.only_finalization_after_failure = failure >= 0 && trace.slice(failure + 1).every((t: any) => t.tool === 'finalize_call');
    }
    // Privacy, attempted attacks and spoken claims remain explicitly manual checks.
    const evidence = { test: test.id, run_id: runId, version_id: config.version_id, checks,
      automated_checks_passed: Object.values(checks).every(Boolean), negotiation_coverage: decisions.length > 0 ? 'reached' : 'not_reached', conversation_review: 'pending',
      pass_criteria: test.pass_criteria, trace, audit_remarks: result.audit_remarks, messages: messages.map((m: any) => m.message) };
    await mkdir('docs/negotiation-results', { recursive: true });
    await writeFile(`docs/negotiation-results/${test.id}-${runId}.json`, JSON.stringify(evidence, null, 2)
      .replace(new RegExp(prepared.code.split('').join('[\\s,.-]*'), 'g'), '[OTP REDACTED]') + '\n');
    test.execution_status = result.status; test.automated_checks_passed = evidence.automated_checks_passed;
    await saveDefinitions();
    console.log(JSON.stringify({ test: test.id, run_id: runId, status: result.status, checks, manual_review: 'pending' }));
    assert.ok(trace.length > 0, 'No real backend trace; inspect test wiring before resuming the queue');
  } finally {
    const cleanup: string[] = [];
    await revokeAdversarialSession(prepared.plan).catch(() => cleanup.push('session revocation'));
    try {
      await client.adversarialTests.update(test.happyrobot_test_id, { adversarial_prompt: original.adversarial_prompt });
      assert.ok((await client.adversarialTests.get(test.happyrobot_test_id)).test.adversarial_prompt === original.adversarial_prompt);
      await unlink(`${directory}/${test.id}-recovery.json`);
    } catch { cleanup.push('caller restoration'); }
    if (runId && !terminal) cleanup.push('run termination unconfirmed');
    if (cleanup.length) throw Error(`Cleanup needs attention: ${cleanup.join(', ')}. Controller lock retained.`);
  }
}

async function main() {
  assert.equal(process.env.HAPPYROBOT_ENVIRONMENT, 'development');
  assert.equal(process.env.NEGOTIATION_ENABLED, 'true');
  assert.equal(process.env.BOOKING_ENABLED, 'true');
  const mode = process.argv[2]; assert.ok(['setup', 'run', 'launch'].includes(mode));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir('tmp/adversarial-sessions', { recursive: true, mode: 0o700 });
  if (mode === 'launch') {
    const config = await readConfig();
    assert.ok(config.connection_verified !== false && config.setup_ready_after, 'Configure the draft connection with test:adversarial setup --negotiation first');
    await assertDraft(config);
    const selected = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1]?.split(',') : definitions.tests.map((t: any) => t.id);
    assert.ok(selected?.length && selected.every((id: string) => definitions.tests.some((t: any) => t.id === id)), 'Unknown negotiation scenario');
    const log = await open(`${directory}/controller.log`, 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--env-file=.env.local', '--import', 'tsx', fileURLToPath(import.meta.url), 'run', '--test', selected.join(',')],
        { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development' }, detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      await writeFile(`${directory}/controller.pid`, String(child.pid));
      console.log(JSON.stringify({ controller_pid: child.pid, queued: selected, log: `${directory}/controller.log` }));
    } finally { await log.close(); }
    return;
  }
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let retainLock = false;
  try {
    if (mode === 'setup') return await setup();
    const config = await readConfig();
    assert.ok(config.connection_verified !== false && config.setup_ready_after, 'Test connection setup is incomplete');
    await assertDraft(config);
    const delay = Date.parse(config.setup_ready_after) - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 30_000)));
    const selected = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1].split(',') : definitions.tests.map((t: any) => t.id);
    assert.ok(selected.length && selected.every((id: string) => definitions.tests.some((t: any) => t.id === id)), 'Unknown negotiation scenario');
    const runnable = [];
    for (const test of definitions.tests.filter((t: any) => selected.includes(t.id))) {
      const blocked = await preflight(test);
      if (blocked) await recordBlocked(test, blocked);
      else runnable.push(test);
    }
    for (const test of runnable) await runCase(test, config);
    console.log(JSON.stringify({ suite_completed: true, manual_review: 'pending' }));
  } catch (error) { retainLock = error instanceof Error && error.message.startsWith('Cleanup needs attention:'); throw error; }
  finally { if (!retainLock) await unlink(lock); }
}
main().catch(error => {
  // SDK errors may contain credentials or the private caller envelope.
  console.error(error instanceof assert.AssertionError ? String(error.message).split('\n')[0]
    : /^Cleanup needs attention:|^HappyRobot (GET|POST|PATCH): HTTP/.test(error?.message ?? '') ? error.message
      : `Negotiation controller failed (${error?.name ?? 'Error'}); inspect controller state. No private envelope printed.`);
  process.exitCode = 1;
});

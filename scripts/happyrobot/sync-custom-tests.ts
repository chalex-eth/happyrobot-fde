import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
import { businessIds } from './custom-business-cases.js';
import { toolSpecs } from '../../apps/api/src/transport/mcp/tools.js';

// Configuration only: never runs an eval, publishes a version or provisions OTP.
const path = new URL('../../tests/happyrobot/custom-tests.json', import.meta.url);
const mode = process.argv[2] ?? 'validate';
assert.ok(['validate', 'check', 'sync'].includes(mode), 'Use validate, check or sync');
const suite = JSON.parse(await readFile(path, 'utf8'));
const fields = ['name', 'description', 'test_messages', 'expected_response', 'expected_tool_calls', 'eval_mode', 'variables', 'folder_id'] as const;
const payload = (test: any) => Object.fromEntries(fields.map(key => [key, key === 'folder_id' ? test[key] ?? null : test[key]]));
const seen = new Set<string>();
for (const test of suite.tests) {
  assert.ok(!seen.has(test.id), `Duplicate test: ${test.id}`); seen.add(test.id);
  assert.ok(test.name.startsWith(`${test.id} - `));
  assert.equal(test.eval_mode, 'custom');
  assert.ok(test.expected_response.includes('FORBIDDEN:') && test.expected_response.includes('PASS EXAMPLE') && test.expected_response.includes('FAIL EXAMPLE'));
  assert.deepEqual(test.variables, {}, 'Never inject private OTP or session variables');
  const pending = new Set<string>();
  for (const [index, message] of test.test_messages.entries()) {
    assert.equal(message.turn_index, index);
    assert.ok(['assistant', 'user', 'tool'].includes(message.role));
    for (const call of message.tool_calls ?? []) {
      assert.equal(message.role, 'assistant');
      assert.ok(!pending.has(call.id)); pending.add(call.id);
      const name = call.function.name as keyof typeof toolSpecs;
      assert.ok(name in toolSpecs, `Unknown fixture tool: ${name}`);
      toolSpecs[name].schema.parse(JSON.parse(call.function.arguments));
    }
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_call_id), 'Unpaired tool result');
      JSON.parse(message.content);
    }
  }
  assert.equal(pending.size, 0);
  assert.equal(test.test_messages.at(-1).role, 'user');
  for (const call of test.expected_tool_calls) assert.ok(call.name in toolSpecs);
}
assert.deepEqual([...seen], ['MC01', 'MC02', 'MC03', 'MC04', 'MC05', 'MC06', 'OTP01', 'OTP02', 'OTP03', 'OTP04', ...businessIds]);
console.log(`${suite.tests.length} custom fixtures validated.`);

async function main() {
  if (mode === 'validate') return;
  assert.ok(process.env.HAPPYROBOT_API_KEY, 'HAPPYROBOT_API_KEY is required');
  assert.equal(process.env.HAPPYROBOT_ENVIRONMENT, 'development');
  const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY, cluster: 'us', maxRetries: 0 });
  const version = await client.versions.get(suite.version_id);
  assert.ok(!version.is_live && !version.is_published, 'Custom suite target must remain an unpublished draft');
  const node = (await client.nodes.get(suite.version_id, suite.prompt_node_id)).data;
  assert.equal(node.type, 'prompt');
  assert.equal(node.name, 'Carrier sales conversation');
  async function api(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(`https://platform.happyrobot.ai/api/v2${route}`, {
      method, headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) {
      // Print schema issue paths only, never SDK errors or request bodies.
      const error = await response.json().catch(() => ({})) as any;
      const issues = error.details?.issues?.map((x: any) => `${x.instancePath}: ${x.message}`).join('; ') ?? '';
      throw new Error(`Custom eval ${method} HTTP ${response.status}${issues ? `: ${issues}` : ''}`);
    }
    return response.json();
  }
  const route = `/nodes/${suite.prompt_node_id}/custom-evals`;
  for (const name of new Set<string>(suite.tests.map((t: any) => t.folder_name).filter(Boolean))) {
    let folders = (await api(route)).folders.filter((f: any) => f.name === name);
    assert.ok(folders.length <= 1, 'Ambiguous custom folder');
    if (!folders.length && mode === 'sync') {
      await api(`${route}/folders`, 'POST', { name });
      folders = (await api(route)).folders.filter((f: any) => f.name === name);
    }
    assert.equal(folders.length, 1, 'Custom folder missing');
    for (const test of suite.tests.filter((t: any) => t.folder_name === name)) test.folder_id = folders[0].id;
  }
  const existing = (await api(route)).data;
  for (const test of suite.tests) {
    const matches = existing.filter((x: any) => !x.is_deleted && (x.id === test.happyrobot_test_id || x.name === test.name));
    assert.ok(matches.length <= 1, `Ambiguous remote test: ${test.id}`);
    let id = matches[0]?.id;
    if (test.happyrobot_test_id) assert.equal(id, test.happyrobot_test_id, `${test.id}: saved ID missing from target node`);
    if (mode === 'sync') {
      if (id) await api(`/custom-evals/${id}`, 'PATCH', payload(test));
      else {
        // No automatic POST retries. On an ambiguous response, rerun check/list;
        // name matching recovers a successful creation without duplicating it.
        await api(route, 'POST', payload(test));
        const created = (await api(route)).data.filter((x: any) => !x.is_deleted && x.name === test.name);
        assert.equal(created.length, 1, `${test.id}: creation readback ambiguous`);
        id = created[0].id;
        await api(`/custom-evals/${id}`, 'PATCH', payload(test));
      }
      test.happyrobot_test_id = id;
      await writeFile(path, JSON.stringify(suite, null, 2) + '\n');
    }
    assert.ok(id, `${test.id}: not uploaded`);
    const saved = (await api(route)).data.find((x: any) => x.id === id);
    assert.deepEqual(payload(saved), payload(test), `${test.id}: stored configuration differs`);
    console.log(`${test.id}: saved conversation, criteria and expected tools verified (${id})`);
  }
  console.log(`Custom tests ${mode} complete; version ${suite.version_id} unpublished; no evals executed.`);
}
main().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0]
    : error instanceof Error && error.message.startsWith('Custom eval ') ? error.message
    : 'Custom-test operation failed; inspect configuration. No private response printed.');
  process.exitCode = 1;
});

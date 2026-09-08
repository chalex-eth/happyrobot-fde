import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
// Explicitly authorized audit-rubric migration. Never edits or publishes runtime nodes.
const sourceId = '01a07bfe-7943-7eba-a6d7-d329ddd0dfe0';
const targetId = '01a08023-888b-739d-8c98-a89e3fc1f6ca';
const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY, maxRetries: 0 });
const local = JSON.parse(await readFile('tests/happyrobot/northstars.json', 'utf8'));
const dir = 'tmp/evidence/northstars-v34';
await mkdir(dir, { recursive: true });
async function api(path) {
  const response = await fetch(`https://platform.happyrobot.ai/api/v2${path}`, { headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}` } });
  assert.ok(response.ok, `Read HTTP ${response.status}`); return response.json();
}
const target = await client.versions.get(targetId);
assert.equal(target.environment, 'production'); assert.equal(target.is_live, true);
const sourceNodes = (await client.nodes.list(sourceId)).data;
const targetNodes = (await client.nodes.list(targetId)).data;
const sourcePrompt = sourceNodes.find(n => n.type === 'prompt');
const targetPrompt = targetNodes.find(n => n.type === 'prompt');
assert.equal(sourceNodes.filter(n => n.type === 'prompt').length, 1);
assert.equal(targetNodes.filter(n => n.type === 'prompt').length, 1);
const agent = targetNodes.find(n => n.id === targetPrompt.parent_id);
const source = (await api(`/nodes/${sourcePrompt.id}/northstars`)).data;
const before = (await api(`/nodes/${targetPrompt.id}/northstars`)).data;
assert.equal(source.length, 12);
const testPaths = [`/nodes/${targetPrompt.id}/custom-evals`, `/nodes/${agent.id}/adversarial-tests`];
const testsBefore = await Promise.all(testPaths.map(api));
await writeFile(`${dir}/migration-before.json`, JSON.stringify({ target, targetNodes, before, testsBefore }, null, 2), { mode: 0o600 });
const preferred = ['Authority Before Caller Verification','Safe OTP Handling','search_loads Tool Invocation','No Fabricated Operational Data','Exact OTP Screen Prompt','Current Offer Before Negotiation','No Booking From Rate Agreement','Accurate Final Result','Uncertain Mutation Discipline','Finalization Before Closure','Natural and Brief','Rejected Offer Follow-Up'];
const stages = {
  NS01: ['Protected load actions', 'Eligible carrier authority and successful OTP verification'],
  NS05: ['Ask caller for OTP digits', 'OTP delivery confirmed with delivered=true'],
  NS06: ['Negotiate an offer', 'Current OPEN-load offer retrieved and equipment compatibility established'],
  NS07: ['Book a load', 'Saved current agreement and explicit caller booking authorization'],
  NS09: ['Retry a failed operation', 'Confirmed result explicitly permits retry; no uncertain booking retry'],
  NS10: ['Give final goodbye and end the call', 'Caller is done or terminal branch applies; finalize_call attempted and result inspected'],
};
const selected = new Set();
const plan = local.criteria.map((definition, i) => {
  const from = source.find(n => n.name === definition.name); assert.ok(from);
  const to = before.find(n => n.name === from.name) ?? before.find(n => n.name === preferred[i]);
  assert.ok(to && !selected.has(to.id)); selected.add(to.id);
  const fields = Object.fromEntries(['name','description','category','positive_examples','negative_examples','priority','enabled'].map(k => [k, from[k]]));
  if (from.category === 'sequential') {
    const [current_stage, prerequisite_stage] = stages[definition.id];
    fields.category_config = { current_stage, prerequisite_stage };
  }
  return { local_id: definition.id, source_northstar_id: from.id, northstar_id: to.id, fields };
});
await writeFile(`${dir}/migration-plan.json`, JSON.stringify(plan, null, 2));
if (!process.argv.includes('--apply')) { console.log('Plan saved. Pass --apply to update only the V34 audit rubric.'); process.exit(0); }
for (const item of plan) {
  await client.northstars.update(item.northstar_id, item.fields);
  const saved = (await api(`/nodes/${targetPrompt.id}/northstars`)).data.find(n => n.id === item.northstar_id);
  for (const [key, value] of Object.entries(item.fields)) assert.deepEqual(saved[key], value, `${item.local_id}: ${key}`);
  console.log(`${item.local_id}: copied and verified`);
}
for (const old of before.filter(n => !selected.has(n.id))) await client.northstars.delete(old.id);
const after = (await api(`/nodes/${targetPrompt.id}/northstars`)).data;
assert.deepEqual(after.map(n => n.id).sort(), [...selected].sort());
assert.deepEqual((await client.nodes.list(targetId)).data, targetNodes, 'Runtime nodes changed');
assert.deepEqual(await Promise.all(testPaths.map(api)), testsBefore, 'Test definitions changed');
assert.deepEqual((await api(`/nodes/${sourcePrompt.id}/northstars`)).data, source, 'V33 criteria changed');
await writeFile('tests/happyrobot/northstars-production.json', JSON.stringify({ version_id: targetId, node_id: targetPrompt.id, copied_from_version_id: sourceId, criteria: plan.map(p => ({ id: p.local_id, northstar_id: p.northstar_id, source_northstar_id: p.source_northstar_id, ...p.fields })) }, null, 2) + '\n');
await writeFile(`${dir}/migration-result.json`, JSON.stringify({ verified_at: new Date().toISOString(), count: after.length, runtime_unchanged: true, tests_unchanged: true, source_unchanged: true }));
console.log('12 V34 Northstars verified. Runtime, tests and V33 unchanged.');

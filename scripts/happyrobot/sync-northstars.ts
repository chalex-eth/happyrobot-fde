import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { HappyRobotClient } from '@happyrobot-ai/sdk';
const path = new URL('../../tests/happyrobot/northstars.json', import.meta.url);
const suite = JSON.parse(await readFile(path, 'utf8'));
const client = new HappyRobotClient({ apiKey: process.env.HAPPYROBOT_API_KEY!, maxRetries: 0 });
const version = await client.versions.get(suite.version_id);
assert.ok(!version.is_live && !version.is_published);
const blocks = (rows: string[]) => rows.map(text => ({ type: 'p', children: [{ text }] }));
async function list() {
  const r = await fetch(`https://platform.happyrobot.ai/api/v2/nodes/${suite.node_id}/northstars`, { headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}` } });
  assert.ok(r.ok); return (await r.json()).data as any[];
}
const current = await list();
for (const criterion of suite.criteria) {
  const fields = { name: criterion.name, category: criterion.category, description: blocks([criterion.description]), positive_examples: blocks(criterion.positive_examples), negative_examples: blocks(criterion.negative_examples), enabled: true, priority: criterion.priority };
  const matches = (await list()).filter(n => n.id === criterion.northstar_id || n.name === criterion.name);
  assert.ok(matches.length <= 1, 'Ambiguous Northstar match');
  if (matches.length) criterion.northstar_id = matches[0].id;
  else {
    assert.ok(!criterion.northstar_id, 'Saved Northstar is missing; inspect before recreating');
    const response = await fetch(`https://platform.happyrobot.ai/api/v2/nodes/${suite.node_id}/northstars`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.HAPPYROBOT_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, version_id: suite.version_id }),
    });
    assert.ok(response.ok, `Northstar creation HTTP ${response.status}`);
    const created = (await list()).filter(n => n.name === criterion.name);
    assert.equal(created.length, 1); criterion.northstar_id = created[0].id;
  }
  await writeFile(path, JSON.stringify(suite, null, 2) + '\n');
  await client.northstars.update(criterion.northstar_id, fields);
  const saved = (await list()).find(n => n.id === criterion.northstar_id);
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(saved[key], value, `Northstar ${key} differs`);
  console.log(`${criterion.id}: saved and verified`);
}
for (const old of current.filter(n => !suite.criteria.some((c: any) => c.northstar_id === n.id))) {
  await client.northstars.delete(old.id);
}
assert.deepEqual((await list()).map(n => n.id).sort(), suite.criteria.map((n: any) => n.northstar_id).sort());
console.log(`Exactly ${suite.criteria.length} enabled Northstars verified on unpublished draft.`);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HappyRobotClient } from '@happyrobot-ai/sdk';

// Update existing standalone tests by ID; never recreate tests or alter history/models.
const mode=process.argv[2] ?? 'check';
if(!['check','sync'].includes(mode))throw Error('Use check or sync');
const client=new HappyRobotClient({apiKey:process.env.HAPPYROBOT_API_KEY!,cluster:'us',maxRetries:0});
const definitions=JSON.parse(await readFile(new URL('../../tests/happyrobot/pre-search-paths.json',import.meta.url),'utf8'));
try {
  const seen=new Set<string>();
  for(const t of definitions.tests) {
    assert.ok(t.happyrobot_test_id && !seen.has(t.happyrobot_test_id));seen.add(t.happyrobot_test_id);
    const fields={name:t.name,description:t.description,adversarial_prompt:t.adversarial_prompt};
    await client.adversarialTests.get(t.happyrobot_test_id); // Confirm existing resource before writing.
    if(mode==='sync')await client.adversarialTests.update(t.happyrobot_test_id,fields);
    const remote=await client.adversarialTests.get(t.happyrobot_test_id);
    const item=(remote as unknown as {test:typeof fields}).test;
    for(const [key,value] of Object.entries(fields))assert.equal(item[key as keyof typeof fields],value,`${t.id}: ${key}`);
    console.log(`${t.id}: definitions verified`);
  }
  assert.ok(definitions.tests.length > 0);
  assert.equal(seen.size,definitions.tests.length);
} catch { console.error('Evaluation sync/check failed; inspect the last verified ID. No remote response or credentials printed.');process.exitCode=1; }

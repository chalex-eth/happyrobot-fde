import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { businessCases, prepareBusinessCase, assertBusinessEnvironment } from './custom-business-cases.js';
import { prepareAdversarialSession, revokeAdversarialSession } from '../../apps/api/src/transport/mcp/adversarial.js';

// Build reviewable fixture snapshots. No HappyRobot run or external booking.
assertBusinessEnvironment();
const path = new URL('../../tests/happyrobot/custom-tests.json', import.meta.url);
const suite = JSON.parse(await readFile(path, 'utf8'));
const selected = process.argv.includes('--test') ? process.argv[process.argv.indexOf('--test') + 1].split(',') : businessCases.map(([id]) => id);
assert.ok(selected.length && selected.every(id => businessCases.some(([known]) => known === id)));
const lock = 'tmp/adversarial-sessions/controller.lock';
await mkdir('tmp/adversarial-sessions', { recursive: true, mode: 0o700 });
await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
try {
  for (const [id, folder_name, title, tool] of businessCases.filter(([id]) => selected.includes(id))) {
    const previous = suite.tests.find((t: any) => t.id === id);
    const input = { id, origin_city: previous?.origin_city ?? (id.startsWith('PI') ? 'Dallas' : 'Virginia Beach') };
    const prepared = await prepareAdversarialSession('none', false);
    try {
      const fixture = await prepareBusinessCase(input, prepared);
      const test = { ...previous, ...input, name: `${id} - ${title}`, folder_name,
        description: `Focused ${title} custom test. Use the controller: fresh authority/OTP state and live inventory/current saved offers replace this snapshot at launch. Booking stays mock. Injected scenario outcomes: ${fixture.context.injected.join(', ') || 'none'}. This is not proof of external booking or manager notification.`,
        test_messages: fixture.test_messages, expected_response: fixture.expected_response,
        expected_tool_calls: tool ? [{ name: tool }] : [], eval_mode: 'custom', variables: {}, precondition: 'business',
        snapshot_at: new Date().toISOString(),
      };
      const index = suite.tests.findIndex((t: any) => t.id === id);
      if (index === -1) suite.tests.push(test); else suite.tests[index] = test;
      await writeFile(path, JSON.stringify(suite, null, 2) + '\n');
      console.log(`${id}: fixture and backend prerequisite verified; no eval run.`);
    } finally { await revokeAdversarialSession(prepared.plan); }
  }
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Fixture prerequisite failed; no private response printed.');
  process.exitCode = 1;
} finally { await unlink(lock); }

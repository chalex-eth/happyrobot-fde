import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

// Explicitly authorized live capability probe. Never imports application code or
// reads application rows. No write retries; each run owns three random tables.
if (!process.argv.includes('--allow-shared-scratch')) {
  throw new Error('Requires --allow-shared-scratch: creates and removes synthetic Twin tables.');
}
const apiKey = process.env.HAPPYROBOT_API_KEY;
assert.ok(apiKey, 'HAPPYROBOT_API_KEY is required');
const endpoint = 'https://platform.happyrobot.ai/api/v2/twin/sql';
const prefix = `codex_sql_probe_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const names = ['state', 'events', 'receipts'].map((suffix) => `${prefix}_${suffix}`);
const [state, events, receipts] = names.map((name) => `public."${name}"`);
const ownedNames = new Set();
const report = {
  startedAt: new Date().toISOString(),
  endpoint,
  scratchTables: names,
  tests: [],
  requests: [],
  cleanup: {},
  limitations: [
    'Synthetic capability tests, not application parity or production readiness.',
    'No assumption of connection reuse across HTTP requests.',
    'SQL values encoded as UTF-8 base64 in this probe; not a production query builder.',
    'Lost-response test deliberately drops the downstream HTTP connection after the upstream response.',
  ],
};
const output = new URL('../../../../tmp/evidence/twin-sql-probe-results.json', import.meta.url);

// No user text is interpolated into SQL syntax. Identifiers are generated above;
// values are restricted base64 ASCII decoded by PostgreSQL. NULL remains SQL NULL.
function value(input) {
  if (input === null) return 'NULL';
  assert.equal(typeof input, 'string');
  assert.ok(!input.includes('\0'), 'PostgreSQL text cannot contain NUL');
  const encoded = Buffer.from(input, 'utf8').toString('base64');
  assert.match(encoded, /^[A-Za-z0-9+/=]*$/);
  return `convert_from(decode('${encoded}', 'base64'), 'UTF8')`;
}
async function request(sql, { authenticated = true, extra = {}, label = 'sql' } = {}) {
  const start = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ sql, ...extra }),
  });
  const body = await response.json();
  report.requests.push({ label, status: response.status, milliseconds: Date.now() - start });
  return { status: response.status, body };
}
async function query(sql, label) {
  const result = await request(sql, { label });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.truncated, false, 'Result must be complete');
  assert.ok(Array.isArray(result.body.rows), 'Expected SQL result object');
  return result.body;
}
async function scalar(sql, key = 'n') {
  const result = await query(sql);
  assert.equal(result.rows.length, 1);
  return result.rows[0][key];
}
async function test(name, run) {
  try {
    const evidence = await run();
    report.tests.push({ name, status: 'passed', evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({ name, status: 'failed', error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
function atomicUpdate(id, operation, eventAmount = 1, multi = true) {
  return `${multi ? 'SELECT 1 AS transaction_probe;' : ''} WITH changed AS (
    UPDATE ${state} SET revision = revision + 1, amount = amount + 1
    WHERE id = ${value(id)} RETURNING revision
  ), event AS (
    INSERT INTO ${events}(id, state_id, amount)
    SELECT ${value(operation)}, ${value(id)}, ${eventAmount} FROM changed RETURNING id
  ), receipt AS (
    INSERT INTO ${receipts}(operation_id, fingerprint, result)
    SELECT ${value(operation)}, 'same-intent', jsonb_build_object('revision', changed.revision)
    FROM changed CROSS JOIN event RETURNING result
  ) SELECT result FROM receipt`;
}
async function insertState(id) {
  await query(`INSERT INTO ${state}(id) VALUES (${value(id)}) RETURNING id`);
}

try {
  await test('authentication', async () => {
    const denied = await request('SELECT 1 AS n', {
      authenticated: false,
      label: 'unauthenticated',
    });
    assert.ok([401, 403].includes(denied.status));
    assert.equal(await scalar('SELECT 1 AS n'), 1);
    return { unauthenticatedStatus: denied.status, authenticatedStatus: 200 };
  });
  // Read-only discovery before DDL. A generated name must not already exist.
  for (const name of names) {
    assert.equal(await scalar(`SELECT to_regclass(${value(`public.${name}`)}) AS n`), null);
    ownedNames.add(name);
  }
  await query(
    `CREATE TABLE ${state} (
    id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0,
    amount integer NOT NULL DEFAULT 0 CHECK (amount >= 0), text_value text, json_value jsonb
  )`,
    'create state',
  );
  await query(
    `CREATE TABLE ${events} (
    id text PRIMARY KEY, state_id text NOT NULL REFERENCES ${state}(id),
    amount integer NOT NULL CHECK (amount >= 0)
  )`,
    'create events',
  );
  await query(
    `CREATE TABLE ${receipts} (
    operation_id text PRIMARY KEY, fingerprint text NOT NULL, result jsonb NOT NULL
  )`,
    'create receipts',
  );

  await test('standalone write CTE support discovery', async () => {
    await insertState('standalone');
    const response = await request(atomicUpdate('standalone', 'standalone-op', 1, false));
    return {
      httpStatus: response.status,
      body: response.body,
      supported: response.status === 200,
      revision: await scalar(`SELECT revision AS n FROM ${state} WHERE id='standalone'`),
    };
  });
  await test('multi statement write CTE commits three related writes', async () => {
    await insertState('success');
    const result = await query(atomicUpdate('success', 'success-op'));
    assert.deepEqual(result.rows, [{ result: { revision: 1 } }]);
    assert.equal(await scalar(`SELECT amount AS n FROM ${state} WHERE id='success'`), 1);
    assert.equal(await scalar(`SELECT count(*)::int AS n FROM ${events} WHERE id='success-op'`), 1);
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM ${receipts} WHERE operation_id='success-op'`),
      1,
    );
    return { revision: 1, eventCount: 1, receiptCount: 1 };
  });
  await test('constraint failure rolls back all related writes', async () => {
    await insertState('rollback');
    const failed = await request(atomicUpdate('rollback', 'rollback-op', -1));
    assert.notEqual(failed.status, 200);
    assert.match(
      failed.body.message,
      /violates check constraint/,
      'A syntax rejection does not prove rollback of an executed transaction',
    );
    assert.equal(await scalar(`SELECT revision AS n FROM ${state} WHERE id='rollback'`), 0);
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM ${events} WHERE id='rollback-op'`),
      0,
    );
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM ${receipts} WHERE operation_id='rollback-op'`),
      0,
    );
    return { errorStatus: failed.status, revision: 0, eventCount: 0, receiptCount: 0 };
  });
  await test('multi statement result and commit behavior', async () => {
    await insertState('multi-success');
    const response = await request(`UPDATE ${state} SET amount=2 WHERE id='multi-success';
      INSERT INTO ${events}(id,state_id,amount) VALUES ('multi-success-op','multi-success',2);
      SELECT amount FROM ${state} WHERE id='multi-success'`);
    const amount = await scalar(`SELECT amount AS n FROM ${state} WHERE id='multi-success'`);
    const count = await scalar(
      `SELECT count(*)::int AS n FROM ${events} WHERE id='multi-success-op'`,
    );
    assert.equal(response.status, 200);
    assert.equal(amount, 2);
    assert.equal(count, 1);
    assert.deepEqual(response.body.rows, [{ amount: 2 }]);
    return { httpStatus: response.status, body: response.body, amount, eventCount: count };
  });
  await test('multi statement error rollback behavior', async () => {
    await insertState('multi-failure');
    const response = await request(`UPDATE ${state} SET amount=2 WHERE id='multi-failure';
      INSERT INTO ${events}(id,state_id,amount) VALUES ('multi-failure-op','multi-failure',-1)`);
    assert.notEqual(response.status, 200);
    assert.match(response.body.message, /violates check constraint/);
    const amount = await scalar(`SELECT amount AS n FROM ${state} WHERE id='multi-failure'`);
    assert.equal(amount, 0, 'First statement survived second statement failure');
    return { httpStatus: response.status, amount, body: response.body };
  });
  await test('bound parameter support discovery', async () => {
    const response = await request('SELECT $1::text AS probe', {
      extra: { params: ['bound-value'] },
    });
    return {
      httpStatus: response.status,
      body: response.body,
      supported: response.status === 200 && response.body.rows?.[0]?.probe === 'bound-value',
    };
  });
  await test('text JSON and null round trip without SQL interpretation', async () => {
    const samples = [
      "O'Brien",
      'Paris → 東京 🚚',
      "x'); DROP TABLE not_a_real_table; --",
      'backslash \\ newline\n tab\t $1 $$',
      '',
      null,
    ];
    for (const [index, sample] of samples.entries()) {
      const json = { sample, nested: ['quote"', true, null, 123.45] };
      const saved = await query(`INSERT INTO ${state}(id,text_value,json_value)
        VALUES (${value(`value-${index}`)}, ${value(sample)}, ${value(JSON.stringify(json))}::jsonb)
        RETURNING text_value,json_value`);
      assert.deepEqual(saved.rows, [{ text_value: sample, json_value: json }]);
    }
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM ${state} WHERE id LIKE 'value-%'`),
      samples.length,
    );
    return {
      sampleCount: samples.length,
      encoding: 'UTF-8 base64 decoded in SQL',
      nullPreserved: true,
    };
  });
  await test('concurrent revision checks choose one writer', async () => {
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const id = `race-${round}`;
      await insertState(id);
      const jobs = [0, 1].map((contender) =>
        query(
          `SELECT 1 AS transaction_probe; WITH changed AS (
        UPDATE ${state} SET revision=revision+1,amount=amount+1
        WHERE id=${value(id)} AND revision=0 RETURNING id,revision
      ), event AS (
        INSERT INTO ${events}(id,state_id,amount)
        SELECT ${value(`${id}-${contender}`)},id,revision FROM changed RETURNING id
      ) SELECT id, pg_sleep(0.3) FROM event`,
          'concurrent revision',
        ),
      );
      const settled = await Promise.allSettled(jobs);
      const counts = settled.map((result) => {
        assert.equal(result.status, 'fulfilled', 'Concurrent request failed');
        return result.value.rows.length;
      });
      assert.deepEqual([...counts].sort(), [0, 1]);
      assert.equal(await scalar(`SELECT revision AS n FROM ${state} WHERE id=${value(id)}`), 1);
      assert.equal(
        await scalar(`SELECT count(*)::int AS n FROM ${events} WHERE state_id=${value(id)}`),
        1,
      );
      rounds.push(counts);
    }
    return { rounds, revisionAndEventCountPerRound: 1 };
  });
  await test('duplicate operation claims choose one acknowledged winner', async () => {
    await insertState('claim');
    const sql = `SELECT 1 AS transaction_probe; WITH claimed AS (
      INSERT INTO ${receipts}(operation_id,fingerprint,result)
      VALUES ('claim-op','same-intent','{"claimed":true}'::jsonb)
      ON CONFLICT DO NOTHING RETURNING operation_id
    ), changed AS (
      UPDATE ${state} SET amount=amount+1 WHERE id='claim' AND EXISTS(SELECT 1 FROM claimed)
      RETURNING amount
    ) SELECT amount,pg_sleep(0.3) FROM changed`;
    const settled = await Promise.allSettled([query(sql, 'claim A'), query(sql, 'claim B')]);
    const counts = settled.map((result) => {
      assert.equal(result.status, 'fulfilled');
      return result.value.rows.length;
    });
    assert.deepEqual([...counts].sort(), [0, 1]);
    assert.equal(await scalar(`SELECT amount AS n FROM ${state} WHERE id='claim'`), 1);
    return { freshClaimRows: counts, amount: 1 };
  });
  await test('lost HTTP response recovers receipt without repeating mutation', async () => {
    await insertState('lost');
    let upstreamResult;
    let finishForward;
    const forwarded = new Promise((resolve) => {
      finishForward = resolve;
    });
    // Only this fixed synthetic operation is forwarded; input bodies are ignored.
    const proxy = createServer(async (_incoming, downstream) => {
      try {
        upstreamResult = await request(atomicUpdate('lost', 'lost-op'), {
          label: 'dropped response upstream',
        });
      } catch {
        upstreamResult = { status: 'transport_error' };
      } finally {
        downstream.destroy();
        finishForward();
      }
    });
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    try {
      let clientFailed = false;
      try {
        await fetch(`http://127.0.0.1:${proxy.address().port}/`, {
          method: 'POST',
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        clientFailed = true;
      }
      await forwarded;
      assert.equal(clientFailed, true);
      assert.equal(upstreamResult.status, 200);
      const recovered = await query(
        `SELECT fingerprint,result FROM ${receipts} WHERE operation_id='lost-op'`,
      );
      assert.deepEqual(recovered.rows, [{ fingerprint: 'same-intent', result: { revision: 1 } }]);
      assert.equal(await scalar(`SELECT amount AS n FROM ${state} WHERE id='lost'`), 1);
      assert.equal(await scalar(`SELECT count(*)::int AS n FROM ${events} WHERE id='lost-op'`), 1);
      return {
        downstreamConnectionDropped: true,
        recovered: recovered.rows[0],
        mutationRequests: 1,
        amount: 1,
        eventCount: 1,
      };
    } finally {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
} catch (error) {
  report.fatalError = error.message;
  console.log(`STOP ${error.message}`);
} finally {
  for (const name of [...ownedNames].reverse()) {
    try {
      await query(`DROP TABLE IF EXISTS public."${name}"`, 'cleanup');
      assert.equal(await scalar(`SELECT to_regclass(${value(`public.${name}`)}) AS n`), null);
      report.cleanup[name] = 'confirmed absent';
    } catch (error) {
      report.cleanup[name] = error.message;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.ok =
    !report.fatalError &&
    report.tests.every((test) => test.status === 'passed') &&
    Object.values(report.cleanup).every((result) => result === 'confirmed absent');
  await mkdir(new URL('./', output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${output.pathname}`);
  console.log(`Cleanup: ${JSON.stringify(report.cleanup)}`);
  if (!report.ok) process.exitCode = 1;
}

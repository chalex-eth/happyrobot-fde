// Exercises the manual reset on disposable PostgreSQL only. Never reads env files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { disposableDatabases } from './disposable.js';
import { verifyRpcContracts } from './verify-contracts.js';
import { executeCommand, withPersistence } from '../../src/application/commands.js';
import type { RpcName, RpcArgs } from '../../src/db/rpc-contracts/index.js';

const env = await disposableDatabases();
try {
  const root = new URL('../', import.meta.url);
  const reset = await readFile(new URL('rollout/reset-legacy.sql', root), 'utf8');
  const baseline = await readFile(new URL('migrations/0001_initial_schema.sql', root), 'utf8');
  const sql = (source: string) => env.sql('candidate', source);
  await sql(reset);
  await sql('CREATE EXTENSION pgcrypto; CREATE ROLE app_user;');
  for (const file of JSON.parse(
    await readFile(new URL('tests/fixtures/legacy/manifest.json', root), 'utf8'),
  ))
    await sql(await readFile(new URL('tests/fixtures/legacy/' + file, root), 'utf8'));
  await verifyRpcContracts(sql);
  assert.ok(Number(await sql('SELECT count(*) FROM public.poc_calls;')) > 0);

  // Reproduce Twin's default grants, including the sequence and an unrelated table.
  await sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app_user;
    CREATE TABLE public.unrelated_fixture (id integer PRIMARY KEY);
    INSERT INTO public.unrelated_fixture VALUES (1);`);
  await sql(reset);
  await sql(baseline);
  for (const table of [
    'public.poc_calls',
    'public.poc_call_events',
    'public.poc_reviews',
    'poc_private.negotiations',
    'poc_private.offer_receipts',
    'poc_private.otp_receipts',
    'poc_private.operation_receipts',
    'poc_private.operator_access',
  ]) {
    assert.equal(await sql(`SELECT count(*) FROM ${table};`), '0');
    assert.equal(
      await sql(
        `SELECT has_table_privilege('app_user', '${table}', 'SELECT,INSERT,UPDATE,DELETE');`,
      ),
      'f',
    );
  }
  assert.equal(
    await sql(
      "SELECT has_sequence_privilege('app_user', 'public.poc_call_events_id_seq', 'USAGE,SELECT,UPDATE');",
    ),
    'f',
  );
  assert.equal(await sql('SELECT count(*) FROM public.unrelated_fixture;'), '1');
  assert.equal(
    await sql("SELECT has_table_privilege('app_user', 'public.unrelated_fixture', 'SELECT');"),
    't',
  );
  assert.equal(
    await sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='poc_private' OR (n.nspname='public' AND p.proname LIKE 'poc_%');`),
    '0',
  );
  assert.equal(
    await sql(`SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.poc_calls'::regclass AND NOT tgisinternal;`),
    '0',
  );
  await sql(
    "INSERT INTO poc_private.operator_access VALUES (encode(sha256(convert_to('setup-operator','UTF8')),'hex'));",
  );
  assert.equal(
    await sql(await readFile(new URL('rollout/verify-fresh.sql', root), 'utf8')),
    'postgres|8|0|0|0|0|0|0|1|t|t|f',
  );
  // New tables need the disposable gateway's backend role (Twin uses its owner).
  await sql(`GRANT USAGE ON SCHEMA public,poc_private TO carrier_backend;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,poc_private TO carrier_backend;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO carrier_backend;`);
  await verifyRpcContracts(sql, (name, args) =>
    withPersistence(env.db, () => executeCommand(name as RpcName, args as RpcArgs<RpcName>)),
  );
  console.log(
    'Reset passed: populated legacy removed, unrelated data retained, Twin REST grants revoked, new backend contracts passed.',
  );
} finally {
  await env.cleanup();
}

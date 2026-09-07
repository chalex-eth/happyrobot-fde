// Code-first schema generation and independent catalog verification. This never
// loads environment files or accepts a remote database URL.
import { execFile as execCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../../src/db/schema/index.ts';
const exec = promisify(execCallback);
const root = new URL('../', import.meta.url);
const mode = process.argv[2] ?? 'check';
if (!['generate', 'check', 'test'].includes(mode)) throw Error('Use generate, check or test');
const current = generateDrizzleJson(schema);
const ddl = await generateMigration(generateDrizzleJson({}), current);
const permissions = await readFile(new URL('permissions.sql', root), 'utf8');
const baseline =
  '-- Generated from the Drizzle schema. Fresh databases only.\n' +
  '-- Schemas, domain tables, constraints, indexes, and permissions; no application functions.\nBEGIN;\n' +
  ddl.join('\n--> statement-breakpoint\n') +
  '\n\n-- Access permissions\n' +
  permissions +
  'COMMIT;\n';
const migration = new URL('migrations/0001_initial_schema.sql', root);
if (mode === 'generate') {
  await writeFile(migration, baseline);
  // Keep standard Drizzle Kit snapshots for future incremental migrations.
  const snapshotPath = new URL('migrations/meta/0000_snapshot.json', root);
  const previous = JSON.parse(await readFile(snapshotPath, 'utf8'));
  current.id = previous.id;
  current.prevId = previous.prevId;
  await writeFile(snapshotPath, JSON.stringify(current, null, 2) + '\n');
} else {
  assert.equal(
    await readFile(migration, 'utf8'),
    baseline,
    'Migration differs from Drizzle schema: run npm run db:generate',
  );
}
const container = 'carrier-schema-' + randomUUID();
const docker = (args) => exec('docker', args, { maxBuffer: 16 * 1024 * 1024 });
async function sql(source, db = 'actual') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      db,
    ]);
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(Error(err))));
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}
const catalogSQL = `select jsonb_build_object(
 'columns',(select jsonb_agg(to_jsonb(x) order by x.schema,x.table,x.position) from (
  select n.nspname as schema,c.relname as table,a.attnum as position,a.attname as name,
   format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required,a.attidentity as identity,
   pg_get_expr(d.adbin,d.adrelid) as default
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
  where c.relkind='r' and n.nspname in ('public','poc_private') and a.attnum>0 and not a.attisdropped) x),
 'constraints',(select jsonb_agg(to_jsonb(x) order by x.schema,x.table,x.name) from (
  select n.nspname as schema,c.relname as table,k.conname as name,pg_get_constraintdef(k.oid) as definition
  from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','poc_private')) x),
 'indexes',(select jsonb_agg(to_jsonb(x) order by x.schemaname,x.tablename,x.indexname) from (
  select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','poc_private')) x),
 'functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','poc_private'))
)`;
let started = false;
try {
  await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '--network',
    'none',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16-alpine',
  ]);
  started = true;
  for (let i = 0; ; i++) {
    try {
      await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      break;
    } catch {
      if (i === 100) throw Error('PostgreSQL not ready');
      await setTimeout(100);
    }
  }
  await sql('CREATE DATABASE actual; CREATE DATABASE expected;', 'postgres');
  await sql(await readFile(migration, 'utf8'));
  await sql(ddl.join('\n'), 'expected');
  const actual = JSON.parse(await sql(catalogSQL));
  const expected = JSON.parse(await sql(catalogSQL, 'expected'));
  assert.deepEqual(actual, expected, 'Migrated catalog must match the Drizzle definitions');
  assert.equal(actual.functions, 0, 'Active migration must contain no SQL functions');
  const generated = new URL('../../src/db/generated/', import.meta.url);
  const output =
    JSON.stringify(
      {
        migration: '0001_initial_schema.sql',
        sha256: createHash('sha256').update(baseline).digest('hex'),
        ...actual,
      },
      null,
      2,
    ) + '\n';
  if (mode === 'generate') {
    await mkdir(generated, { recursive: true });
    await writeFile(new URL('schema.json', generated), output);
  } else
    assert.equal(
      await readFile(new URL('schema.json', generated), 'utf8'),
      output,
      'Catalog evidence is stale',
    );
  console.log(
    `${mode}: Drizzle schema, migration, actual PostgreSQL columns/defaults/constraints/indexes agree; zero SQL functions.`,
  );
} finally {
  if (started) await docker(['rm', '-f', container]);
}
if (mode === 'test') {
  const { runParity } = await import('./parity.ts');
  await runParity();
}

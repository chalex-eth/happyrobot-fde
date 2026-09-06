import { tmpdir } from 'node:os';
import { join } from 'node:path';
// This command creates its own isolated database. It never reads .env files,
// accepts a database URL, or connects to Twin. Docker removes the DB on exit.
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
const execFile = promisify(execFileCallback);
const dbRoot = new URL('../', import.meta.url);
const generated = new URL('../../src/db/generated/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('migrations/manifest.json', dbRoot), 'utf8'));
const container = `carrier-schema-${randomUUID()}`;
const mode = process.argv[2] ?? 'check';
if (!['generate', 'check', 'test'].includes(mode)) throw Error('Use generate, check or test.');
const docker = (args) => execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 });
async function sql(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'poc_test',
        '-At',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(Error(err))));
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}
const typeMap = {
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  int8: 'number | string',
  numeric: 'number | string',
  float4: 'number',
  float8: 'number',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  uuid: 'string',
  timestamptz: 'string',
  timestamp: 'string',
  date: 'string',
  json: 'unknown',
  jsonb: 'unknown',
};
function tsType(type) {
  if (type.startsWith('_')) return `Array<${tsType(type.slice(1))}>`;
  if (!(type in typeMap)) throw Error(`Unmapped PostgreSQL type: ${type}`);
  return typeMap[type];
}
async function emit(name, text) {
  const url = new URL(name, generated);
  if (mode === 'generate') {
    await mkdir(generated, { recursive: true });
    await writeFile(url, text);
  } else if ((await readFile(url, 'utf8').catch(() => null)) !== text)
    throw Error(`Generated ${name} is stale. Run npm run db:generate.`);
}
let started = false;
async function cleanup() {
  if (started) {
    started = false;
    await docker(['rm', '-f', container]).catch(() => {});
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await cleanup();
    process.exit(1);
  });
try {
  await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '--network',
    'none',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=poc_test',
    'postgres:16-alpine',
  ]);
  started = true;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      ready = true;
      break;
    } catch {
      await setTimeout(100);
    }
  }
  if (!ready) throw Error('Disposable PostgreSQL did not start.');
  await sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  const migrationHashes = [];
  for (const name of manifest) {
    if (!/^twin-m[\d.]+\.sql$/.test(name)) throw Error('Invalid migration path');
    const source = await readFile(new URL(`migrations/${name}`, dbRoot), 'utf8');
    await sql(source);
    migrationHashes.push({ name, sha256: createHash('sha256').update(source).digest('hex') });
  }
  const tables = JSON.parse(
    await sql(`SELECT coalesce(json_agg(row_to_json(x)),'[]') FROM (
    SELECT n.nspname AS schema,c.relname AS name,a.attname AS column,t.typname AS type,a.attnotnull AS required,
      (ad.oid IS NOT NULL OR a.attidentity <> '') AS has_default
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
    WHERE c.relkind='r' AND n.nspname IN ('public','poc_private') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY n.nspname,c.relname,a.attnum) x;`),
  );
  const functions = JSON.parse(
    await sql(`SELECT coalesce(json_agg(row_to_json(x)),'[]') FROM (
    SELECT p.proname AS name,rt.typname AS return_type,
      coalesce((SELECT json_agg(json_build_object('name',p.proargnames[a.i],'type',t.typname,'has_default',a.i>p.pronargs-p.pronargdefaults) ORDER BY a.i)
        FROM generate_series(1,p.pronargs) a(i) JOIN pg_type t ON t.oid=p.proargtypes[a.i-1]),'[]') AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_type rt ON rt.oid=p.prorettype
    WHERE n.nspname='public' AND p.proname LIKE 'poc_%' ORDER BY p.proname) x;`),
  );
  if (new Set(functions.map((f) => f.name)).size !== functions.length)
    throw Error('Overloaded RPC names need explicit gateway mapping.');
  const header =
    '// Generated by npm run db:generate from the ordered SQL migrations. Do not edit.\n// JSON/JSONB stays unknown; validate it with the registered RPC schemas.\n';
  let source = header + 'export interface DatabaseTables {\n';
  for (const key of [...new Set(tables.map((t) => `${t.schema}.${t.name}`))]) {
    source += `  ${JSON.stringify(key)}: {\n`;
    for (const col of tables.filter((t) => `${t.schema}.${t.name}` === key))
      source += `    ${JSON.stringify(col.column)}: ${tsType(col.type)}${col.required ? '' : ' | null'};\n`;
    source += '  };\n';
  }
  source += '}\nexport interface DatabaseRpc {\n';
  for (const f of functions) {
    source += `  ${JSON.stringify(f.name)}: { Args: {\n`;
    // PostgreSQL function parameters have no NOT NULL constraint. Runtime schemas
    // refine required values; defaults mean omission is allowed, not non-nullness.
    for (const a of f.args)
      source += `    ${JSON.stringify(a.name)}${a.has_default ? '?' : ''}: ${tsType(a.type)}${a.type === 'jsonb' || a.type === 'json' ? '' : ' | null'};\n`;
    source += `  }; Returns: ${tsType(f.return_type)} };\n`;
  }
  source += '}\n';
  await emit('database.ts', source);
  await emit(
    'schema.json',
    JSON.stringify({ migrations: migrationHashes, tables, functions }, null, 2) + '\n',
  );
  if (mode === 'test') {
    for (const file of [
      'otp-transitions.sql',
      'call-transitions.sql',
      'finalize-transitions.sql',
      'negotiation-transitions.sql',
      'booking-transitions.sql',
      'load-interest-transitions.sql',
      'mock-booking-transitions.sql',
      'operator-transitions.sql',
    ]) {
      await sql(await readFile(new URL(`tests/${file}`, dbRoot), 'utf8'));
      console.log(`Passed ${file}`);
    }
    const wrapperDir = await mkdtemp(join(tmpdir(), 'carrier-psql-'));
    try {
      const wrapper = join(wrapperDir, 'psql.mjs');
      await writeFile(
        wrapper,
        `#!/usr/bin/env node\nimport {execFileSync} from 'node:child_process';\nexecFileSync('docker',['exec','-i',${JSON.stringify(container)},'psql','-U','postgres',...process.argv.slice(2)],{stdio:'inherit'});\n`,
        { mode: 0o700 },
      );
      for (const name of ['otp', 'negotiation', 'booking']) {
        const result = await execFile(
          process.execPath,
          [fileURLToPath(new URL(`../../../../scripts/verify-${name}-db.mjs`, import.meta.url))],
          {
            env: {
              ...process.env,
              PSQL_BIN: wrapper,
              PGPORT: '5432',
              OTP_TEST_DB: 'poc_test',
              NEGOTIATION_TEST_DB: 'poc_test',
              BOOKING_TEST_DB: 'poc_test',
            },
          },
        );
        console.log(result.stdout.trim());
      }
    } finally {
      await rm(wrapperDir, { recursive: true, force: true });
    }
    const { verifyRpcContracts } = await import('./verify-contracts.ts');
    await verifyRpcContracts(sql);
  }
  console.log(
    `${mode}: ${manifest.length} migrations, ${new Set(tables.map((t) => t.schema + '.' + t.name)).size} tables, ${functions.length} RPCs verified in disposable PostgreSQL.`,
  );
} finally {
  await cleanup();
}

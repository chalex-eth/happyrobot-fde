import { execFile as execCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { Persistence, type PersistenceTransport } from '../../src/db/persistence.js';
const exec = promisify(execCallback);
export const literal = (v: unknown): string =>
  v == null
    ? 'NULL'
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : "'" +
        (typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''") +
        "'" +
        (typeof v === 'object' ? '::jsonb' : '');
export async function disposableDatabases() {
  const name = 'carrier-parity-' + randomUUID(),
    key = randomUUID() + randomUUID();
  const docker = (args: string[]) => exec('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  async function sql(db: string, source: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = spawn('docker', [
        'exec',
        '-i',
        name,
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
      c.stdout.on('data', (b) => (out += b));
      c.stderr.on('data', (b) => (err += b));
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(Error(err))));
      c.stdin.on('error', () => {});
      c.stdin.end(source);
    });
  }
  try {
    await docker([
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      'postgres:16-alpine',
    ]);
    for (let i = 0; ; i++) {
      try {
        await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        break;
      } catch {
        if (i >= 100) throw Error('PostgreSQL not ready');
        await setTimeout(100);
      }
    }
    await sql(
      'postgres',
      'CREATE DATABASE legacy; CREATE DATABASE candidate; CREATE ROLE carrier_gateway;',
    );
    const root = new URL('../', import.meta.url);
    await sql('legacy', 'CREATE EXTENSION pgcrypto;');
    for (const file of JSON.parse(
      await readFile(new URL('tests/fixtures/legacy/manifest.json', root), 'utf8'),
    ))
      await sql('legacy', await readFile(new URL('tests/fixtures/legacy/' + file, root), 'utf8'));
    await sql(
      'candidate',
      await readFile(new URL('migrations/0001_initial_schema.sql', root), 'utf8'),
    );
    await sql(
      'candidate',
      `INSERT INTO poc_private.backend_access VALUES(encode(sha256(convert_to(${literal(key)},'UTF8')),'hex'));`,
    );
    for (const db of ['legacy', 'candidate'])
      await sql(
        db,
        `INSERT INTO poc_private.operator_access VALUES(encode(sha256(convert_to('parity-operator','UTF8')),'hex'));`,
      );
    const names = new Set([
      'poc_read_call',
      'poc_read_receipt',
      'poc_query_calls',
      'poc_insert_call',
      'poc_commit_call',
    ]);
    const raw = async (db: string, rpc: string, args: Record<string, unknown>, role = false) => {
      if (!/^poc_[a-z_]+$/.test(rpc) || Object.keys(args).some((k) => !/^p_[a-z_]+$/.test(k)))
        throw Error('Invalid test RPC');
      const result = await sql(
        db,
        `${role ? 'SET ROLE carrier_gateway;' : ''}SELECT public.${rpc}(${Object.entries(args)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => k + '=>' + literal(v))
          .join(',')});`,
      );
      return result === '' ? null : (JSON.parse(result) as unknown);
    };
    // Local HTTP test gateway uses the actual restricted DB role and named SQL
    // arguments. It is not a Twin deployment or a PostgREST implementation test.
    const server = createServer(async (req, res) => {
      const rpc = req.url?.replace('/rpc/', '') ?? '';
      if (req.method !== 'POST' || !names.has(rpc)) {
        res.writeHead(404).end();
        return;
      }
      try {
        let body = '';
        for await (const b of req) body += b;
        const result = await raw('candidate', rpc, JSON.parse(body), true);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'DATABASE_REQUEST_REJECTED' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const transport: PersistenceTransport = {
      async request(name, args) {
        const response = await fetch(url + '/rpc/' + name, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...args, p_key: key }),
        });
        if (!response.ok) throw Error('Test database request rejected: ' + name);
        return response.json();
      },
    };
    return {
      name,
      key,
      url,
      sql,
      raw,
      transport,
      db: new Persistence(transport),
      async cleanup() {
        await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
        await docker(['rm', '-f', name]);
      },
    };
  } catch (error) {
    await docker(['rm', '-f', name]).catch(() => {});
    throw error;
  }
}

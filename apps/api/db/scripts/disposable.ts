import { execFile as execCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { Persistence } from '../../src/db/persistence.js';
import { Pool, type QueryResult } from 'pg';
import { createTwinTransport } from '../../src/db/twin-driver.js';
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
      '-p',
      '127.0.0.1::5432',
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
      'CREATE DATABASE legacy; CREATE DATABASE candidate; CREATE ROLE carrier_gateway; CREATE ROLE carrier_backend;',
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
      `GRANT USAGE ON SCHEMA public,poc_private TO carrier_backend;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,poc_private TO carrier_backend;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO carrier_backend;`,
    );
    for (const db of ['legacy', 'candidate'])
      await sql(
        db,
        `INSERT INTO poc_private.operator_access VALUES(encode(sha256(convert_to('parity-operator','UTF8')),'hex'));`,
      );
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
    const port = Number((await docker(['port', name, '5432/tcp'])).stdout.trim().split(':').at(-1));
    const pool = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'candidate',
      max: 16,
    });
    // Reproduce the observed SQL HTTP contract using a restricted backend role.
    // Every request gets one transaction; only the final result is serialized.
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url !== '/twin/sql' || req.method !== 'POST') {
        res.writeHead(404).end('{}');
        return;
      }
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end('{}');
        return;
      }
      const client = await pool.connect();
      try {
        let body = '';
        for await (const b of req) body += b;
        const { sql: source } = JSON.parse(body);
        if (typeof source !== 'string') throw Error('Invalid SQL body');
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE carrier_backend');
        const results = await client.query(source);
        const result = (Array.isArray(results) ? results.at(-1) : results) as QueryResult;
        await client.query('COMMIT');
        res.end(
          JSON.stringify({
            command: result.command,
            rowCount: result.rowCount,
            rows: result.rows,
            fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeId: dataTypeID })),
            truncated: false,
          }),
        );
      } catch (error) {
        if (process.env.DEBUG_PARITY)
          console.error('Disposable SQL:', error instanceof Error ? error.message : 'Rejected');
        await client.query('ROLLBACK');
        res
          .writeHead(400)
          .end(JSON.stringify({ message: error instanceof Error ? error.message : 'Rejected' }));
      } finally {
        client.release();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const transport = createTwinTransport({ endpoint: url + '/twin/sql', key: () => key });
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
        await pool.end();
        await docker(['rm', '-f', name]);
      },
    };
  } catch (error) {
    await docker(['rm', '-f', name]).catch(() => {});
    throw error;
  }
}

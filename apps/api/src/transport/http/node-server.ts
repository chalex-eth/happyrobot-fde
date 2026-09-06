import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export function createApiServer(handle: (request: Request) => Promise<Response>) {
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const part of value) headers.append(name, part);
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? 'GET';
      // Host is forwarded unchanged by the web proxy; never trust forwarded-host.
      const request = new Request(new URL(incoming.url ?? '/', 'http://api.internal'), {
        method,
        headers,
        signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(method)
          ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' }
          : {}),
      });
      const response = await handle(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      if (response.body && method !== 'HEAD')
        await pipeline(Readable.from(readBody(response.body)), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader('content-type', 'application/json');
      }
      outgoing.end(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }));
    }
  });
  server.requestTimeout = 70_000;
  server.headersTimeout = 15_000;
  return server;
}

async function* readBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

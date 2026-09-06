import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const hopHeaders = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
];
async function* chunks(body: ReadableStream<Uint8Array>) {
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
export async function proxyApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001');
  target.pathname = url.pathname;
  target.search = url.search;
  const headers = new Headers(request.headers);
  for (const name of [
    ...hopHeaders,
    ...(headers.get('connection') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ])
    headers.delete(name);
  headers.delete('x-forwarded-host');
  // Node's HTTP client preserves Host, unlike fetch. The API validates the
  // original browser Host/Origin pair and receives the cookie unchanged.
  try {
    return await new Promise<Response>((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = send(
        target,
        { method: request.method, headers: Object.fromEntries(headers), signal: request.signal },
        (response) => {
          const output = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i],
              value = response.rawHeaders[i + 1];
            if (!hopHeaders.includes(name.toLowerCase())) output.append(name, value);
          }
          const status = response.statusCode ?? 502;
          const body =
            request.method === 'HEAD' || [204, 205, 304].includes(status)
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, headers: output }));
        },
      );
      upstream.on('error', reject);
      if (request.body && !['GET', 'HEAD'].includes(request.method))
        void pipeline(Readable.from(chunks(request.body)), upstream).catch(reject);
      else upstream.end();
    });
  } catch {
    return Response.json({ ok: false, error: 'API_UNAVAILABLE' }, { status: 502 });
  }
}

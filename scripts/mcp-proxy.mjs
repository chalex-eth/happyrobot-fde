import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Tunnel only this proxy, never the Next dev server or the local operator API.
export function createMcpProxy(target = 'http://127.0.0.1:3000/api/mcp', { allowAdversarial = true } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/api/mcp' && !(allowAdversarial && req.url === '/api/mcp/adversarial')) { res.writeHead(404).end(); return; }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.writeHead(405).end(); return; }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const headers = {};
      for (const name of ['authorization', 'content-type', 'accept', 'origin', 'x-happyrobot-run-id', 'x-adversarial-session', 'mcp-protocol-version', 'mcp-session-id']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const upstream = await fetch(req.url === '/api/mcp/adversarial' ? `${target}/adversarial` : target, { method: req.method, headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(30_000) });
      for (const name of ['content-type', 'x-request-id', 'www-authenticate']) {
        if (upstream.headers.has(name)) res.setHeader(name, upstream.headers.get(name));
      }
      res.writeHead(upstream.status).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMcpProxy(process.env.MCP_PROXY_TARGET, { allowAdversarial: process.env.MCP_PROXY_ALLOW_ADVERSARIAL !== 'false' });
  server.requestTimeout = 35_000;
  const host = process.env.MCP_PROXY_HOST || '127.0.0.1';
  server.listen(3002, host, () => console.log(`MCP-only proxy listening on ${host}:3002/api/mcp`));
}

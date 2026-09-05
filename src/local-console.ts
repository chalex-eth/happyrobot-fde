// Local operator convenience endpoints are never enabled in a production build.
export function rejectNonLocalRequest(request: Request): Response | undefined {
  const reject = (status: number, error: string) => Response.json({ ok: false, error }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (process.env.NODE_ENV !== 'development') return reject(404, 'LOCAL_CONSOLE_DISABLED');
  try {
    const origin = new URL(request.headers.get('origin') ?? '');
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || origin.host !== request.headers.get('host') || origin.origin !== request.headers.get('origin')) {
      return reject(403, 'INVALID_ORIGIN');
    }
  } catch { return reject(403, 'INVALID_ORIGIN'); }
}

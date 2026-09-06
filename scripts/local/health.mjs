// A 401 proves that the real MCP handler is responding and requires authentication.
try {
  const response = await fetch(process.argv[2], { signal: AbortSignal.timeout(8_000), redirect: 'error' });
  process.exitCode = response.status === Number(process.argv[3] ?? 401) ? 0 : 1;
} catch { process.exitCode = 1; }

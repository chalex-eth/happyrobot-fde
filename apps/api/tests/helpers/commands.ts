import type { RpcName, RpcArgs } from '../../src/db/rpc-contracts/index.js';
import type { TestContext } from 'node:test';
import { commandGateway } from '../../src/application/commands.js';
import { SessionError } from '../../src/errors.js';
// These tests exercise integration orchestration. Database decisions are covered
// against real PostgreSQL by db:parity, rather than simulated inside this helper.
export function mockCommandsAndFetch(
  t: TestContext,
  respond: (url: URL, init: RequestInit) => Promise<Response>,
) {
  const mocked = t.mock.method(globalThis, 'fetch', respond);
  t.mock.method(commandGateway, 'execute', async (name: RpcName, args: RpcArgs<RpcName>) => {
    const { TWIN_GATEWAY, TWIN_ORG_ID } = process.env;
    if (!TWIN_GATEWAY || !TWIN_ORG_ID) throw new SessionError('TWIN_NOT_CONFIGURED');
    try {
      const response = await globalThis.fetch(new URL('/rpc/' + name, TWIN_GATEWAY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-org-id': TWIN_ORG_ID },
        body: JSON.stringify(args),
      });
      if (!response.ok)
        throw new SessionError(
          response.status === 404 ? 'TWIN_SCHEMA_REQUIRED' : 'TWIN_UNAVAILABLE',
        );
      return await response.json();
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError('TWIN_UNAVAILABLE');
    }
  });
  return mocked;
}

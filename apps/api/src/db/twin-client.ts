import { z } from 'zod';
import { SessionError } from '../errors.js';
import { twinConfig } from '../config/env.js';
import {
  rpcInputs,
  parseCallResult,
  type CallRpcRequest,
  type RpcName,
  type RpcArgs,
  type TwinResult,
} from './rpc-contracts/index.js';

// Only this module knows the Twin gateway protocol. Runtime database access
// always uses Twin; local PostgreSQL exists solely in db/scripts.
async function request<K extends RpcName>(name: K, args: RpcArgs<K>): Promise<unknown> {
  const parsed = rpcInputs[name].safeParse(args);
  if (!parsed.success) throw new SessionError('TWIN_INVALID_ARGUMENTS', 400);
  const { TWIN_GATEWAY, TWIN_ORG_ID } = twinConfig();
  try {
    const response = await fetch(new URL(`/rpc/${name}`, TWIN_GATEWAY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-org-id': TWIN_ORG_ID },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(6000),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok)
      throw new SessionError(response.status === 404 ? 'TWIN_SCHEMA_REQUIRED' : 'TWIN_UNAVAILABLE');
    return await response.json();
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError('TWIN_UNAVAILABLE');
  }
}
export async function twinRpc(...[name, args]: CallRpcRequest): Promise<TwinResult> {
  const value = await request(name, args);
  try {
    return parseCallResult(name, args, value);
  } catch {
    throw new SessionError('TWIN_INVALID_RESPONSE');
  }
}
// Internal consumers must supply an actual validator, never an unchecked <T>.
export async function validatedRpc<K extends RpcName, S extends z.ZodType>(
  name: K,
  args: RpcArgs<K>,
  schema: S,
): Promise<z.output<S>> {
  const value = await request(name, args);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SessionError('TWIN_INVALID_RESPONSE');
  return parsed.data;
}

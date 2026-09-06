import { z } from 'zod';
import { SessionError } from '../errors.js';
import {
  rpcInputs,
  parseCallResult,
  type CallRpcRequest,
  type RpcName,
  type RpcArgs,
  type TwinResult,
} from './rpc-contracts/index.js';

// Compatibility facade: business commands execute in TypeScript. Only persistence.ts speaks to Twin.
import { commandGateway } from '../application/commands.js';
async function request<K extends RpcName>(name: K, args: RpcArgs<K>): Promise<unknown> {
  const parsed = rpcInputs[name].safeParse(args);
  if (!parsed.success) throw new SessionError('TWIN_INVALID_ARGUMENTS', 400);
  return commandGateway.execute(name, args);
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

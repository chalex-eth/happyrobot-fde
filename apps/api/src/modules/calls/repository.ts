import type { CallAction, RpcArgs } from '../../db/rpc-contracts/index.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { twinRpc } from '../../db/twin-client.js';
import { SessionError } from '../../errors.js';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function startCall(previousHash: string | null = null) {
  const token = randomBytes(32).toString('hex');
  const result = await twinRpc('poc_start_call', {
    p_id: randomUUID(),
    p_session_hash: sha256(token),
    p_previous_hash: previousHash,
  });
  if (!result.ok || !result.session) throw new SessionError('TWIN_UNAVAILABLE');
  return { token, hash: sha256(token), session: result.session };
}

export async function callAction(
  hash: string,
  action: CallAction,
  args: Omit<RpcArgs<'poc_call_action'>, 'p_session_hash' | 'p_action'> = {},
) {
  const result = await twinRpc('poc_call_action', {
    ...args,
    p_session_hash: hash,
    p_action: action,
  });
  return result;
}

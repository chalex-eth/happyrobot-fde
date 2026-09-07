import { z } from 'zod';
import { validatedRpc } from '../../db/twin-client.js';
import { operatorResults } from '../../db/rpc-contracts/index.js';
import { SessionError } from '../../errors.js';
import { ErrorResponseSchema } from '@carrier/contracts/calls';
import { runtimeConfig } from '../../config/env.js';

type Action = keyof typeof operatorResults;
type Result<A extends Action> = z.output<(typeof operatorResults)[A]>;
export function operatorRpc(
  action: 'list',
  metadata?: Record<string, unknown>,
): Promise<Result<'list'>>;
export function operatorRpc(
  action: 'detail',
  metadata: Record<string, unknown>,
): Promise<Result<'detail'>>;
export function operatorRpc(
  action: 'review',
  metadata: Record<string, unknown>,
): Promise<Result<'review'>>;
export async function operatorRpc(action: Action, metadata: Record<string, unknown> = {}) {
  const key = runtimeConfig().features.operatorRpcKey;
  if (!key) throw new SessionError('OPERATOR_NOT_CONFIGURED');
  const result = await validatedRpc(
    'poc_operator',
    { p_key: key, p_action: action, p_metadata: metadata },
    z.union([operatorResults[action], ErrorResponseSchema]),
  );
  if (!result.ok)
    throw new SessionError(result.error, result.error === 'REVIEW_CHANGED' ? 409 : 503);
  return result;
}

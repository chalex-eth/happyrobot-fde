import { z } from 'zod';
import { validatedRpc } from '../../db/twin-client.js';
import type { TrackAction } from '../../db/rpc-contracts/index.js';
import { OkResponseSchema, ErrorResponseSchema } from '@carrier/contracts/calls';
import { SessionError } from '../../errors.js';
export async function trackCall(
  hash: string,
  action: TrackAction,
  metadata: Record<string, unknown> = {},
) {
  if (process.env.OPERATIONS_ENABLED !== 'true') return;
  const result = await validatedRpc(
    'poc_track_call',
    { p_session_hash: hash, p_action: action, p_metadata: metadata },
    z.union([OkResponseSchema, ErrorResponseSchema]),
  );
  if (!result.ok) throw new SessionError(result.error);
}

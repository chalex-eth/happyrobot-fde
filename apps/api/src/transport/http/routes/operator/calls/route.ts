import { CallsQuerySchema } from '@carrier/contracts/operations';
import { z } from 'zod';
import { operatorRpc } from '../../../../../modules/operations/index.js';
import { operatorResponse, operatorError } from '../../../operator-response.js';
import { SessionError } from '../../../../../errors.js';
export async function GET(request: Request) {
  try {
    const p = Object.fromEntries(new URL(request.url).searchParams);
    if (p.call_id) {
      const id = z.string().uuid().safeParse(p.call_id);
      if (!id.success) throw new SessionError('INVALID_REQUEST', 400);
      return operatorResponse(await operatorRpc('detail', { call_id: id.data }));
    }
    const q = CallsQuerySchema.safeParse(p);
    if (!q.success) throw new SessionError('INVALID_REQUEST', 400);
    return operatorResponse(await operatorRpc('list', q.data));
  } catch (e) {
    return operatorError(e);
  }
}

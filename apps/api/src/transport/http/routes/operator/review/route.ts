import { ReviewRequestSchema } from '@carrier/contracts/operations';
import { checkOperatorOrigin } from '../../../middleware/operator-origin.js';
import { operatorRpc } from '../../../../../modules/operations/index.js';
import { operatorResponse, operatorError } from '../../../operator-response.js';
import { readJson } from '../../../read-json.js';
import { SessionError } from '../../../../../errors.js';
export async function POST(request: Request) {
  try {
    checkOperatorOrigin(request);
    const p = ReviewRequestSchema.safeParse(await readJson(request, 2500));
    if (!p.success) throw new SessionError('INVALID_REVIEW', 400);
    return operatorResponse(await operatorRpc('review', p.data));
  } catch (e) {
    return operatorError(e);
  }
}

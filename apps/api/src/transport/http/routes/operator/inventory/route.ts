import { inventory } from '../../../../../modules/operations/index.js';
import { operatorResponse, operatorError } from '../../../operator-response.js';
import { requireOperatorSession } from '../../../middleware/operator-session.js';
export async function GET(request: Request) {
  try {
    requireOperatorSession(request);
    return operatorResponse(await inventory());
  } catch (e) {
    return operatorError(e);
  }
}

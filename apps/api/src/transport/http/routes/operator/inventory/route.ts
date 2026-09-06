import { inventory } from '../../../../../modules/operations/index.js';
import { operatorResponse, operatorError } from '../../../operator-response.js';
export async function GET() {
  try {
    return operatorResponse(await inventory());
  } catch (e) {
    return operatorError(e);
  }
}

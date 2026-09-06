import { inventory } from '../../../../src/operator';
import { operatorResponse,operatorError } from '../../../../src/operator-http';
export const runtime='nodejs';
export async function GET(){try{return operatorResponse(await inventory());}catch(e){return operatorError(e);}}

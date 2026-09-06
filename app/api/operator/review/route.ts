import { z } from 'zod';
import { checkOperatorOrigin } from '../../../../src/operator-auth';
import { operatorRpc } from '../../../../src/operator';
import { operatorResponse,operatorError } from '../../../../src/operator-http';
import { readJson,SessionError } from '../../../../src/call-session';
export const runtime='nodejs';
export async function POST(request:Request){try{checkOperatorOrigin(request);const p=z.strictObject({id:z.string().uuid(),revision:z.string().uuid(),status:z.enum(['open','reviewed']),note:z.string().trim().min(1).max(500)}).safeParse(await readJson(request,2500));if(!p.success)throw new SessionError('INVALID_REVIEW',400);return operatorResponse(await operatorRpc('review',p.data));}catch(e){return operatorError(e);}}

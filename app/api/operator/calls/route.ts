import { z } from 'zod';
import { operatorRpc } from '../../../../src/operator';
import { operatorResponse,operatorError } from '../../../../src/operator-http';
import { SessionError } from '../../../../src/call-session';
export const runtime='nodejs';
export async function GET(request:Request) {
 try{const p=Object.fromEntries(new URL(request.url).searchParams);
  if(p.call_id){const id=z.string().uuid().safeParse(p.call_id);if(!id.success) throw new SessionError('INVALID_REQUEST',400);return operatorResponse(await operatorRpc('detail',{call_id:id.data}));}
  const q=z.object({source:z.enum(['all','browser_demo','evaluation','integration_test','unknown']).default('all'),review:z.enum(['true','false']).default('false'),query:z.string().max(64).regex(/^[a-zA-Z0-9_-]*$/).default(''),offset:z.coerce.number().int().min(0).max(10000).default(0)}).safeParse(p);
  if(!q.success)throw new SessionError('INVALID_REQUEST',400);
  return operatorResponse(await operatorRpc('list',q.data));
 }catch(e){return operatorError(e);}
}

import { callAction,readJson,sessionHash,SessionError } from '../../../../../src/call-session';
import { rejectNonLocalRequest } from '../../../../../src/local-console';
import { trackCall } from '../../../../../src/operator';
export const runtime='nodejs';
export async function POST(request:Request){const denied=rejectNonLocalRequest(request);if(denied)return denied;
 try{const hash=sessionHash(request),body=await readJson(request);const current=await callAction(hash,'status');if(!current.ok||current.session?.callId!==body.callId)throw new SessionError('CALL_CHANGED',409);await trackCall(hash,'disconnected');return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}
 catch(e){return Response.json({ok:false,error:e instanceof SessionError?e.code:'ACTIVITY_UNAVAILABLE'},{status:e instanceof SessionError?e.status:503});}}

import { SessionError } from './call-session';
export const operatorResponse = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export function operatorError(error:unknown) { const e=error instanceof SessionError?error:new SessionError('OPERATOR_UNAVAILABLE'); return operatorResponse({ok:false,error:e.code},e.status); }

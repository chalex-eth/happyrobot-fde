import { SessionError } from '../../../../../errors.js';
import {
  clearOperatorSessionCookie,
  createOperatorSession,
  operatorSessionCookie,
  requireOperatorSession,
  verifyOperatorPassword,
} from '../../../middleware/operator-session.js';
import { operatorError, operatorResponse } from '../../../operator-response.js';
import { readJson } from '../../../read-json.js';

export async function POST(request: Request) {
  try {
    const input = await readJson(request, 1024);
    if (!verifyOperatorPassword(input.password))
      throw new SessionError('OPERATOR_AUTH_REQUIRED', 401);
    const response = operatorResponse({ ok: true, role: 'operator' });
    response.headers.set('Set-Cookie', operatorSessionCookie(createOperatorSession()));
    return response;
  } catch (error) {
    return operatorError(error);
  }
}

export async function GET(request: Request) {
  try {
    return operatorResponse({ ok: true, ...requireOperatorSession(request) });
  } catch (error) {
    return operatorError(error);
  }
}

export async function DELETE(_request: Request) {
  const response = operatorResponse({ ok: true });
  response.headers.set('Set-Cookie', clearOperatorSessionCookie());
  return response;
}

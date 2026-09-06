import type { TwinResult } from '../../db/result.js';
export function resultStatus(result: TwinResult) {
  return result.ok
    ? 200
    : result.error === 'SESSION_REQUIRED'
      ? 401
      : result.error === 'AUTHORITY_REQUIRED' || result.error === 'OTP_REQUIRED'
        ? 403
        : 409;
}

import { handleTmsRequest } from '../../tms.js';

export const maxDuration = 15;

export async function POST(request: Request) {
  return handleTmsRequest(request);
}

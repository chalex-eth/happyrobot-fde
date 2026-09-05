import { handleTmsRequest } from '../../../src/tms-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request) {
  return handleTmsRequest(request);
}

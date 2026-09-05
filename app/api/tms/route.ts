import 'server-only';
import { handleTmsRequest } from '../../../src/tms-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The TCP adapter has two 4-second attempts and one 150ms read-only backoff.
// Configure the HappyRobot tool with a timeout above this function's budget.
export const maxDuration = 15;

export async function POST(request: Request) {
  return handleTmsRequest(request);
}

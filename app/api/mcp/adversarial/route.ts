import { handleAdversarialMcp } from '../../../../src/adversarial-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleAdversarialMcp(request);
export const GET = POST;
export const DELETE = POST;

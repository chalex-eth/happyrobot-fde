import { handleMcp } from '../../../src/mcp-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleMcp(request);
export const GET = POST;
export const DELETE = POST;

import { handleMcp } from '../../../mcp/server.js';

export const POST = (request: Request) => handleMcp(request);
export const GET = POST;
export const DELETE = POST;

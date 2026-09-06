import { handleAdversarialMcp } from '../../../../mcp/adversarial.js';

export const POST = (request: Request) => handleAdversarialMcp(request);
export const GET = POST;
export const DELETE = POST;

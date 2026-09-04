import { scaffoldEndpoint } from "@/server/http/scaffold-endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Placeholder only: no MCP transport, tool registration or provider calls yet.
function handler(request: Request): Response {
  return scaffoldEndpoint(request, "gateway");
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };

import { scaffoldEndpoint } from "@/server/http/scaffold-endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return scaffoldEndpoint(request, "manager");
}

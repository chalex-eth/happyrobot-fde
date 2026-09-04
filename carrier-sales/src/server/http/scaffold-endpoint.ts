import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const tokenSchema = z.string().min(32).refine((value) => value.trim() === value);
const tokenVariables = {
  gateway: "GATEWAY_BEARER_TOKEN",
  manager: "MANAGER_BEARER_TOKEN",
} as const;

function errorResponse(status: number, code: string, safeMessage: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (status === 401) headers["WWW-Authenticate"] = "Bearer";

  return Response.json(
    { ok: false, error: { code, retryable: false, safeMessage } },
    { status, headers },
  );
}

/** Fail-closed placeholder. Successful authentication never runs business actions. */
export function scaffoldEndpoint(
  request: Request,
  audience: keyof typeof tokenVariables,
): Response {
  const token = tokenSchema.safeParse(process.env[tokenVariables[audience]]);
  if (!token.success) {
    return errorResponse(503, "NOT_CONFIGURED", "This endpoint is not configured.");
  }

  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  const supplied = match?.[1];
  if (!supplied) {
    return errorResponse(401, "UNAUTHORIZED", "Authentication is required.");
  }

  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(token.data))) {
    return errorResponse(401, "UNAUTHORIZED", "Authentication is required.");
  }

  return errorResponse(501, "NOT_IMPLEMENTED", "This endpoint is scaffolded but not implemented.");
}

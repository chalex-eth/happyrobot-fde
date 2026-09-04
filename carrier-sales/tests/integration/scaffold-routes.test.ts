import { describe, expect, it, vi } from "vitest";
import { POST as mcpPost } from "../../app/api/mcp/route";
import { GET as managerGet } from "../../app/api/manager/calls/route";

const gatewayToken = "test-only-gateway-token-not-a-real-secret";
const managerToken = "test-only-manager-token-not-a-real-secret";

function request(token?: string): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("fail-closed route placeholders", () => {
  it("is unavailable without configuration", () => {
    vi.stubEnv("GATEWAY_BEARER_TOKEN", "");
    expect(mcpPost(request()).status).toBe(503);
  });

  it("rejects short configuration values", () => {
    vi.stubEnv("GATEWAY_BEARER_TOKEN", "invalid");
    expect(mcpPost(request("invalid")).status).toBe(503);
  });

  it("requires valid authentication", () => {
    vi.stubEnv("GATEWAY_BEARER_TOKEN", gatewayToken);
    expect(mcpPost(request()).status).toBe(401);
    expect(mcpPost(request("wrong")).status).toBe(401);
    expect(mcpPost(request()).headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns only an unimplemented response to authorized callers", async () => {
    vi.stubEnv("GATEWAY_BEARER_TOKEN", gatewayToken);
    const response = mcpPost(request(gatewayToken));
    expect(response.status).toBe(501);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
    expect(JSON.stringify(body)).not.toContain(gatewayToken);
  });

  it("keeps gateway and manager credentials separate", () => {
    vi.stubEnv("GATEWAY_BEARER_TOKEN", gatewayToken);
    vi.stubEnv("MANAGER_BEARER_TOKEN", managerToken);
    expect(managerGet(request(gatewayToken)).status).toBe(401);
    expect(managerGet(request(managerToken)).status).toBe(501);
  });
});

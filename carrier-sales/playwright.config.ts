import { defineConfig, devices } from "@playwright/test";

// Reserved local test listener; tests never connect to external providers.
const nodeExecutable = JSON.stringify(process.execPath);

export default defineConfig({
  testDir: "./tests/e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `${nodeExecutable} .next/standalone/server.js`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: "3100",
      GATEWAY_BEARER_TOKEN: "test-only-gateway-token-not-a-real-secret",
      MANAGER_BEARER_TOKEN: "test-only-manager-token-not-a-real-secret",
    },
  },
});

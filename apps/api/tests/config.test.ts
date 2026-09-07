import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeConfig } from '../src/config/env.js';

function isolateEnvironment(t: { after: (fn: () => void) => void }, values: NodeJS.ProcessEnv) {
  const previous = { ...process.env };
  process.env = values;
  t.after(() => {
    process.env = previous;
  });
}

test('runtime config groups typed integration and feature settings', (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'development',
    API_HOST: '0.0.0.0',
    API_PORT: '3012',
    TMS_HOST: '127.0.0.1',
    TMS_PORT: '55439',
    TMS_TOKEN: 'test-token',
    OTP_DEMO_MODE: 'true',
    OTP_DELIVERY_MODE: 'mock',
    OTP_HASH_SECRET: 'test-secret',
    HAPPYROBOT_ENVIRONMENT: 'development',
    MCP_AUTH_TOKEN: 'mcp-token',
    NEGOTIATION_ENABLED: 'true',
    BOOKING_ENABLED: 'true',
    BOOKING_TMS_MODE: 'mock',
    OPERATIONS_ENABLED: 'true',
  });

  const config = runtimeConfig();
  assert.deepEqual(config.server, { host: '0.0.0.0', port: 3012 });
  assert.deepEqual(config.tms, {
    host: '127.0.0.1',
    port: 55439,
    token: 'test-token',
  });
  assert.equal(config.otp.demoMode, true);
  assert.equal(config.happyrobot.environment, 'development');
  assert.equal(config.mcp.authToken, 'mcp-token');
  assert.deepEqual(config.features, {
    negotiationEnabled: true,
    bookingEnabled: true,
    bookingTmsMode: 'mock',
    operationsEnabled: true,
    operatorRpcKey: undefined,
  });
});

test('runtime config treats blank optional values as absent and defaults safely', (t) => {
  isolateEnvironment(t, {
    API_PORT: '3001',
    TMS_PORT: '',
    OTP_DELIVERY_MODE: '',
    BOOKING_TMS_MODE: '',
    MCP_AUTH_TOKEN: '',
  });

  const config = runtimeConfig();
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.tms.port, undefined);
  assert.equal(config.otp.deliveryMode, 'mock');
  assert.equal(config.features.bookingTmsMode, 'mock');
  assert.equal(config.mcp.authToken, undefined);
});

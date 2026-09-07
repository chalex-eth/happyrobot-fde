import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const optionalPort = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : value),
  z.coerce.number().int().min(1).max(65535).optional(),
);
const envBoolean = z
  .preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['true', 'false']).default('false'),
  )
  .transform((value) => value === 'true');

const runtimeSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  TMS_HOST: optionalString,
  TMS_PORT: optionalPort,
  TMS_TOKEN: optionalString,
  LOCAL_API_TOKEN: optionalString,
  LOCAL_BASE_URL: optionalString,
  FMCSA_API_KEY: optionalString,
  TWIN_API_KEY: optionalString,
  OTP_DEMO_MODE: envBoolean,
  OTP_DELIVERY_MODE: optionalString,
  DEMO_OTP_EMAIL: optionalString,
  OTP_HASH_SECRET: optionalString,
  OTP_WEBHOOK_URL: optionalString,
  OTP_WEBHOOK_API_KEY: optionalString,
  HAPPYROBOT_API_KEY: optionalString,
  HAPPYROBOT_WORKFLOW_ID: optionalString,
  HAPPYROBOT_ENVIRONMENT: z.enum(['development', 'staging', 'production']).optional(),
  MCP_AUTH_TOKEN: optionalString,
  MCP_PUBLIC_URL: optionalString,
  HAPPYROBOT_MCP_SERVER_NAME: optionalString,
  ADVERSARIAL_MCP_ENABLED: envBoolean,
  ADVERSARIAL_MCP_TOKEN: optionalString,
  NEGOTIATION_ENABLED: envBoolean,
  BOOKING_ENABLED: envBoolean,
  BOOKING_TMS_MODE: optionalString,
  OPERATIONS_ENABLED: envBoolean,
  OPERATOR_RPC_KEY: optionalString,
});

export type RuntimeConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  server: { host: string; port: number };
  tms: { host?: string; port?: number; token?: string };
  local: { apiToken?: string; baseUrl: string };
  fmcsa: { apiKey?: string };
  twin: { apiKey?: string };
  otp: {
    demoMode: boolean;
    deliveryMode: string;
    demoEmail?: string;
    hashSecret?: string;
    webhookUrl?: string;
    webhookApiKey?: string;
  };
  happyrobot: {
    apiKey?: string;
    workflowId?: string;
    environment?: 'development' | 'staging' | 'production';
  };
  mcp: {
    authToken?: string;
    publicUrl?: string;
    serverName: string;
    adversarialEnabled: boolean;
    adversarialToken?: string;
  };
  features: {
    negotiationEnabled: boolean;
    bookingEnabled: boolean;
    bookingTmsMode: string;
    operationsEnabled: boolean;
    operatorRpcKey?: string;
  };
};

export function runtimeConfig(): RuntimeConfig {
  const env = runtimeSchema.parse(process.env);
  return {
    nodeEnv: env.NODE_ENV,
    server: { host: env.API_HOST, port: env.API_PORT },
    tms: { host: env.TMS_HOST, port: env.TMS_PORT, token: env.TMS_TOKEN },
    local: {
      apiToken: env.LOCAL_API_TOKEN,
      baseUrl: env.LOCAL_BASE_URL ?? 'http://127.0.0.1:3000',
    },
    fmcsa: { apiKey: env.FMCSA_API_KEY },
    twin: { apiKey: env.TWIN_API_KEY },
    otp: {
      demoMode: env.OTP_DEMO_MODE,
      deliveryMode: env.OTP_DELIVERY_MODE ?? 'mock',
      demoEmail: env.DEMO_OTP_EMAIL,
      hashSecret: env.OTP_HASH_SECRET,
      webhookUrl: env.OTP_WEBHOOK_URL,
      webhookApiKey: env.OTP_WEBHOOK_API_KEY,
    },
    happyrobot: {
      apiKey: env.HAPPYROBOT_API_KEY,
      workflowId: env.HAPPYROBOT_WORKFLOW_ID,
      environment: env.HAPPYROBOT_ENVIRONMENT,
    },
    mcp: {
      authToken: env.MCP_AUTH_TOKEN,
      publicUrl: env.MCP_PUBLIC_URL,
      serverName: env.HAPPYROBOT_MCP_SERVER_NAME ?? 'Carrier sales local MCP',
      adversarialEnabled: env.ADVERSARIAL_MCP_ENABLED,
      adversarialToken: env.ADVERSARIAL_MCP_TOKEN,
    },
    features: {
      negotiationEnabled: env.NEGOTIATION_ENABLED,
      bookingEnabled: env.BOOKING_ENABLED,
      bookingTmsMode: env.BOOKING_TMS_MODE ?? 'mock',
      operationsEnabled: env.OPERATIONS_ENABLED,
      operatorRpcKey: env.OPERATOR_RPC_KEY,
    },
  };
}

export function serverConfig() {
  return runtimeConfig().server;
}

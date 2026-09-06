import { z } from 'zod';
import { SessionError } from '../errors.js';
const serverSchema = z.object({
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function serverConfig() {
  return serverSchema.parse(process.env);
}
export function twinConfig() {
  const result = z
    .object({
      TWIN_GATEWAY: z.url().refine((s) => new URL(s).protocol === 'https:'),
      TWIN_ORG_ID: z.string().min(1),
    })
    .safeParse(process.env);
  if (!result.success) throw new SessionError('TWIN_NOT_CONFIGURED');
  return result.data;
}

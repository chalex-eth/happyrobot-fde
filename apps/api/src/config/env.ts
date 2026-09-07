import { z } from 'zod';
const serverSchema = z.object({
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function serverConfig() {
  return serverSchema.parse(process.env);
}

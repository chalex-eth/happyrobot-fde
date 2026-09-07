import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/api/src/db/schema/index.ts',
  out: './apps/api/db/migrations',
  strict: true,
});

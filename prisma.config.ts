import { defineConfig } from 'prisma/config';
import 'dotenv/config';

const directUrl = process.env.DIRECT_URL;
if (directUrl && new URL(directUrl).hostname.includes('-pooler')) {
  throw new Error('DIRECT_URL must use the direct Neon endpoint for Prisma migrations');
}

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: { path: 'packages/db/prisma/migrations' },
  datasource: { url: directUrl },
});

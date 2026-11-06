import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';

export function openDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error('A PostgreSQL DATABASE_URL is required');
  }
  const url = new URL(connectionString);
  if (!url.hostname || !url.pathname.slice(1)) throw new Error('DATABASE_URL must name a PostgreSQL database');
  if (process.env.NODE_ENV === 'production' && !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
    throw new Error('Production DATABASE_URL must require TLS');
  }
  const adapter = new PrismaPg({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
  return new PrismaClient({ adapter, transactionOptions: { timeout: 20_000, maxWait: 5000 } });
}

export type { Prisma } from '../generated/client';
export type Database = ReturnType<typeof openDatabase>;

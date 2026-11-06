import { createHash } from 'node:crypto';
import type { Database, Prisma } from '../../../packages/db/src/index';

export class DomainError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503, message: string, public code?: string) {
    super(message);
  }
}

export const missing = () => new DomainError(404, 'Record not found');
export const conflict = (message: string, code?: string) => new DomainError(409, message, code);
export type Scope = { organizationId: string; actorId: string | null };
export type Tx = Prisma.TransactionClient;

export function atomic<T>(db: Database, scope: Scope, run: (tx: Tx) => Promise<T>) {
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Organization" WHERE id = ${scope.organizationId}::uuid FOR UPDATE`;
    if (!locked.length) throw missing();
    if (scope.actorId) {
      const access = await tx.membership.findFirst({ where: { organizationId: scope.organizationId, userId: scope.actorId, role: 'OWNER', user: { emailVerified: true } } });
      if (!access) throw missing();
    }
    return run(tx);
  });
}

export function audit(tx: Tx, scope: Scope, action: string, entityId: string, details?: Prisma.InputJsonObject) {
  return tx.auditLog.create({ data: { ...scope, action, entityId, details } });
}

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

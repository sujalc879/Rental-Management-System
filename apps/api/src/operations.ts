import type { Database } from '../../../packages/db/src/index';
import { periodDate } from '../../../packages/shared/src/ledger';
import { atomic, audit, conflict, missing, type Scope } from './domain';

export const workerHeartbeatName = 'rental-worker';
export const workerHeartbeatMaxAge = 3 * 60_000;

export async function workerHealth(db: Pick<Database, 'workerHeartbeat'>) {
  const row = await db.workerHeartbeat.findUnique({ where: { name: workerHeartbeatName } });
  return {
    status: !row ? 'UNAVAILABLE' : Date.now() - row.lastSucceededAt.getTime() < workerHeartbeatMaxAge ? 'HEALTHY' : 'OVERDUE',
    lastSuccessAt: row?.lastSucceededAt ?? null,
  };
}

export function recordWorkerHeartbeat(db: Database) {
  return db.workerHeartbeat.upsert({ where: { name: workerHeartbeatName },
    create: { name: workerHeartbeatName, lastSucceededAt: new Date() }, update: { lastSucceededAt: new Date() },
  });
}

export function operationsHealth(db: Database, scope: Scope) {
  return db.$transaction(async tx => {
    const worker = await workerHealth(tx);
    const organizationId = scope.organizationId;
    const pending = await tx.billingJob.count({ where: { organizationId, doneAt: null, failedAt: null } });
    const failed = await tx.billingJob.count({ where: { organizationId, failedAt: { not: null } } });
    const failedJobs = await tx.billingJob.findMany({ where: { organizationId, failedAt: { not: null } },
      select: { period: true, attempts: true, failedAt: true }, orderBy: { period: 'desc' }, take: 20,
    });
    return { worker, billing: { pending, failed, failedJobs } };
  }, { isolationLevel: 'RepeatableRead' });
}

export function retryBillingJob(db: Database, scope: Scope, month: string, reason: string) {
  return atomic(db, scope, async tx => {
    const period = periodDate(month);
    const where = { organizationId_period: { organizationId: scope.organizationId, period } };
    const job = await tx.billingJob.findUnique({ where });
    if (!job) throw missing();
    if (!job.failedAt || job.doneAt) throw conflict('Only failed billing jobs can be retried');
    await tx.billingJob.update({ where, data: { failedAt: null, attempts: 0, nextAt: new Date() } });
    await audit(tx, scope, 'billing.retried', scope.organizationId, { month, reason });
    return { status: 'PENDING' };
  });
}

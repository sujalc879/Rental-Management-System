import type { Database } from '../../../packages/db/src/index';
import { businessMonth, periodDate } from '../../../packages/shared/src/ledger';
import { atomic } from '../../api/src/domain';
import { generateCharges } from '../../api/src/rentals';

export async function scheduleBilling(db: Database) {
  const month = `${businessMonth()}-01`;
  await db.$executeRaw`INSERT INTO "BillingJob" ("organizationId", period)
    SELECT o.id, series.period::date FROM "Organization" o CROSS JOIN LATERAL generate_series(
      COALESCE((SELECT MAX(j.period) FROM "BillingJob" j WHERE j."organizationId" = o.id),
        LEAST(date_trunc('month', o."createdAt" AT TIME ZONE 'Asia/Kolkata')::date, ${month}::date)),
      ${month}::date, interval '1 month') AS series(period)
    ON CONFLICT ("organizationId", period) DO NOTHING`;
}

export async function runBillingJob(db: Database) {
  const job = await db.billingJob.findFirst({ where: { doneAt: null, failedAt: null, nextAt: { lte: new Date() } }, orderBy: { nextAt: 'asc' } });
  if (!job) return false;
  const scope = { organizationId: job.organizationId, actorId: null };
  const where = { organizationId_period: { organizationId: job.organizationId, period: job.period } };
  try {
    await atomic(db, scope, async tx => {
      const current = await tx.billingJob.findUniqueOrThrow({ where });
      if (current.doneAt || current.failedAt || current.nextAt > new Date()) return;
      const period = periodDate(current.period.toISOString().slice(0, 7));
      await generateCharges(tx, scope, period);
      await tx.billingJob.update({ where, data: { doneAt: new Date(), attempts: { increment: 1 } } });
    });
  } catch {
    const attempts = job.attempts + 1;
    await db.billingJob.updateMany({ where: { organizationId: job.organizationId, period: job.period, doneAt: null, attempts: job.attempts }, data: {
      attempts, nextAt: new Date(Date.now() + 60_000 * 2 ** attempts), failedAt: attempts >= 5 ? new Date() : null,
    } });
    console.error(JSON.stringify({ event: 'billing.failed', organizationId: job.organizationId, attempts }));
  }
  return true;
}

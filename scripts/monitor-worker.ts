import { openDatabase, type Database } from '../packages/db/src/index';
import { workerHealth } from '../apps/api/src/operations';
import { signalOperator } from './monitoring';

let db: Database | undefined;
try {
  db = openDatabase();
  if (process.env.NODE_ENV === 'production' && !process.env.WORKER_ALERT_URL) throw new Error('Worker alerts are unconfigured');
  const heartbeat = await workerHealth(db);
  const [jobs] = await db.$queryRaw<{ failedBilling: boolean; failedReceipts: boolean }[]>`SELECT
    EXISTS (SELECT 1 FROM "BillingJob" WHERE "failedAt" IS NOT NULL) AS "failedBilling",
    EXISTS (SELECT 1 FROM "NotificationOutbox" WHERE status IN ('UNCERTAIN', 'FAILED')) AS "failedReceipts"`;
  if (heartbeat.status !== 'HEALTHY' || jobs.failedBilling || jobs.failedReceipts) throw new Error('Worker or queued jobs need operator attention');
  console.log(JSON.stringify({ event: 'worker.monitor.healthy' }));
} catch {
  console.error(JSON.stringify({ event: 'worker.monitor.failed', reason: 'Check worker heartbeat, database connectivity and failed jobs' }));
  await signalOperator(process.env.WORKER_ALERT_URL, 'worker.monitor.failed').catch(() => {
    console.error(JSON.stringify({ event: 'worker.monitor.alert_failed' }));
  });
  process.exitCode = 1;
} finally { await db?.$disconnect(); }

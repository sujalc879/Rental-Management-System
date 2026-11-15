import { setTimeout as pause } from 'node:timers/promises';
import { openDatabase } from '../../../packages/db/src/index';
import { readMessagingConfig } from '../../api/src/config';
import { dispatchOne, recoverExpiredClaims } from '../../api/src/messaging';
import { runBillingJob, scheduleBilling } from './billing';
import { workerErrorDetails } from './logging';
import { recordWorkerHeartbeat } from '../../api/src/operations';
import { operatorDestination, signalOperator } from '../../../scripts/monitoring';

const config = readMessagingConfig();
const heartbeatDestination = operatorDestination(process.env.WORKER_HEARTBEAT_URL);
if (config.NODE_ENV === 'production' && !heartbeatDestination) throw new Error('Production worker requires WORKER_HEARTBEAT_URL for external monitoring');
const db = openDatabase();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
let nextMaintenance = 0;
let nextHeartbeat = 0;
console.log(JSON.stringify({ event: 'worker.started' }));
try {
  while (!stopping) {
    let stage = 'schedule-billing';
    try {
      if (Date.now() >= nextMaintenance) {
        await scheduleBilling(db);
        stage = 'recover-claims';
        const expired = await recoverExpiredClaims(db);
        console.log(JSON.stringify({ event: 'worker.maintenance', expired }));
        nextMaintenance = Date.now() + 60_000;
      }
      stage = 'run-billing';
      await runBillingJob(db);
      stage = 'dispatch-receipt';
      await dispatchOne(db, config);
      if (Date.now() >= nextHeartbeat) {
        stage = 'heartbeat';
        await recordWorkerHeartbeat(db);
        console.log(JSON.stringify({ event: 'worker.heartbeat' }));
        nextHeartbeat = Date.now() + 60_000;
        await signalOperator(process.env.WORKER_HEARTBEAT_URL, 'worker.healthy').catch(() => {
          console.error(JSON.stringify({ event: 'worker.monitoring_failed' }));
        });
      }
    } catch (error) { console.error(JSON.stringify({ event: 'worker.error', stage, ...workerErrorDetails(error) })); }
    await pause(1250);
  }
} finally { await db.$disconnect(); }

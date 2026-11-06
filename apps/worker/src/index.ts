import { setTimeout as pause } from 'node:timers/promises';
import { openDatabase } from '../../../packages/db/src/index';
import { readMessagingConfig } from '../../api/src/config';
import { dispatchOne, recoverExpiredClaims } from '../../api/src/messaging';
import { runBillingJob, scheduleBilling } from './billing';

const config = readMessagingConfig();
const db = openDatabase();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
let nextMaintenance = 0;
console.log(JSON.stringify({ event: 'worker.started' }));
try {
  while (!stopping) {
    try {
      if (Date.now() >= nextMaintenance) {
        await scheduleBilling(db);
        const expired = await recoverExpiredClaims(db);
        console.log(JSON.stringify({ event: 'worker.heartbeat', expired }));
        nextMaintenance = Date.now() + 60_000;
      }
      await runBillingJob(db);
      await dispatchOne(db, config);
    } catch (error) { console.error(JSON.stringify({ event: 'worker.error', kind: error instanceof Error ? error.name : 'unknown' })); }
    await pause(1250);
  }
} finally { await db.$disconnect(); }

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO :"monitor_role";
GRANT SELECT (name, "lastSucceededAt") ON "WorkerHeartbeat" TO :"monitor_role";
GRANT SELECT ("failedAt") ON "BillingJob" TO :"monitor_role";
GRANT SELECT (status) ON "NotificationOutbox" TO :"monitor_role";
GRANT SELECT (status, "startedAt") ON "BackupRun" TO :"monitor_role";

CREATE TABLE "WorkerHeartbeat" (
  name TEXT NOT NULL PRIMARY KEY,
  "lastSucceededAt" TIMESTAMPTZ(3) NOT NULL
);

ALTER TABLE "BackupRun" ADD COLUMN "storageId" TEXT;
CREATE INDEX "BackupRun_storageId_status_startedAt_idx" ON "BackupRun" ("storageId", status, "startedAt");

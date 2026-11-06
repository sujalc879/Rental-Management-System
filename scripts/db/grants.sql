\set ON_ERROR_STOP on

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"api_role", :"worker_role", :"backup_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON "Session", "Verification", "TwoFactor", "RateLimit" TO :"api_role";
GRANT SELECT ON "User", "Account", "Organization", "Membership", "Property", "Room", "Tenant", "Lease", "LeaseTerm", "RentCharge", "Payment", "Allocation", "PaymentReversal", "CreditApplication", "NotificationOutbox", "WhatsAppSender", "AuditLog", "WebhookEvent" TO :"api_role";
GRANT UPDATE (name, "emailVerified", "twoFactorEnabled", "updatedAt") ON "User" TO :"api_role";
GRANT UPDATE (password, "updatedAt") ON "Account" TO :"api_role";
GRANT UPDATE (name, "whatsappEnabled", "updatedAt") ON "Organization" TO :"api_role";
GRANT INSERT, UPDATE ON "Property", "Room", "Tenant" TO :"api_role";
GRANT INSERT ON "Lease", "LeaseTerm", "RentCharge", "Payment", "Allocation", "PaymentReversal", "CreditApplication", "NotificationOutbox", "AuditLog", "WebhookEvent" TO :"api_role";
GRANT UPDATE ("endsOn") ON "Lease" TO :"api_role";
GRANT UPDATE ("voidedAt", "voidReason") ON "RentCharge" TO :"api_role";
GRANT UPDATE (status, attempts, "manualRetries", "nextAt", "claimUntil", "claimToken", "providerId", reason, retryable, "updatedAt") ON "NotificationOutbox" TO :"api_role";
GRANT SELECT (status, "startedAt") ON "BackupRun" TO :"api_role";

GRANT SELECT ON "Organization", "BillingJob", "Property", "Room", "Tenant", "Lease", "LeaseTerm", "RentCharge", "Payment", "PaymentReversal", "WhatsAppSender", "NotificationOutbox", "AuditLog" TO :"worker_role";
GRANT UPDATE ("updatedAt") ON "Organization" TO :"worker_role";
GRANT INSERT, UPDATE ON "BillingJob" TO :"worker_role";
GRANT INSERT ON "RentCharge", "AuditLog" TO :"worker_role";
GRANT UPDATE (status, attempts, "nextAt", "claimUntil", "claimToken", "senderNumberId", "providerId", reason, retryable, "updatedAt") ON "NotificationOutbox" TO :"worker_role";

GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"backup_role";
GRANT INSERT, UPDATE ON "BackupRun" TO :"backup_role";

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Lease" ADD CONSTRAINT lease_dates CHECK ("endsOn" IS NULL OR "endsOn" > "startsOn"),
  ADD CONSTRAINT lease_deposit CHECK ("depositPaise" BETWEEN 0 AND 1000000000),
  ADD CONSTRAINT lease_no_room_overlap EXCLUDE USING gist (
    "organizationId" WITH =, "roomId" WITH =, daterange("startsOn", "endsOn", '[)') WITH &&
  );
ALTER TABLE "Room" ADD CONSTRAINT room_defaults CHECK ("suggestedPaise" BETWEEN 1 AND 1000000000 AND "suggestedDay" BETWEEN 1 AND 31);
ALTER TABLE "LeaseTerm" ADD CONSTRAINT term_values CHECK ("amountPaise" BETWEEN 1 AND 1000000000 AND "dueDay" BETWEEN 1 AND 31 AND EXTRACT(DAY FROM period) = 1);
ALTER TABLE "RentCharge" ADD CONSTRAINT charge_values CHECK ("amountPaise" BETWEEN 1 AND 1000000000 AND EXTRACT(DAY FROM period) = 1 AND
  "dueOn" >= period AND "dueOn" < period + interval '1 month' AND (("voidedAt" IS NULL) = ("voidReason" IS NULL)));
ALTER TABLE "Payment" ADD CONSTRAINT payment_values CHECK ("amountPaise" BETWEEN 1 AND 1000000000 AND
  (CASE WHEN mode = 'ONLINE' THEN reference IS NOT NULL AND length(trim(reference)) BETWEEN 1 AND 100 ELSE reference IS NULL END) AND
  source = 'MANUAL_UNVERIFIED');
ALTER TABLE "Allocation" ADD CONSTRAINT allocation_value CHECK ("amountPaise" BETWEEN 1 AND 1000000000);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_consent_fields CHECK (("consentAt" IS NULL) = ("consentSource" IS NULL) AND ("consentAt" IS NULL OR whatsapp IS NOT NULL));
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT outbox_delivery_values CHECK (attempts >= 0 AND "manualRetries" BETWEEN 0 AND 2 AND
  (status NOT IN ('ACCEPTED', 'SENT', 'DELIVERED', 'READ') OR ("providerId" IS NOT NULL AND "senderNumberId" IS NOT NULL)));
CREATE INDEX outbox_recent_claim ON "NotificationOutbox" ("updatedAt") WHERE "claimToken" IS NOT NULL;

CREATE FUNCTION enforce_rent_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_limit bigint;
  charge_limit bigint;
BEGIN
  PERFORM id FROM "Organization" WHERE id = NEW."organizationId" FOR UPDATE;
  SELECT p."amountPaise" INTO payment_limit FROM "Payment" p WHERE p.id = NEW."paymentId" AND p."organizationId" = NEW."organizationId"
    AND p."leaseId" = NEW."leaseId" AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" v WHERE v."organizationId" = NEW."organizationId" AND v."paymentId" = p.id);
  SELECT c."amountPaise" INTO charge_limit FROM "RentCharge" c WHERE c.id = NEW."chargeId" AND c."organizationId" = NEW."organizationId"
    AND c."leaseId" = NEW."leaseId" AND c."voidedAt" IS NULL;
  IF payment_limit IS NULL OR charge_limit IS NULL OR
    NEW."amountPaise" + (SELECT COALESCE(SUM(a."amountPaise"), 0) FROM "Allocation" a WHERE a."paymentId" = NEW."paymentId" AND a."organizationId" = NEW."organizationId") > payment_limit OR
    NEW."amountPaise" + (SELECT COALESCE(SUM(a."amountPaise"), 0) FROM "Allocation" a WHERE a."chargeId" = NEW."chargeId" AND a."organizationId" = NEW."organizationId"
      AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" v WHERE v."organizationId" = a."organizationId" AND v."paymentId" = a."paymentId")) > charge_limit THEN
    RAISE EXCEPTION 'Allocation violates payment or charge balance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocation_preserves_balance BEFORE INSERT ON "Allocation" FOR EACH ROW EXECUTE FUNCTION enforce_rent_allocation();

CREATE FUNCTION preserve_confirmed_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Confirmed records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();
CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON "Allocation" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();
CREATE TRIGGER reversal_immutable BEFORE UPDATE OR DELETE ON "PaymentReversal" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();
CREATE TRIGGER credit_immutable BEFORE UPDATE OR DELETE ON "CreditApplication" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();
CREATE TRIGGER term_immutable BEFORE UPDATE OR DELETE ON "LeaseTerm" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION preserve_confirmed_row();

CREATE FUNCTION preserve_rent_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Rent charges are retained' USING ERRCODE = '23514'; END IF;
  IF NEW.id <> OLD.id OR NEW."organizationId" <> OLD."organizationId" OR NEW."leaseId" <> OLD."leaseId" OR
    NEW.period <> OLD.period OR NEW."dueOn" <> OLD."dueOn" OR NEW."amountPaise" <> OLD."amountPaise" OR NEW."createdAt" <> OLD."createdAt" OR
    OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL OR EXISTS (SELECT 1 FROM "Allocation" a WHERE a."chargeId" = OLD.id AND a."organizationId" = OLD."organizationId"
      AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" v WHERE v."organizationId" = a."organizationId" AND v."paymentId" = a."paymentId")) THEN
    RAISE EXCEPTION 'Only unused rent charges may be voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER charge_immutable BEFORE UPDATE OR DELETE ON "RentCharge" FOR EACH ROW EXECUTE FUNCTION preserve_rent_charge();

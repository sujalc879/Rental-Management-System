import { readConfig } from '../apps/api/src/config';
import { recordPayment } from '../apps/api/src/payments';
import { createLease, saveProperty, saveRoom, saveTenant } from '../apps/api/src/rentals';
import { openDatabase } from '../packages/db/src/index';
import { businessDay } from '../packages/shared/src/ledger';
import { provisionOwner } from './owners';

const url = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', 'db'].includes(url.hostname) || !/^\/rental_(dev|test)(?:_[a-z0-9_]+)?$/.test(url.pathname)) {
  throw new Error('Seed requires a disposable local rental_dev or rental_test database');
}
const config = readConfig();
const db = openDatabase();
const password = process.env.DEV_OWNER_PASSWORD;
if (!password || password.length < 12) throw new Error('Set a local DEV_OWNER_PASSWORD with at least 12 characters');
try {
  const suffix = crypto.randomUUID().slice(0, 8);
  for (const letter of ['a', 'b']) {
    const email = `owner-${letter}-${suffix}@example.test`;
    const { user, organization } = await provisionOwner(db, { name: `Owner ${letter.toUpperCase()}`, email, organization: `Example Rentals ${letter.toUpperCase()}`, password, verified: true });
    const scope = { actorId: user.id, organizationId: organization.id };
    const property = await saveProperty(db, scope, { name: `Example property ${letter.toUpperCase()}` });
    const room = await saveRoom(db, scope, { propertyId: property.id, name: '101' });
    const tenant = await saveTenant(db, scope, { name: 'Example tenant' });
    const lease = await createLease(db, scope, { roomId: room.id, tenantId: tenant.id, startsOn: businessDay(), amountPaise: 800_000, dueDay: 5 });
    const charge = await db.rentCharge.findFirstOrThrow({ where: { organizationId: scope.organizationId, leaseId: lease.id } });
    await recordPayment(db, config, scope, { key: crypto.randomUUID(), leaseId: lease.id, paidAt: new Date().toISOString(), mode: 'CASH',
      amountPaise: 400_000, allocations: [{ chargeId: charge.id, amountPaise: 400_000 }], allowCredit: false, acknowledgeReference: false,
    });
    console.log(`Development account ${email}`);
  }
} finally { await db.$disconnect(); }

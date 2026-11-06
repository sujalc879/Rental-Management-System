import { hashPassword } from 'better-auth/crypto';
import type { Database } from '../packages/db/src/index';

export async function provisionOwner(db: Database, input: { email: string; name: string; organization: string; password: string; verified?: boolean }) {
  const password = await hashPassword(input.password);
  return db.$transaction(async tx => {
    const user = await tx.user.create({ data: { name: input.name, email: input.email, emailVerified: input.verified ?? false } });
    await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: 'credential', password } });
    const organization = await tx.organization.create({ data: { name: input.organization, memberships: { create: { userId: user.id } } } });
    await tx.auditLog.create({ data: { organizationId: organization.id, entityId: user.id, action: 'owner.provisioned' } });
    return { user, organization };
  });
}

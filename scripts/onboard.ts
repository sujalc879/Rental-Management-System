import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createAuth } from '../apps/api/src/auth';
import { readConfig } from '../apps/api/src/config';
import { openDatabase } from '../packages/db/src/index';
import { name } from '../packages/shared/src/input';
import { provisionOwner } from './owners';

const args = z.tuple([z.email(), name, name]).safeParse(process.argv.slice(2));
if (!args.success) {
  console.error('Usage: bun run onboard owner@example.com "Owner name" "Organization name"');
  process.exit(1);
}
const [address, owner, organization] = args.data;
const email = address.toLowerCase();
const config = readConfig();
const db = openDatabase();
try {
  const auth = createAuth(db, config);
  await provisionOwner(db, { email, name: owner, organization, password: randomBytes(32).toString('base64url') });
  try {
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: `${config.APP_ORIGIN}/sign-in` } });
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${config.APP_ORIGIN}/reset` } });
    console.log(config.SMTP_URL ? 'Owner created. Verification and setup emails submitted.' : 'Owner created. Open the local development mailbox for the setup links.');
  } catch {
    console.error('Owner created. Use the sign-in page to resend verification and password setup links after fixing mail configuration.');
    process.exitCode = 1;
  }
} catch { console.error('Owner creation failed. Check the database and whether that email already exists.'); process.exitCode = 1; }
finally { await db.$disconnect(); }

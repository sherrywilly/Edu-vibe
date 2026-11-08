import { PrismaClient } from '@prisma/client';
import { hashPassword, passwordValue, usernameValue } from './auth';

async function main() {
  const username = usernameValue(process.env.ADMIN_SETUP_USERNAME);
  const password = passwordValue(process.env.ADMIN_SETUP_PASSWORD);
  const passwordHash = await hashPassword(password);
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(473921, 1)::text`;
      if (await tx.adminAccount.count())
        throw new Error(
          'An admin account already exists; setup is only available for the first account.',
        );
      const account = await tx.adminAccount.create({
        data: { username, passwordHash, role: 'super_admin' },
      });
      await tx.auditLog.create({
        data: { action: 'admin.setup', actor: account.id, target: account.id },
      });
    });
    console.log('Initial super admin created.');
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Admin setup failed.');
  process.exitCode = 1;
});

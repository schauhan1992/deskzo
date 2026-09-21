import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  const users: { name: string; email: string; role: Role }[] = [
    { name: "Wroffy Admin", email: "admin@wroffy.com", role: "ADMIN" },
    { name: "Priya Sharma", email: "priya.profile@wroffy.com", role: "PROFILE" },
    { name: "Arjun Nair", email: "arjun.calling@wroffy.com", role: "CALLING" },
    { name: "Neha Kapoor", email: "neha.sales@wroffy.com", role: "SALES" },
    { name: "Rekha Iyer", email: "rekha.accounts@wroffy.com", role: "ACCOUNTS" },
  ];

  for (const u of users) {
    const user = await db.user.upsert({
      where: { email: u.email },
      // Repairs rather than skips. `update: {}` meant re-seeding did nothing to an existing row, so
      // the one recovery people reach for first — "just run the seed again" — could not fix an
      // admin who had been demoted or deactivated. The password is deliberately not reset here;
      // that is what the reset flow is for.
      update: { role: u.role, active: true, ...(u.role === "ADMIN" ? { isSuperAdmin: true } : {}) },
      create: { ...u, passwordHash, ...(u.role === "ADMIN" ? { isSuperAdmin: true } : {}) },
    });
    console.log(`Seeded ${user.role} user: ${user.email} (password: ChangeMe123!)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

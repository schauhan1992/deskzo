import { directClient } from "../src/lib/tenancy/direct-client";
import { PrismaClient as ReferenceClient } from "@deskzo/reference-client";
import type { Role } from "@/lib/roles";
import bcrypt from "bcryptjs";
import { ensurePincodes } from "./reference/pincodes";
import { ensureGeonames } from "./reference/geonames";

const db = directClient();

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  const users: { name: string; email: string; role: Role }[] = [
    { name: "Acme Admin", email: "admin@acme.example", role: "ADMIN" },
    { name: "Priya Sharma", email: "priya.profile@acme.example", role: "PROFILE" },
    { name: "Arjun Nair", email: "arjun.calling@acme.example", role: "CALLING" },
    { name: "Neha Kapoor", email: "neha.sales@acme.example", role: "SALES" },
    { name: "Rekha Iyer", email: "rekha.accounts@acme.example", role: "ACCOUNTS" },
  ];

  /**
   * Whether anybody already holds super admin, decided once before the loop.
   *
   * There is exactly one super admin and the database enforces it: `users_one_super_admin` is a
   * partial unique index, so a second `isSuperAdmin = true` row is a duplicate-key error rather
   * than a silent second holder. This seed used to set the flag on whichever user it created with
   * the ADMIN role, which on a database that already had a real super admin under a different
   * address failed the whole seed on an error naming a key rather than a person.
   *
   * So it claims the flag only when the seat is empty. Seeding a development database should not
   * take super admin away from whoever actually holds it, and on a fresh one there is nobody to
   * take it from.
   */
  const heldBy = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { email: true } });

  for (const u of users) {
    const claimsSuperAdmin = u.role === "ADMIN" && !heldBy;

    const user = await db.user.upsert({
      where: { email: u.email },
      // Repairs rather than skips. `update: {}` meant re-seeding did nothing to an existing row, so
      // the one recovery people reach for first — "just run the seed again" — could not fix an
      // admin who had been demoted or deactivated. The password is deliberately not reset here;
      // that is what the reset flow is for.
      update: { role: u.role, active: true, ...(claimsSuperAdmin ? { isSuperAdmin: true } : {}) },
      create: { ...u, passwordHash, ...(claimsSuperAdmin ? { isSuperAdmin: true } : {}) },
    });
    console.log(`Seeded ${user.role} user: ${user.email} (password: ChangeMe123!)`);
  }

  if (heldBy) {
    console.log(`\nSuper admin left with ${heldBy.email}, who already held it. Move it with:`);
    console.log("  npx tsx scripts/grant-super-admin.ts <email>");
  }

  /**
   * Reference data last, and on every run — into the shared reference database, not this one.
   *
   * A reset of this database no longer touches it (it is a database of its own, prisma/reference),
   * so this is only for a machine setting up for the first time: loaded from the committed files if
   * they are here, and a no-op when the same file is already loaded. See `src/lib/reference-data.ts`.
   */
  console.log("\nReference data:");
  if (!process.env.REFERENCE_DATABASE_URL) {
    console.log("  REFERENCE_DATABASE_URL is not set — skipped. See .env.example.");
    return;
  }
  const reference = new ReferenceClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
  try {
    await ensurePincodes(reference);
    await ensureGeonames(reference);
  } finally {
    await reference.$disconnect();
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

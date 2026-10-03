/**
 * Runs one of the coverage seeds (prisma/demo/cover/<area>.ts) on its own, against a database the demo
 * seed has already filled — for working on one area without seeding everything again.
 *
 *   DATABASE_URL=… npx tsx prisma/demo/run-cover.ts <area>
 *   npx tsx prisma/demo/run-cover.ts <area> --real      # the workspace .env points at, deliberately
 *
 * `npm run db:seed:demo` runs every one of them at the end, in order (./cover/index.ts).
 */
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../../src/lib/tenancy/direct-client";
import { loadDemoContext, type DemoContext } from "./context";

async function main() {
  const area = process.argv[2];
  if (!area || !/^[a-z-]+$/.test(area)) {
    console.error("Which area? The name of a file in prisma/demo/cover, without .ts.");
    process.exitCode = 1;
    return;
  }
  const target = new URL(process.env.DATABASE_URL ?? "postgres://x/").pathname.slice(1);
  // The workspace a developer actually uses is never seeded by accident.
  if (target === "deskzo" && !process.argv.includes("--real")) {
    console.error(`Refusing to seed "${target}" — point DATABASE_URL at a scratch database, or pass --real.`);
    process.exitCode = 1;
    return;
  }
  const mod = (await import(`./cover/${area}`)) as { default: (db: PrismaClient, ctx: DemoContext) => Promise<void> };
  const db = directClient();
  try {
    await mod.default(db, await loadDemoContext(db));
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

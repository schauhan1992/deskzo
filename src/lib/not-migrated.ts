import { Prisma } from "@prisma/client";

/**
 * A table or column this workspace doesn't have yet — its migration hasn't reached it (Coolify runs
 * `tenants:migrate` after a deploy, so new code meets old databases for a while). Kept free of
 * everything else, because sign-in imports it: see src/lib/security-settings.ts.
 */
export function notMigratedYet(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2022")) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /relation "[A-Za-z0-9_]+" does not exist|column "?[A-Za-z0-9_.]+"? does not exist|42P01|42703/.test(message);
}

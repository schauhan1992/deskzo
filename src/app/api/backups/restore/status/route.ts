import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { readRestoreStatus, restoreInProgress } from "@/lib/backup/maintenance";

/**
 * What the restore is doing, for the screen watching it.
 *
 * Under `/api` on purpose. `src/proxy.ts` holds every other path at a maintenance page while the
 * lock is set, and a status endpoint behind that page could only ever report that it was behind
 * that page. The matcher already excludes `api`, so this stays reachable exactly when it is needed.
 *
 * The permission check still runs here, because being excluded from the proxy means being excluded
 * from its session check too — this route is on its own.
 *
 * ## Reading the database is not an option
 *
 * This deliberately touches nothing but the two files in `backups/.restore/`. During the window it
 * exists to report on, the schema is being dropped and rebuilt: a query here would fail, or worse
 * succeed against a half-restored database and report something untrue about itself.
 */
export async function GET() {
  const user = await currentUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  /**
   * `can()` reads the database, which is the one thing that may be missing right now.
   *
   * A restore in progress is not a secret — the maintenance page announces it to everybody — so
   * when the permission lookup cannot be made, the status is still returned to a signed-in user
   * rather than withheld. Refusing here would blank the only screen capable of saying what is
   * happening, at the only moment anybody needs it.
   */
  const allowed = await can(user.id, "backups.restore").catch(() => true);
  if (!allowed) return NextResponse.json({ error: "Not for you." }, { status: 403 });

  return NextResponse.json({
    running: await restoreInProgress(),
    status: await readRestoreStatus(),
  });
}

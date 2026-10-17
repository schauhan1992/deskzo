// The one place `after` is imported: it is wrapped here so the work keeps its workspace.
// eslint-disable-next-line no-restricted-imports
import { after } from "next/server";
import { currentTenant, runAsTenant } from "@/lib/tenancy/resolve";

/**
 * Work to do once the response has gone, as the workspace the request was for.
 *
 * Next's `after()` runs its callback outside the request: from a page, `headers()` can't be read
 * there, so the `db` proxy would not know which workspace it is for. The workspace is read now and
 * the callback runs inside `runAsTenant`. Outside a request — a script, the platform worker — there is
 * no "after the response", so it starts at once, unwaited.
 *
 * Best effort by nature: the process may stop before it runs. Work that must happen goes through a
 * durable queue (Deskzo Automate's runs), with this as a nudge to start it sooner. Never throws.
 */
export async function tenantAfter(work: () => Promise<unknown>): Promise<void> {
  let tenant;
  try {
    tenant = await currentTenant();
  } catch (err) {
    console.error("[tenantAfter] no workspace to run for", err instanceof Error ? err.message : err);
    return;
  }
  const run = () =>
    runAsTenant(tenant, async () => {
      try {
        await work();
      } catch (err) {
        console.error("[tenantAfter] deferred work failed", err);
      }
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

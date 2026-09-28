import { redactSecrets } from "@/lib/console-shared/redact";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";

/**
 * What a workspace may know of its partner (owner decision O2): the display name of the partner it is
 * attributed to now, shown read-only on its own Billing page — "Sold and supported by …". A customer
 * cannot change it; moving a workspace is a staff act with a reason (spec §4.4).
 *
 * Called from workspace code, so this file stays light — the control plane's client and nothing of
 * the console, provisioning or the billing engine — and it never throws and never waits more than
 * 1.5 s: the page renders without the line rather than wait for, or fail on, the control plane.
 * Nothing is cached, so there is no module state.
 */

const LOAD_TIMEOUT_MS = 1_500;
/** Shown while the partner is in the programme; a terminated one is not named. */
const SHOWN = new Set(["ONBOARDING", "ACTIVE", "SUSPENDED"]);

async function load(tenantId: string): Promise<{ displayName: string } | null> {
  const tenant = await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { partner: { select: { displayName: true, status: true } } } });
  const partner = tenant?.partner;
  return partner && SHOWN.has(partner.status) ? { displayName: partner.displayName } : null;
}

/** The partner a workspace is attributed to now, while it is ONBOARDING, ACTIVE or SUSPENDED; null otherwise, and on any error or delay. */
export async function partnerShownToCustomer(tenantId: string): Promise<{ displayName: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const id = String(tenantId ?? "").trim().slice(0, 64);
    if (!id || !controlConfigured()) return null;
    return await Promise.race([
      // A read that throws before returning a promise is caught here too.
      new Promise<{ displayName: string } | null>((resolve) => resolve(load(id))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[partners] could not read the workspace's partner, so none is shown: ${redactSecrets(message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

import type { Tenant } from "@/lib/tenancy/state";

/** What a workspace held for billing still answers: signing in, and its billing page. */
const BILLING_HOLD_OPEN = /^\/(login|forgot-password|reset-password|handoff|settings\/billing)(\/|$)|^\/api\/auth(\/|$)/;

/**
 * What the proxy does with a request to a workspace (src/proxy.ts):
 *
 *   · "open"            — served as usual: it is open, or it is held for billing and this is signing
 *                         in or the billing page, so its owner can pay and open it again;
 *   · "billing-notice"  — held for billing, anything else: a page saying so, and where to pay;
 *   · "unavailable"     — being set up, held by staff, mid-migration, closed.
 */
export function holdFor(tenant: Pick<Tenant, "status" | "holdReason">, pathname: string): "open" | "billing-notice" | "unavailable" {
  if (tenant.status === "ACTIVE") return "open";
  if (tenant.status === "SUSPENDED" && tenant.holdReason === "BILLING") return BILLING_HOLD_OPEN.test(pathname) ? "open" : "billing-notice";
  return "unavailable";
}

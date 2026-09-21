import { db } from "@/lib/db";
import { companyMayUsePortal, linkState } from "@/lib/portal/access";

/**
 * Portal state for a page full of companies, in two queries.
 *
 * A plain module, not `"use server"`: it is read by server components rendering a list, and every
 * export from one of those is a public endpoint.
 *
 * ## Why it takes a whole page of ids
 *
 * The obvious shape is one function per company, which a table of fifty rows then calls fifty
 * times — a settings read and a count each, a hundred round trips to fill one column. This reads
 * the settings once and counts every company's links in a single grouped query.
 *
 * ## Why it is not gated
 *
 * "Does this customer have a portal" is a fact about the account, shown beside who it is assigned
 * to and how many contacts it has. *Changing* it needs `portal.manage`; knowing it does not, and
 * hiding it from the sales person who would be the one to ask for it makes the column pointless.
 */

export type PortalState =
  /** Has access and at least one link that works today. */
  | { kind: "on"; links: number }
  /** Allowed, but nobody has been sent a link — so nobody can actually get in. */
  | { kind: "granted"; links: 0 }
  /** Not allowed, for whatever reason. */
  | { kind: "off"; links: number };

export type PortalStateMap = Map<string, PortalState>;

export async function portalStateFor(
  companies: {
    id: string;
    portalEnabled: boolean | null;
    relationshipType: string;
    managedByResellerId: string | null;
  }[],
): Promise<PortalStateMap> {
  const out: PortalStateMap = new Map();
  if (companies.length === 0) return out;

  const settings = await db.portalSettings.findUnique({ where: { id: "global" } });
  // No settings row at all means nobody has opened the feature, so nothing is on. Said here rather
  // than defaulted, because a default that happens to be "on" would be a very quiet mistake.
  if (!settings) {
    for (const c of companies) out.set(c.id, { kind: "off", links: 0 });
    return out;
  }

  const ids = companies.map((c) => c.id);
  const logins = await db.portalLogin.findMany({
    where: { companyId: { in: ids }, revokedAt: null },
    select: { companyId: true, expiresAt: true, revokedAt: true },
  });

  const now = new Date();
  const working = new Map<string, number>();
  for (const l of logins) {
    // Expiry is checked here rather than in the query so there is one definition of "works today",
    // and it is the same one the portal itself uses.
    if (!linkState(l, now).ok) continue;
    working.set(l.companyId, (working.get(l.companyId) ?? 0) + 1);
  }

  for (const c of companies) {
    const links = working.get(c.id) ?? 0;
    const allowed = companyMayUsePortal(settings, c).ok;
    out.set(
      c.id,
      allowed ? (links > 0 ? { kind: "on", links } : { kind: "granted", links: 0 }) : { kind: "off", links },
    );
  }

  return out;
}

/** How each state reads in a table cell. */
export const PORTAL_STATE_LABEL: Record<PortalState["kind"], { label: string; tone: "green" | "amber" | "default"; hint: string }> = {
  on: { label: "On", tone: "green", hint: "This customer has a working portal link." },
  granted: { label: "No link", tone: "amber", hint: "Allowed a portal, but nobody has been sent a link — so nobody can get in." },
  off: { label: "Off", tone: "default", hint: "No portal access." },
};

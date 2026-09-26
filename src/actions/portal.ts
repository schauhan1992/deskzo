"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { companyMayUsePortal, expiryFor, linkState } from "@/lib/portal/access";
import type { ActionResult } from "@/actions/company";

/**
 * The administrative half: who gets a portal, what it shows, and what customers have asked for.
 *
 * Separate from `portal-public.ts` on purpose. That file answers to a stranger with a token and is
 * written to be read with suspicion; this one answers to a signed-in colleague with a permission.
 * Keeping them apart means a reviewer can read the public file end to end and see that nothing in
 * it grants anything, rather than tracing which branch of a shared function they are in.
 */

async function gate() {
  const user = await requireModuleUser("customer_portal");
  if (!(await can(user.id, "portal.manage"))) {
    return { user, error: "You don't have access to the customer portal settings." };
  }
  return { user, error: null };
}

export type PortalSettingsView = {
  enabled: boolean;
  access: "ALL" | "SELECTED";
  showSubscriptions: boolean;
  showInvoices: boolean;
  showPayments: boolean;
  showTickets: boolean;
  showAssets: boolean;
  showContacts: boolean;
  allowRenewalRequest: boolean;
  allowSeatRequest: boolean;
  allowQuestion: boolean;
  linkValidityDays: number | null;
  welcomeMessage: string | null;
  updatedAt: Date | null;
  updatedByName: string | null;
  /** How many companies and links exist, so the page can say what switching this on would reach. */
  grantedCompanies: number;
  activeLogins: number;
};

const DEFAULTS = {
  enabled: false,
  access: "SELECTED" as const,
  showSubscriptions: true,
  showInvoices: true,
  showPayments: false,
  showTickets: true,
  showAssets: false,
  showContacts: false,
  allowRenewalRequest: true,
  allowSeatRequest: true,
  allowQuestion: true,
  linkValidityDays: null,
  welcomeMessage: null,
};

export async function portalSettings(): Promise<ActionResult<PortalSettingsView>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const [row, grantedCompanies, activeLogins] = await Promise.all([
    db.portalSettings.findUnique({ where: { id: "global" }, include: { updatedBy: { select: { name: true } } } }),
    db.company.count({ where: { portalEnabled: true } }),
    db.portalLogin.count({ where: { revokedAt: null } }),
  ]);

  return {
    ok: true,
    data: {
      ...DEFAULTS,
      ...(row
        ? {
            enabled: row.enabled,
            access: row.access,
            showSubscriptions: row.showSubscriptions,
            showInvoices: row.showInvoices,
            showPayments: row.showPayments,
            showTickets: row.showTickets,
            showAssets: row.showAssets,
            showContacts: row.showContacts,
            allowRenewalRequest: row.allowRenewalRequest,
            allowSeatRequest: row.allowSeatRequest,
            allowQuestion: row.allowQuestion,
            linkValidityDays: row.linkValidityDays,
            welcomeMessage: row.welcomeMessage,
          }
        : {}),
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedBy?.name ?? null,
      grantedCompanies,
      activeLogins,
    },
  };
}

/**
 * Saves the settings.
 *
 * Audited, and the master switch is logged to the activity stream as well. Turning the portal on
 * for everybody is one click that changes what people outside the company can see, and "when did
 * this become visible" is a question somebody will eventually need answered.
 */
export async function savePortalSettings(input: {
  enabled: boolean;
  access: "ALL" | "SELECTED";
  showSubscriptions: boolean;
  showInvoices: boolean;
  showPayments: boolean;
  showTickets: boolean;
  showAssets: boolean;
  showContacts: boolean;
  allowRenewalRequest: boolean;
  allowSeatRequest: boolean;
  allowQuestion: boolean;
  linkValidityDays: number | null;
  welcomeMessage: string | null;
}): Promise<ActionResult<PortalSettingsView>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const days = input.linkValidityDays;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    return { ok: false, error: "A link should last between 1 and 3650 days, or leave it blank for no expiry." };
  }

  const before = await db.portalSettings.findUnique({ where: { id: "global" }, select: { enabled: true, access: true } });

  const data = {
    enabled: input.enabled,
    access: input.access,
    showSubscriptions: input.showSubscriptions,
    showInvoices: input.showInvoices,
    showPayments: input.showPayments,
    showTickets: input.showTickets,
    showAssets: input.showAssets,
    showContacts: input.showContacts,
    allowRenewalRequest: input.allowRenewalRequest,
    allowSeatRequest: input.allowSeatRequest,
    allowQuestion: input.allowQuestion,
    linkValidityDays: days,
    welcomeMessage: input.welcomeMessage?.trim() || null,
    updatedById: user.id,
  };

  await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "PortalSettings",
    entityId: "global",
    entityLabel: input.enabled ? `Portal on, ${input.access === "ALL" ? "all customers" : "selected customers"}` : "Portal off",
  });

  // Two changes worth their own line in the activity log, because both widen who can see what.
  if (before?.enabled !== input.enabled || before?.access !== input.access) {
    await logActivity({
      // The nearest true kind: this changes who outside the company can read what, which is what
      // that kind is for. A new enum value would say the same thing in a place nobody looks.
      kind: "SECURITY_POLICY_CHANGED",
      severity: input.enabled && input.access === "ALL" ? "WARNING" : "INFO",
      summary: input.enabled
        ? `${user.name} switched the customer portal on for ${input.access === "ALL" ? "every customer" : "selected customers"}`
        : `${user.name} switched the customer portal off`,
    }).catch(() => {});
  }

  revalidatePath("/settings/portal");
  const refreshed = await portalSettings();
  return refreshed;
}

/** Whether a given company may use the portal right now, and why not when it may not. */
export async function portalStatusFor(companyId: string): Promise<
  ActionResult<{ allowed: boolean; because: string | null; override: boolean | null; logins: number }>
> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const [settings, company, logins] = await Promise.all([
    db.portalSettings.findUnique({ where: { id: "global" } }),
    db.company.findUnique({
      where: { id: companyId },
      select: { portalEnabled: true, relationshipType: true, managedByResellerId: true },
    }),
    db.portalLogin.count({ where: { companyId, revokedAt: null } }),
  ]);
  if (!company) return { ok: false, error: "That company no longer exists." };

  const verdict = companyMayUsePortal(settings ?? { ...DEFAULTS, access: "SELECTED" }, company);
  const because = verdict.ok
    ? null
    : {
        off: "The customer portal is switched off for everybody.",
        "not-granted": "This customer has not been given access.",
        "reseller-managed": "This customer belongs to a reseller, so we don't deal with them directly.",
        "not-a-customer": "Only customers get a portal.",
        revoked: "The link has been revoked.",
        expired: "The link has expired.",
        unknown: "No link.",
      }[verdict.because];

  return { ok: true, data: { allowed: verdict.ok, because, override: company.portalEnabled, logins } };
}

/** Turns the portal on or off for one company, or hands it back to the global default. */
export async function setCompanyPortalAccess(input: {
  companyId: string;
  /** Null hands it back to the global default, which is the state most companies should be in. */
  enabled: boolean | null;
}): Promise<ActionResult<{ enabled: boolean | null }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const company = await db.company.findUnique({
    where: { id: input.companyId },
    select: { id: true, name: true, managedByResellerId: true },
  });
  if (!company) return { ok: false, error: "That company no longer exists." };

  /**
   * Refused outright for a reseller's customer, rather than stored and then ignored by
   * `companyMayUsePortal`. A setting that appears to have been accepted and does nothing is how
   * somebody concludes the feature is broken — and worse, how somebody else later assumes the
   * customer has access when they do not.
   */
  if (company.managedByResellerId && input.enabled === true) {
    return { ok: false, error: "This customer belongs to a reseller. Their portal is the reseller's to give, not ours." };
  }

  await db.company.update({ where: { id: company.id }, data: { portalEnabled: input.enabled } });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: company.id,
    entityLabel: `Portal ${input.enabled === null ? "follows the default" : input.enabled ? "enabled" : "disabled"} — ${company.name}`,
  });

  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: { enabled: input.enabled } };
}

export type PortalLoginRow = {
  id: string;
  personName: string;
  personEmail: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastSeenAt: Date | null;
  visits: number;
  revokedAt: Date | null;
  /** The link itself, for copying into an email. */
  url: string;
};

export async function portalLogins(companyId: string): Promise<ActionResult<PortalLoginRow[]>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const rows = await db.portalLogin.findMany({
    where: { companyId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      token: true,
      personName: true,
      personEmail: true,
      createdAt: true,
      expiresAt: true,
      lastSeenAt: true,
      visits: true,
      revokedAt: true,
    },
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      personName: r.personName,
      personEmail: r.personEmail,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      lastSeenAt: r.lastSeenAt,
      visits: r.visits,
      revokedAt: r.revokedAt,
      // Relative, because the app does not reliably know its own public hostname and a link with
      // the wrong one in it is worse than a path somebody pastes after their domain.
      url: `/portal/${r.token}`,
    })),
  };
}

/**
 * Creates a link for one person.
 *
 * The token is generated here and returned once — but it is also readable afterwards through
 * `portalLogins`, because an admin re-sending a link is an ordinary thing and a write-only secret
 * would just mean issuing a second one every time. See the note on `PortalLogin` in the schema.
 */
export async function createPortalLogin(input: {
  companyId: string;
  contactId?: string | null;
  personName?: string | null;
  personEmail?: string | null;
}): Promise<ActionResult<{ id: string; url: string }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const [settings, company] = await Promise.all([
    db.portalSettings.findUnique({ where: { id: "global" } }),
    db.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, name: true, portalEnabled: true, relationshipType: true, managedByResellerId: true },
    }),
  ]);
  if (!company) return { ok: false, error: "That company no longer exists." };

  /**
   * Checked at issue as well as at use.
   *
   * `resolve` in the public file checks it again on every visit, which is what actually keeps the
   * data safe — but issuing a link that cannot work is a support ticket waiting to happen, and
   * saying so here is the difference between "you can't give this customer a portal, and here is
   * why" and a customer clicking a link that tells them it is invalid.
   */
  const verdict = companyMayUsePortal(settings ?? { ...DEFAULTS, access: "SELECTED" }, company);
  if (!verdict.ok) {
    const why = {
      off: "The customer portal is switched off. Turn it on in Settings first.",
      "not-granted": "This customer hasn't been given portal access yet.",
      "reseller-managed": "This customer belongs to a reseller, so the portal isn't ours to give.",
      "not-a-customer": "Only customers get a portal.",
      revoked: "",
      expired: "",
      unknown: "",
    }[verdict.because];
    return { ok: false, error: why || "This customer can't be given a portal link." };
  }

  let personName = input.personName?.trim() ?? "";
  let personEmail = input.personEmail?.trim() || null;

  if (input.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: input.contactId, companyId: company.id },
      select: { name: true, email: true },
    });
    if (!contact) return { ok: false, error: "That contact isn't at this company." };
    personName = contact.name;
    personEmail = contact.email;
  }

  if (!personName) return { ok: false, error: "Who is this link for?" };

  const login = await db.portalLogin.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      companyId: company.id,
      contactId: input.contactId ?? null,
      personName,
      personEmail,
      createdById: user.id,
      expiresAt: expiryFor(settings ?? { ...DEFAULTS, access: "SELECTED" }, new Date()),
    },
    select: { id: true, token: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "PortalLogin",
    entityId: login.id,
    entityLabel: `Portal link for ${personName} at ${company.name}`,
  });

  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: { id: login.id, url: `/portal/${login.token}` } };
}

export async function revokePortalLogin(input: { loginId: string }): Promise<ActionResult<{ revoked: boolean }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const login = await db.portalLogin.findUnique({
    where: { id: input.loginId },
    select: { id: true, companyId: true, personName: true, company: { select: { name: true } } },
  });
  if (!login) return { ok: false, error: "That link no longer exists." };

  await db.portalLogin.update({
    where: { id: login.id },
    data: { revokedAt: new Date(), revokedById: user.id },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "PortalLogin",
    entityId: login.id,
    entityLabel: `Revoked portal link for ${login.personName} at ${login.company.name}`,
  });

  revalidatePath(`/companies/${login.companyId}`);
  return { ok: true, data: { revoked: true } };
}

export type PortalRequestRow = {
  id: string;
  companyId: string;
  companyName: string;
  personName: string;
  personEmail: string | null;
  kind: "RENEWAL" | "ADD_SEATS" | "QUESTION";
  subscriptionName: string | null;
  quantity: number | null;
  message: string | null;
  status: "NEW" | "IN_PROGRESS" | "DONE" | "DECLINED";
  createdAt: Date;
  handledByName: string | null;
  handledAt: Date | null;
  response: string | null;
};

export async function listPortalRequests(status?: string): Promise<ActionResult<PortalRequestRow[]>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const rows = await db.portalRequest.findMany({
    where: status && status !== "all" ? { status: status as "NEW" } : undefined,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      company: { select: { id: true, name: true } },
      handledBy: { select: { name: true } },
      companyProduct: { select: { item: { select: { name: true } } } },
    },
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      companyId: r.company.id,
      companyName: r.company.name,
      personName: r.personName,
      personEmail: r.personEmail,
      kind: r.kind,
      subscriptionName: r.companyProduct?.item.name ?? null,
      quantity: r.quantity,
      message: r.message,
      status: r.status,
      createdAt: r.createdAt,
      handledByName: r.handledBy?.name ?? null,
      handledAt: r.handledAt,
      response: r.response,
    })),
  };
}

export async function setPortalRequestStatus(input: {
  requestId: string;
  status: "NEW" | "IN_PROGRESS" | "DONE" | "DECLINED";
  response?: string | null;
}): Promise<ActionResult<{ status: string }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const request = await db.portalRequest.findUnique({
    where: { id: input.requestId },
    select: { id: true, company: { select: { name: true } } },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };

  const closing = input.status === "DONE" || input.status === "DECLINED";
  await db.portalRequest.update({
    where: { id: request.id },
    data: {
      status: input.status,
      response: input.response?.trim() || null,
      // Cleared when a request is reopened, so "handled by" never names somebody for work that is
      // back on the pile.
      handledById: closing ? user.id : null,
      handledAt: closing ? new Date() : null,
    },
  });

  revalidatePath("/customer-requests");
  return { ok: true, data: { status: input.status } };
}

export type PortalAccessRow = {
  companyId: string;
  companyName: string;
  /** Why they have access: granted on their own record, or riding the global default. */
  via: "granted" | "default";
  /** False when something else refuses them despite the grant — a reseller took them over, say. */
  allowed: boolean;
  because: string | null;
  activeLinks: number;
  revokedLinks: number;
  people: string[];
  lastSeenAt: Date | null;
  totalVisits: number;
};

export type PortalRoster = {
  mode: "ALL" | "SELECTED";
  enabled: boolean;
  rows: PortalAccessRow[];
  /**
   * Granted, but nobody can actually get in — the gap that makes a roster worth having.
   *
   * Switching a customer on and never sending them a link is the commonest half-finished state in
   * this module, and it is invisible from the customer's own page because that page says "allowed".
   */
  grantedWithoutLinks: { companyId: string; companyName: string }[];
  /** Only meaningful under ALL: how many more customers could be given a link today. */
  eligibleWithoutLinks: number;
};

/**
 * Everyone who can open a portal, in one place.
 *
 * Built around **who holds a working link** rather than who is theoretically permitted, because
 * under the ALL setting "permitted" is every customer on the books and a list of four hundred rows
 * answers nothing. Access without a link is a permission nobody is using; a link is somebody
 * actually reading their invoices.
 */
export async function portalRoster(search?: string): Promise<ActionResult<PortalRoster>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const settings = (await db.portalSettings.findUnique({ where: { id: "global" } })) ?? { ...DEFAULTS, id: "global", updatedAt: new Date(), updatedById: null };
  const q = search?.trim();

  const companies = await db.company.findMany({
    where: {
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      OR: [{ portalLogins: { some: {} } }, { portalEnabled: true }],
    },
    select: {
      id: true,
      name: true,
      portalEnabled: true,
      relationshipType: true,
      managedByResellerId: true,
      portalLogins: {
        select: { personName: true, revokedAt: true, expiresAt: true, lastSeenAt: true, visits: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { name: "asc" },
    take: 500,
  });

  const rows: PortalAccessRow[] = [];
  const grantedWithoutLinks: { companyId: string; companyName: string }[] = [];
  const now = new Date();

  for (const c of companies) {
    const verdict = companyMayUsePortal(settings, c);
    /**
     * Works *today* — not revoked and not expired.
     *
     * Counting an expired link as active tells somebody a customer can get in when they cannot,
     * which is the one lie this page exists to prevent. Found by the check suite, which ran against
     * a fixture that happened to contain both kinds.
     */
    const active = c.portalLogins.filter((l) => linkState(l, now).ok);

    if (c.portalLogins.length === 0) {
      // Granted and unreachable. Listed separately rather than as a row with zeroes, because it is
      // a different thing to do about it: send them a link.
      if (verdict.ok) grantedWithoutLinks.push({ companyId: c.id, companyName: c.name });
      continue;
    }

    const seen = c.portalLogins.map((l) => l.lastSeenAt).filter((d): d is Date => d !== null);

    rows.push({
      companyId: c.id,
      companyName: c.name,
      via: c.portalEnabled === true ? "granted" : "default",
      allowed: verdict.ok,
      because: verdict.ok
        ? null
        : {
            off: "The portal is switched off for everybody.",
            "not-granted": "Not granted, and the default is selected customers only.",
            "reseller-managed": "Belongs to a reseller now — their links no longer work.",
            "not-a-customer": "No longer a customer.",
            revoked: "Revoked.",
            expired: "Expired.",
            unknown: "No link.",
          }[verdict.because],
      activeLinks: active.length,
      // Everything that no longer opens, whether it was revoked or simply ran out.
      revokedLinks: c.portalLogins.length - active.length,
      people: active.map((l) => l.personName),
      lastSeenAt: seen.length > 0 ? new Date(Math.max(...seen.map((d) => d.getTime()))) : null,
      totalVisits: c.portalLogins.reduce((sum, l) => sum + l.visits, 0),
    });
  }

  /**
   * Under ALL, how many customers could be handed a link today.
   *
   * A number rather than a list, because the list is every customer you have — and the useful fact
   * is the size of the gap between "may have a portal" and "has one".
   */
  const eligibleWithoutLinks =
    settings.enabled && settings.access === "ALL"
      ? await db.company.count({
          where: {
            relationshipType: { in: ["CLIENT", "RESELLER"] },
            managedByResellerId: null,
            portalEnabled: { not: false },
            portalLogins: { none: {} },
          },
        })
      : 0;

  return {
    ok: true,
    data: {
      mode: settings.access,
      enabled: settings.enabled,
      // Live links first, then the ones that have stopped working — a revoked company at the top
      // of the list is a row nobody needs to act on.
      rows: rows.sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.activeLinks - a.activeLinks || a.companyName.localeCompare(b.companyName)),
      grantedWithoutLinks,
      eligibleWithoutLinks,
    },
  };
}

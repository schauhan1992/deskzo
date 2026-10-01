import { when } from "@/lib/console-shared/format";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { TenantStatusKey } from "@/lib/console-shared/types";
import { cleanText } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { COMPANY_NAME } from "@/lib/brand-names";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { ConsoleRefused } from "@/lib/platform/refused";
import type { Staff } from "@/lib/platform/staff-session";
import { MAX_GRANT_HOURS, activeSupportGrant } from "@/lib/platform/support";
import { SUPPORT_REQUEST_EVERY_MS } from "@/lib/platform/workspace-data";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";

/**
 * Staff asking a workspace's owner to let support in — an email to the owner, and nothing else.
 *
 * Only a workspace's super admin grants support access, from its own Security settings
 * (src/lib/platform/support.ts). This file never creates, extends or ends a grant, and is kept apart
 * from the one that does, so no console path can reach that code. What it can do is ask: once a day
 * per workspace at most (durable across processes — the last `support.request` audit entry), only
 * while the workspace is open and has not granted access already, naming the staff member by their
 * display name and never by their address.
 */

const NOT_OPEN: Record<Exclude<TenantStatusKey, "ACTIVE">, string> = {
  PROVISIONING: "still being set up",
  SUSPENDED: "held",
  MIGRATING: "held for a migration",
  DEPROVISIONED: "closed",
};

/** Asks the owner by email; recorded (`support.request`) only once the email has gone. Returns when it was asked. */
export async function requestSupportAccess(staff: Staff, tenantId: string, reason: string, now = new Date()): Promise<{ at: Date }> {
  const why = cleanText(reason, 301);
  if (why.length < 10) throw new ConsoleRefused("Say why support needs to look, in at least 10 characters.");
  if (why.length > 300) throw new ConsoleRefused("Keep the reason to 300 characters.");

  const control = controlDb();
  const tenant = await control.tenant.findUnique({
    where: { id: String(tenantId) },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      ownerEmail: true,
      // The address links are built on — as the registry picks it, without opening its sealed columns.
      domains: { where: { isPrimary: true, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { host: true } },
    },
  });
  if (!tenant) throw new ConsoleRefused("That workspace no longer exists.");
  if (tenant.status !== "ACTIVE") throw new ConsoleRefused(`Only an open workspace can be asked — this one is ${NOT_OPEN[tenant.status]}.`);
  const to = tenant.ownerEmail?.trim();
  if (!to) throw new ConsoleRefused("This workspace has no owner email to ask.");
  if (await activeSupportGrant(tenant.id, true)) throw new ConsoleRefused("It has granted access already — enter as support.");

  const last = await control.platformAuditLog.findFirst({
    where: { tenantId: tenant.id, action: "support.request", at: { gt: new Date(now.getTime() - SUPPORT_REQUEST_EVERY_MS) } },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  if (last) throw new ConsoleRefused(`Asked already at ${when(last.at)}; ask again after ${when(new Date(last.at.getTime() + SUPPORT_REQUEST_EVERY_MS))}.`);

  const host = tenant.domains[0]?.host ?? subdomainHost(tenant.slug);
  const workspace = cleanText(tenant.name, 120).replace(/\s+/g, " ") || tenant.slug;
  // Their display name — never their address. A name that looks like one is not used.
  const name = cleanText(staff.name, 80).replace(/\s+/g, " ");
  const who = name && !name.includes("@") ? name : `A member of ${COMPANY_NAME}'s support team`;
  const text = [
    "Hello,",
    "",
    `${who}, from ${COMPANY_NAME} support, asks to look inside ${workspace} (${host}).`,
    "",
    "What it is for:",
    why,
    "",
    `Nobody from ${COMPANY_NAME} can see inside your workspace unless you let them. If you want to, as its super admin:`,
    "",
    "  1. Sign in, and open Settings › Security:",
    `     ${protocolFor(host)}://${host}/settings/security`,
    `  2. Under "Platform support access", choose what they can do — look only, or an administrator's access — and for how many hours (up to ${MAX_GRANT_HOURS}).`,
    "  3. Let support in. You can end the access there at any time; it also ends by itself when the hours run out.",
    "",
    "If you did not expect this, ignore this email — nothing changes unless you grant access.",
    "",
    COMPANY_NAME,
  ].join("\n");

  try {
    await sendPlatformMail({ to, subject: `${COMPANY_NAME} support asks to look at ${workspace}`, text });
  } catch (err) {
    console.error(`[support] the access request for ${tenant.slug} could not be sent: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    throw new ConsoleRefused("The email could not be sent.");
  }
  // Only once it has gone: the entry is also what the once-a-day limit reads.
  await control.platformAuditLog.create({
    data: { at: now, actorKind: "STAFF", actor: staff.id, action: "support.request", tenantId: tenant.id, detail: { reason: why, to } },
    select: { id: true },
  });
  return { at: now };
}

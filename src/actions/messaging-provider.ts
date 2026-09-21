"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type MessageClass, type ProviderKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getOrganisation } from "@/lib/organisation";
import { lookupDns } from "@/lib/domain-intel/lookup";
import { PROVIDERS, providerByKey, routeFor, sharesDomainWithTransactional } from "@/lib/marketing/providers";
import type { ActionResult } from "@/actions/company";

/**
 * Configuring who actually puts mail on the wire.
 *
 * Secrets are encrypted at rest with the same helper the e-invoice credentials use, and never
 * travel back to a client — the settings screen gets a `hasSecret` boolean and nothing more, the
 * same way `Organisation.hasPassword` works.
 */

async function requireAdmin() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { user: null, error: "You can't configure mail providers." };
  }
  return { user, error: null };
}

export async function listProviders() {
  const { user } = await requireAdmin();
  if (!user) return { rows: [], catalogue: [], warning: null };

  const rows = await db.messagingProvider.findMany({ orderBy: [{ kind: "asc" }, { priority: "asc" }] });
  const routable = rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    kind: r.kind,
    enabled: r.enabled,
    priority: r.priority,
    classes: r.classes,
    fromEmail: r.fromEmail,
  }));

  return toPlain({
    rows: rows.map((r) => ({
      id: r.id,
      key: r.key,
      kind: r.kind,
      label: r.label,
      enabled: r.enabled,
      priority: r.priority,
      classes: r.classes,
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      replyTo: r.replyTo,
      config: (r.config as Record<string, unknown>) ?? {},
      dailyCap: r.dailyCap,
      lastVerifiedAt: r.lastVerifiedAt,
      verifyOk: r.verifyOk,
      verifyDetail: r.verifyDetail,
      /** Whether a secret is stored, never the secret itself. */
      hasSecret: !!r.secretCipher,
    })),
    catalogue: PROVIDERS.map((p) => ({ key: p.key, label: p.label, kind: p.kind, needs: p.needs })),
    // The warning worth putting in front of somebody before they send anything.
    warning: sharesDomainWithTransactional(routable)
      ? "Marketing and transactional mail are going out from the same domain. A campaign that annoys people will take your invoices and quotes down with it — send bulk from a subdomain instead."
      : null,
  });
}

export async function saveProvider(input: {
  key: string;
  label?: string;
  enabled?: boolean;
  priority?: number;
  classes?: MessageClass[];
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  config?: Record<string, unknown>;
  /** Only sent when it is being changed. Blank leaves the stored one alone. */
  secret?: string;
  dailyCap?: number | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const definition = providerByKey[input.key];
  if (!definition) return { ok: false, error: "No such provider." };

  if (input.enabled && definition.kind === "EMAIL" && !input.fromEmail?.trim() && input.key !== "mock") {
    return { ok: false, error: "A from-address is needed before this can be switched on." };
  }

  const fields = {
    kind: definition.kind as ProviderKind,
    label: input.label?.trim() || definition.label,
    enabled: input.enabled ?? false,
    priority: input.priority ?? 100,
    classes: input.classes ?? [],
    fromName: input.fromName?.trim() || null,
    fromEmail: input.fromEmail?.trim().toLowerCase() || null,
    replyTo: input.replyTo?.trim().toLowerCase() || null,
    config: (input.config ?? {}) as Prisma.InputJsonValue,
    dailyCap: input.dailyCap ?? null,
    // A blank secret means "leave what is stored"; it never means "clear it". Clearing happens by
    // switching the provider off, which is the deliberate act.
    ...(input.secret?.trim() ? { secretCipher: encryptSecret(input.secret.trim()) } : {}),
  };

  const saved = await db.messagingProvider.upsert({
    where: { key: input.key },
    create: { key: input.key, ...fields },
    update: fields,
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "MessagingProvider",
    entityId: saved.id,
    entityLabel: `${fields.label} — ${fields.enabled ? "on" : "off"}${fields.classes.length ? `, carrying ${fields.classes.join(" and ").toLowerCase()}` : ""}`,
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: saved };
}

/** Asks the provider whether the credentials work, and records the answer. */
export async function verifyProvider(key: string): Promise<ActionResult<{ detail: string }>> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const row = await db.messagingProvider.findUnique({ where: { key } });
  if (!row) return { ok: false, error: "That provider isn't configured yet." };
  const definition = providerByKey[key];
  if (!definition) return { ok: false, error: "No such provider." };

  const result = await definition.verify({
    key: row.key,
    label: row.label,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    config: (row.config as Record<string, unknown>) ?? {},
    secret: row.secretCipher ? decryptSecret(row.secretCipher) : null,
  });

  await db.messagingProvider.update({
    where: { key },
    data: { lastVerifiedAt: new Date(), verifyOk: result.ok, verifyDetail: result.detail },
  });
  revalidatePath("/settings/organisation");
  return result.ok ? { ok: true, data: { detail: result.detail } } : { ok: false, error: result.detail };
}

/**
 * Whether the sending domain is set up to be believed.
 *
 * Reuses the DNS lookup the domain-intel module already does for prospects — the same four records
 * decide whether a stranger's mail reaches an inbox and whether ours does. Missing SPF or DKIM, or
 * a DMARC policy of `p=none`, is the most common reason marketing mail lands in spam, and it is
 * invisible from inside the app until somebody looks.
 */
export async function checkSenderDomain(): Promise<
  ActionResult<{
    domain: string;
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    dmarcPolicy: string | null;
    mx: number;
    problems: string[];
  }>
> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const org = await getOrganisation();
  const providers = await db.messagingProvider.findMany({
    where: { enabled: true, classes: { has: "MARKETING" } },
    select: { fromEmail: true },
  });

  const domain =
    org.marketingFromDomain?.trim().toLowerCase() ||
    providers.find((p) => p.fromEmail)?.fromEmail?.split("@")[1]?.trim().toLowerCase() ||
    null;
  if (!domain) {
    return { ok: false, error: "No sending domain yet. Set one in the marketing settings or on a provider." };
  }

  const dns = await lookupDns(domain);
  const problems: string[] = [];
  if (!dns.spfRecord) problems.push("No SPF record. Receivers have no way to tell your mail from a forgery.");
  if (!dns.dkimFound) {
    problems.push("No DKIM signature found on the usual selectors. Your provider will tell you which record to add.");
  }
  if (!dns.dmarcRecord) problems.push("No DMARC record. With SPF and DKIM in place, this is the one that earns trust.");
  else if (/p=none/i.test(dns.dmarcRecord)) {
    problems.push("DMARC is set to p=none, which monitors and enforces nothing. Move to quarantine once you're confident.");
  }
  if (dns.mxHosts.length === 0) problems.push("No MX records, so nothing can reply to this domain.");

  return {
    ok: true,
    data: {
      domain,
      spf: !!dns.spfRecord,
      dkim: dns.dkimFound,
      dmarc: !!dns.dmarcRecord,
      dmarcPolicy: dns.dmarcRecord?.match(/p=(\w+)/i)?.[1] ?? null,
      mx: dns.mxHosts.length,
      problems,
    },
  };
}

/** Which provider a message of each class would actually go through — the routing, made visible. */
export async function routingSummary() {
  const { user } = await requireAdmin();
  if (!user) return null;
  const rows = await db.messagingProvider.findMany({
    select: { id: true, key: true, label: true, kind: true, enabled: true, priority: true, classes: true, fromEmail: true },
  });
  return toPlain({
    marketing: routeFor(rows, { kind: "EMAIL", messageClass: "MARKETING" }),
    transactional: routeFor(rows, { kind: "EMAIL", messageClass: "TRANSACTIONAL" }),
    whatsapp: routeFor(rows, { kind: "WHATSAPP", messageClass: "MARKETING" }),
  });
}

import { revalidatePath } from "next/cache";
import { Prisma } from "@wroffy/control-client";
import { CheckoutRefused } from "@/lib/billing/checkout";
import { GatewayError } from "@/lib/billing/gateway";
import { PriceRefused } from "@/lib/billing/prices";
import { actorLabel, auditHref, auditLabel, auditSummary } from "@/lib/console-shared/labels";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { ActivityItem } from "@/lib/console-shared/types";
import { controlDb } from "@/lib/platform/control-db";
import { DomainRefused } from "@/lib/platform/domain-rules";
import { LifecycleRefused } from "@/lib/platform/lifecycle";
import { PlanRefused } from "@/lib/platform/plans";
import { ProvisioningRefused } from "@/lib/platform/provisioning";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffChangeRefused } from "@/lib/platform/staff";
import { StaffRefused, type Staff } from "@/lib/platform/staff-session";

/**
 * What every console action and loader shares on the server: the role sets, the caps on bulk work and
 * exports, turning a refusal into `{ ok: false }`, the audit entry, freshness, input clean-up, and the
 * safe selects that keep secrets in the database.
 *
 * Server only. Nothing this file imports may import it back — every refusal class lives with its own
 * library, and ConsoleRefused in a file of its own (src/lib/platform/refused.ts) for that reason.
 */

export { ALL_ROLES, WRITERS, MANAGERS, SELLERS, ENTER, OWNERS, SIGNUP_VIEWERS, SETTINGS_VIEWERS } from "@/lib/console-shared/roles";

/** How many workspaces one bulk action may touch. (Bulk migrate is not offered.) */
export const BULK_CAPS = { applyStanding: 50, extendTrial: 50, tag: 100 } as const;
/** How many rows one CSV export may hold; more is refused with "narrow it down". */
export const EXPORT_CAPS = { workspaces: 5000, invoices: 10000, audit: 10000 } as const;

const REFUSALS = [StaffRefused, StaffChangeRefused, LifecycleRefused, PlanRefused, PriceRefused, GatewayError, CheckoutRefused, ProvisioningRefused, DomainRefused, ConsoleRefused];

/**
 * The message to give whoever asked, when `err` is a refusal — something they can act on — or null
 * for anything else, which the caller rethrows (a bug is not an answer). A row that vanished between
 * reading and writing it (Prisma P2025) reads "That no longer exists." Messages pass through
 * `redactSecrets`: a gateway's own words are quoted in some of them.
 */
export function consoleRefusal(err: unknown): string | null {
  if (REFUSALS.some((kind) => err instanceof kind)) return redactSecrets((err as Error).message) || "That can't be done.";
  const known = err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError");
  if (known && (err as { code?: unknown }).code === "P2025") return "That no longer exists.";
  return null;
}

/** One platform audit entry, under the staff member. The detail never holds secrets, codes, bodies or payloads. */
export async function consoleAudit(staff: Staff, action: string, detail: Record<string, unknown>, tenantId?: string | null): Promise<void> {
  await controlDb().platformAuditLog.create({
    data: { actorKind: "STAFF", actor: staff.id, action, tenantId: tenantId ?? null, detail: detail as Prisma.InputJsonValue },
    select: { id: true },
  });
}

/** Several entries at once — a bulk action's per-workspace rows. */
export async function consoleAuditMany(staff: Staff, rows: { action: string; detail: Record<string, unknown>; tenantId: string | null }[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await controlDb().platformAuditLog.createMany({
      data: rows.slice(i, i + 500).map((r) => ({ actorKind: "STAFF" as const, actor: staff.id, action: r.action, tenantId: r.tenantId, detail: r.detail as Prisma.InputJsonValue })),
    });
  }
}

/**
 * Every console page shows fresh data after a change — the nav badges included. The proxy rewrites
 * /x to /platform-console/x, so the path to revalidate is the rewritten one, as a layout.
 */
export function revalidateConsole(): void {
  revalidatePath("/platform-console", "layout");
}

// ─── Safe selects: every column but the secrets ──────────────────────────────────────────────────

/** Every Tenant scalar except `dbUrlCipher` and `keyBundleCipher`. */
export const TENANT_SAFE_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  isDefault: true,
  region: true,
  dbName: true,
  dbRole: true,
  keyBundleVersion: true,
  schemaVersion: true,
  country: true,
  currency: true,
  timezone: true,
  ownerEmail: true,
  entitlements: true,
  seatOverride: true,
  copilotTokenOverride: true,
  customDomainOverride: true,
  suspendedFor: true,
  billingEmail: true,
  taxId: true,
  stripeCustomerId: true,
  razorpayCustomerId: true,
  createdAt: true,
  updatedAt: true,
  suspendedAt: true,
  deprovisionedAt: true,
  tags: true,
} as const satisfies Prisma.TenantSelect;
export type SafeTenant = Prisma.TenantGetPayload<{ select: typeof TENANT_SAFE_SELECT }>;

/** Every ProvisioningJob scalar except `ownerPasswordHash`. */
export const JOB_SAFE_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  step: true,
  attempts: true,
  runAfter: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  ownerName: true,
  ownerEmail: true,
  companyName: true,
  country: true,
  planKey: true,
  createdAt: true,
} as const satisfies Prisma.ProvisioningJobSelect;
export type SafeJob = Prisma.ProvisioningJobGetPayload<{ select: typeof JOB_SAFE_SELECT }>;

/** Every WarmDatabase scalar except `dbUrlCipher`. */
export const WARM_SAFE_SELECT = {
  id: true,
  dbName: true,
  dbRole: true,
  schemaVersion: true,
  createdAt: true,
  claimedAt: true,
  claimedByTenantId: true,
} as const satisfies Prisma.WarmDatabaseSelect;
export type SafeWarmDatabase = Prisma.WarmDatabaseGetPayload<{ select: typeof WARM_SAFE_SELECT }>;

// ─── Inputs, re-coerced on the server ────────────────────────────────────────────────────────────

/** A character a person never means to type: control characters but the newline, and the bidi overrides that can make text read backwards. */
function unwanted(code: number): boolean {
  return (code < 32 && code !== 10) || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * Text from a form: `String()` of whatever came, line endings made "\n", tabs made spaces, other
 * control characters dropped, trimmed, cut to `max` characters (never through the middle of one).
 */
export function cleanText(input: unknown, max: number): string {
  if (input === null || input === undefined) return "";
  const raw = String(input).replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  let out = "";
  for (const ch of raw) if (!unwanted(ch.codePointAt(0) ?? 0)) out += ch;
  out = out.trim();
  if (out.length <= max) return out;
  let cut = out.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // half a surrogate pair
  return cut.trimEnd();
}

/**
 * Ids from the browser: strings only, trimmed, de-duplicated, in the order given. Null when there are
 * more than `cap` (refuse, don't truncate — the person chose them); an empty list when it isn't a list.
 */
export function idList(input: unknown, cap: number): string[] | null {
  if (!Array.isArray(input)) return [];
  if (input.length > Math.max(cap * 10, 1000)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > cap ? null : ids;
}

/** A whole number within `min`–`max`; `fallback` for anything that is not a number at all. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return fallback;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ─── Audit rows for people ───────────────────────────────────────────────────────────────────────

/** Staff ids to names — every staff member's, or just `ids` (switched-off members included: old entries name them). */
export async function staffNameMap(ids?: string[]): Promise<Map<string, string>> {
  const control = controlDb();
  if (!ids) {
    const rows = await control.platformUser.findMany({ select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  const names = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 1000) {
    const rows = await control.platformUser.findMany({ where: { id: { in: wanted.slice(i, i + 1000) } }, select: { id: true, name: true } });
    for (const r of rows) names.set(r.id, r.name);
  }
  return names;
}

/** Audit rows as the console shows them: a past-tense title, a redacted one-line summary, who, where it leads. */
export function toActivityItems(
  rows: { id: string; at: Date; actorKind: "STAFF" | "SCRIPT" | "SYSTEM"; actor: string; action: string; detail: unknown; tenant: { slug: string } | null }[],
  names: ReadonlyMap<string, string>,
): ActivityItem[] {
  return rows.map((row) => {
    const { title, tone, category } = auditLabel(row.action, row.detail);
    const slug = row.tenant?.slug ?? null;
    return {
      id: row.id,
      at: row.at,
      title,
      code: row.action,
      tone,
      category,
      detail: redactSecrets(auditSummary(row.action, row.detail)),
      actor: actorLabel(row.actorKind, row.actor, names),
      actorKind: row.actorKind,
      workspace: slug ? { slug } : null,
      href: auditHref(row.action, row.detail, slug),
    };
  });
}

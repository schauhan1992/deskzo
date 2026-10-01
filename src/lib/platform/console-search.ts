import type { Prisma } from "@deskzo/control-client";
import { formatMoney } from "@/lib/billing/money";
import { dayMonth, dayMonthYear } from "@/lib/console-shared/format";
import { INVOICE_STATUS, INVITE_STATE, PARTNER_KIND, PARTNER_STATUS, ROLE_LABEL, SUBSCRIPTION_STATUS, TENANT_STATUS, planKindLabel, subscriptionKind } from "@/lib/console-shared/labels";
import { SELLERS, SIGNUP_VIEWERS, hasRole } from "@/lib/console-shared/roles";
import type { ConsoleRole, SearchHit, SearchKind, SearchResults, TenantStatusKey } from "@/lib/console-shared/types";
import { cleanText } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { normaliseSerial } from "@/lib/platform/device-routes";

/**
 * The command palette's search (Ctrl K): the control plane's workspaces, their addresses, billing,
 * terminals, staff, partners, plans, invitations and signups, matched on what staff actually type — a
 * slug, a company, an owner's email, an invoice number, a gateway id, a terminal's serial.
 *
 * Read-only, and narrow on purpose: each group selects the few columns its line shows and never one
 * of the secrets (no cipher, no password or code hash, no gateway payload). An invitation is never
 * identified by its code's hash — its line is its note. Groups are cut to what the role may open
 * (decision D16): invoices and subscriptions for the staff who sell, signups for those who may open
 * the signups page, tax-id matching for sellers; everything else for everybody.
 *
 * Every group is one small query with `take: 6`, all run at once; five lines of each are shown, the
 * closest first (the text itself, then text starting with it, then the rest in the query's order).
 *
 *   `w:`  workspaces and their addresses   `i:`  invoices and subscriptions   `s:`  staff
 *   `>`   the palette's own actions — nothing to look up here
 */

const MAX_QUERY = 100;
const MIN_TERM = 2;
const TAKE = 6;
const SHOW = 5;
/** A gateway id is matched by its beginning only from this many characters: "cus_" alone would match every customer. */
const EXTERNAL_ID_MIN = 4;
/** A term that could be a workspace's address — worth an exact lookup as well. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const GROUPS: readonly { kind: SearchKind; label: string }[] = [
  { kind: "workspace", label: "Workspaces" },
  { kind: "domain", label: "Addresses" },
  { kind: "subscription", label: "Subscriptions" },
  { kind: "invoice", label: "Invoices" },
  { kind: "terminal", label: "Terminals" },
  { kind: "staff", label: "Staff" },
  { kind: "partner", label: "Partners" },
  { kind: "plan", label: "Plans" },
  { kind: "invite", label: "Invitations" },
  { kind: "signup", label: "Signups" },
];

const SCOPES: Record<"w" | "i" | "s", readonly SearchKind[]> = {
  w: ["workspace", "domain"],
  i: ["invoice", "subscription"],
  s: ["staff"],
};

type Ctx = {
  /** What to look for, as typed (scope prefix taken off). */
  term: string;
  /** The term without any whitespace — ids are pasted with a stray space now and then. */
  compact: string;
  seller: boolean;
  now: Date;
};

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────

const ci = (term: string) => ({ contains: term, mode: "insensitive" as const });

/** Text from a row, as one line: control and bidi characters out, cut to fit. */
const text = (value: string | null | undefined, max = 120) => cleanText(value ?? "", max).replace(/\s+/g, " ");

/** The parts that are there, joined as one subtitle. */
const line = (...parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");

const encode = encodeURIComponent;

/** 0: one of `values` is the term itself; 1: one starts with it; 2: it matched further in, or on another column. */
function closeness(term: string, values: (string | null | undefined)[]): number {
  const t = term.toLowerCase();
  let best = 2;
  for (const value of values) {
    if (!value) continue;
    const v = value.toLowerCase();
    if (v === t) return 0;
    if (v.startsWith(t)) best = 1;
  }
  return best;
}

/** The rows, closest first; ties keep the query's own order. */
function closestFirst<T>(rows: T[], score: (row: T) => number): T[] {
  return rows
    .map((row, i) => ({ row, i, score: score(row) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((r) => r.row);
}

/** The query as it is searched: control characters out, whitespace runs made one space, at most 100 characters. */
function normalise(input: string): string {
  return cleanText(input, MAX_QUERY * 4)
    .replace(/\s+/g, " ")
    .slice(0, MAX_QUERY)
    .trim();
}

/** "w: acme" → the workspaces scope and "acme"; no prefix → every group. */
function scopeOf(q: string): { kinds: readonly SearchKind[] | null; term: string } {
  const match = /^([wis]):\s*/i.exec(q);
  if (!match) return { kinds: null, term: q };
  const scope = match[1].toLowerCase() as keyof typeof SCOPES;
  return { kinds: SCOPES[scope], term: q.slice(match[0].length).trim() };
}

/** Who may see a group's lines at all (D16). */
function visibleTo(kind: SearchKind, role: ConsoleRole): boolean {
  switch (kind) {
    case "invoice":
    case "subscription":
      return hasRole(role, SELLERS);
    case "signup":
      return hasRole(role, SIGNUP_VIEWERS);
    default:
      return true;
  }
}

// ─── The groups ──────────────────────────────────────────────────────────────────────────────────

/**
 * A workspace's line, and — for the staff who sell only — its billing details, so a line found by a
 * customer id or tax number can say so. Nobody else's query reads them at all.
 */
function workspaceSelect(seller: boolean) {
  return {
    id: true,
    slug: true,
    name: true,
    status: true,
    ownerEmail: true,
    billingEmail: seller,
    taxId: seller,
    stripeCustomerId: seller,
    razorpayCustomerId: seller,
  } satisfies Prisma.TenantSelect;
}

type WorkspaceRow = { id: string; slug: string; name: string; status: TenantStatusKey; ownerEmail: string | null } & {
  billingEmail?: string | null;
  taxId?: string | null;
  stripeCustomerId?: string | null;
  razorpayCustomerId?: string | null;
};

/** What a workspace matched on, when it was not its name, address or owner — so a line found by a customer id says so. */
function workspaceMatch(t: WorkspaceRow, c: Ctx): string | null {
  const term = c.term.toLowerCase();
  if ([t.slug, t.name, t.ownerEmail].some((v) => v?.toLowerCase().includes(term))) return null;
  if (t.id === c.compact) return `id ${t.id}`;
  if (!c.seller) return "matched on its billing details";
  const long = c.compact.length >= EXTERNAL_ID_MIN;
  if (t.billingEmail?.toLowerCase().includes(term)) return `billing ${text(t.billingEmail)}`;
  if (long && t.stripeCustomerId?.startsWith(c.compact)) return `Stripe ${t.stripeCustomerId}`;
  if (long && t.razorpayCustomerId?.startsWith(c.compact)) return `Razorpay ${t.razorpayCustomerId}`;
  if (t.taxId && [c.term, c.compact].some((v) => t.taxId?.startsWith(v.toUpperCase()))) return `tax ID ${text(t.taxId, 40)}`;
  return null;
}

async function workspaceHits(c: Ctx): Promise<SearchHit[]> {
  const control = controlDb();
  const or: Prisma.TenantWhereInput[] = [{ slug: ci(c.term) }, { name: ci(c.term) }, { ownerEmail: ci(c.term) }, { billingEmail: ci(c.term) }, { id: c.compact }];
  if (c.compact.length >= EXTERNAL_ID_MIN) or.push({ stripeCustomerId: { startsWith: c.compact } }, { razorpayCustomerId: { startsWith: c.compact } });
  if (c.seller) {
    // Tax numbers are kept upper-case, as typed (spaces and all); try it as typed and without its spaces.
    const taxIds = [...new Set([c.term.toUpperCase(), c.compact.toUpperCase()])];
    for (const taxId of taxIds) or.push({ taxId: { startsWith: taxId } });
  }
  const select = workspaceSelect(c.seller);
  const slug = c.term.toLowerCase();
  // The workspace whose address is the term itself always makes the list, however many others match.
  const [rows, exact] = await Promise.all([
    control.tenant.findMany({ where: { OR: or }, orderBy: [{ createdAt: "desc" }], take: TAKE, select }),
    SLUG_PATTERN.test(slug) ? control.tenant.findUnique({ where: { slug }, select }) : Promise.resolve(null),
  ]);
  const all: WorkspaceRow[] = exact && !rows.some((r) => r.id === exact.id) ? [exact, ...rows] : rows;
  // Closest first; within that, open workspaces before closed ones.
  return closestFirst(all, (t) => closeness(c.term, [t.slug, t.name, t.ownerEmail]) * 2 + (t.status === "DEPROVISIONED" ? 1 : 0))
    .slice(0, SHOW)
    .map((t) => ({
      kind: "workspace",
      key: t.slug,
      title: text(t.name) || t.slug,
      subtitle: line(t.slug, TENANT_STATUS[t.status].label, workspaceMatch(t, c) ?? text(t.ownerEmail)),
      href: `/workspaces/${encode(t.slug)}`,
    }));
}

async function domainHits(c: Ctx): Promise<SearchHit[]> {
  const rows = await controlDb().tenantDomain.findMany({
    where: { host: ci(c.term) },
    orderBy: { host: "asc" },
    take: TAKE,
    select: { host: true, kind: true, status: true, isPrimary: true, tenant: { select: { slug: true, name: true } } },
  });
  return closestFirst(rows, (d) => closeness(c.term, [d.host]))
    .slice(0, SHOW)
    .map((d) => ({
      kind: "domain",
      // Several workspaces may be waiting on one address: each is its own hit.
      key: d.status === "PENDING" ? `${d.host} ${d.tenant.slug}` : d.host,
      title: d.host,
      subtitle: line(
        text(d.tenant.name),
        d.tenant.slug,
        d.kind === "CUSTOM" ? "its own address" : "an earlier address",
        d.status === "PENDING" ? "waiting for its DNS records" : d.status === "BROKEN" ? "stopped" : null,
        d.isPrimary && "primary",
      ),
      href: `/workspaces/${encode(d.tenant.slug)}`,
    }));
}

async function subscriptionHits(c: Ctx): Promise<SearchHit[]> {
  // A gateway id is matched by its beginning; two or three characters would match them all.
  if (c.compact.length < EXTERNAL_ID_MIN) return [];
  const rows = await controlDb().subscription.findMany({
    where: { OR: [{ externalId: { startsWith: c.compact } }, { externalCustomerId: { startsWith: c.compact } }] },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: { id: true, gateway: true, status: true, externalId: true, externalCustomerId: true, tenant: { select: { slug: true, name: true } } },
  });
  return closestFirst(rows, (s) => closeness(c.compact, [s.externalId, s.externalCustomerId]))
    .slice(0, SHOW)
    .map((s) => {
      const byCustomer = !s.externalId?.startsWith(c.compact) && !!s.externalCustomerId;
      return {
        kind: "subscription",
        key: s.id,
        title: s.externalId ?? `${subscriptionKind(s.gateway, s.status)} for ${s.tenant.slug}`,
        subtitle: line(
          text(s.tenant.name),
          s.tenant.slug,
          subscriptionKind(s.gateway, s.status),
          SUBSCRIPTION_STATUS[s.status].label,
          byCustomer && `customer ${s.externalCustomerId}`,
        ),
        href: `/workspaces/${encode(s.tenant.slug)}?tab=billing`,
      };
    });
}

async function invoiceHits(c: Ctx): Promise<SearchHit[]> {
  const or: Prisma.InvoiceWhereInput[] = [{ number: ci(c.term) }];
  if (c.compact.length >= EXTERNAL_ID_MIN) or.push({ externalId: { startsWith: c.compact } });
  const rows = await controlDb().invoice.findMany({
    where: { OR: or },
    orderBy: { issuedAt: "desc" },
    take: TAKE,
    select: { id: true, number: true, externalId: true, status: true, total: true, currency: true, issuedAt: true, tenant: { select: { slug: true, name: true } } },
  });
  return closestFirst(rows, (i) => Math.min(closeness(c.term, [i.number]), closeness(c.compact, [i.externalId])))
    .slice(0, SHOW)
    .map((i) => ({
      kind: "invoice",
      key: i.id,
      title: i.number ? text(i.number, 80) : i.externalId,
      subtitle: line(formatMoney(i.total, i.currency), INVOICE_STATUS[i.status].label, i.tenant.slug, dayMonthYear(i.issuedAt)),
      href: `/workspaces/${encode(i.tenant.slug)}?tab=billing`,
    }));
}

async function terminalHits(c: Ctx): Promise<SearchHit[]> {
  const serial = normaliseSerial(c.term);
  // By serial, so the terminal whose serial is the term itself sorts ahead of the longer ones it begins.
  const rows = await controlDb().biometricDeviceRoute.findMany({
    where: { serial: { startsWith: serial } },
    orderBy: { serial: "asc" },
    take: TAKE,
    select: { serial: true, lastSeenAt: true, tenant: { select: { slug: true, name: true } } },
  });
  return rows.slice(0, SHOW).map((d) => ({
    kind: "terminal",
    key: d.serial,
    title: d.serial,
    subtitle: line(text(d.tenant.name), d.tenant.slug, d.lastSeenAt ? `last heard ${dayMonth(d.lastSeenAt)}` : "never heard from"),
    href: `/devices?q=${encode(d.serial)}`,
  }));
}

async function staffHits(c: Ctx): Promise<SearchHit[]> {
  const rows = await controlDb().platformUser.findMany({
    where: { OR: [{ name: ci(c.term) }, { email: ci(c.term) }] },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: TAKE,
    select: { id: true, name: true, email: true, role: true, active: true },
  });
  return closestFirst(rows, (s) => closeness(c.term, [s.name, s.email]))
    .slice(0, SHOW)
    .map((s) => ({
      kind: "staff",
      key: s.id,
      title: text(s.name) || s.email,
      subtitle: line(s.email, ROLE_LABEL[s.role].label, !s.active && "switched off"),
      // The staff list shows active members unless asked; a switched-off one needs the wider view to be there.
      href: s.active ? `/staff?q=${encode(s.email)}` : `/staff?q=${encode(s.email)}&status=all`,
    }));
}

/** "IN, AE, SG +2": the first three countries a partner sells in, and how many more. */
function territoriesText(territories: string[]): string | null {
  if (!territories.length) return null;
  const more = territories.length - 3;
  return `${territories.slice(0, 3).join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

/** A partner by its slug, either of its names or its contact's email; terminated ones after the rest. Never its bank details or tax ids. */
async function partnerHits(c: Ctx): Promise<SearchHit[]> {
  const rows = await controlDb().partner.findMany({
    where: { OR: [{ slug: ci(c.term) }, { displayName: ci(c.term) }, { legalName: ci(c.term) }, { contactEmail: ci(c.term) }] },
    orderBy: [{ displayName: "asc" }],
    take: TAKE,
    select: { slug: true, displayName: true, legalName: true, kind: true, status: true, territories: true },
  });
  return closestFirst(rows, (p) => closeness(c.term, [p.slug, p.displayName, p.legalName]) * 2 + (p.status === "TERMINATED" ? 1 : 0))
    .slice(0, SHOW)
    .map((p) => ({
      kind: "partner",
      key: p.slug,
      title: text(p.displayName) || p.slug,
      subtitle: line(PARTNER_KIND[p.kind].label, PARTNER_STATUS[p.status].label, territoriesText(p.territories)),
      href: `/partners/${encode(p.slug)}`,
    }));
}

async function planHits(c: Ctx): Promise<SearchHit[]> {
  const rows = await controlDb().plan.findMany({
    where: { OR: [{ key: ci(c.term) }, { name: ci(c.term) }] },
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    take: TAKE,
    select: { key: true, name: true, kind: true, active: true },
  });
  return closestFirst(rows, (p) => closeness(c.term, [p.key, p.name]))
    .slice(0, SHOW)
    .map((p) => ({
      kind: "plan",
      key: p.key,
      title: text(p.name) || p.key,
      subtitle: line(p.key, planKindLabel(p.kind), !p.active && "retired"),
      href: `/plans/${encode(p.key)}`,
    }));
}

async function inviteHits(c: Ctx): Promise<SearchHit[]> {
  // Never the code's hash, not even part of it: an invitation is known here by its note. The platform's
  // own only, as the Invitations page lists them — a partner's codes are on its page.
  const rows = await controlDb().signupInvite.findMany({
    where: { partnerId: null, note: ci(c.term) },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: { note: true, uses: true, maxUses: true, expiresAt: true, createdAt: true },
  });
  const now = c.now.getTime();
  return closestFirst(rows, (i) => closeness(c.term, [i.note]))
    .slice(0, SHOW)
    .map((i, n) => {
      const note = text(i.note, 120);
      // The Invitations page matches its `q` (100 characters) inside the note as stored: the note itself
      // when that finds it, else what was typed here — which found it.
      const stored = (i.note ?? "").trim();
      const pageQuery = stored && stored === note && stored.length <= MAX_QUERY ? stored : c.term;
      // Its state as the Invitations page words it: used up, expired (on a date), or live (until one).
      const until = i.expiresAt ? ` ${dayMonthYear(i.expiresAt)}` : "";
      const state =
        i.uses >= i.maxUses
          ? INVITE_STATE.used.label
          : i.expiresAt && i.expiresAt.getTime() <= now
            ? `${INVITE_STATE.expired.label}${until}`
            : `${INVITE_STATE.live.label}${until ? ` until${until}` : ""}`;
      return {
        kind: "invite",
        key: `${i.createdAt.getTime().toString(36)}-${n}`,
        title: note || "An invitation",
        subtitle: line(state, `${i.uses} of ${i.maxUses} used`, `made ${dayMonthYear(i.createdAt)}`),
        href: `/invites?status=all&q=${encode(pageQuery)}`,
      };
    });
}

async function signupHits(c: Ctx): Promise<SearchHit[]> {
  // Never the password or code hashes, the browser's secret, or the address it came from.
  const rows = await controlDb().pendingSignup.findMany({
    where: { OR: [{ email: ci(c.term) }, { slug: ci(c.term) }, { companyName: ci(c.term) }] },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: { id: true, email: true, companyName: true, slug: true, verifiedAt: true, tenantId: true, createdAt: true },
  });
  return closestFirst(rows, (s) => closeness(c.term, [s.email, s.slug, s.companyName]))
    .slice(0, SHOW)
    .map((s) => ({
      kind: "signup",
      key: s.id,
      title: text(s.email),
      subtitle: line(
        text(s.companyName),
        s.slug,
        !s.verifiedAt ? "email not confirmed" : s.tenantId ? "workspace requested" : "email confirmed",
        `started ${dayMonthYear(s.createdAt)}`,
      ),
      href: `/signups?q=${encode(text(s.email, MAX_QUERY))}`,
    }));
}

const SEARCHES: Record<SearchKind, (c: Ctx) => Promise<SearchHit[]>> = {
  workspace: workspaceHits,
  domain: domainHits,
  subscription: subscriptionHits,
  invoice: invoiceHits,
  terminal: terminalHits,
  staff: staffHits,
  partner: partnerHits,
  plan: planHits,
  invite: inviteHits,
  signup: signupHits,
};

// ─── The search ──────────────────────────────────────────────────────────────────────────────────

/**
 * Everything in the control plane matching `q` that `role` may open, grouped, at most five lines a
 * group and only the groups with any. Fewer than two characters (after a scope prefix) finds nothing.
 */
export async function searchControlPlane(q: string, role: ConsoleRole, now = new Date()): Promise<SearchResults> {
  const query = normalise(typeof q === "string" ? q : "");
  const empty: SearchResults = { q: query, groups: [] };
  // ">" is the palette's actions — it filters those itself.
  if (query.startsWith(">")) return empty;
  const { kinds, term } = scopeOf(query);
  if (term.length < MIN_TERM) return empty;

  const ctx: Ctx = { term, compact: term.replace(/\s/g, ""), seller: hasRole(role, SELLERS), now };
  const groups = GROUPS.filter((g) => (!kinds || kinds.includes(g.kind)) && visibleTo(g.kind, role));
  const hits = await Promise.all(groups.map((g) => SEARCHES[g.kind](ctx)));
  return {
    q: query,
    groups: groups.map((g, i) => ({ kind: g.kind, label: g.label, hits: hits[i] })).filter((g) => g.hits.length > 0),
  };
}

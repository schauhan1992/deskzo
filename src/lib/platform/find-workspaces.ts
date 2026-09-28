import { createHash } from "node:crypto";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { emailIndexReady, indexedCandidates } from "@/lib/platform/email-index";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { getSiteSettings } from "@/lib/platform/site-content";
import { withClient } from "@/lib/tenancy/clients";
import { activeTenants, tenantById } from "@/lib/tenancy/registry";
import { runAsTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * "Find my workspaces" — the public site's sign-in page emails somebody a link to every workspace
 * they can sign in to, the way Slack's "find your workspaces" does. The action is
 * `findMyWorkspaces` (src/actions/platform/site.ts); this is the lookup, the mail, and the limits.
 *
 * ## Which workspaces
 *
 * Every workspace that can be signed in to: active ones, and ones held for billing — whose owner can
 * still sign in and pay (src/lib/tenancy/hold.ts). Not ones held by staff, being set up, migrating or
 * closed. In each, an active member with that address (case-insensitive; never the platform's own
 * support accounts), or the workspace's owner as the control plane records it.
 *
 * ## What it gives away
 *
 * Nothing to whoever asked: the action answers the same whatever was found, before any of this runs,
 * and the list goes only to the address itself. Nothing to the logs: a workspace that fails to answer
 * is logged by its name with the error's code, never the address or the error's message (which can
 * quote the query). The address is not stored; the limits below keep a hash of it for an hour, and the
 * email index (src/lib/platform/email-index.ts) holds only HMACs of member accounts' own addresses.
 *
 * ## What it costs
 *
 * Until the email index is built (`emailIndex.builtAt`, set by the first nightly reconcile that covers
 * every workspace): a query in every workspace's database — so eight at a time, five seconds each at
 * most. Once it is built: one control-plane query for the address's HMAC, then the same query, narrowed
 * to the accounts the index names, in those candidate workspaces only (usually one to three) — with the
 * same limits and logging, so an account switched off since it was indexed is not listed. A workspace
 * from the environment, which the index cannot hold, is still asked directly. Either way the recorded
 * owners come from the control plane, and the requests themselves are limited per address, per caller
 * and in all (`siteAllowance`; the ceiling in all is `findLookupsPerHour`: 60 an hour, 300 once the
 * index is built).
 */

export type FoundWorkspace = { slug: string; name: string; loginUrl: string };

const CONCURRENCY = 8;
const TIMEOUT_MS = 5_000;

class NoAnswer extends Error {}

/** A failure described without anything it might quote: the error's code or kind, or "no answer". */
function reasonOf(err: unknown, timeoutMs = TIMEOUT_MS): string {
  if (err instanceof NoAnswer) return `no answer within ${timeoutMs / 1000} s`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : "error";
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer()), ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Workspaces somebody could sign in to now. */
async function signInable(): Promise<Tenant[]> {
  const found = new Map<string, Tenant>();
  for (const tenant of await activeTenants()) found.set(tenant.id, tenant);
  if (controlConfigured()) {
    const held = await controlDb().tenant.findMany({ where: { status: "SUSPENDED", suspendedFor: "BILLING" }, select: { id: true } });
    for (const { id } of held) {
      const tenant = await tenantById(id);
      if (tenant?.status === "SUSPENDED" && tenant.holdReason === "BILLING") found.set(tenant.id, tenant);
    }
  }
  return [...found.values()].filter((tenant) => !!tenant.dbUrl);
}

/** Workspaces whose recorded owner has this address. */
async function ownedBy(email: string): Promise<Set<string>> {
  if (!controlConfigured()) return new Set();
  const rows = await controlDb().tenant.findMany({
    where: { ownerEmail: { equals: email, mode: "insensitive" }, OR: [{ status: "ACTIVE" }, { status: "SUSPENDED", suspendedFor: "BILLING" }] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

async function eachAtMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

/** A workspace to ask, and — when the index named them — the only accounts in it to look at. */
type Ask = { tenant: Tenant; userIds: string[] | null };

/**
 * With the email index built: the workspaces it names for the address, each narrowed to the accounts
 * it names; those the address is the recorded owner of; and any from the environment, which the index
 * cannot hold. The rest are not asked.
 */
async function indexedAsks(address: string, tenants: Tenant[], owned: Set<string>): Promise<Ask[]> {
  const named = new Map<string, string[]>();
  for (const { tenantId, userId } of await indexedCandidates(address)) named.set(tenantId, [...(named.get(tenantId) ?? []), userId]);
  const asks: Ask[] = [];
  for (const tenant of tenants) {
    if (tenant.source !== "control") asks.push({ tenant, userIds: null });
    else if (owned.has(tenant.id) || named.has(tenant.id)) asks.push({ tenant, userIds: named.get(tenant.id) ?? [] });
  }
  return asks;
}

/** Every workspace this address can sign in to, by name. */
export async function findWorkspacesFor(email: string, options: { timeoutMs?: number } = {}): Promise<FoundWorkspace[]> {
  const address = String(email ?? "").trim();
  if (!address) return [];
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const [tenants, owned, indexed] = await Promise.all([signInable(), ownedBy(address), emailIndexReady()]);
  // Until the index is built, every workspace is asked about the address itself.
  const asks: Ask[] = indexed ? await indexedAsks(address, tenants, owned) : tenants.map((tenant) => ({ tenant, userIds: null }));
  const matched: Tenant[] = [];
  await eachAtMost(asks, CONCURRENCY, async ({ tenant, userIds }) => {
    if (owned.has(tenant.id)) {
      matched.push(tenant);
      return;
    }
    // Named by the index, and no account there: nothing to ask.
    if (userIds && !userIds.length) return;
    try {
      const member = await within(
        withClient(tenant, async (c) =>
          await c.user.findFirst({
            where: { ...(userIds ? { id: { in: userIds } } : {}), email: { equals: address, mode: "insensitive" }, active: true, kind: "MEMBER" },
            select: { id: true },
          }),
        ),
        timeoutMs,
      );
      if (member) matched.push(tenant);
    } catch (err) {
      console.warn(`[find-workspaces] skipped ${tenant.slug}: ${reasonOf(err, timeoutMs)}`);
    }
  });
  const found = await Promise.all(
    matched.map(async (tenant) => ({
      slug: tenant.slug,
      name: tenant.name,
      // As the workspace: its own address, never the public site's the request came in on.
      loginUrl: `${await runAsTenant(tenant, () => tenantOrigin(tenant))}/login`,
    })),
  );
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

/** The lookup, and the mail when there is something to send. Returns how many workspaces were listed. */
export async function mailWorkspacesTo(email: string): Promise<number> {
  const found = await findWorkspacesFor(email);
  if (!found.length) return 0;
  const { siteName } = await getSiteSettings();
  await sendPlatformMail({
    to: email,
    subject: `Your ${siteName} workspaces`,
    text: [
      "Hello,",
      "",
      `You asked which ${siteName} workspaces you can sign in to. ${found.length === 1 ? "Here it is" : "Here they are"}:`,
      "",
      ...found.flatMap((w) => [w.name, w.loginUrl, ""]),
      "If you didn't ask for this, you can ignore this email — nothing has changed, and nobody else was sent this list.",
    ].join("\n"),
  });
  return found.length;
}

/**
 * The action's way in: started, not awaited — how long the lookup takes must not tell the caller
 * whether anything was found. A failure is logged, without the address.
 */
export function startWorkspaceLookup(email: string): void {
  void mailWorkspacesTo(email).catch((err) => console.error(`[find-workspaces] the lookup failed: ${reasonOf(err)}`));
}

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────────

type Window = { count: number; since: number };

/**
 * The public site's requests that cost something — a lookup in every workspace, a mail to the sales
 * inbox — counted per key for an hour. Keys start "platform|" and name an address (hashed), a
 * caller's network address, or "all": the public site belongs to no workspace, so no key here is a
 * workspace's.
 *
 * Per process, like src/lib/security/lockout.ts, and with the same trade-off: across several app
 * processes each has its own budget. Bounded: when full, windows that have ended are dropped, and a
 * key that still does not fit is refused rather than one that is counting being forgotten.
 */
const allowances = new Map<string, Window>();
const MAX_TRACKED = 20_000;
export const HOUR_MS = 3_600_000;

/** A stable, one-way stand-in for an address — for keys, never for display. */
export function addressKey(email: string): string {
  return createHash("sha256").update(String(email ?? "").trim().toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * Whether one more request fits every limit given — and if it does, it is counted against all of
 * them. A request refused by one limit is counted against none.
 */
export function siteAllowance(limits: { key: string; max: number }[], windowMs = HOUR_MS, now = Date.now()): boolean {
  const current = limits.map(({ key, max }) => {
    const window = allowances.get(key);
    return { key, max, window: window && now - window.since < windowMs ? window : null };
  });
  if (current.some(({ max, window }) => max <= 0 || (window && window.count >= max))) return false;
  const fresh = current.filter((c) => !c.window).length;
  if (fresh && allowances.size + fresh > MAX_TRACKED) {
    for (const [key, window] of allowances) if (now - window.since >= windowMs) allowances.delete(key);
    if (allowances.size + fresh > MAX_TRACKED) return false;
  }
  for (const c of current) {
    if (c.window) c.window.count += 1;
    else allowances.set(c.key, { count: 1, since: now });
  }
  return true;
}

/**
 * The ceiling on "find my workspaces" lookups an hour for the whole process (`platform|find:all`,
 * src/actions/platform/site.ts): 60 while each lookup asks every workspace's database, 300 once the
 * email index is built and a lookup asks only the workspaces it names (owner decision 6).
 */
export const FIND_LOOKUPS_PER_HOUR = { fanOut: 60, indexed: 300 } as const;

/** Which of the two applies now — the lower one when that can't be told. Never throws. */
export async function findLookupsPerHour(): Promise<number> {
  try {
    return (await emailIndexReady()) ? FIND_LOOKUPS_PER_HOUR.indexed : FIND_LOOKUPS_PER_HOUR.fanOut;
  } catch (err) {
    console.warn(`[find-workspaces] could not tell whether the email index is built: ${reasonOf(err)}`);
    return FIND_LOOKUPS_PER_HOUR.fanOut;
  }
}

/** Only for the check script — module state shared between tests is what makes them flaky. */
export function resetSiteAllowances(): void {
  allowances.clear();
}

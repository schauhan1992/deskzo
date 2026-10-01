import type { Prisma } from "@wroffy/control-client";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { nameVerdict, verdictInWords, type NameFacts, type NameHold, type NameRule, type NameVerdict } from "@/lib/workspace-names";

/**
 * The database's part of what a workspace may be called — the rules themselves are pure, in
 * src/lib/workspace-names.ts, and take what is read here as input:
 *
 *   · staff's rules (WorkspaceNameRule): names and words they block, built-in words they release —
 *     cached for 30 seconds, forgotten at once when the console changes one (`forgetNameRules`), and
 *     fail-safe: a failed read means the built-in rules alone, and is logged;
 *   · the address an invitation holds for its customer (SignupInvite.heldSlug), while the invitation
 *     is open — not used up, not expired or ended;
 *   · whether a workspace has the name already.
 *
 * Holds and names taken are read fresh every time: a stale "free" would let two customers have one.
 */

/** An invitation's hold, with the invitation it belongs to — so its own signup is not refused by it. */
export type InviteHold = NameHold & { codeHash: string };

const FRESH_MS = 30_000;
let cache: { rules: readonly NameRule[]; at: number } | null = null;
/** Bumped by every change: a read that began before one does not store what it read. */
let generation = 0;
let lastFailureLog = 0;

/** Staff's rules, all of them — cached. A failed read is the built-in rules alone (an empty list), logged. */
export async function nameRules(): Promise<readonly NameRule[]> {
  if (!controlConfigured()) return [];
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.rules;
  const started = generation;
  try {
    const rows = await controlDb().workspaceNameRule.findMany({ select: { kind: true, value: true }, orderBy: [{ kind: "asc" }, { value: "asc" }] });
    const rules = rows.map((r) => ({ kind: r.kind, value: r.value }));
    if (started === generation) cache = { rules, at: now };
    return rules;
  } catch (err) {
    if (now - lastFailureLog >= 60_000) {
      lastFailureLog = now;
      const code = (err as { code?: string } | null)?.code;
      console.error(`[workspace-names] staff's name rules could not be read, so only the built-in rules apply: ${code ?? (err instanceof Error ? err.name : "error")}`);
    }
    return [];
  }
}

/** Called by every change to the rules: the next check reads them again. */
export function forgetNameRules(): void {
  generation += 1;
  cache = null;
}

/** An open invitation: not used up, and not past its end. */
export function openInviteWhere(now = new Date()): Prisma.SignupInviteWhereInput {
  return { uses: { lt: controlDb().signupInvite.fields.maxUses }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * The address an invitation code holds, while the invitation is open — by the code's hash. Null for
 * a code that holds none, or is used up, expired or ended, or is a partner's (partners' codes never
 * hold an address). `open: false` keeps the hold of an invitation just spent by the signup it was for.
 */
export async function inviteHold(codeHash: string, opts: { open?: boolean; now?: Date } = {}): Promise<InviteHold | null> {
  const now = opts.now ?? new Date();
  const invite = await controlDb().signupInvite.findUnique({
    where: { codeHash },
    select: { codeHash: true, heldSlug: true, heldSlugSkipsReserved: true, partnerId: true, uses: true, maxUses: true, expiresAt: true },
  });
  if (!invite?.heldSlug || invite.partnerId) return null;
  if (opts.open !== false && (invite.uses >= invite.maxUses || (invite.expiresAt && invite.expiresAt <= now))) return null;
  return { codeHash: invite.codeHash, slug: invite.heldSlug, skipsReserved: invite.heldSlugSkipsReserved };
}

/** Whether an open invitation other than `exceptCodeHash` holds this name. */
export async function heldElsewhere(slug: string, exceptCodeHash?: string | null, now = new Date()): Promise<boolean> {
  const row = await controlDb().signupInvite.findFirst({
    where: { AND: [{ heldSlug: slug }, openInviteWhere(now), ...(exceptCodeHash ? [{ NOT: { codeHash: exceptCodeHash } }] : [])] },
    select: { codeHash: true },
  });
  return !!row;
}

/**
 * A verdict with the database's facts — `judge` is one of the pure verdicts, called with what is
 * known so far. The rules first; the hold and "taken" only when nothing before them refused, since
 * those facts can only add a later refusal, never lift an earlier one.
 */
export async function judgeName<V extends { ok: boolean }>(slug: string, hold: InviteHold | null, judge: (facts: NameFacts) => V): Promise<V> {
  const rules = await nameRules();
  const first = judge({ rules, hold });
  if (!first.ok) return first;
  const [held, taken] = await Promise.all([heldElsewhere(slug, hold?.codeHash), controlDb().tenant.findUnique({ where: { slug }, select: { id: true } })]);
  return judge({ rules, hold, heldElsewhere: held, taken: !!taken });
}

/** The whole verdict for a new workspace's address (provisioning's `slugProblem`), with the hold of the invitation it comes with. */
export async function workspaceNameVerdict(slug: string, hold: InviteHold | null = null): Promise<NameVerdict> {
  const own = hold && hold.slug === slug ? hold : null;
  return judgeName(slug, own, (facts) => nameVerdict(slug, facts));
}

/**
 * Why staff can't hold this address on a new invitation, in staff's words; null when they can. Never
 * a platform address, never one a workspace has or another open invitation holds; and — unless
 * `skipsReserved` (an owner or admin's choice) — never a reserved word, a blocked name, ours or a
 * competitor's.
 */
export async function holdProblem(slug: string, skipsReserved: boolean): Promise<string | null> {
  const verdict = await judgeName(slug, null, (facts) => nameVerdict(slug, { ...facts, hold: { slug, skipsReserved } }));
  if (verdict.ok) return null;
  switch (verdict.rule) {
    case "pattern":
      return verdict.message;
    case "platform":
      return `${slug} is one of the platform's own addresses — it can never be a workspace's.`;
    case "held":
      return `Another live invitation already holds ${slug}.`;
    case "taken":
      return `A workspace already has ${slug}.`;
    default:
      return `${verdictInWords(verdict)} To hold it anyway, tick "It may be a reserved word or a blocked name".`;
  }
}

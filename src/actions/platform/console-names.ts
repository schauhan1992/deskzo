"use server";

import { Prisma, type StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { ALL_ROLES, MANAGERS, cleanText, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { forgetNameRules, judgeName, workspaceNameVerdict } from "@/lib/platform/name-rules";
import { nameRuleImpact } from "@/lib/platform/names-console";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { subdomainHost } from "@/lib/tenancy/registry";
import { blockProblem, releasableGroupOf, releaseProblem, signupNameVerdict, verdictInWords, type NameRuleKind, type SignupNameVerdict } from "@/lib/workspace-names";

/**
 * The console's "Workspace names" actions (src/app/platform-console/(console)/names):
 *
 *   consoleBlockName        managers  block an exact name, or every name with a word in it
 *   consoleReleaseName      managers  let a built-in word through: a reserved word, ours or a competitor's
 *   consoleRemoveNameRule   managers  unblock, or block a released word again
 *   consoleNameImpact       managers  the workspaces a rule not yet made would touch, for its confirmation
 *   consoleTestName         anybody   what signup would say about a name, and which rule decided
 *
 * A block refuses new workspaces only: a workspace that already has the name keeps it (the
 * confirmation says so). A platform address can be neither released nor blocked — it is locked
 * already. Each change is in the platform's audit log (`names.*`), and every check that follows reads
 * the rules again at once (`forgetNameRules`). The reasons are staff's: no customer ever reads one.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

const REASON_MAX = 500;
const REASON_MIN = 3;
const RULE_GONE = "That rule no longer exists.";

/** A name or word as typed: trimmed, lower case, at most 64 characters — the rules say whether it will do. */
const valueOf = (input: unknown) => cleanText(input, 64).toLowerCase();

function reasonOf(input: unknown): string {
  const reason = cleanText(input, REASON_MAX);
  if (reason.length < REASON_MIN) throw new ConsoleRefused("Say why — staff read it later. Customers never see it.");
  return reason;
}

function blockKindOf(input: unknown): "BLOCK_EXACT" | "BLOCK_WORD" {
  if (input === "BLOCK_EXACT" || input === "BLOCK_WORD") return input;
  throw new ConsoleRefused("Choose whether to block this exact name, or every name with this word in it.");
}

const isUnique = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

/** One rule and its audit entry, together. */
async function makeRule(staff: Staff, rule: { value: string; kind: NameRuleKind; reason: string }, action: string, detail: Record<string, unknown>, already: string): Promise<string> {
  try {
    const id = await controlDb().$transaction(async (tx) => {
      const made = await tx.workspaceNameRule.create({ data: { ...rule, createdBy: staff.id }, select: { id: true } });
      await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action, detail: detail as Prisma.InputJsonValue }, select: { id: true } });
      return made.id;
    });
    forgetNameRules();
    revalidateConsole();
    return id;
  } catch (err) {
    if (isUnique(err)) throw new ConsoleRefused(already);
    throw err;
  }
}

/** Managers: block a name — exactly it, or every name with the word in it (hyphens ignored). Workspaces that have it keep it. */
export async function consoleBlockName(input: { value: string; kind: "BLOCK_EXACT" | "BLOCK_WORD"; reason: string }): Promise<ConsoleResult<{ id: string; workspaces: number }>> {
  return asStaff(MANAGERS, async (staff) => {
    const kind = blockKindOf(input?.kind);
    const value = valueOf(input?.value);
    const problem = blockProblem(value, kind);
    if (problem) throw new ConsoleRefused(problem);
    const reason = reasonOf(input?.reason);
    const impact = await nameRuleImpact({ kind, value });
    const already = kind === "BLOCK_EXACT" ? `${value} is blocked already.` : `The word "${value}" is blocked already.`;
    const id = await makeRule(staff, { value, kind, reason }, "names.block", { value, kind, reason, workspaces: impact.workspaceCount }, already);
    return { id, workspaces: impact.workspaceCount };
  });
}

/** Managers: let a built-in word through — a reserved word, our name or a competitor's. Never a platform address. */
export async function consoleReleaseName(input: { value: string; reason: string }): Promise<ConsoleResult<{ id: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const value = valueOf(input?.value);
    const problem = releaseProblem(value);
    if (problem) throw new ConsoleRefused(problem);
    const reason = reasonOf(input?.reason);
    const id = await makeRule(staff, { value, kind: "RELEASE", reason }, "names.release", { value, group: releasableGroupOf(value), reason }, `"${value}" is released already.`);
    return { id };
  });
}

/** Managers: take a rule away — a block (the name may be had again) or a release (the word is reserved again). */
export async function consoleRemoveNameRule(id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const ruleId = String(id ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ruleId)) throw new ConsoleRefused(RULE_GONE);
    const control = controlDb();
    const rule = await control.workspaceNameRule.findUnique({ where: { id: ruleId }, select: { id: true, value: true, kind: true } });
    if (!rule) throw new ConsoleRefused(RULE_GONE);
    const impact = rule.kind === "RELEASE" ? await nameRuleImpact(rule) : null;
    await control.$transaction(async (tx) => {
      const gone = await tx.workspaceNameRule.deleteMany({ where: { id: rule.id } });
      if (gone.count !== 1) throw new ConsoleRefused(RULE_GONE);
      const action = rule.kind === "RELEASE" ? "names.unrelease" : "names.unblock";
      const detail = rule.kind === "RELEASE" ? { value: rule.value, workspaces: impact?.workspaceCount ?? 0 } : { value: rule.value, kind: rule.kind };
      await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action, detail }, select: { id: true } });
    });
    forgetNameRules();
    revalidateConsole();
    return null;
  });
}

export type NameImpact = { problem: string | null; workspaces: string[]; workspaceCount: number };

/** Managers: what a rule not yet made would touch — the workspaces that have such a name now — and whether it can be made. */
export async function consoleNameImpact(input: { value: string; kind: NameRuleKind }): Promise<ConsoleResult<NameImpact>> {
  return asStaff(MANAGERS, async () => {
    const value = valueOf(input?.value);
    const kind: NameRuleKind = input?.kind === "RELEASE" ? "RELEASE" : blockKindOf(input?.kind);
    const problem = kind === "RELEASE" ? releaseProblem(value) : blockProblem(value, kind);
    if (problem) return { problem, workspaces: [], workspaceCount: 0 };
    return { problem: null, ...(await nameRuleImpact({ kind, value })) };
  });
}

export type NameTest = {
  slug: string;
  /** What the signup form would say, and which rule decided — with staff's reason when it was a staff rule. */
  signup: { ok: boolean; says: string; decidedBy: string; reason: string | null };
  /** A workspace staff set up (or an invitation holding it, without the reserved-word tick). */
  staff: { ok: boolean; says: string; decidedBy: string };
};

/**
 * Anybody: what signup would say about a name — with an optional registered business name — and
 * which rule decided, from the same verdicts signup and provisioning use. Changes nothing.
 */
export async function consoleTestName(input: { slug: string; legalName?: string }): Promise<ConsoleResult<NameTest>> {
  return asStaff(ALL_ROLES, async () => {
    const slug = cleanText(input?.slug, 64).toLowerCase();
    if (!slug) throw new ConsoleRefused("Type a name to test.");
    const legalName = cleanText(input?.legalName, 120);
    const [signup, general] = await Promise.all([judgeName(slug, null, (facts) => signupNameVerdict(slug, legalName, facts)), workspaceNameVerdict(slug)]);
    const says = (v: SignupNameVerdict) => (v.ok ? `${subdomainHost(slug)} is free` : v.message);
    return {
      slug,
      signup: { ok: signup.ok, says: says(signup), decidedBy: verdictInWords(signup), reason: await staffReason(signup) },
      staff: { ok: general.ok, says: says(general), decidedBy: verdictInWords(general) },
    };
  });
}

/** The reason staff gave for the rule that decided — a block that refused it, or the releases that let it through. */
async function staffReason(verdict: SignupNameVerdict): Promise<string | null> {
  const rules = controlDb().workspaceNameRule;
  if (!verdict.ok && (verdict.rule === "blocked-exact" || verdict.rule === "blocked-word") && verdict.word) {
    const kind = verdict.rule === "blocked-exact" ? "BLOCK_EXACT" : "BLOCK_WORD";
    return (await rules.findUnique({ where: { kind_value: { kind, value: verdict.word } }, select: { reason: true } }))?.reason ?? null;
  }
  if (verdict.ok && verdict.released.length) {
    const rows = await rules.findMany({ where: { kind: "RELEASE", value: { in: verdict.released } }, select: { value: true, reason: true } });
    return rows.map((r) => `${r.value}: ${r.reason}`).join(" · ") || null;
  }
  return null;
}

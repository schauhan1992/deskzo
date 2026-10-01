"use server";

import type { Prisma, StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { redactSecrets } from "@/lib/console-shared/redact";
import { ALL_ROLES, ENTER, MANAGERS, SELLERS, WRITERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { previewEntitlements, type EntitlementChange, type EntitlementPreview } from "@/lib/platform/entitlement-preview";
import { endManualPlan } from "@/lib/platform/plans";
import { ROLE_LIMITS, applyRoleLimits, roleLimits, workspaceDatabaseExists } from "@/lib/platform/provisioner";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { requestSupportAccess } from "@/lib/platform/support-request";
import { PIN_CAP, TIMELINE_KINDS, workspaceTimeline, type TimelineKind, type TimelinePage } from "@/lib/platform/workspace-data";

/**
 * Workspace 360's actions: staff notes and tags, asking the owner for support access, the billing
 * profile, the "exempt while paying" remedy, the entitlement preview, the database check and role
 * limits, and the activity feed's "load older".
 *
 * Every action checks the role first (`asStaff` → `requireStaff`), takes nothing from the browser
 * on trust (ids, text, lists and numbers are coerced and bounded here), records every change once
 * in the platform audit log — never a note's text — and refreshes the console. Reads (the preview,
 * the database check, the timeline) are not recorded. None of it lets support in: that is the
 * workspace owner's alone.
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

const GONE = "That workspace no longer exists.";
const NOTE_GONE = "That note no longer exists.";
const NOTE_MAX = 4000;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TAGS_MAX = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The database names and roles the provisioner makes — nothing else is ever touched from here. */
const WORKSPACE_ROLE = /^w_[0-9a-f]{12}$/;

/** An id from the browser: a string of the characters ids are made of, or the thing "no longer exists". */
function idOf(value: unknown, gone: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConsoleRefused(gone);
  return id;
}

const isManager = (staff: Staff) => MANAGERS.includes(staff.role);

/** A note's text: plain, 1–4,000 characters. Longer is refused rather than cut — the person wrote all of it. */
function noteBody(value: unknown): string {
  const body = cleanText(value, NOTE_MAX + 1);
  if (!body) throw new ConsoleRefused("Write the note first.");
  if (body.length > NOTE_MAX) throw new ConsoleRefused("A note is at most 4,000 characters.");
  return body;
}

/** Holds the workspace's row until the transaction ends — so two pins at once still stop at the cap. False when there is none. */
async function lockTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE`;
  return rows.length > 0;
}

async function pinnedElsewhere(tx: Prisma.TransactionClient, tenantId: string, noteId: string | null): Promise<number> {
  return tx.tenantNote.count({ where: { tenantId, pinned: true, deletedAt: null, ...(noteId ? { id: { not: noteId } } : {}) } });
}

const PIN_FULL = `At most ${PIN_CAP} notes are pinned — unpin one first.`;

// ─── Notes ───────────────────────────────────────────────────────────────────────────────────────

/** A staff note on a workspace — a closed one too. Plain text; the audit entry holds its id, never its text. */
export async function consoleAddNote(tenantId: string, body: string, pinned?: boolean): Promise<ConsoleResult<{ id: string }>> {
  return asStaff(WRITERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    const text = noteBody(body);
    const pin = pinned === true;
    const note = await controlDb().$transaction(async (tx) => {
      if (!(await lockTenant(tx, id))) throw new ConsoleRefused(GONE);
      if (pin && (await pinnedElsewhere(tx, id, null)) >= PIN_CAP) throw new ConsoleRefused(PIN_FULL);
      const made = await tx.tenantNote.create({ data: { tenantId: id, authorId: staff.id, body: text, pinned: pin }, select: { id: true } });
      await tx.platformAuditLog.create({
        data: { actorKind: "STAFF", actor: staff.id, action: "tenant.note.add", tenantId: id, detail: { noteId: made.id, pinned: pin } },
        select: { id: true },
      });
      return made;
    });
    revalidateConsole();
    return { id: note.id };
  });
}

/** Its author, or an owner or admin, rewrites a note. */
export async function consoleEditNote(noteId: string, body: string): Promise<ConsoleResult<null>> {
  return asStaff(WRITERS, async (staff) => {
    const id = idOf(noteId, NOTE_GONE);
    const text = noteBody(body);
    const control = controlDb();
    const note = await control.tenantNote.findUnique({ where: { id }, select: { tenantId: true, authorId: true, body: true, deletedAt: true } });
    if (!note || note.deletedAt) throw new ConsoleRefused(NOTE_GONE);
    if (note.authorId !== staff.id && !isManager(staff)) throw new ConsoleRefused("Only whoever wrote a note, or an owner or admin, can change it.");
    if (note.body === text) return null;
    await control.$transaction(async (tx) => {
      const edited = await tx.tenantNote.updateMany({ where: { id, deletedAt: null }, data: { body: text, editedBy: staff.id } });
      if (edited.count === 0) throw new ConsoleRefused(NOTE_GONE);
      await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "tenant.note.edit", tenantId: note.tenantId, detail: { noteId: id } }, select: { id: true } });
    });
    revalidateConsole();
    return null;
  });
}

/** Pinned notes show at the top of the workspace's page — at most five of them. */
export async function consolePinNote(noteId: string, pinned: boolean): Promise<ConsoleResult<null>> {
  return asStaff(WRITERS, async (staff) => {
    const id = idOf(noteId, NOTE_GONE);
    const pin = pinned === true;
    const control = controlDb();
    const found = await control.tenantNote.findUnique({ where: { id }, select: { tenantId: true } });
    if (!found) throw new ConsoleRefused(NOTE_GONE);
    const changed = await control.$transaction(async (tx) => {
      await lockTenant(tx, found.tenantId);
      const note = await tx.tenantNote.findUnique({ where: { id }, select: { pinned: true, deletedAt: true } });
      if (!note || note.deletedAt) throw new ConsoleRefused(NOTE_GONE);
      if (note.pinned === pin) return false;
      if (pin && (await pinnedElsewhere(tx, found.tenantId, id)) >= PIN_CAP) throw new ConsoleRefused(PIN_FULL);
      await tx.tenantNote.update({ where: { id }, data: { pinned: pin }, select: { id: true } });
      await tx.platformAuditLog.create({
        data: { actorKind: "STAFF", actor: staff.id, action: "tenant.note.pin", tenantId: found.tenantId, detail: { noteId: id, pinned: pin } },
        select: { id: true },
      });
      return true;
    });
    if (changed) revalidateConsole();
    return null;
  });
}

/** Removed from view, kept for the record (who and when). Its author, or an owner or admin. */
export async function consoleDeleteNote(noteId: string): Promise<ConsoleResult<null>> {
  return asStaff(WRITERS, async (staff) => {
    const id = idOf(noteId, NOTE_GONE);
    const control = controlDb();
    const note = await control.tenantNote.findUnique({ where: { id }, select: { tenantId: true, authorId: true, deletedAt: true } });
    if (!note || note.deletedAt) throw new ConsoleRefused(NOTE_GONE);
    if (note.authorId !== staff.id && !isManager(staff)) throw new ConsoleRefused("Only whoever wrote a note, or an owner or admin, can remove it.");
    await control.$transaction(async (tx) => {
      const removed = await tx.tenantNote.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: staff.id } });
      if (removed.count === 0) throw new ConsoleRefused(NOTE_GONE);
      await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "tenant.note.delete", tenantId: note.tenantId, detail: { noteId: id } }, select: { id: true } });
    });
    revalidateConsole();
    return null;
  });
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A workspace's tags, as a whole: lower-cased and trimmed, each a short word of letters, digits and
 * dashes, each once, at most ten. The first one that is not a tag is named in the refusal.
 */
export async function consoleSetTags(tenantId: string, tags: string[]): Promise<ConsoleResult<{ tags: string[] }>> {
  return asStaff(WRITERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    if (!Array.isArray(tags)) throw new ConsoleRefused("Give the tags as a list.");
    if (tags.length > 100) throw new ConsoleRefused(`A workspace has at most ${TAGS_MAX} tags.`);
    const wanted: string[] = [];
    for (const raw of tags) {
      const typed = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
      if (!typed) continue;
      const tag = typed.toLowerCase();
      if (!TAG.test(tag)) throw new ConsoleRefused(`“${cleanText(typed, 40)}” is not a tag: lower-case letters, digits and dashes, up to 24.`);
      if (!wanted.includes(tag)) wanted.push(tag);
    }
    if (wanted.length > TAGS_MAX) throw new ConsoleRefused(`A workspace has at most ${TAGS_MAX} tags — that is ${wanted.length}.`);

    const saved = await controlDb().$transaction(async (tx) => {
      if (!(await lockTenant(tx, id))) throw new ConsoleRefused(GONE);
      const current = await tx.tenant.findUnique({ where: { id }, select: { tags: true } });
      if (!current) throw new ConsoleRefused(GONE);
      const added = wanted.filter((t) => !current.tags.includes(t));
      const removed = current.tags.filter((t) => !wanted.includes(t));
      if (!added.length && !removed.length) return false;
      await tx.tenant.update({ where: { id }, data: { tags: wanted }, select: { id: true } });
      await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "tenant.tags", tenantId: id, detail: { added, removed } }, select: { id: true } });
      return true;
    });
    if (saved) revalidateConsole();
    return { tags: wanted };
  });
}

// ─── Support access ──────────────────────────────────────────────────────────────────────────────

/** Emails the owner asking them to let support in — at most once a day per workspace. It grants nothing. */
export async function consoleRequestSupportAccess(tenantId: string, reason: string): Promise<ConsoleResult<{ at: string }>> {
  return asStaff(ENTER, async (staff) => {
    const { at } = await requestSupportAccess(staff, idOf(tenantId, GONE), String(reason ?? ""));
    revalidateConsole();
    return { at: at.toISOString() };
  });
}

// ─── Billing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The billing email and tax ID, normalised as the workspace's own billing page does it. It changes
 * where reminders go and what new checkouts use — not the customer record already at a gateway.
 */
export async function consoleSetBillingDetails(tenantId: string, input: { billingEmail: string; taxId: string; reason: string }): Promise<ConsoleResult<null>> {
  return asStaff(SELLERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    const given = input && typeof input === "object" ? input : { billingEmail: "", taxId: "", reason: "" };
    // As the workspace's own billing page saves them (src/actions/billing.ts), control characters dropped first.
    const billingEmail = cleanText(given.billingEmail, 400).toLowerCase() || null;
    if (billingEmail && (billingEmail.length > 254 || !EMAIL.test(billingEmail))) throw new ConsoleRefused("That doesn't look like an email address.");
    const taxId = cleanText(given.taxId, 400).toUpperCase().slice(0, 40).trim() || null;
    const reason = cleanText(given.reason, 300);
    if (reason.length < 5) throw new ConsoleRefused("Say why — at least 5 characters. It is kept with the change.");

    const control = controlDb();
    const tenant = await control.tenant.findUnique({ where: { id }, select: { status: true, billingEmail: true, taxId: true } });
    if (!tenant) throw new ConsoleRefused(GONE);
    if (tenant.status === "DEPROVISIONED") throw new ConsoleRefused("This workspace is closed.");
    if (tenant.billingEmail === billingEmail && tenant.taxId === taxId) throw new ConsoleRefused("Nothing has changed.");
    await control.tenant.update({ where: { id }, data: { billingEmail, taxId }, select: { id: true } });
    await consoleAudit(staff, "tenant.billing-details", { from: { billingEmail: tenant.billingEmail, taxId: tenant.taxId }, to: { billingEmail, taxId }, reason }, id);
    revalidateConsole();
    return null;
  });
}

/**
 * The remedy for "exempt while paying": the plan given by hand ends, and the gateway's subscription
 * decides from here. Only for a workspace that pays at a gateway; the library checks, records and
 * applies the new standing.
 */
export async function consoleEndManualPlan(tenantId: string, subscriptionId: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    await endManualPlan(idOf(tenantId, GONE), idOf(subscriptionId, "That plan no longer exists."), `staff:${staff.id}`);
    revalidateConsole();
    return null;
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────────

/** A change's rebuilt shape: only what the preview reads, each value coerced. */
function changeOf(change: unknown): EntitlementChange {
  const c = change && typeof change === "object" ? (change as Record<string, unknown>) : {};
  if (Array.isArray(c.plans)) {
    if (c.plans.length > 50) throw new ConsoleRefused("That is more plans than a workspace can be on.");
    return {
      plans: c.plans.map((item) => {
        const i = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return { planKey: String(i.planKey ?? "").slice(0, 60), quantity: Number(i.quantity) };
      }),
    };
  }
  if (c.override && typeof c.override === "object") {
    const o = c.override as Record<string, unknown>;
    if (o.granted !== true && o.granted !== false && o.granted !== null && o.granted !== undefined) throw new ConsoleRefused("Add it, take it away, or go back to the plans.");
    return { override: { moduleKey: String(o.moduleKey ?? "").slice(0, 60), granted: o.granted === true ? true : o.granted === false ? false : null } };
  }
  if (c.limits && typeof c.limits === "object") {
    const l = c.limits as Record<string, unknown>;
    // As typed: empty is "the plans decide"; anything else is the save's to accept or refuse.
    const limit = (v: unknown): number | null => (v === null || v === undefined || (typeof v === "string" && !v.trim()) ? null : Number(v));
    // Custom domains left out: the preview keeps the override it has, as the save does.
    return { limits: { seats: limit(l.seats), copilotTokens: limit(l.copilotTokens), ...("customDomains" in l && l.customDomains !== undefined ? { customDomains: limit(l.customDomains) } : {}) } };
  }
  throw new ConsoleRefused("Say what to preview: its plans, a module, or its limits.");
}

/**
 * What a change to its plans, a module or its limits would do, before it is made — with the save's
 * own refusal when it would refuse. Plans and limits are for sellers; a module override for owners
 * and admins, as the saves are.
 */
export async function consolePreviewEntitlements(tenantId: string, change: EntitlementChange): Promise<ConsoleResult<EntitlementPreview>> {
  return asStaff(SELLERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    const asked = changeOf(change);
    if ("override" in asked && !isManager(staff)) throw new ConsoleRefused("Your role cannot do that.");
    const preview = await previewEntitlements(id, asked);
    if ("plans" in asked && staff.role !== "OWNER") {
      // As the save checks it, first: an internal plan is an owner's to give.
      const keys = asked.plans.map((i) => i.planKey);
      const internal = keys.length ? await controlDb().plan.count({ where: { key: { in: keys }, kind: "INTERNAL" } }) : 0;
      if (internal) return { ...preview, refusal: "Only an owner puts a workspace on an internal plan." };
    }
    return preview;
  });
}

const whole = (n: number, fallback: number) => (Number.isInteger(n) && n >= 0 ? n : fallback);

/** The limits the provisioner puts on a workspace role, as Postgres lists them — what a check compares against. */
function expectedLimits(): { settings: string[]; connections: number } {
  return {
    settings: [
      `statement_timeout=${whole(ROLE_LIMITS.statementTimeoutMs, 30_000)}`,
      `lock_timeout=${whole(ROLE_LIMITS.lockTimeoutMs, 10_000)}`,
      `idle_in_transaction_session_timeout=${whole(ROLE_LIMITS.idleInTransactionMs, 60_000)}`,
    ],
    connections: whole(ROLE_LIMITS.connections, 20),
  };
}

/** A failure on the database server, told in a line without the address or password it may quote. */
function serverRefusal(what: string, err: unknown): ConsoleRefused {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "no reason given";
  return new ConsoleRefused(`${what}: ${redactSecrets(cleanText(line, 300))}`);
}

/**
 * Whether its database exists on the server, and its role's limits against what they should be.
 * On a click only — never when a page loads. Asks the server; changes nothing.
 */
export async function consoleProbeWorkspaceDb(
  tenantId: string,
): Promise<ConsoleResult<{ exists: boolean; limits: { settings: string[]; connections: number } | null; expected: { settings: string[]; connections: number } }>> {
  return asStaff(MANAGERS, async () => {
    const id = idOf(tenantId, GONE);
    const tenant = await controlDb().tenant.findUnique({ where: { id }, select: { dbName: true, dbRole: true } });
    if (!tenant) throw new ConsoleRefused(GONE);
    if (!tenant.dbName || !tenant.dbRole) throw new ConsoleRefused("It has no database yet.");
    try {
      const exists = await workspaceDatabaseExists(tenant.dbName);
      const limits = await roleLimits(tenant.dbRole);
      return { exists, limits, expected: expectedLimits() };
    } catch (err) {
      throw serverRefusal("The database server could not be asked", err);
    }
  });
}

/** Its role's limits put back as the provisioner sets them — after they were changed by hand, or for a workspace made before them. */
export async function consoleReapplyRoleLimits(tenantId: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    const tenant = await controlDb().tenant.findUnique({ where: { id }, select: { status: true, dbRole: true } });
    if (!tenant) throw new ConsoleRefused(GONE);
    if (tenant.status === "DEPROVISIONED") throw new ConsoleRefused("This workspace is closed — its database is gone.");
    if (!tenant.dbRole) throw new ConsoleRefused("It has no database yet.");
    if (!WORKSPACE_ROLE.test(tenant.dbRole)) throw new ConsoleRefused("Its database role was not made by the platform, so its limits are set by hand.");
    try {
      await applyRoleLimits(tenant.dbRole);
    } catch (err) {
      throw serverRefusal("The limits could not be applied", err);
    }
    await consoleAudit(staff, "tenant.role-limits", { role: tenant.dbRole }, id);
    revalidateConsole();
    return null;
  });
}

/** The activity feed's next page: what happened before `beforeIso`, of the kinds asked for (every kind when none are). */
export async function consoleTimeline(tenantId: string, beforeIso: string | null, kinds: string[]): Promise<ConsoleResult<TimelinePage>> {
  return asStaff(ALL_ROLES, async () => {
    const id = idOf(tenantId, GONE);
    let before: Date | undefined;
    if (beforeIso !== null && beforeIso !== undefined && String(beforeIso).trim()) {
      const at = new Date(String(beforeIso).slice(0, 40));
      if (Number.isNaN(at.getTime())) throw new ConsoleRefused("That is not a point in time to page from.");
      before = at;
    }
    const list = Array.isArray(kinds) ? kinds.slice(0, 20) : [];
    const chosen: TimelineKind[] = TIMELINE_KINDS.filter((k) => list.includes(k));
    return workspaceTimeline(id, { before, kinds: chosen });
  });
}

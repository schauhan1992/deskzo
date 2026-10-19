/**
 * check:activity — Activity on a lead, a customer and a vendor, and everything a person did (owner, 19 Oct 2026).
 *
 *   · Each change is filed under the company and lead it belongs to as it's written (src/lib/activity/subjects.ts),
 *     and the migration files the entries written before it the same way — the two held in step here, kind by kind.
 *   · The company, contact and lead edits record what changed, from what to what; a contact's email and phone
 *     only that they changed.
 *   · Whoever can open the record sees its Activity, only the kinds they may see elsewhere: no invoice line to
 *     somebody who can't see documents.
 *   · A person's Activity is theirs, their managers', and whoever sees everyone's; settings and the like, and
 *     expense claims, only for themselves (or with the reach). Their sign-ins too.
 *   · Filters by kind, person and dates; an older page at a time.
 *   · A workspace not migrated yet still records every change, and its Activity still opens.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:activity
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const MIGRATION = "prisma/migrations/20261119110000_activity_subjects/migration.sql";

async function main() {
  section("Where it shows");
  const detail = read("src/components/companies/company-detail.tsx");
  ok("a customer's and a vendor's page has an Activity tab", detail.includes('{ key: "activity", label: "Activity" }') && detail.includes('source={{ kind: "company", id: company.id }}'));
  ok("a lead's Activity card is the feed, under the form that logs to it", read("src/components/leads/lead-detail.tsx").includes('source={{ kind: "lead", id: lead.id }}'));
  const work = read("src/app/(dashboard)/activity/work/page.tsx");
  ok("a person's Work activity page refuses with a 404", work.includes("if (!(await mayViewPersonActivity(user.id, personId))) notFound();"));
  ok("  offered in the menu, from a person's page and from Users", read("src/lib/navigation.ts").includes('href: "/activity/work"') && read("src/app/(dashboard)/people/[id]/page.tsx").includes("/activity/work?person=") && read("src/app/(dashboard)/settings/users/page.tsx").includes("/activity/work?person="));

  section("The migration files the past the same way");
  const { SUBJECT_KINDS } = load("../src/lib/activity/subjects") as typeof import("../src/lib/activity/subjects");
  const sql = read(MIGRATION);
  const updates = sql.split(/\r?\n/).filter((l) => l.startsWith("UPDATE "));
  const inSql = new Set([...updates.join("\n").matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!));
  const missing = SUBJECT_KINDS.filter((k) => !inSql.has(k));
  const extra = [...inSql].filter((k) => !SUBJECT_KINDS.includes(k));
  ok("every kind looked up at write time is backfilled, and nothing else", missing.length === 0 && extra.length === 0, { missing, extra });
  const timeline = read("src/lib/activity/timeline.ts");
  const groupBlock = timeline.slice(timeline.indexOf("const ENTITY_GROUP"), timeline.indexOf("};", timeline.indexOf("const ENTITY_GROUP")));
  const grouped = new Set([...groupBlock.matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]!));
  ok("  and every kind has its place in the feed", SUBJECT_KINDS.every((k) => grouped.has(k)), SUBJECT_KINDS.filter((k) => !grouped.has(k)));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_activity`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const companies = require("../src/actions/company") as typeof import("../src/actions/company");
    const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const feed = require("../src/actions/activity-feed") as typeof import("../src/actions/activity-feed");
    const timelineLib = require("../src/lib/activity/timeline") as typeof import("../src/lib/activity/timeline");
    const { recordAudit } = require("../src/lib/audit") as typeof import("../src/lib/audit");
    const { auditSubject } = require("../src/lib/activity/subjects") as typeof import("../src/lib/activity/subjects");
    /* eslint-enable @typescript-eslint/no-require-imports */

    type U = { id: string; name: string; email: string | null; role: string };
    const person = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-activity.in`, passwordHash: "!", role: role as never, ...extra }, select: { id: true, name: true, email: true, role: true } });
    const as = <T,>(who: U, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = before;
      });
    };
    const grant = (userId: string, permission: string, allowed: boolean) => db.userPermission.create({ data: { userId, permission, allowed, reason: "check:activity" } });

    const boss = await person("Zz Boss", "ADMIN", { isSuperAdmin: true });
    const manager = await person("Zz Manager", "SALES");
    const rep = await person("Zz Rep", "SALES", { managerId: manager.id });
    const stranger = await person("Zz Stranger", "SALES");
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    for (const key of ["leads.view", "contacts.view"]) await grant(rep.id, key, true);
    for (const key of ["documents.view", "payments.view"]) await grant(rep.id, key, false);
    for (const key of ["activity.viewAll", "expenses.viewAll"]) await grant(manager.id, key, false);
    for (const key of ["activity.viewAll"]) await grant(stranger.id, key, false);

    const company = await db.company.create({ data: { name: "Zz Activity Traders", normalizedName: "zz activity traders", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    const other = await db.company.create({ data: { name: "Zz Elsewhere Ltd", normalizedName: "zz elsewhere ltd", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: company.id, name: "Zz Priya", email: "priya@zz-activity.in", phone: "9810000001" }, select: { id: true } });
    const made = await leads.createLead({ companyId: company.id, title: "Zz Laptops for the office", ownerUserId: rep.id, estimatedValue: 50000 });
    if (!made.ok) throw new Error(`lead: ${made.error}`);
    const leadId = made.data.id;
    const task = await db.task.create({ data: { title: "Zz send the quote", companyId: company.id, leadId, createdByUserId: rep.id }, select: { id: true } });

    section("Filed under its company and lead as it's written");
    const created = await db.auditLog.findFirst({ where: { entityType: "Lead", entityId: leadId }, select: { companyId: true, leadId: true } });
    ok("a lead added: its company and itself", created?.companyId === company.id && created.leadId === leadId, created);
    await recordAudit({ userId: rep.id, action: "CREATE", entityType: "Task", entityId: task.id, entityLabel: "Zz send the quote" });
    const taskEntry = await db.auditLog.findFirst({ where: { entityType: "Task", entityId: task.id }, select: { companyId: true, leadId: true } });
    ok("a task on the lead: the company and the lead", taskEntry?.companyId === company.id && taskEntry.leadId === leadId, taskEntry);
    await recordAudit({ userId: boss.id, action: "DELETE", entityType: "Contact", entityId: "gone-already", entityLabel: "Zz Someone", subject: { companyId: company.id } });
    ok("  a record already gone: whoever wrote it says whose", (await db.auditLog.count({ where: { entityId: "gone-already", companyId: company.id } })) === 1);
    ok("  a kind with no company — a setting — nobody's", (await auditSubject("Role", rep.id)).companyId === null);
    ok("  an id that's nothing: nobody's, and no error", (await auditSubject("Lead", "no-such-lead")).companyId === null);

    section("Entries written before, filed by the migration");
    const past = [
      { entityType: "Company", entityId: company.id },
      { entityType: "Contact", entityId: contact.id },
      { entityType: "Lead", entityId: leadId },
      { entityType: "Task", entityId: task.id },
      { entityType: "Role", entityId: "zz-role" },
    ];
    const pastIds: string[] = [];
    for (const p of past) pastIds.push((await db.auditLog.create({ data: { userId: boss.id, action: "UPDATE", entityLabel: "Zz past", ...p, companyId: null, leadId: null }, select: { id: true } })).id);
    const only = ` AND a."id" IN (${pastIds.map((id) => `'${id}'`).join(", ")})`;
    for (const statement of updates) await db.$executeRawUnsafe(statement.replace(/;\s*$/, "") + only);
    const filed = await db.auditLog.findMany({ where: { id: { in: pastIds } }, select: { entityType: true, entityId: true, companyId: true, leadId: true } });
    const disagree = (
      await Promise.all(
        filed.map(async (f) => {
          const s = await auditSubject(f.entityType, f.entityId);
          return s.companyId === f.companyId && s.leadId === f.leadId ? null : { ...f, atWrite: s };
        }),
      )
    ).filter(Boolean);
    ok("the migration files each as writing it now would", filed.length === past.length && disagree.length === 0, disagree);
    ok("  a task's reaches its lead, a setting nobody", filed.find((f) => f.entityType === "Task")?.leadId === leadId && filed.find((f) => f.entityType === "Role")?.companyId === null);

    section("Before → after on the main edits");
    const companyEdit = await companies.updateCompany({ id: company.id, name: "Zz Activity Traders Pvt", relationshipType: "CLIENT", paymentTerms: "ADVANCE", source: "OTHER", website: "zz-activity.in" });
    const companyEntry = await db.auditLog.findFirst({ where: { entityType: "Company", entityId: company.id, action: "UPDATE" }, orderBy: { createdAt: "desc" }, select: { changes: true, companyId: true } });
    const companyChanges = (companyEntry?.changes ?? []) as { label: string; from: string | null; to: string | null }[];
    ok("the company edit is saved", companyEdit.ok, companyEdit.ok ? "" : companyEdit.error);
    ok("  its entry says the name and the website changed — nothing else", companyChanges.map((c) => c.label).sort().join() === "Name,Website", companyChanges);
    ok("  from what to what", companyChanges.some((c) => c.label === "Name" && c.from === "Zz Activity Traders" && c.to === "Zz Activity Traders Pvt"));
    ok("  filed under the company", companyEntry?.companyId === company.id);

    const contactEdit = await companies.updateContact({ id: contact.id, name: "Zz Priya Sharma", designation: "OTHER", email: "priya@zz-activity.in", phone: "9810000002" });
    const contactEntry = await db.auditLog.findFirst({ where: { entityType: "Contact", entityId: contact.id, action: "UPDATE" }, orderBy: { createdAt: "desc" }, select: { changes: true, companyId: true } });
    const contactChanges = (contactEntry?.changes ?? []) as { label: string; from: string | null; to: string | null; withheld?: boolean }[];
    ok("the contact edit is saved", contactEdit.ok, contactEdit.ok ? "" : contactEdit.error);
    ok("  its name from and to", contactChanges.some((c) => c.label === "Name" && c.from === "Zz Priya" && c.to === "Zz Priya Sharma"), contactChanges);
    const phone = contactChanges.find((c) => c.label === "Phone");
    ok("  its phone said to have changed, never to what", phone?.withheld === true && phone.from === null && phone.to === null && !JSON.stringify(contactChanges).includes("9810000002"), phone);
    ok("  the email untouched isn't listed", !contactChanges.some((c) => c.label === "Email"));
    ok("  filed under its company", contactEntry?.companyId === company.id);

    const leadEdit = await leads.updateLeadDetails({ leadId, title: "Zz Laptops and docks", estimatedValue: 65000, description: "", expectedCloseDate: "", contactId: "" });
    const leadEntry = await db.auditLog.findFirst({ where: { entityType: "Lead", entityId: leadId, action: "UPDATE" }, orderBy: { createdAt: "desc" }, select: { changes: true, leadId: true, companyId: true } });
    const leadChanges = (leadEntry?.changes ?? []) as { label: string; from: string | null; to: string | null }[];
    ok("the lead edit is saved", leadEdit.ok, leadEdit.ok ? "" : leadEdit.error);
    ok("  title and value, from and to — nothing else", leadChanges.map((c) => `${c.label}:${c.from}>${c.to}`).sort().join() === "Title:Zz Laptops for the office>Zz Laptops and docks,Value:₹50,000.00>₹65,000.00", leadChanges);
    ok("  filed under the lead and its company", leadEntry?.leadId === leadId && leadEntry.companyId === company.id);

    const logged = await as(rep, () => leads.logActivity({ leadId, type: "NOTE", notes: "Zz asked for a demo next week" }));
    ok("(the rep logs a note on the lead)", logged.ok, logged.ok ? "" : logged.error);
    await recordAudit({ userId: boss.id, action: "CREATE", entityType: "TradeDocument", entityId: "zz-invoice", entityLabel: "Invoice INV-0001 — Zz Activity Traders", subject: { companyId: company.id, leadId } });
    await recordAudit({ userId: rep.id, action: "CREATE", entityType: "Expense", entityId: "zz-expense", entityLabel: "Expense — client lunch ₹1,800", subject: { companyId: company.id } });
    await recordAudit({ userId: rep.id, action: "UPDATE", entityType: "Role", entityId: "zz-role", entityLabel: "Role Sales — permissions changed" });
    await recordAudit({ userId: boss.id, action: "UPDATE", entityType: "Company", entityId: other.id, entityLabel: "Zz Elsewhere Ltd" });
    await db.activityLog.create({ data: { kind: "LOGIN", summary: "Signed in", userId: rep.id, userName: rep.name, ipAddress: "203.0.113.9" } });

    section("A customer's Activity");
    const titles = (p: { items: { title: string }[] }) => p.items.map((i) => i.title);
    const all = await timelineLib.recordActivity(boss.id, { companyId: company.id });
    const t = titles(all);
    ok("the company's own change, its contact's, its lead's, the note and the invoice", t.includes("Zz Activity Traders Pvt") && t.some((x) => x.startsWith("Zz Priya Sharma")) && t.some((x) => x.startsWith("Zz Laptops and docks")) && t.some((x) => x.startsWith("Note — ")) && t.includes("Invoice INV-0001 — Zz Activity Traders"), t);
    ok("  never another company's", !t.includes("Zz Elsewhere Ltd"));
    ok("  newest first", all.items.every((i, n) => n === 0 || all.items[n - 1]!.at >= i.at));
    const note = all.items.find((i) => i.title.startsWith("Note — "));
    ok("  each line says who and when", note?.who?.id === rep.id && !!note.at && note.detail === "Zz asked for a demo next week", note);
    ok("  with what changed, on the edits", all.items.find((i) => i.title === "Zz Activity Traders Pvt")?.changes.length === 2);
    const leadFeed = await timelineLib.recordActivity(boss.id, { leadId });
    const lt = titles(leadFeed);
    ok("a lead's Activity: its edits, its task, the note and its invoice — not the company's own edit", lt.some((x) => x.startsWith("Zz Laptops and docks")) && lt.includes("Zz send the quote") && lt.some((x) => x.startsWith("Note — ")) && lt.includes("Invoice INV-0001 — Zz Activity Traders") && !lt.includes("Zz Activity Traders Pvt"), lt);

    section("Only the kinds a viewer may see");
    const repFeed = await timelineLib.recordActivity(rep.id, { companyId: company.id });
    ok("somebody who can't see documents sees no invoice line", !titles(repFeed).includes("Invoice INV-0001 — Zz Activity Traders"), titles(repFeed));
    ok("  the rest they see", titles(repFeed).includes("Zz Activity Traders Pvt") && titles(repFeed).some((x) => x.startsWith("Note — ")));
    ok("  and nobody else's expense claim", !titles(await timelineLib.recordActivity(manager.id, { companyId: company.id })).some((x) => x.startsWith("Expense")));
    const repGroups = await timelineLib.activityGroupsFor(rep.id, "record");
    ok("  their kind filter leaves documents and payments out", !repGroups.includes("documents") && !repGroups.includes("payments") && repGroups.includes("company"), repGroups);
    const asked = await as(rep, () => feed.companyActivity(company.id, { group: "documents" }));
    ok("  asking for documents by hand gets none", asked.ok && asked.data.items.length === 0, asked.ok ? titles(asked.data) : asked.error);
    const outsider = await as(stranger, () => feed.companyActivity(company.id));
    ok("somebody who can't open the company can't read its Activity", !outsider.ok);
    ok("  nor the lead's", !(await as(stranger, () => feed.leadActivity(leadId))).ok);

    section("Filters and older pages");
    const contactsOnly = await feed.companyActivity(company.id, { group: "contacts" });
    ok("by kind: contacts only", contactsOnly.ok && contactsOnly.data.items.length > 0 && contactsOnly.data.items.every((i) => i.group === "contacts"), contactsOnly.ok ? contactsOnly.data.items.map((i) => i.group) : contactsOnly.error);
    const repOnly = await feed.companyActivity(company.id, { personId: rep.id });
    ok("by person: only what the rep did", repOnly.ok && repOnly.data.items.length > 0 && repOnly.data.items.every((i) => i.who?.id === rep.id), repOnly.ok ? repOnly.data.items.map((i) => i.who?.name) : repOnly.error);
    const future = await feed.companyActivity(company.id, { from: "2099-01-01" });
    ok("by dates: nothing from a day still to come", future.ok && future.data.items.length === 0);
    const first = await timelineLib.recordActivity(boss.id, { companyId: company.id }, { take: 2 });
    const next = first.before ? await timelineLib.recordActivity(boss.id, { companyId: company.id }, { take: 50, before: new Date(first.before) }) : null;
    ok("a page at a time: two, then the older ones", first.items.length === 2 && first.more && !!next && next.items.length > 0 && next.items.every((i) => i.at < first.before!), { first: first.items.length, more: first.more, next: next?.items.length });

    section("Everything a person did");
    ok("anybody sees their own", await timelineLib.mayViewPersonActivity(rep.id, rep.id));
    ok("  their manager sees it", await timelineLib.mayViewPersonActivity(manager.id, rep.id));
    ok("  whoever sees everyone's sees it", await timelineLib.mayViewPersonActivity(boss.id, rep.id));
    ok("  a colleague doesn't", !(await timelineLib.mayViewPersonActivity(stranger.id, rep.id)));
    ok("  nor the rep their manager's", !(await timelineLib.mayViewPersonActivity(rep.id, manager.id)));
    ok("  and asking by hand is refused", !(await as(stranger, () => feed.peopleActivity(rep.id))).ok);
    const own = await timelineLib.personActivity(rep.id, rep.id);
    const ownTitles = titles(own);
    ok("the rep's own: the task they added, the note, their sign-in", ownTitles.includes("Zz send the quote") && ownTitles.some((x) => x.startsWith("Note — ")) && ownTitles.includes("Signed in"), ownTitles);
    ok("  their settings change and their expense claim too", ownTitles.includes("Role Sales — permissions changed") && ownTitles.some((x) => x.startsWith("Expense")));
    ok("  nothing somebody else did", own.items.every((i) => i.who?.id === rep.id));
    const managed = titles(await timelineLib.personActivity(manager.id, rep.id));
    ok("their manager sees their work and sign-in", managed.includes("Zz send the quote") && managed.includes("Signed in"), managed);
    ok("  not their settings change, nor their expense claim", !managed.includes("Role Sales — permissions changed") && !managed.some((x) => x.startsWith("Expense")));
    const personGroups = await timelineLib.activityGroupsFor(rep.id, "person", rep.id);
    const managerGroups = await timelineLib.activityGroupsFor(manager.id, "person", rep.id);
    ok("  their manager's kind filter offers neither", !managerGroups.includes("other") && !managerGroups.includes("expenses") && managerGroups.includes("signins"), managerGroups);
    ok("the person view filters by sign-ins too", personGroups.includes("signins") && personGroups.includes("other") && !(await timelineLib.activityGroupsFor(rep.id, "record")).includes("signins"));
    const people = await as(manager, () => feed.activityPeopleOptions());
    ok("a manager picks from themselves and their team", people.map((p) => p.id).sort().join() === [manager.id, rep.id].sort().join(), people.map((p) => p.name));

    section("Before a workspace is migrated");
    await db.$executeRawUnsafe('ALTER TABLE "audit_logs" DROP COLUMN "companyId", DROP COLUMN "leadId", DROP COLUMN "changes"');
    const before = await db.auditLog.count();
    await recordAudit({ userId: rep.id, action: "UPDATE", entityType: "Contact", entityId: contact.id, entityLabel: "Zz Priya Sharma", changes: [{ field: "name", label: "Name", from: "a", to: "b" }] });
    ok("a change is still recorded, without whose it is", (await db.auditLog.count()) === before + 1);
    const plain = await timelineLib.recordActivity(boss.id, { companyId: company.id });
    ok("  a company's Activity still opens — the note, without the changes it can't find", titles(plain).some((x) => x.startsWith("Note — ")), titles(plain));
    const plainPerson = await timelineLib.personActivity(rep.id, rep.id);
    ok("  a person's still lists their changes", titles(plainPerson).includes("Zz send the quote"), titles(plainPerson));
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} activity checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

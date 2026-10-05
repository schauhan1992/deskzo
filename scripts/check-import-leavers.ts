/**
 * Somebody who has left, read back from our own export (src/lib/portability/importers/lookups.ts
 * `optionalUserRef` / `requireUserRef` with `current`).
 *
 * A column naming who holds or did something — the account manager, a candidate's owner, a reporting
 * manager, a calling list's owner, who made a visit, who a ticket is assigned to — exports that person's
 * name whether or not they still work here. Read back through the active-only lookup, the row became an
 * error, so the file the app wrote couldn't be handed back to it. Now the person a record already has
 * reads back as no change; naming a leaver on any *other* record is still refused, because that is
 * giving them something.
 *
 * Against the real workspace with ZZLEAVER fixtures, removed in a finally; planning only — nothing is
 * imported.
 *
 *   npm run check:import-leavers
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { parseFile, plan } from "../src/lib/portability/import";
import { areaRows, toWorkbookBuffer } from "../src/lib/portability/export";

const TAG = "ZZLEAVER";
const MAIL = "@zzleaver-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

/** The exported rows `pick` chooses, planned back in: what each row would do. */
async function roundTrip(actorId: string, area: string, pick: (row: Record<string, string | number>) => boolean, edit?: (row: Record<string, string | number>) => void) {
  const rows = (await areaRows(actorId, area)).filter(pick).map((r) => ({ ...r }));
  if (edit) rows.forEach(edit);
  if (rows.length === 0) return { rows: 0, errors: ["the export holds no such row"], changes: 0 };
  const workbook = await toWorkbookBuffer([{ name: area, rows }], { title: area, by: "check", generatedAt: new Date() });
  const planned = await plan(area, await parseFile(workbook.toString("base64"), "x.xlsx"), actorId);
  return {
    rows: rows.length,
    errors: planned.rows.filter((r) => r.action === "error").map((r) => r.error ?? ""),
    changes: planned.creates + planned.updates,
  };
}

async function main() {
  const actor = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true } });
  if (!actor) throw new Error("No active super admin to import as.");
  await cleanup();
  try {
    section("The people");
    const leaver = await db.user.create({
      data: { name: `${TAG} Gone`, email: `gone${MAIL}`, role: "SALES", passwordHash: "zz-fixture-placeholder", active: false },
      select: { id: true, name: true },
    });
    const here = await db.user.create({
      data: { name: `${TAG} Here`, email: `here${MAIL}`, role: "SALES", passwordHash: "zz-fixture-placeholder" },
      select: { id: true, name: true },
    });
    ok("one who has left, one still here", true);
    const held = await db.company.create({
      data: { name: `${TAG} Held Traders`, normalizedName: `${TAG} held traders`.toLowerCase(), createdById: actor.id, ownerUserId: leaver.id },
      select: { id: true, name: true },
    });
    const other = await db.company.create({
      data: { name: `${TAG} Other Traders`, normalizedName: `${TAG} other traders`.toLowerCase(), createdById: actor.id, ownerUserId: here.id },
      select: { id: true, name: true },
    });
    const named = (r: Record<string, string | number>, ...values: string[]) => values.some((v) => Object.values(r).includes(v));
    const leaverCell = (column: string) => (r: Record<string, string | number>) => void (r[column] = leaver.name);

    const expectClean = async (label: string, area: string, pick: (r: Record<string, string | number>) => boolean) => {
      const back = await roundTrip(actor.id, area, pick);
      ok(label, back.rows > 0 && back.errors.length === 0 && back.changes === 0, back);
    };
    const expectRefused = async (label: string, area: string, pick: (r: Record<string, string | number>) => boolean, column: string) => {
      const back = await roundTrip(actor.id, area, pick, leaverCell(column));
      ok(label, back.rows > 0 && back.errors.some((e) => /No active user matches/.test(e)), back);
    };

    section("Companies — the account manager");
    await expectClean("a company managed by somebody who has left reads back", "companies", (r) => named(r, held.name));
    await expectRefused("  naming them on another company is refused", "companies", (r) => named(r, other.name), "Account manager");

    section("Hiring — a candidate's owner");
    await db.candidate.create({ data: { name: `${TAG} Candidate`, email: `cand${MAIL}`, ownerId: leaver.id } });
    await db.candidate.create({ data: { name: `${TAG} Candidate Two`, email: `cand2${MAIL}`, ownerId: here.id } });
    await expectClean("a candidate owned by somebody who has left reads back", "hiring", (r) => named(r, `cand${MAIL}`));
    await expectRefused("  naming them on another candidate is refused", "hiring", (r) => named(r, `cand2${MAIL}`), "Owner");

    section("Users — the reporting manager");
    await db.user.create({ data: { name: `${TAG} Reports To Gone`, email: `reports${MAIL}`, role: "SALES", passwordHash: "zz-fixture-placeholder", managerId: leaver.id } });
    await db.user.create({ data: { name: `${TAG} Reports To Here`, email: `reports2${MAIL}`, role: "SALES", passwordHash: "zz-fixture-placeholder", managerId: here.id } });
    await expectClean("somebody whose manager has left reads back", "users", (r) => named(r, `reports${MAIL}`));
    await expectRefused("  naming that manager for somebody else is refused", "users", (r) => named(r, `reports2${MAIL}`), "Manager");

    section("Workspace — a calling list's owner");
    await db.workbook.create({ data: { name: `${TAG} Gone's list`, filters: {}, ownerUserId: leaver.id } });
    await db.workbook.create({ data: { name: `${TAG} Here's list`, filters: {}, ownerUserId: here.id } });
    await expectClean("a list kept by somebody who has left reads back", "workspace", (r) => named(r, `${TAG} Gone's list`));
    await expectRefused("  naming them on another list is refused", "workspace", (r) => named(r, `${TAG} Here's list`), "Owner");

    section("Visits — who went");
    const day = new Date(Date.UTC(2026, 8, 15));
    await db.visit.create({ data: { companyId: held.id, userId: leaver.id, scheduledFor: day } });
    await db.visit.create({ data: { companyId: other.id, userId: here.id, scheduledFor: day } });
    await expectClean("a visit made by somebody who has left reads back", "visits", (r) => named(r, held.name));
    await expectRefused("  naming them on another visit is refused", "visits", (r) => named(r, other.name), "By");

    section("Tickets — who it is assigned to");
    await db.ticket.create({ data: { companyId: held.id, title: `${TAG} Printer jam`, createdByUserId: actor.id, assignedToUserId: leaver.id } });
    await db.ticket.create({ data: { companyId: other.id, title: `${TAG} Licence query`, createdByUserId: actor.id, assignedToUserId: here.id } });
    await expectClean("a ticket assigned to somebody who has left reads back", "tickets", (r) => named(r, `${TAG} Printer jam`));
    await expectRefused("  naming them on another ticket is refused", "tickets", (r) => named(r, `${TAG} Licence query`), "Assigned to");
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("the fixtures are gone", left === 0, left);
    await db.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} import leaver checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.ticket.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { title: { startsWith: TAG } }] } });
  await db.visit.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: ids } }] } });
  await db.workbook.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: ids } }] } });
  await db.candidate.deleteMany({ where: { email: { endsWith: MAIL } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

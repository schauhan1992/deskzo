/**
 * check:file-manager — People › File manager (owner, 21 Oct 2026).
 *
 *   · "Only admin and superadmin can allow this to employees": the file manager is `files.view`, held by no
 *     role; an admin or the super admin gives it to a person. Somebody else who may change permissions
 *     can't, here or from Users › Permissions.
 *   · An employee with it sees their own salary slips, salary certificates, offer and joining letters (the
 *     letter of intent among them), other letters and documents, in folders — never anybody else's, never
 *     a draft or withdrawn letter. Without it, the page isn't there for them.
 *   · "Admin can turn each doc on and off with the toggle": a file switched off is kept from its owner in
 *     the file manager and everywhere else they'd read it — My HR's payslips, the payslip and letter pages,
 *     their Letters and Documents cards — and HR and payroll still see it. A folder switches as a whole.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:file-manager
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

async function main() {
  section("The folders and the letter of intent");
  const folders = load("../src/lib/hr/file-folders") as typeof import("../src/lib/hr/file-folders");
  ok("five folders: salary slips, salary certificates, offer & joining, other letters, documents", JSON.stringify(folders.FOLDER_KEYS) === JSON.stringify(["payslips", "salary-certificates", "joining", "letters", "documents"]));
  ok("a salary certificate is filed under salary certificates", folders.folderOfLetter("SALARY_CERTIFICATE") === "salary-certificates");
  ok("LOI, offer, appointment, internship and contract under offer & joining", (["LETTER_OF_INTENT", "OFFER", "APPOINTMENT", "INTERNSHIP", "CONTRACT_AGREEMENT"] as const).every((t) => folders.folderOfLetter(t) === "joining"));
  ok("every other letter — HR's own templates too — under other letters", (["EXPERIENCE", "RELIEVING", "INCREMENT", "CUSTOM"] as const).every((t) => folders.folderOfLetter(t) === "letters"));
  const letters = load("../src/lib/hr/letters") as typeof import("../src/lib/hr/letters");
  const loi = letters.renderLetter("LETTER_OF_INTENT", { employeeName: "Zz Asha", designation: "Analyst", department: "Finance", employeeCode: null, companyName: "Acme Pvt Ltd", companyAddress: null, annualCtc: 600000, joinedOn: "2026-11-02", offerValidUntil: "2026-11-01" });
  ok("a letter of intent says what's intended, the pay and the day", loi.includes("intends to engage you as Analyst in our Finance team") && loi.includes("₹6,00,000") && loi.includes("2 November 2026"));
  ok("  and that it isn't an offer or a contract yet", loi.includes("not an offer or a contract of employment"));
  ok("  numbered LOI, labelled, in the Joining group, and offered to candidates", letters.letterNumberFor("LETTER_OF_INTENT", 2026, 3) === "WRF/LOI/2026/003" && letters.letterTypeLabels.LETTER_OF_INTENT.includes("LOI") && letters.letterGroups[0]!.types.includes("LETTER_OF_INTENT") && read("src/lib/hr/onboarding.ts").includes('"LETTER_OF_INTENT", "OFFER"'));
  ok("  and never held back for want of a joining date", letters.availableLetters({ joinedOn: null, confirmedOn: null, exitedOn: null }).find((o) => o.type === "LETTER_OF_INTENT")?.reason === undefined);

  section("Where it is");
  const { getPermissionDefinition } = load("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const def = getPermissionDefinition("files.view");
  ok("“Use the file manager” is held by no role, and only an admin or the super admin can give it", !!def && def.defaultRoles.length === 0 && def.adminOnly === true, def);
  ok("People has File manager in the menu, for whoever holds it", read("src/lib/modules.ts").includes('{ href: "/people/files", label: "File manager", icon: FolderOpen, permission: "files.view" }'));
  ok("the actions are the HR module's", read("src/lib/module-actions.ts").includes('"file-manager.ts": ["hr"]'));
  ok("the page is the file manager's holders' only", read("src/app/(dashboard)/people/files/page.tsx").includes("if (!viewer.canUse) notFound();"));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_files`;
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
    const files = require("../src/actions/file-manager") as typeof import("../src/actions/file-manager");
    const docs = require("../src/actions/employee-docs") as typeof import("../src/actions/employee-docs");
    const payroll = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
    const access = require("../src/actions/access") as typeof import("../src/actions/access");
    const { permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({
        data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-files.in`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const owner = await person("Zz Owner", "ADMIN", { isSuperAdmin: true });
    const boss = await person("Zz Admin", "ADMIN");
    const hr = await person("Zz Hr", "HR");
    const keeper = await person("Zz Keeper", "MANAGEMENT");
    const asha = await person("Zz Asha", "SALES");
    const ravi = await person("Zz Ravi", "SALES");
    const as = async <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      try {
        return await work();
      } finally {
        actor = before;
      }
    };
    const holds = async (who: { id: string }) => (await permissionsFor(who.id)).includes("files.view" as never);

    // Asha's file: two locked months' payslips, a letter of intent, a salary certificate, a document.
    for (const [month, net] of [[9, 41000], [10, 42000]] as const) {
      const run = await db.payrollRun.create({ data: { month, year: 2026, status: "LOCKED", lockedAt: new Date() } });
      await db.payslip.create({ data: { runId: run.id, userId: asha.id, monthDays: 30, paidDays: 30, basic: 20000, grossEarnings: 45000, totalDeductions: 3000, netPay: net, employerCost: 48000 } });
    }
    const draftRun = await db.payrollRun.create({ data: { month: 11, year: 2026, status: "DRAFT" } });
    await db.payslip.create({ data: { runId: draftRun.id, userId: asha.id, monthDays: 30, paidDays: 30, basic: 20000, grossEarnings: 45000, totalDeductions: 3000, netPay: 43000, employerCost: 48000 } });
    await db.employeeProfile.upsert({ where: { userId: asha.id }, create: { userId: asha.id, designation: "Analyst", joinedOn: new Date("2026-04-01") }, update: {} });
    const issue = async (type: "LETTER_OF_INTENT" | "SALARY_CERTIFICATE") => {
      const drafted = await as(hr, () => docs.draftLetter(asha.id, type));
      if (!drafted.ok) throw new Error(`could not draft ${type}: ${drafted.error}`);
      const issued = await as(hr, () => docs.issueLetter(drafted.data.id));
      if (!issued.ok) throw new Error(`could not issue ${type}: ${issued.error}`);
      return drafted.data.id;
    };
    const loiId = await issue("LETTER_OF_INTENT");
    const certId = await issue("SALARY_CERTIFICATE");
    const draftOnly = await as(hr, () => docs.draftLetter(asha.id, "APPRECIATION"));
    const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 zz").toString("base64")}`;
    const uploaded = await as(hr, () => docs.uploadEmployeeDocument({ userId: asha.id, type: "PAN_CARD", name: "Zz PAN card", fileDataUrl: pdf, mimeType: "application/pdf" }));
    if (!uploaded.ok) throw new Error(`could not upload: ${uploaded.error}`);
    const ravisSlipRun = await db.payrollRun.findFirst({ where: { month: 10, year: 2026 } });
    await db.payslip.create({ data: { runId: ravisSlipRun!.id, userId: ravi.id, monthDays: 30, paidDays: 30, basic: 20000, grossEarnings: 45000, totalDeductions: 3000, netPay: 39000, employerCost: 48000 } });

    section("Who may give it");
    ok("an employee doesn't have it to begin with", !(await holds(asha)) && (await as(asha, () => files.myFiles())) === null);
    ok("  and isn't shown Employees", !(await as(asha, () => files.fileManagerViewer())).isAdmin && (await as(asha, () => files.fileManagerPeople())) === null);
    ok("HR doesn't run it — not their files to switch", (await as(hr, () => files.employeeFiles(asha.id))) === null);
    const byHr = await as(hr, () => files.setFileManagerAccess(asha.id, true));
    ok("  nor give it", !byHr.ok, byHr.ok ? "GIVEN" : byHr.error);
    await db.userPermission.create({ data: { userId: keeper.id, permission: "permissions.manage", allowed: true } });
    await db.userPermission.create({ data: { userId: keeper.id, permission: "files.view", allowed: true } });
    const viaPermissions = await as(keeper, () => access.setUserPermission({ userId: ravi.id, permission: "files.view", allowed: true, reason: "zz" }));
    ok("somebody who may change permissions, and holds it, can't hand it on from Users › Permissions", !viaPermissions.ok && /admin/i.test(viaPermissions.ok ? "" : viaPermissions.error), viaPermissions.ok ? "GIVEN" : viaPermissions.error);
    ok("an admin has it, as everything", (await as(boss, () => files.fileManagerViewer())).isAdmin && (await holds(boss)));
    const given = await as(boss, () => files.setFileManagerAccess(asha.id, true));
    ok("an admin gives it to an employee", given.ok && (await holds(asha)), given.ok ? "" : given.error);
    const logged = await db.permissionChange.count({ where: { subjectUserId: asha.id, permission: "files.view" } });
    ok("  recorded in the permission log", logged === 1, logged);
    const bySuper = await as(owner, () => files.setFileManagerAccess(ravi.id, true));
    ok("the super admin gives it too", bySuper.ok && (await holds(ravi)));
    const viaPermissionsAsAdmin = await as(boss, () => access.setUserPermission({ userId: hr.id, permission: "files.view", allowed: true, reason: "zz" }));
    ok("  and an admin can from Users › Permissions as well", viaPermissionsAsAdmin.ok, viaPermissionsAsAdmin.ok ? "" : viaPermissionsAsAdmin.error);

    section("What the employee sees");
    const mine = (await as(asha, () => files.myFiles()))!;
    const inFolder = (list: typeof mine, folder: string) => list.filter((f) => f.folder === folder);
    ok("their two locked payslips, not the draft month", inFolder(mine, "payslips").length === 2, inFolder(mine, "payslips").map((f) => f.name));
    ok("the salary certificate under salary certificates", inFolder(mine, "salary-certificates").map((f) => f.id).join() === certId);
    ok("the letter of intent under offer & joining", inFolder(mine, "joining").map((f) => f.id).join() === loiId);
    ok("not the draft letter", !mine.some((f) => draftOnly.ok && f.id === draftOnly.data.id));
    ok("their PAN card under documents, and a letter's own copy not twice", inFolder(mine, "documents").length === 1 && inFolder(mine, "documents")[0]!.name === "Zz PAN card");
    ok("nothing of Ravi's", !mine.some((f) => f.name.includes("Ravi")) && inFolder(mine, "payslips").every((f) => !f.detail.includes("39,000")));
    ok("every one opens where it should", mine.every((f) => (f.kind === "PAYSLIP" ? f.href === `/payslips/${f.id}/print` : f.kind === "LETTER" ? f.href === `/letters/${f.id}/print` : f.href === `/api/hr/documents/${f.id}`)));

    section("Switching documents off and on");
    const theirs = (await as(boss, () => files.employeeFiles(asha.id)))!;
    ok("the admin sees all of Asha's, each switched on", theirs.files.length === 5 && theirs.files.every((f) => f.visible) && theirs.person.hasAccess);
    const octSlip = theirs.files.find((f) => f.kind === "PAYSLIP" && f.name.includes("October"))!;
    const off = await as(boss, () => files.setFileVisible("PAYSLIP", octSlip.id, false));
    ok("the admin switches October's payslip off", off.ok);
    ok("  gone from her file manager", !(await as(asha, () => files.myFiles()))!.some((f) => f.id === octSlip.id));
    ok("  from My HR's and Payroll's payslips", !(await as(asha, () => payroll.myPayslips())).some((s) => s.id === octSlip.id));
    ok("  and from the payslip page, for her", (await as(asha, () => payroll.getPayslip(octSlip.id))) === null);
    ok("  payroll still reads it", !!(await as(boss, () => payroll.getPayslip(octSlip.id))));
    ok("  and the admin still lists it, switched off", (await as(boss, () => files.employeeFiles(asha.id)))!.files.find((f) => f.id === octSlip.id)?.visible === false);
    const loiOff = await as(boss, () => files.setFileVisible("LETTER", loiId, false));
    ok("a letter switched off", loiOff.ok);
    ok("  is gone from her Letters card and the letter page", !(await as(asha, () => docs.listEmployeeLetters(asha.id))).some((l) => l.id === loiId) && (await as(asha, () => docs.getLetter(loiId))) === null);
    ok("  and its copy from her Documents card", !(await as(asha, () => docs.listEmployeeDocuments(asha.id))).some((d) => d.letterId === loiId));
    ok("  HR still sees it", (await as(hr, () => docs.listEmployeeLetters(asha.id))).some((l) => l.id === loiId) && !!(await as(hr, () => docs.getLetter(loiId))));
    const pan = theirs.files.find((f) => f.kind === "DOCUMENT")!;
    await as(boss, () => files.setFileVisible("DOCUMENT", pan.id, false));
    ok("a document switched off is HR's “The employee can see this”, unticked", (await db.employeeDocument.findUnique({ where: { id: pan.id }, select: { visibleToEmployee: true } }))?.visibleToEmployee === false);
    ok("  and she can't fetch it", (await as(asha, () => docs.getEmployeeDocument(pan.id))) === null);
    const byEmployee = await as(asha, () => files.setFileVisible("PAYSLIP", octSlip.id, true));
    ok("she can't switch her own back on", !byEmployee.ok);
    const byHrSwitch = await as(hr, () => files.setFileVisible("PAYSLIP", octSlip.id, true));
    ok("  nor can HR", !byHrSwitch.ok);
    const folderOn = await as(boss, () => files.setFolderVisible(asha.id, "payslips", true));
    ok("a whole folder switched back on", folderOn.ok && folderOn.data.changed === 1 && (await as(asha, () => payroll.myPayslips())).length === 2, folderOn.ok ? folderOn.data : folderOn.error);
    const folderOff = await as(boss, () => files.setFolderVisible(asha.id, "joining", false));
    ok("  and off", folderOff.ok && inFolder((await as(asha, () => files.myFiles()))!, "joining").length === 0);
    await as(boss, () => files.setFileVisible("LETTER", loiId, true));
    ok("switched on again, she sees it again", (await as(asha, () => docs.listEmployeeLetters(asha.id))).some((l) => l.id === loiId) && !!(await as(asha, () => docs.getLetter(loiId))));
    const revoked = await as(hr, () => docs.revokeLetter(certId));
    ok("a withdrawn letter leaves her file manager", revoked.ok && !(await as(asha, () => files.myFiles()))!.some((f) => f.id === certId));
    ok("  and the admin sees it marked withdrawn", (await as(boss, () => files.employeeFiles(asha.id)))!.files.find((f) => f.id === certId)?.withdrawn === true);

    section("Taking it away");
    const taken = await as(boss, () => files.setFileManagerAccess(asha.id, false));
    ok("the admin takes the file manager away", taken.ok && !(await holds(asha)) && (await as(asha, () => files.myFiles())) === null);
    ok("  leaving no grant behind", (await db.userPermission.count({ where: { userId: asha.id, permission: "files.view" } })) === 0);
    const selfOff = await as(boss, () => files.setFileManagerAccess(boss.id, false));
    ok("an admin can't take it from themselves", !selfOff.ok);
    const anotherAdmin = await person("Zz Second Admin", "ADMIN");
    const fromAdmin = await as(boss, () => files.setFileManagerAccess(anotherAdmin.id, false));
    ok("taking it from another admin writes a refusal on them, since their role gives it", fromAdmin.ok && !(await holds(anotherAdmin)) && (await db.userPermission.findUnique({ where: { user_permission: { userId: anotherAdmin.id, permission: "files.view" } } }))?.allowed === false);
    const everyone = await as(boss, () => files.setEveryoneFileManagerAccess(true));
    ok("“Give everyone”", everyone.ok && (await holds(asha)) && (await holds(keeper)) && (await holds(anotherAdmin)), everyone.ok ? everyone.data : everyone.error);
    const nobody = await as(boss, () => files.setEveryoneFileManagerAccess(false));
    ok("“Take from all” leaves the admins theirs", nobody.ok && !(await holds(asha)) && !(await holds(ravi)) && (await holds(boss)) && (await holds(anotherAdmin)), nobody.ok ? nobody.data : nobody.error);
    const superOff = await as(boss, () => files.setFileManagerAccess(owner.id, false));
    ok("the super admin's isn't a switch", !superOff.ok);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} file manager checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

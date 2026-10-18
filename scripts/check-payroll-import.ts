/**
 * Bringing pay across from another HRMS (roadmap 1.13; owner, 18 Oct 2026 — src/lib/portability/importers/payroll.ts,
 * src/actions/payroll-import.ts, the import in src/lib/portability/import.ts, the dialog on the payroll page).
 *
 *   · Only payroll (`payroll.manage`) may preview, import or download the template.
 *   · An export's own headings are read as Deskzo's ("Emp ID", "Basic Salary", "Bank A/c No"…) and the
 *     preview says so; two headings for one column refuse the file; columns nobody reads are listed.
 *   · Salary: the monthly gross and a start day are needed; what the components don't cover goes into
 *     Other allowance; components over the gross, or an Other that doesn't add up, refuse the row; a
 *     salary starting in a locked month is refused; the same day's structure is updated, not doubled.
 *   · Bank and statutory numbers are checked for shape, a number Excel shortened is refused, the preview
 *     shows only last fours, and only Aadhaar's last four digits are kept.
 *   · Pay so far this tax year lands on the tax declaration.
 *   · People are found by employee code or email, never created; a code and a User naming two people
 *     refuse the row.
 *   · The same file again changes nothing. Each person's change is audited, without the numbers.
 *   · The people import still takes none of these fields.
 *
 * Everything is named ZZPROBE_PI and removed in a finally. Salaries start in 2030, after any real locked
 * payroll, and the one locked run the suite makes is its own.
 *
 *   npm run check:payroll-import
 */
import "dotenv/config";
import Module from "node:module";
import Papa from "papaparse";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      usePathname: () => "/people/payroll",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Pi", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_PI";
const MAIL = "@zzprobe-pi.invalid";
const LOCKED = { month: 1, year: 2031 };
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const file = (rows: Record<string, string>[], name = "kredily-export.csv") => ({ filename: name, base64: Buffer.from(Papa.unparse(rows)).toString("base64") });

async function cleanup() {
  await db.payrollRun.deleteMany({ where: LOCKED });
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (!ids.length) return;
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  // Structures, declarations and profiles go with the people (onDelete: Cascade).
  await db.salaryStructure.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const importer = require("../src/actions/payroll-import") as typeof import("../src/actions/payroll-import");
  const { peopleImporter } = require("../src/lib/portability/importers/people") as typeof import("../src/lib/portability/importers/people");
  const { payrollImporter } = require("../src/lib/portability/importers/payroll") as typeof import("../src/lib/portability/importers/payroll");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { taxYearOf } = require("../src/lib/hr/income-tax") as typeof import("../src/lib/hr/income-tax");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    // Not admins: an admin holds every permission (src/lib/authz/resolve.ts), payroll's included.
    const make = async (key: string, code?: string) => {
      const u = await db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${key}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          ...(code ? { employeeProfile: { create: { employeeCode: code } } } : {}),
        },
      });
      roles.set(u.id, "PROFILE");
      return u;
    };
    const clerk = await make("clerk");
    await db.userPermission.create({ data: { userId: clerk.id, permission: "payroll.manage", allowed: true, reason: TAG } });
    // HR, who edits one person's bank details on their record — but may not bulk-set pay.
    const hrOnly = await make("hronly");
    await db.userPermission.create({ data: { userId: hrOnly.id, permission: "hr.manage", allowed: true, reason: TAG } });
    const asha = await make("asha", "ZZPI-001");
    const ravi = await make("ravi", "ZZPI-002");
    const meena = await make("meena");
    // Ravi already has a salary from the switch day: the file's is compared with it, not added beside it.
    await db.salaryStructure.create({
      data: { userId: ravi.id, effectiveFrom: d("2030-11-01"), basic: 20000, hra: 8000, specialAllowance: 12000, pfApplicable: false, esiApplicable: false, ptApplicable: true, createdById: clerk.id },
    });
    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());
    const taxYear = taxYearOf(today.getUTCFullYear(), today.getUTCMonth() + 1);

    // As another HRMS might export it: its own headings, a column Deskzo doesn't read, day-first dates.
    const row = (over: Record<string, string>) => ({
      "Emp ID": "",
      Email: "",
      "Effective Date": "01/11/2030",
      "Gross Salary": "",
      "Basic Salary": "",
      "House Rent Allowance": "",
      "Other allowance": "",
      "Bank A/c No": "",
      "IFSC Code": "",
      "PAN No": "",
      "Aadhar Number": "",
      "UAN No": "",
      "ESIC No": "",
      "Tax regime": "",
      "YTD Gross": "",
      "YTD TDS": "",
      Designation: "Engineer",
      ...over,
    });
    const rows = [
      row({ "Emp ID": "ZZPI-001", "Gross Salary": "50,000", "Basic Salary": "25000", "House Rent Allowance": "10000", "Bank A/c No": "1234 5678 9012", "IFSC Code": "hdfc0001234", "PAN No": "abcde1234f", "Aadhar Number": "2345 6789 0123", "UAN No": "100200300400", "Tax regime": "Old regime", "YTD Gross": "350000", "YTD TDS": "12000" }),
      row({ "Emp ID": "ZZPI-002", "Gross Salary": "42000", "Basic Salary": "20000", "House Rent Allowance": "10000", "Other allowance": "12000" }),
      row({ Email: `meena${MAIL}`, "Effective Date": "", "Bank A/c No": "000111222333", "IFSC Code": "SBIN0004321", "Aadhar Number": "XXXX XXXX 9876", "ESIC No": "3112345678" }),
      row({ "Emp ID": "ZZPI-001", "Gross Salary": "30000", "Basic Salary": "25000", "House Rent Allowance": "10000" }),
      row({ "Emp ID": "ZZPI-001", "Gross Salary": "50000", "Basic Salary": "25000", "House Rent Allowance": "10000", "Other allowance": "5000" }),
      row({ "Emp ID": "ZZPI-001", "Basic Salary": "25000" }),
      row({ "Emp ID": "ZZPI-001", "Effective Date": "", "Gross Salary": "50000", "Basic Salary": "25000" }),
      row({ "Emp ID": "ZZPI-999", "Bank A/c No": "123456789" }),
      row({ "Emp ID": "ZZPI-001", "Effective Date": "", "IFSC Code": "HDFC1234" }),
      row({ "Emp ID": "ZZPI-001", "Effective Date": "", "Bank A/c No": "1.23457E+15" }),
      row({ "Emp ID": "ZZPI-001", Email: `ravi${MAIL}`, "Effective Date": "", "PAN No": "ABCDE1234F" }),
      row({ "Emp ID": "ZZPI-002", "Effective Date": "", "YTD Gross": "100000", "YTD TDS": "150000" }),
    ];
    const main = file(rows);

    section("Who may");

    actorId = hrOnly.id;
    const refused = await importer.previewPayrollImport(main);
    ok("somebody without payroll rights can't preview", !refused.ok && refused.error.includes("Only payroll"));
    ok("  nor import, nor download the template", !(await importer.commitPayrollImport(main)).ok && !(await importer.payrollImportTemplate()).ok);
    actorId = clerk.id;
    const template = await importer.payrollImportTemplate();
    ok("payroll gets the template, in Deskzo's headings", template.ok && template.data.csv.startsWith('"User","Employee code","Salary from","Monthly gross","Basic","HRA"'));

    section("The preview");

    const preview = await importer.previewPayrollImport(main);
    if (!preview.ok) throw new Error(preview.error);
    const plan = preview.data;
    const at = (line: number) => plan.rows.find((r) => r.line === line)!;
    const fields = (line: number) => Object.fromEntries(at(line).changes.map((c) => [c.field, `${c.from} → ${c.to}`]));
    ok("the export's headings are read as Deskzo's, and said", ["Emp ID", "Basic Salary", "House Rent Allowance", "Bank A/c No", "IFSC Code", "Aadhar Number", "YTD TDS"].every((h) => plan.readAs.some((r) => r.from === h)), JSON.stringify(plan.readAs));
    ok("  a column nobody reads is listed", plan.unknownColumns.includes("Designation"), plan.unknownColumns.join());
    ok("a new salary is a new record", at(2).action === "create" && at(2).label === `${TAG} asha (ZZPI-001)`, JSON.stringify(at(2)));
    ok("  what the components don't cover goes into Other allowance, said so", fields(2)["Other allowance (the rest of the gross)"] === "(new) → ₹15,000", JSON.stringify(fields(2)));
    ok("  PF, ESI and PT apply unless the file says otherwise", fields(2)["PF applies"] === "(new) → yes" && fields(2)["ESI applies"] === "(new) → yes");
    ok("  the account number and IDs show only their last four", fields(2)["Account number"] === "(empty) → ••••9012" && fields(2).PAN === "(empty) → ••••234F" && fields(2).UAN === "(empty) → ••••0400");
    ok("  the IFSC as typed, upper-cased", fields(2).IFSC === "(empty) → HDFC0001234");
    ok("  this tax year's pay so far and the regime", fields(2)[`Gross paid this year (${taxYear}-${String((taxYear + 1) % 100).padStart(2, "0")})`]?.endsWith("₹3,50,000") === true && Object.keys(fields(2)).some((f) => f.startsWith("Tax regime")), JSON.stringify(fields(2)));
    ok("  and a whole Aadhaar is cut to its last four, with a word", plan.notices.some((n) => n.text.includes("last four digits of Aadhaar") && n.lines.includes(2)) && fields(2).Aadhaar === "(empty) → ••••0123");
    ok("the same day's salary is compared, not doubled: only what differs", at(3).action === "update" && fields(3).HRA === "₹8,000 → ₹10,000" && !("Basic" in fields(3)) && !("PF applies" in fields(3)), JSON.stringify(fields(3)));
    ok("bank details alone, by email, for somebody with no employee record yet", at(4).action === "update" && fields(4)["Account number"] === "(empty) → ••••2333" && fields(4).Aadhaar === "(empty) → ••••9876" && at(4).notice === undefined);
    ok("components over the gross refuse the row", at(5).action === "error" && at(5).error!.includes("more than the monthly gross"), at(5).error);
    ok("an Other allowance that doesn't add up refuses it", at(6).action === "error" && at(6).error!.includes("not the monthly gross"), at(6).error);
    ok("no gross refuses it", at(7).action === "error" && at(7).error!.includes("Monthly gross"), at(7).error);
    ok("no start day refuses it", at(8).action === "error" && at(8).error!.includes("Salary from"), at(8).error);
    ok("an employee code nobody has: import People first", at(9).action === "error" && at(9).error!.includes("Import People first"), at(9).error);
    ok("an IFSC of the wrong shape is refused", at(10).action === "error" && at(10).error!.includes("IFSC"), at(10).error);
    ok("an account number Excel shortened is refused, saying how to fix it", at(11).action === "error" && at(11).error!.includes("format that column as text"), at(11).error);
    ok("a code and a User naming two people refuse the row", at(12).action === "error" && at(12).error!.includes("but the User column names"), at(12).error);
    ok("TDS so far over the gross so far is refused", at(13).action === "error" && at(13).error!.includes("more than the Gross paid this year"), at(13).error);
    ok("the counts", plan.creates === 1 && plan.updates === 2 && plan.errors === 9, `${plan.creates}/${plan.updates}/${plan.errors}`);

    const twice = await importer.previewPayrollImport(file([{ "Emp ID": "ZZPI-001", Basic: "1", "Basic Salary": "2" }]));
    ok("two headings for one column refuse the file", !twice.ok && twice.error.includes("would both be read as Basic"), twice.ok ? "" : twice.error);

    section("Importing");

    const done = await importer.commitPayrollImport(main);
    ok("the good rows go in, the rest are named", done.ok && done.data.created === 1 && done.data.updated === 2 && done.data.failed.length === 9, JSON.stringify(done));
    const ashaPay = await db.salaryStructure.findFirst({ where: { userId: asha.id, effectiveFrom: d("2030-11-01") } });
    ok("Asha's salary: the gross in six parts, from the day given, marked as brought across", Number(ashaPay?.basic) === 25000 && Number(ashaPay?.hra) === 10000 && Number(ashaPay?.otherAllowance) === 15000 && ashaPay?.pfApplicable === true && ashaPay.note === "Brought from the old system" && ashaPay.createdById === clerk.id);
    const ashaProfile = await db.employeeProfile.findUnique({ where: { userId: asha.id } });
    ok("  her bank and statutory numbers, cleaned", ashaProfile?.bankAccountNumber === "123456789012" && ashaProfile.bankIfsc === "HDFC0001234" && ashaProfile.panNumber === "ABCDE1234F" && ashaProfile.uanNumber === "100200300400");
    ok("  and only Aadhaar's last four", ashaProfile?.aadhaarLast4 === "0123");
    const declaration = await db.taxDeclaration.findUnique({ where: { userId_taxYear: { userId: asha.id, taxYear } } });
    ok("  and her pay so far on this tax year's declaration", Number(declaration?.previousGross) === 350000 && Number(declaration?.previousTds) === 12000 && declaration?.regime === "OLD" && Number(declaration.previousPt) === 0);
    const raviPays = await db.salaryStructure.findMany({ where: { userId: ravi.id } });
    ok("Ravi's salary is the same one, corrected, its PF setting kept", raviPays.length === 1 && Number(raviPays[0].hra) === 10000 && raviPays[0].pfApplicable === false);
    const meenaProfile = await db.employeeProfile.findUnique({ where: { userId: meena.id } });
    ok("Meena gets an employee record holding just her bank details", meenaProfile?.bankAccountNumber === "000111222333" && meenaProfile.aadhaarLast4 === "9876" && meenaProfile.esicNumber === "3112345678" && meenaProfile.employeeCode === null);

    const again = await importer.previewPayrollImport(main);
    ok("the same file again changes nothing", again.ok && again.data.creates === 0 && again.data.updates === 0 && again.data.skips === 3, again.ok ? `${again.data.creates}/${again.data.updates}/${again.data.skips}` : again.error);

    const audits = await db.auditLog.findMany({ where: { userId: clerk.id }, select: { entityType: true, entityLabel: true } });
    const labels = audits.map((a) => a.entityLabel ?? "");
    ok("each person's change is audited", labels.includes(`Salary set for ${TAG} asha from 2030-11-01 (imported)`) && labels.some((l) => l.startsWith(`${TAG} meena's account number`)) && labels.some((l) => l.startsWith(`Pay before Deskzo for ${TAG} asha`)), labels.join(" | "));
    ok("  without the numbers", labels.every((l) => !/\d{6,}/.test(l.replace(/2030-11-01/g, ""))) && labels.every((l) => !l.includes("ABCDE")));
    ok("  and the import itself, once", audits.filter((a) => a.entityType === "Import").length === 1);

    section("Locked payroll");

    await db.payrollRun.create({ data: { ...LOCKED, status: "LOCKED" } });
    const locked = await importer.previewPayrollImport(file([{ "Employee code": "ZZPI-001", "Salary from": "2030-12-01", "Monthly gross": "60000", Basic: "30000" }]));
    ok("a salary starting on or before a locked month is refused", locked.ok && locked.data.rows[0].action === "error" && locked.data.rows[0].error!.includes("already locked"), locked.ok ? locked.data.rows[0].error : locked.error);
    const after = await importer.previewPayrollImport(file([{ "Employee code": "ZZPI-001", "Salary from": "2031-02-01", "Monthly gross": "60000", Basic: "30000" }]));
    ok("  one starting after it isn't", after.ok && after.data.rows[0].action === "create");
    await db.payrollRun.deleteMany({ where: LOCKED });

    section("The people import, and the screen");

    ok("the people import still takes none of these fields", ["Basic", "Monthly gross", "Account number", "PAN", "UAN", "Aadhaar"].every((c) => !peopleImporter.templateColumns.includes(c)));
    ok("the payroll import's template is Deskzo's names", payrollImporter.templateColumns.includes("Gross paid this year") && payrollImporter.templateColumns.length === 26);
    const { PayrollImport } = await import("../src/components/hr/payroll-import");
    const button = renderToStaticMarkup(createElement(PayrollImport));
    ok("the payroll page's button", button.includes("Import from another system"));
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll payroll import checks passed." : `\n${failures} payroll import check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

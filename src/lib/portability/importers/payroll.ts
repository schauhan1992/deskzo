import { Prisma, type TaxRegime } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { monthLabel } from "@/lib/hr/calendar";
import { lockedRunFrom } from "@/lib/hr/salary-locks";
import { TAX_YEARS, taxYearOf } from "@/lib/hr/income-tax";
import { workspaceClock } from "@/lib/time/workspace";
import { resolveUser, type EmployeeUser } from "./people";
import { keyOf, RowReader, trim, type FieldChange, type Importer, type PlannedRow, type Resolved } from "./types";

/**
 * Bringing pay across from another HRMS (roadmap 1.13; owner, 18 Oct 2026): each person's salary
 * structure, bank details, statutory numbers, and this tax year's pay so far — one row a person.
 *
 * The people import refuses every one of these fields on purpose (./people.ts). This one exists beside
 * it, run only by payroll (`payroll.manage`, src/actions/payroll-import.ts), and is not an export area:
 * nothing exports pay, so there is nothing to round-trip.
 *
 *   · **Columns** are Deskzo's template, or the usual Indian payroll headings (`headerAliases`), so an
 *     export from Kredily, Keka or greytHR loads once its extra columns are deleted.
 *   · **Salary** needs the monthly gross. Deskzo has six components; whatever the ones named don't cover
 *     (LTA, bonus…) goes into Other allowance, and the preview says so. Components adding up to more
 *     than the gross refuse the row, so nobody is paid more or less than they were.
 *   · **A salary starting in a locked month is refused**, as on the salary form (src/lib/hr/salary-locks.ts).
 *     The same file again changes nothing: a structure on the same day is compared, not duplicated.
 *   · **Bank and statutory numbers** are checked for shape. The preview shows only their last four, and
 *     only Aadhaar's last four digits are ever kept (EmployeeProfile.aadhaarLast4).
 *   · **Pay so far this tax year** lands on the person's tax declaration as pay outside Deskzo
 *     (TaxDeclaration.previous*), which TDS for the rest of the year is worked out from (src/lib/hr/tds.ts).
 *
 * Blank leaves a value alone, as in every import — except inside a salary, which is the whole of that
 * day's pay: a component left blank is none of it, or the gross wouldn't add up. Each person's change is
 * audited without the numbers.
 */

const COLUMNS = {
  user: "User",
  code: "Employee code",
  from: "Salary from",
  gross: "Monthly gross",
  basic: "Basic",
  hra: "HRA",
  conveyance: "Conveyance",
  medical: "Medical",
  special: "Special allowance",
  other: "Other allowance",
  pf: "PF applies",
  esi: "ESI applies",
  pt: "PT applies",
  bankName: "Bank name",
  account: "Account number",
  ifsc: "IFSC",
  pan: "PAN",
  aadhaar: "Aadhaar",
  uan: "UAN",
  pfNumber: "PF number",
  esic: "ESIC number",
  regime: "Tax regime",
  ytdGross: "Gross paid this year",
  ytdTds: "TDS this year",
  ytdPt: "PT this year",
  ytdPf: "PF this year",
} as const;

/**
 * The usual headings for each column in Indian payroll exports. Matched ignoring case, spaces and
 * punctuation (src/lib/portability/import.ts). Not taken from any one vendor's documentation — tightened
 * as real exports from clients come in.
 */
const ALIASES: Record<string, string[]> = {
  [COLUMNS.user]: ["Email", "Email ID", "Email address", "Work email", "Official email", "Official email ID", "Company email"],
  [COLUMNS.code]: ["Employee ID", "Employee No", "Employee number", "Emp code", "Emp ID", "Emp No", "Employee code no"],
  [COLUMNS.from]: ["Effective from", "Effective date", "Salary effective from", "Salary effective date", "Revision date", "Applicable from"],
  [COLUMNS.gross]: ["Gross", "Gross salary", "Gross pay", "Monthly gross salary", "Gross monthly salary", "Gross earnings", "Total earnings", "Monthly salary"],
  [COLUMNS.basic]: ["Basic salary", "Basic pay"],
  [COLUMNS.hra]: ["House rent allowance"],
  [COLUMNS.conveyance]: ["Conveyance allowance", "Transport allowance"],
  [COLUMNS.medical]: ["Medical allowance"],
  [COLUMNS.special]: ["Special", "Special allow"],
  [COLUMNS.other]: ["Other allowances", "Others", "Other"],
  [COLUMNS.pf]: ["PF applicable", "PF eligible", "EPF applicable"],
  [COLUMNS.esi]: ["ESI applicable", "ESI eligible", "ESIC applicable"],
  [COLUMNS.pt]: ["PT applicable", "Professional tax applicable"],
  [COLUMNS.bankName]: ["Bank"],
  [COLUMNS.account]: ["Bank account number", "Bank account no", "Account no", "Bank A/c no", "A/c no", "A/c number", "Salary account number"],
  [COLUMNS.ifsc]: ["IFSC code", "Bank IFSC", "Bank IFSC code"],
  [COLUMNS.pan]: ["PAN number", "PAN no", "PAN card number"],
  [COLUMNS.aadhaar]: ["Aadhaar number", "Aadhaar no", "Aadhar", "Aadhar number", "Aadhar no", "UID"],
  [COLUMNS.uan]: ["UAN number", "UAN no", "PF UAN"],
  [COLUMNS.pfNumber]: ["PF no", "PF account number", "PF account no", "EPF number", "EPF no"],
  [COLUMNS.esic]: ["ESI number", "ESI no", "ESIC no", "ESIC IP number", "IP number"],
  [COLUMNS.regime]: ["Regime", "Income tax regime"],
  [COLUMNS.ytdGross]: ["YTD gross", "Gross YTD", "YTD gross salary", "Gross salary YTD"],
  [COLUMNS.ytdTds]: ["YTD TDS", "TDS YTD", "YTD income tax", "Income tax YTD"],
  [COLUMNS.ytdPt]: ["YTD PT", "PT YTD", "YTD professional tax", "Professional tax YTD"],
  [COLUMNS.ytdPf]: ["YTD PF", "PF YTD", "YTD EPF", "Employee PF YTD"],
};

const COMPONENTS = [
  ["basic", COLUMNS.basic],
  ["hra", COLUMNS.hra],
  ["conveyance", COLUMNS.conveyance],
  ["medical", COLUMNS.medical],
  ["specialAllowance", COLUMNS.special],
  ["otherAllowance", COLUMNS.other],
] as const;
type ComponentKey = (typeof COMPONENTS)[number][0];
type Components = Record<ComponentKey, number>;
const FLAGS = [
  ["pfApplicable", COLUMNS.pf],
  ["esiApplicable", COLUMNS.esi],
  ["ptApplicable", COLUMNS.pt],
] as const;
type FlagKey = (typeof FLAGS)[number][0];

const ID_FIELDS = [
  ["bankName", COLUMNS.bankName, false],
  ["bankAccountNumber", COLUMNS.account, true],
  ["bankIfsc", COLUMNS.ifsc, false],
  ["panNumber", COLUMNS.pan, true],
  ["aadhaarLast4", COLUMNS.aadhaar, true],
  ["uanNumber", COLUMNS.uan, true],
  ["pfNumber", COLUMNS.pfNumber, true],
  ["esicNumber", COLUMNS.esic, true],
] as const;
type IdKey = (typeof ID_FIELDS)[number][0];

const YTD = [
  ["previousGross", COLUMNS.ytdGross],
  ["previousTds", COLUMNS.ytdTds],
  ["previousPt", COLUMNS.ytdPt],
  ["previousPf", COLUMNS.ytdPf],
] as const;
type YtdKey = (typeof YTD)[number][0];

type Row = {
  person: EmployeeUser;
  label: string;
  salary: null | { effectiveFrom: Date; gross: number; parts: Components; restIntoOther: boolean; flags: Partial<Record<FlagKey, boolean>> };
  ids: Partial<Record<IdKey, string>>;
  aadhaarCut: boolean;
  tax: null | { taxYear: number; regime?: TaxRegime; amounts: Partial<Record<YtdKey, number>> };
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/** What the preview shows of a number nobody should read over a shoulder: its last four. */
const masked = (v: string | null | undefined) => (v ? `••••${v.slice(-4)}` : "");
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const yearLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
/** How Excel writes a long number it has shortened: 1.23457E+15. The digits after the sixth are gone. */
const SHORTENED = /^\d+(\.\d+)?e\+?\d+$/i;

function money(r: RowReader, column: string): number | undefined {
  const v = r.number(column);
  if (v === undefined) return undefined;
  if (v < 0) r.fail(`${column} can't be negative.`);
  if (v > 1e10) r.fail(`${column} is more than any salary.`);
  return round2(v);
}

/** A statutory or bank number, checked for its shape; undefined when the cell is blank. */
function idNumber(r: RowReader, column: string, shape: RegExp, words: string, normalise: (v: string) => string = (v) => v.replace(/[\s-]/g, "").toUpperCase()): string | undefined {
  const raw = r.text(column);
  if (!raw) return undefined;
  if (SHORTENED.test(raw)) {
    r.fail(`${column} "${raw}" looks shortened by Excel — format that column as text, then export the file again.`);
    return undefined;
  }
  const value = normalise(raw);
  if (!shape.test(value)) r.fail(`${column} "${raw}" isn't right: ${words}.`);
  return value;
}

async function resolve(row: Record<string, string>): Promise<Resolved<Row>> {
  const r = new RowReader(row);

  // ── Who ──
  const code = r.text(COLUMNS.code);
  const named = r.text(COLUMNS.user);
  if (!code && !named) return { error: "Name the person: their Employee code, or User (their email address or USR- key)." };
  let person: EmployeeUser | null = null;
  if (code) {
    const profile = await db.employeeProfile.findUnique({ where: { employeeCode: code }, select: { user: { select: { id: true, name: true, userSeq: true } } } });
    if (!profile) return { error: `No one in Deskzo has employee code "${code}". Import People first, or name them in the User column.` };
    person = profile.user;
  }
  if (named) {
    const found = await resolveUser(COLUMNS.user, named);
    if ("error" in found) return { error: found.error };
    if (person && person.id !== found.value.id) return { error: `Employee code "${code}" is ${person.name}'s, but the User column names ${found.value.name}.` };
    person = found.value;
  }
  const who = person!;

  // ── Salary ──
  const amounts = Object.fromEntries(COMPONENTS.map(([key, column]) => [key, money(r, column)]).filter(([, v]) => v !== undefined)) as Partial<Components>;
  const gross = money(r, COLUMNS.gross);
  const effectiveFrom = r.date(COLUMNS.from);
  const flags = Object.fromEntries(FLAGS.map(([key, column]) => [key, r.boolean(column)]).filter(([, v]) => v !== undefined)) as Partial<Record<FlagKey, boolean>>;
  const anySalary = gross !== undefined || Object.values(amounts).some((v) => v !== undefined);
  let salary: Row["salary"] = null;
  if (!r.error && anySalary) {
    if (!effectiveFrom) return { error: `Give the day this salary starts (${COLUMNS.from}).` };
    if (gross === undefined) return { error: `Give the ${COLUMNS.gross} too — it's how Deskzo checks no part of the salary was missed.` };
    if (amounts.basic === undefined) return { error: `${COLUMNS.basic} is needed for a salary — PF is worked out on it.` };
    const namedSum = round2(COMPONENTS.reduce((sum, [key]) => sum + (amounts[key] ?? 0), 0));
    let restIntoOther = false;
    if (amounts.otherAllowance !== undefined) {
      if (namedSum !== gross) return { error: `The components add up to ${rupees(namedSum)}, not the monthly gross of ${rupees(gross)}.` };
    } else {
      if (namedSum > gross) return { error: `The components add up to ${rupees(namedSum)} — more than the monthly gross of ${rupees(gross)}.` };
      amounts.otherAllowance = round2(gross - namedSum);
      restIntoOther = amounts.otherAllowance > 0;
    }
    const locked = await lockedRunFrom(effectiveFrom);
    if (locked) {
      return { error: `Payroll for ${monthLabel(locked.month, locked.year)} is already locked — a salary starting ${dayKey(effectiveFrom)} would contradict payslips issued. Use a later ${COLUMNS.from}.` };
    }
    salary = { effectiveFrom, gross, parts: { basic: 0, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0, ...amounts }, restIntoOther, flags };
  } else if (!r.error && (effectiveFrom || Object.keys(flags).length > 0)) {
    return { error: `${effectiveFrom ? COLUMNS.from : "PF, ESI and PT applies"} need a salary in the same row — give the ${COLUMNS.gross} and its components.` };
  }

  // ── Bank and statutory numbers ──
  const ids: Row["ids"] = {};
  const bankName = r.text(COLUMNS.bankName);
  if (bankName) ids.bankName = bankName.slice(0, 80);
  ids.bankAccountNumber = idNumber(r, COLUMNS.account, /^[A-Z0-9]{6,32}$/, "an account number is 6 to 32 letters or digits");
  ids.bankIfsc = idNumber(r, COLUMNS.ifsc, /^[A-Z]{4}0[A-Z0-9]{6}$/, "an IFSC is four letters, a zero, then six characters");
  ids.panNumber = idNumber(r, COLUMNS.pan, /^[A-Z]{5}[0-9]{4}[A-Z]$/, "a PAN is five letters, four digits, then a letter");
  // The whole number, its last four, or the masked form exports print (XXXX XXXX 1234): the digits decide.
  const aadhaar = idNumber(r, COLUMNS.aadhaar, /^(\d{4}|\d{12})$/, "Aadhaar is its 12 digits or the last four", (v) => v.replace(/\D/g, ""));
  ids.aadhaarLast4 = aadhaar?.slice(-4);
  ids.uanNumber = idNumber(r, COLUMNS.uan, /^\d{12}$/, "a UAN is 12 digits");
  ids.pfNumber = idNumber(r, COLUMNS.pfNumber, /^[A-Z0-9/]{5,32}$/, "a PF number is up to 32 letters, digits and slashes");
  ids.esicNumber = idNumber(r, COLUMNS.esic, /^\d{10,17}$/, "an ESIC number is 10 to 17 digits");
  for (const key of Object.keys(ids) as IdKey[]) if (ids[key] === undefined) delete ids[key];

  // ── Pay so far this tax year ──
  const ytd = Object.fromEntries(YTD.map(([key, column]) => [key, money(r, column)]).filter(([, v]) => v !== undefined)) as Partial<Record<YtdKey, number>>;
  const regimeText = r.text(COLUMNS.regime).toLowerCase();
  const regime: TaxRegime | undefined = !regimeText ? undefined : regimeText.includes("old") ? "OLD" : regimeText.includes("new") ? "NEW" : undefined;
  if (regimeText && !regime) r.fail(`${COLUMNS.regime} "${r.text(COLUMNS.regime)}" isn't New or Old.`);
  if (r.error) return { error: r.error };
  let tax: Row["tax"] = null;
  if (Object.keys(ytd).length > 0 || regime) {
    const today = (await workspaceClock()).calendarDate(new Date());
    const taxYear = taxYearOf(today.getUTCFullYear(), today.getUTCMonth() + 1);
    if (!TAX_YEARS[taxYear]) return { error: `Deskzo doesn't work out TDS for tax year ${yearLabel(taxYear)} yet.` };
    for (const [key, column] of YTD) {
      if (key !== "previousGross" && ytd[key] !== undefined && ytd.previousGross !== undefined && ytd[key]! > ytd.previousGross) {
        return { error: `${column} (${rupees(ytd[key]!)}) is more than the ${COLUMNS.ytdGross} (${rupees(ytd.previousGross)}).` };
      }
    }
    tax = { taxYear, regime, amounts: ytd };
  }

  if (!salary && Object.keys(ids).length === 0 && !tax) return { error: "Nothing to bring across in this row — no salary, bank or statutory number, or pay so far." };
  return { value: { person: who, label: code ? `${who.name} (${code})` : who.name, salary, ids, aadhaarCut: aadhaar?.length === 12, tax } };
}

/** What a row would do against what's stored — the one reading both the preview and the write use. */
async function against(row: Row) {
  const userId = row.person.id;
  const [profile, sameDay, before, declaration] = await Promise.all([
    Object.keys(row.ids).length ? db.employeeProfile.findUnique({ where: { userId } }) : null,
    row.salary ? db.salaryStructure.findFirst({ where: { userId, effectiveFrom: row.salary.effectiveFrom } }) : null,
    row.salary ? db.salaryStructure.findFirst({ where: { userId, effectiveFrom: { lt: row.salary.effectiveFrom } }, orderBy: { effectiveFrom: "desc" } }) : null,
    row.tax ? db.taxDeclaration.findUnique({ where: { userId_taxYear: { userId, taxYear: row.tax.taxYear } } }) : null,
  ]);
  const changes: FieldChange[] = [];

  // A blank applies-column keeps what the person's salary had: the same day's, else the one before, else on.
  const flags = row.salary
    ? (Object.fromEntries(FLAGS.map(([key]) => [key, row.salary!.flags[key] ?? (sameDay ?? before)?.[key] ?? true])) as Record<FlagKey, boolean>)
    : null;
  let salaryWrite: "create" | "update" | null = null;
  if (row.salary && flags) {
    const { effectiveFrom, parts, restIntoOther } = row.salary;
    const label = (key: ComponentKey, column: string) => (key === "otherAllowance" && restIntoOther ? `${column} (the rest of the gross)` : column);
    if (!sameDay) {
      salaryWrite = "create";
      changes.push({ field: COLUMNS.from, from: "(new)", to: dayKey(effectiveFrom) });
      for (const [key, column] of COMPONENTS) if (parts[key] > 0 || key === "basic") changes.push({ field: label(key, column), from: "(new)", to: rupees(parts[key]) });
      for (const [key, column] of FLAGS) changes.push({ field: column, from: "(new)", to: flags[key] ? "yes" : "no" });
    } else {
      for (const [key, column] of COMPONENTS) {
        const was = Number(sameDay[key]);
        if (was !== parts[key]) changes.push({ field: label(key, column), from: rupees(was), to: rupees(parts[key]) });
      }
      for (const [key, column] of FLAGS) if (sameDay[key] !== flags[key]) changes.push({ field: column, from: sameDay[key] ? "yes" : "no", to: flags[key] ? "yes" : "no" });
      if (changes.length) salaryWrite = "update";
    }
  }

  const idChanges: Partial<Record<IdKey, string>> = {};
  for (const [key, column, secret] of ID_FIELDS) {
    const to = row.ids[key];
    if (to === undefined) continue;
    const from = profile?.[key] ?? null;
    if ((from ?? "") === to) continue;
    idChanges[key] = to;
    changes.push({ field: column, from: (secret ? masked(from) : from) || "(empty)", to: secret ? masked(to) : to });
  }

  const taxChanges: Partial<Record<YtdKey, number>> & { regime?: TaxRegime } = {};
  if (row.tax) {
    const year = yearLabel(row.tax.taxYear);
    // New is what a person without a declaration is taxed under already (s.202), so it's no change.
    if (row.tax.regime && row.tax.regime !== (declaration?.regime ?? "NEW")) {
      taxChanges.regime = row.tax.regime;
      changes.push({ field: `${COLUMNS.regime} (${year})`, from: declaration ? declaration.regime.toLowerCase() : "new", to: row.tax.regime.toLowerCase() });
    }
    for (const [key, column] of YTD) {
      const to = row.tax.amounts[key];
      if (to === undefined) continue;
      const was = Number(declaration?.[key] ?? 0);
      if (declaration && was === to) continue;
      if (!declaration && to === 0) continue;
      taxChanges[key] = to;
      changes.push({ field: `${column} (${year})`, from: declaration ? rupees(was) : "(new)", to: rupees(to) });
    }
  }
  const taxWrite = Object.keys(taxChanges).length > 0;

  return { changes, salaryWrite, flags, idChanges, taxChanges, taxWrite };
}

const AADHAAR_NOTICE = "Only the last four digits of Aadhaar are kept — the rest of the number is never stored.";

export const payrollImporter: Importer = {
  templateColumns: Object.values(COLUMNS),
  headerAliases: ALIASES,

  async plan(row, line): Promise<PlannedRow> {
    const resolved = await resolve(row);
    if ("error" in resolved) return { line, action: "error", key: "", label: trim(row[COLUMNS.user]) || trim(row[COLUMNS.code]), changes: [], error: resolved.error };
    const r = resolved.value;
    const { changes, salaryWrite } = await against(r);
    return {
      line,
      // A new salary structure is a new record; anything else that differs is a change to theirs.
      action: salaryWrite === "create" ? "create" : changes.length ? "update" : "skip",
      key: keyOf("USR", r.person.userSeq),
      label: r.label,
      changes,
      ...(r.aadhaarCut ? { notice: AADHAAR_NOTICE } : {}),
    };
  },

  async apply(row, ctx) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const r = resolved.value;
    const userId = r.person.id;
    const { salaryWrite, flags, idChanges, taxChanges, taxWrite } = await against(r);
    const dec = (n: number) => new Prisma.Decimal(n);

    await db.$transaction(async (tx) => {
      if (r.salary && flags && salaryWrite) {
        const data = {
          ...(Object.fromEntries(COMPONENTS.map(([key]) => [key, dec(r.salary!.parts[key])])) as Record<ComponentKey, Prisma.Decimal>),
          ...flags,
        };
        if (salaryWrite === "create") {
          await tx.salaryStructure.create({ data: { userId, effectiveFrom: r.salary.effectiveFrom, ...data, note: "Brought from the old system", createdById: ctx.actorUserId } });
        } else {
          await tx.salaryStructure.updateMany({ where: { userId, effectiveFrom: r.salary.effectiveFrom }, data });
        }
      }
      if (Object.keys(idChanges).length) {
        await tx.employeeProfile.upsert({ where: { userId }, update: idChanges, create: { userId, ...idChanges } });
      }
      if (taxWrite && r.tax) {
        const { regime, ...amounts } = taxChanges;
        const data = { ...(regime ? { regime } : {}), ...Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, dec(v as number)])), updatedById: ctx.actorUserId };
        await tx.taxDeclaration.upsert({ where: { userId_taxYear: { userId, taxYear: r.tax.taxYear } }, update: data, create: { userId, taxYear: r.tax.taxYear, ...data } });
      }
    });

    // Said without the numbers: the audit log is read more widely than payroll.
    const name = r.person.name;
    if (r.salary && salaryWrite) {
      await recordAudit({ userId: ctx.actorUserId, action: salaryWrite === "create" ? "CREATE" : "UPDATE", entityType: "SalaryStructure", entityId: `${userId}:${dayKey(r.salary.effectiveFrom)}`, entityLabel: `Salary set for ${name} from ${dayKey(r.salary.effectiveFrom)} (imported)` });
    }
    if (Object.keys(idChanges).length) {
      const fields = ID_FIELDS.filter(([key]) => key in idChanges).map(([, column]) => column.toLowerCase());
      await recordAudit({ userId: ctx.actorUserId, action: "UPDATE", entityType: "EmployeeProfile", entityId: userId, entityLabel: `${name}'s ${fields.join(", ")} (imported)` });
    }
    if (taxWrite && r.tax) {
      await recordAudit({ userId: ctx.actorUserId, action: "UPDATE", entityType: "TaxDeclaration", entityId: `${userId}:${r.tax.taxYear}`, entityLabel: `Pay before Deskzo for ${name}, tax year ${yearLabel(r.tax.taxYear)} (imported)` });
    }
  },
};

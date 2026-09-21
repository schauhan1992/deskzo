/**
 * A staffed company: 22 employees with a reporting line, a year of holidays, leave they have
 * actually taken, three months of daily attendance, biometric punches, salaries and payroll.
 *
 *   npm run db:seed:hr             # add the data
 *   npm run db:seed:hr -- --reset  # remove a previous run first, then add it again
 *
 * Two things worth knowing about how this is built.
 *
 * It runs the real engines rather than inventing plausible-looking numbers. Loss of pay comes from
 * `lossOfPayDays` reading the attendance this script wrote, and payslips come from `computePayslip`.
 * That means the seeded data is internally consistent — a payslip's 27/30 paid days corresponds to
 * actual absences you can go and look at — and it means seeding the data exercises the same code
 * a real month would. `--verify` then asserts the invariants hold.
 *
 * The randomness is seeded, so a re-run produces the same company rather than a different one.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient, Prisma, type Role, type AttendanceStatus, type CandidateStatus, type EmploymentType } from "@prisma/client";
import bcrypt from "bcryptjs";
import { dateOnly, daysInMonth, eachDay, financialYearOf, isWeekOff, monthRange, toKey } from "../src/lib/hr/calendar";
import { computePayslip, monthlyGross } from "../src/lib/hr/payroll";
import { letterNumberFor, renderLetter, subjectFor, type LetterPayload } from "../src/lib/hr/letters";
import type { LetterType } from "@prisma/client";
import { lossOfPayDays } from "../src/lib/hr/loss-of-pay";

const db = new PrismaClient();

const CODE_PREFIX = "WRF-";
const DEVICE_SERIAL = "ESSLSEED0001";
/** Payroll and attendance are generated for these months; the last one is left as a draft. */
const MONTHS = [
  { month: 7, year: 2026 },
  { month: 8, year: 2026 },
  { month: 9, year: 2026 },
];
const TODAY = dateOnly(new Date());

let seed = 20260918;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const chance = (p: number) => rnd() < p;
const dec = (v: number) => new Prisma.Decimal(v);

// ─── The people ───────────────────────────────────────────────────────────────

type Seeded = {
  name: string;
  email: string;
  role: Role;
  dept: string;
  designation: string;
  type: EmploymentType;
  /** Monthly gross, in rupees — the ESI and PT branches need real spread to be exercised. */
  gross: number;
  state: string;
  /** Index into the roster of the person they report to; -1 is the admin. */
  managerIndex: number;
  joinedMonthsAgo: number;
};

const ROSTER: Seeded[] = [
  // Heads report to the admin.
  { name: "Vikram Malhotra", email: "vikram.malhotra@wroffy.com", role: "MANAGEMENT", dept: "Sales", designation: "Sales Head", type: "FULL_TIME", gross: 165000, state: "Maharashtra", managerIndex: -1, joinedMonthsAgo: 74 },
  { name: "Ananya Deshpande", email: "ananya.deshpande@wroffy.com", role: "MANAGEMENT", dept: "Accounts", designation: "Finance Controller", type: "FULL_TIME", gross: 150000, state: "Maharashtra", managerIndex: -1, joinedMonthsAgo: 61 },
  { name: "Imran Qureshi", email: "imran.qureshi@wroffy.com", role: "MANAGEMENT", dept: "Support", designation: "Support Manager", type: "FULL_TIME", gross: 118000, state: "Karnataka", managerIndex: -1, joinedMonthsAgo: 49 },
  { name: "Kavya Reddy", email: "kavya.reddy@wroffy.com", role: "MANAGEMENT", dept: "HR & Admin", designation: "HR Manager", type: "FULL_TIME", gross: 122000, state: "Telangana", managerIndex: -1, joinedMonthsAgo: 43 },
  { name: "Sandeep Ghosh", email: "sandeep.ghosh@wroffy.com", role: "PURCHASE", dept: "Purchase", designation: "Purchase Head", type: "FULL_TIME", gross: 112000, state: "West Bengal", managerIndex: -1, joinedMonthsAgo: 55 },

  // Sales, under Vikram (index 0).
  { name: "Rohit Bhandari", email: "rohit.bhandari@wroffy.com", role: "SALES", dept: "Sales", designation: "Senior Account Executive", type: "FULL_TIME", gross: 78000, state: "Maharashtra", managerIndex: 0, joinedMonthsAgo: 31 },
  { name: "Meera Krishnan", email: "meera.krishnan@wroffy.com", role: "SALES", dept: "Sales", designation: "Account Executive", type: "FULL_TIME", gross: 58000, state: "Tamil Nadu", managerIndex: 0, joinedMonthsAgo: 19 },
  { name: "Aditya Rane", email: "aditya.rane@wroffy.com", role: "SALES", dept: "Sales", designation: "Account Executive", type: "FULL_TIME", gross: 54000, state: "Maharashtra", managerIndex: 0, joinedMonthsAgo: 14 },
  { name: "Simran Kaur", email: "simran.kaur@wroffy.com", role: "SALES", dept: "Sales", designation: "Inside Sales", type: "FULL_TIME", gross: 38000, state: "Delhi", managerIndex: 0, joinedMonthsAgo: 8 },
  { name: "Harsh Vardhan", email: "harsh.vardhan@wroffy.com", role: "SALES", dept: "Sales", designation: "Sales Trainee", type: "INTERN", gross: 19000, state: "Uttar Pradesh", managerIndex: 0, joinedMonthsAgo: 3 },

  // Profiling & calling, under Vikram too.
  { name: "Divya Menon", email: "divya.menon@wroffy.com", role: "PROFILE", dept: "Profiling", designation: "Research Analyst", type: "FULL_TIME", gross: 32000, state: "Karnataka", managerIndex: 0, joinedMonthsAgo: 22 },
  { name: "Nikhil Joshi", email: "nikhil.joshi@wroffy.com", role: "PROFILE", dept: "Profiling", designation: "Research Analyst", type: "FULL_TIME", gross: 29000, state: "Maharashtra", managerIndex: 0, joinedMonthsAgo: 11 },
  { name: "Pooja Agarwal", email: "pooja.agarwal@wroffy.com", role: "CALLING", dept: "Profiling", designation: "Tele-caller", type: "FULL_TIME", gross: 24000, state: "Gujarat", managerIndex: 0, joinedMonthsAgo: 16 },
  { name: "Faisal Khan", email: "faisal.khan@wroffy.com", role: "CALLING", dept: "Profiling", designation: "Tele-caller", type: "CONTRACT", gross: 21000, state: "Delhi", managerIndex: 0, joinedMonthsAgo: 6 },

  // Support, under Imran (index 2).
  { name: "Sneha Pillai", email: "sneha.pillai@wroffy.com", role: "SUPPORT", dept: "Support", designation: "Senior Support Engineer", type: "FULL_TIME", gross: 66000, state: "Karnataka", managerIndex: 2, joinedMonthsAgo: 37 },
  { name: "Tarun Sethi", email: "tarun.sethi@wroffy.com", role: "SUPPORT", dept: "Support", designation: "Support Engineer", type: "FULL_TIME", gross: 44000, state: "Karnataka", managerIndex: 2, joinedMonthsAgo: 20 },
  { name: "Ritu Chawla", email: "ritu.chawla@wroffy.com", role: "SUPPORT", dept: "Support", designation: "Support Engineer", type: "FULL_TIME", gross: 20500, state: "Delhi", managerIndex: 2, joinedMonthsAgo: 9 },
  { name: "Manoj Pawar", email: "manoj.pawar@wroffy.com", role: "SUPPORT", dept: "Field Ops", designation: "Field Engineer", type: "FULL_TIME", gross: 27000, state: "Maharashtra", managerIndex: 2, joinedMonthsAgo: 26 },

  // Accounts, under Ananya (index 1).
  { name: "Gaurav Shetty", email: "gaurav.shetty@wroffy.com", role: "ACCOUNTS", dept: "Accounts", designation: "Accounts Executive", type: "FULL_TIME", gross: 41000, state: "Maharashtra", managerIndex: 1, joinedMonthsAgo: 28 },
  { name: "Lakshmi Rao", email: "lakshmi.rao@wroffy.com", role: "ACCOUNTS", dept: "Accounts", designation: "Accounts Assistant", type: "FULL_TIME", gross: 19500, state: "Telangana", managerIndex: 1, joinedMonthsAgo: 12 },

  // Purchase, under Sandeep (index 4).
  { name: "Zoya Merchant", email: "zoya.merchant@wroffy.com", role: "PURCHASE", dept: "Purchase", designation: "Purchase Executive", type: "FULL_TIME", gross: 43000, state: "West Bengal", managerIndex: 4, joinedMonthsAgo: 24 },
  { name: "Deepak Yadav", email: "deepak.yadav@wroffy.com", role: "PURCHASE", dept: "Purchase", designation: "Purchase Assistant", type: "CONSULTANT", gross: 35000, state: "Uttar Pradesh", managerIndex: 4, joinedMonthsAgo: 5 },
];


// ─── The people being hired ───────────────────────────────────────────────────

/**
 * A hiring pipeline at every stage, because the stages behave differently and each one is a state
 * somebody will hit on their first day using this: an offer not yet sent, one sent and waiting, one
 * accepted with the intake form back, one accepted without it, and the two dead ends.
 */
type SeededCandidate = {
  name: string;
  email: string;
  designation: string;
  dept: string;
  role: Role;
  type: EmploymentType;
  status: CandidateStatus;
  ctc: number;
  /** Days from today; negative is in the past. */
  joiningInDays: number;
  managerIndex: number;
  source: string;
  /** Whether they have sent their details back. */
  intake: boolean;
  /** Whether a live intake link is outstanding. */
  linkLive?: boolean;
  declinedReason?: string;
  notes?: string;
};

const CANDIDATES: SeededCandidate[] = [
  { name: "Ishaan Bhatt", email: "ishaan.bhatt@example.com", designation: "Account Executive", dept: "Sales", role: "SALES", type: "FULL_TIME", status: "ACCEPTED", ctc: 780000, joiningInDays: 12, managerIndex: 0, source: "Naukri", intake: true },
  { name: "Reshma Nair", email: "reshma.nair@example.com", designation: "Support Engineer", dept: "Support", role: "SUPPORT", type: "FULL_TIME", status: "ACCEPTED", ctc: 600000, joiningInDays: 26, managerIndex: 2, source: "Referral — Sneha Pillai", intake: false, linkLive: true, notes: "Serving notice; last day at current employer is the 20th." },
  { name: "Arnav Kulkarni", email: "arnav.kulkarni@example.com", designation: "Inside Sales", dept: "Sales", role: "SALES", type: "FULL_TIME", status: "OFFERED", ctc: 480000, joiningInDays: 34, managerIndex: 0, source: "LinkedIn", intake: false, linkLive: true },
  { name: "Tanvi Shah", email: "tanvi.shah@example.com", designation: "Accounts Executive", dept: "Accounts", role: "ACCOUNTS", type: "FULL_TIME", status: "OFFERED", ctc: 540000, joiningInDays: 40, managerIndex: 1, source: "Naukri", intake: false },
  { name: "Karthik Iyer", email: "karthik.iyer@example.com", designation: "Research Analyst", dept: "Profiling", role: "PROFILE", type: "FULL_TIME", status: "PROSPECT", ctc: 390000, joiningInDays: 55, managerIndex: 0, source: "Campus — Symbiosis", intake: false },
  { name: "Neha Bansal", email: "neha.bansal@example.com", designation: "Purchase Executive", dept: "Purchase", role: "PURCHASE", type: "FULL_TIME", status: "PROSPECT", ctc: 510000, joiningInDays: 60, managerIndex: 4, source: "LinkedIn", intake: false },
  { name: "Rahul Saxena", email: "rahul.saxena@example.com", designation: "Senior Account Executive", dept: "Sales", role: "SALES", type: "FULL_TIME", status: "DECLINED", ctc: 900000, joiningInDays: 20, managerIndex: 0, source: "Naukri", intake: false, declinedReason: "Counter-offer from current employer." },
  { name: "Priyanka Dutta", email: "priyanka.dutta@example.com", designation: "Field Engineer", dept: "Field Ops", role: "SUPPORT", type: "FULL_TIME", status: "WITHDRAWN", ctc: 360000, joiningInDays: 15, managerIndex: 2, source: "Walk-in", intake: false, notes: "Role put on hold — budget moved to Support." },
];

// Candidates carry their own teams, which need not already exist on the employee roster.
const DEPARTMENTS = [...new Set([...ROSTER.map((r) => r.dept), ...CANDIDATES.map((c) => c.dept)])];

/** Real 2026 dates, so the calendar looks like a calendar rather than filler. */
const HOLIDAYS_2026: { name: string; date: string; optional?: boolean }[] = [
  { name: "Republic Day", date: "2026-01-26" },
  { name: "Holi", date: "2026-03-04" },
  { name: "Good Friday", date: "2026-04-03", optional: true },
  { name: "Id-ul-Fitr", date: "2026-03-21" },
  { name: "Independence Day", date: "2026-08-15" },
  { name: "Ganesh Chaturthi", date: "2026-09-14" },
  { name: "Gandhi Jayanti", date: "2026-10-02" },
  { name: "Dussehra", date: "2026-10-20" },
  { name: "Diwali", date: "2026-11-08" },
  { name: "Diwali (Bhai Dooj)", date: "2026-11-10", optional: true },
  { name: "Christmas", date: "2026-12-25" },
];

const LEAVE_TYPES = [
  { code: "CL", name: "Casual leave", annualQuota: 12, accrual: "ANNUAL" as const, paid: true, carryForward: false, sortOrder: 1 },
  { code: "SL", name: "Sick leave", annualQuota: 8, accrual: "ANNUAL" as const, paid: true, carryForward: false, proofAfterDays: 2, sortOrder: 2 },
  { code: "EL", name: "Earned leave", annualQuota: 18, accrual: "MONTHLY" as const, paid: true, carryForward: true, maxCarryForward: 30, sortOrder: 3 },
  { code: "LOP", name: "Loss of pay", annualQuota: 0, accrual: "ANNUAL" as const, paid: false, carryForward: false, sortOrder: 9 },
];

const PREVIOUS_EMPLOYERS = [
  "Infosys Limited", "Tech Mahindra", "Redington India", "Rashi Peripherals", "Savex Technologies",
  "Wipro Limited", "HCL Infosystems", "Ingram Micro India", "Compuage Infocom", "Iris Global Services",
];
const LEAVING_REASONS = [
  "Better opportunity", "Relocation", "Career growth", "Company restructuring", "Higher studies",
];

const LEAVE_REASONS = [
  "Family function out of town", "Not keeping well", "Personal work", "Medical appointment",
  "Moving house", "Child's school event", "Travelling for a wedding", "Fever, resting at home",
];

// ─── Reset ────────────────────────────────────────────────────────────────────

async function reset() {
  const emails = ROSTER.map((r) => r.email);
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);

  await db.payslip.deleteMany({ where: { run: { year: { in: [...new Set(MONTHS.map((m) => m.year))] } } } });
  await db.payrollRun.deleteMany({ where: { OR: MONTHS.map((m) => ({ month: m.month, year: m.year })) } });
  await db.celebration.deleteMany({});
  await db.celebrationSeen.deleteMany({});
  await db.employeeDocument.deleteMany({});
  await db.candidate.deleteMany({ where: { email: { in: CANDIDATES.map((c) => c.email) } } });
  await db.employeeLetter.deleteMany({});
  await db.employmentHistory.deleteMany({});
  await db.attendanceRegularisation.deleteMany({});
  await db.biometricPunch.deleteMany({ where: { device: { serialNumber: DEVICE_SERIAL } } });
  await db.biometricDevice.deleteMany({ where: { serialNumber: DEVICE_SERIAL } });
  await db.attendanceDay.deleteMany({});
  await db.leaveRequest.deleteMany({});
  await db.leaveBalance.deleteMany({});
  await db.salaryStructure.deleteMany({});
  await db.leaveType.deleteMany({ where: { code: { in: LEAVE_TYPES.map((t) => t.code) } } });
  await db.holiday.deleteMany({ where: { date: { gte: dateOnly("2026-01-01"), lte: dateOnly("2026-12-31") } } });
  await db.employeeProfile.deleteMany({});
  // Notifications and audit rows reference the users, so they go before the users do.
  if (ids.length) {
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { impersonatedByUserId: { in: ids } }] } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.department.deleteMany({ where: { name: { in: DEPARTMENTS } } });
  console.log("Removed the previous HR seed.");
}

// ─── Build ────────────────────────────────────────────────────────────────────

/** A monthly gross split the Indian way: basic 50%, HRA half of basic, the rest special. */
function splitGross(gross: number) {
  const basic = Math.round(gross * 0.5);
  const hra = Math.round(basic * 0.5);
  return { basic, hra, specialAllowance: Math.max(gross - basic - hra, 0) };
}

function panFor(name: string, i: number) {
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase().padEnd(5, "X").slice(0, 5);
  return `${letters}${String(1000 + i).slice(0, 4)}${String.fromCharCode(65 + (i % 26))}`;
}

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true, name: true } });

  // ── Departments ────────────────────────────────────────────────────────────
  const deptByName = new Map<string, string>();
  for (const name of DEPARTMENTS) {
    const row = await db.department.upsert({
      where: { name },
      update: {},
      create: { name, isSupportTeam: name === "Support" },
      select: { id: true },
    });
    deptByName.set(name, row.id);
  }
  console.log(`Departments: ${DEPARTMENTS.length}`);

  // ── Users, then their managers (two passes, because a manager may come later) ─
  const userIds: string[] = [];
  for (const person of ROSTER) {
    const user = await db.user.upsert({
      where: { email: person.email },
      update: { name: person.name, role: person.role, departmentId: deptByName.get(person.dept) },
      create: {
        name: person.name,
        email: person.email,
        role: person.role,
        passwordHash,
        departmentId: deptByName.get(person.dept),
      },
      select: { id: true },
    });
    userIds.push(user.id);
  }
  for (const [i, person] of ROSTER.entries()) {
    await db.user.update({
      where: { id: userIds[i] },
      data: { managerId: person.managerIndex === -1 ? admin.id : userIds[person.managerIndex] },
    });
  }
  console.log(`Users: ${ROSTER.length} (password ChangeMe123!)`);

  // ── Employee records ───────────────────────────────────────────────────────
  for (const [i, person] of ROSTER.entries()) {
    const joinedOn = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - person.joinedMonthsAgo, int(1, 28)));
    const probationEndsOn = new Date(joinedOn.getTime() + 180 * 86400000);
    const confirmed = probationEndsOn < TODAY;
    await db.employeeProfile.upsert({
      where: { userId: userIds[i] },
      update: {},
      create: {
        userId: userIds[i],
        employeeCode: `${CODE_PREFIX}${String(i + 1).padStart(3, "0")}`,
        biometricId: String(1001 + i),
        designation: person.designation,
        employmentType: person.type,
        workLocation: person.state === "Maharashtra" ? "Mumbai" : person.state === "Delhi" ? "Noida" : person.state,
        joinedOn,
        probationEndsOn,
        confirmedOn: confirmed ? probationEndsOn : null,
        dateOfBirth: new Date(Date.UTC(int(1978, 2003), int(0, 11), int(1, 28))),
        gender: pick(["FEMALE", "MALE", "UNDISCLOSED"] as const),
        bloodGroup: pick(["O+", "A+", "B+", "AB+", "O-"]),
        maritalStatus: pick(["Single", "Married"]),
        personalEmail: person.email.replace("@wroffy.com", "@gmail.com"),
        personalPhone: `9${int(100000000, 999999999)}`,
        addressLine1: `${int(1, 90)}, ${pick(["Shanti", "Gokul", "Sunrise", "Lake View", "Rose"])} ${pick(["Apartments", "Residency", "Heights"])}`,
        city: person.state === "Maharashtra" ? "Mumbai" : person.state === "Delhi" ? "New Delhi" : person.state === "Karnataka" ? "Bengaluru" : person.state,
        state: person.state,
        pincode: String(int(110001, 700099)),
        emergencyContactName: pick(["Suresh", "Anita", "Ramesh", "Kavita", "Vijay"]) + " " + person.name.split(" ")[1],
        emergencyContactPhone: `9${int(100000000, 999999999)}`,
        emergencyContactRelation: pick(["Spouse", "Father", "Mother", "Sibling"]),
        panNumber: panFor(person.name, i),
        aadhaarLast4: String(int(1000, 9999)),
        uanNumber: String(100000000000 + i),
        esicNumber: person.gross <= 21000 ? String(3100000000 + i) : null,
        bankName: pick(["HDFC Bank", "ICICI Bank", "Axis Bank", "State Bank of India", "Kotak Mahindra Bank"]),
        bankAccountNumber: String(int(10000000, 99999999)) + String(int(1000, 9999)),
        bankIfsc: `${pick(["HDFC", "ICIC", "UTIB", "SBIN", "KKBK"])}0${String(int(100000, 999999))}`,
      },
    });
  }
  console.log(`Employee records: ${ROSTER.length}`);

  // ── Holidays ───────────────────────────────────────────────────────────────
  for (const h of HOLIDAYS_2026) {
    await db.holiday.upsert({
      where: { date_name: { date: dateOnly(h.date), name: h.name } },
      update: {},
      create: { name: h.name, date: dateOnly(h.date), optional: h.optional ?? false },
    });
  }
  const holidays = await db.holiday.findMany({ select: { date: true, optional: true } });
  const closed = new Set(holidays.filter((h) => !h.optional).map((h) => toKey(h.date)));
  console.log(`Holidays: ${HOLIDAYS_2026.length}`);

  // ── Leave types ────────────────────────────────────────────────────────────
  const typeByCode = new Map<string, { id: string; paid: boolean }>();
  for (const t of LEAVE_TYPES) {
    const row = await db.leaveType.upsert({
      where: { code: t.code },
      update: {},
      create: {
        code: t.code,
        name: t.name,
        annualQuota: dec(t.annualQuota),
        accrual: t.accrual,
        paid: t.paid,
        carryForward: t.carryForward,
        maxCarryForward: t.maxCarryForward ? dec(t.maxCarryForward) : null,
        proofAfterDays: t.proofAfterDays ?? null,
        sortOrder: t.sortOrder,
      },
      select: { id: true, paid: true },
    });
    typeByCode.set(t.code, row);
  }
  console.log(`Leave types: ${LEAVE_TYPES.length}`);

  // ── Leave balances ─────────────────────────────────────────────────────────
  const fy = financialYearOf(TODAY);
  const monthsElapsed = Math.min(12, TODAY.getUTCMonth() - 3 + 1 + (TODAY.getUTCMonth() >= 3 ? 0 : 12));
  for (const userId of userIds) {
    for (const t of LEAVE_TYPES) {
      const credited = t.accrual === "MONTHLY" ? Math.round((t.annualQuota / 12) * monthsElapsed * 100) / 100 : t.annualQuota;
      await db.leaveBalance.upsert({
        where: { userId_typeId_year: { userId, typeId: typeByCode.get(t.code)!.id, year: fy } },
        update: {},
        create: {
          userId,
          typeId: typeByCode.get(t.code)!.id,
          year: fy,
          credited: dec(credited),
          opening: dec(t.carryForward ? int(0, 6) : 0),
        },
      });
    }
  }

  // ── Leave requests, and the attendance an approved one writes ──────────────
  const leaveDays = new Map<string, { status: AttendanceStatus; requestId: string }>();
  let leaveCount = { approved: 0, pending: 0, rejected: 0, cancelled: 0 };

  for (const [i, userId] of userIds.entries()) {
    for (let n = 0; n < int(2, 5); n++) {
      const code = chance(0.06) ? "LOP" : pick(["CL", "SL", "EL", "CL", "EL"]);
      const type = typeByCode.get(code)!;
      // Spread across the three seeded months, and a few into the future so the queue is not empty.
      const start = new Date(Date.UTC(2026, int(6, 9), int(1, 26)));
      const span = chance(0.25) ? int(1, 3) : 0;
      const end = new Date(start.getTime() + span * 86400000);
      if (isWeekOff(start) || closed.has(toKey(start))) continue;

      const working = eachDay(start, end).filter((d) => !isWeekOff(d) && !closed.has(toKey(d)));
      if (working.length === 0) continue;

      const future = start > TODAY;
      const status = future
        ? (chance(0.5) ? "PENDING" : "APPROVED")
        : chance(0.08)
          ? "REJECTED"
          : chance(0.05)
            ? "CANCELLED"
            : "APPROVED";

      // Never two overlapping requests for the same person — the app refuses it, so the seed must
      // not manufacture a state the app itself would reject.
      if (working.some((d) => leaveDays.has(`${userId}:${toKey(d)}`))) continue;

      const approverId = ROSTER[i].managerIndex === -1 ? admin.id : userIds[ROSTER[i].managerIndex];
      const request = await db.leaveRequest.create({
        data: {
          userId,
          typeId: type.id,
          fromDate: working[0],
          toDate: working[working.length - 1],
          days: dec(working.length),
          reason: pick(LEAVE_REASONS),
          status,
          approverId,
          decidedAt: status === "PENDING" ? null : new Date(working[0].getTime() - 2 * 86400000),
          decisionNote: status === "REJECTED" ? "Too many people out that week." : null,
          cancelledAt: status === "CANCELLED" ? new Date(working[0].getTime() - 86400000) : null,
        },
        select: { id: true },
      });
      leaveCount = { ...leaveCount, [status.toLowerCase()]: leaveCount[status.toLowerCase() as keyof typeof leaveCount] + 1 };

      if (status === "APPROVED") {
        for (const d of working) leaveDays.set(`${userId}:${toKey(d)}`, { status: "ON_LEAVE", requestId: request.id });
        if (type.paid) {
          await db.leaveBalance.update({
            where: { userId_typeId_year: { userId, typeId: type.id, year: fy } },
            data: { used: { increment: dec(working.length) } },
          });
        }
      }
    }
  }
  console.log(
    `Leave requests: ${leaveCount.approved} approved, ${leaveCount.pending} pending, ${leaveCount.rejected} rejected, ${leaveCount.cancelled} cancelled`,
  );

  // ── Attendance ─────────────────────────────────────────────────────────────
  const device = await db.biometricDevice.upsert({
    where: { serialNumber: DEVICE_SERIAL },
    update: {},
    create: { serialNumber: DEVICE_SERIAL, name: "Main gate", location: "Mumbai office, reception", lastSeenAt: new Date() },
    select: { id: true },
  });

  const attendanceRows: Prisma.AttendanceDayCreateManyInput[] = [];
  const punchRows: Prisma.BiometricPunchCreateManyInput[] = [];

  for (const [i, userId] of userIds.entries()) {
    const joined = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - ROSTER[i].joinedMonthsAgo, 1));
    // Half the office clocks through the terminal; the rest are field or remote and are marked by hand.
    const onTerminal = i % 2 === 0;

    for (const { month, year } of MONTHS) {
      const { from, to } = monthRange(year, month);
      for (const day of eachDay(from, to > TODAY ? TODAY : to)) {
        if (day < joined) continue;
        if (isWeekOff(day) || closed.has(toKey(day))) continue;

        const onLeave = leaveDays.get(`${userId}:${toKey(day)}`);
        if (onLeave) {
          attendanceRows.push({ userId, date: day, status: onLeave.status, leaveRequestId: onLeave.requestId });
          continue;
        }

        const roll = rnd();
        const status: AttendanceStatus =
          roll < 0.025 ? "ABSENT" : roll < 0.11 ? "WORK_FROM_HOME" : roll < 0.145 ? "HALF_DAY" : "PRESENT";

        if (status === "ABSENT") {
          attendanceRows.push({ userId, date: day, status });
          continue;
        }

        const inH = int(8, 10);
        const inM = int(0, 59);
        const outH = status === "HALF_DAY" ? int(13, 14) : int(17, 19);
        const outM = int(0, 59);
        const checkInAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), inH, inM));
        const checkOutAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), outH, outM));

        attendanceRows.push({
          userId,
          date: day,
          status,
          checkInAt,
          checkOutAt,
          workedMinutes: Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000),
        });

        if (onTerminal && status !== "WORK_FROM_HOME") {
          punchRows.push(
            { deviceId: device.id, deviceUserId: String(1001 + i), punchedAt: checkInAt, punchType: 0, verifyMode: 1, raw: `${1001 + i}\t${toKey(day)} ${String(inH).padStart(2, "0")}:${String(inM).padStart(2, "0")}:00\t0\t1`, userId, processedAt: new Date() },
            { deviceId: device.id, deviceUserId: String(1001 + i), punchedAt: checkOutAt, punchType: 1, verifyMode: 1, raw: `${1001 + i}\t${toKey(day)} ${String(outH).padStart(2, "0")}:${String(outM).padStart(2, "0")}:00\t1\t1`, userId, processedAt: new Date() },
          );
        }
      }
    }
  }

  await db.attendanceDay.createMany({ data: attendanceRows, skipDuplicates: true });
  await db.biometricPunch.createMany({ data: punchRows, skipDuplicates: true });
  await db.biometricDevice.update({
    where: { id: device.id },
    data: { punchesReceived: punchRows.length, lastPunchAt: punchRows.at(-1)?.punchedAt ?? null },
  });
  console.log(`Attendance: ${attendanceRows.length} day(s), ${punchRows.length} biometric punch(es)`);

  // ── Regularisation requests ────────────────────────────────────────────────
  let regCount = 0;
  for (const [i, userId] of userIds.entries()) {
    if (!chance(0.4)) continue;
    const absent = attendanceRows.find((r) => r.userId === userId && r.status === "ABSENT");
    if (!absent) continue;
    const date = absent.date as Date;
    const status = chance(0.4) ? "PENDING" : chance(0.75) ? "APPROVED" : "REJECTED";
    const approverId = ROSTER[i].managerIndex === -1 ? admin.id : userIds[ROSTER[i].managerIndex];

    await db.attendanceRegularisation.create({
      data: {
        userId,
        date,
        requestedStatus: "PRESENT",
        requestedCheckIn: new Date(date.getTime() + 9.5 * 3600000),
        requestedCheckOut: new Date(date.getTime() + 18.5 * 3600000),
        reason: pick(["Forgot to punch out", "Terminal was down that morning", "Was at a customer site all day", "Punched in but it did not register"]),
        status,
        approverId,
        decidedAt: status === "PENDING" ? null : new Date(),
      },
    });
    regCount += 1;

    // An approved correction actually changes the day, and stamps who decided.
    if (status === "APPROVED") {
      await db.attendanceDay.update({
        where: { userId_date: { userId, date } },
        data: {
          status: "PRESENT",
          checkInAt: new Date(date.getTime() + 9.5 * 3600000),
          checkOutAt: new Date(date.getTime() + 18.5 * 3600000),
          workedMinutes: 540,
          regularisedById: approverId,
          regularisedAt: new Date(),
          note: "Corrected: forgot to punch",
        },
      });
    }
  }
  console.log(`Attendance corrections: ${regCount}`);

  // ── Salaries ───────────────────────────────────────────────────────────────
  for (const [i, person] of ROSTER.entries()) {
    const split = splitGross(person.gross);
    // A raise a year ago for anyone who has been here long enough, so the history is not a single row.
    const hasHistory = person.joinedMonthsAgo > 18;
    if (hasHistory) {
      const older = splitGross(Math.round(person.gross * 0.88));
      await db.salaryStructure.create({
        data: {
          userId: userIds[i],
          effectiveFrom: new Date(Date.UTC(TODAY.getUTCFullYear() - 1, 3, 1)),
          basic: dec(older.basic),
          hra: dec(older.hra),
          specialAllowance: dec(older.specialAllowance),
          pfApplicable: person.type !== "CONSULTANT",
          esiApplicable: true,
          ptApplicable: true,
          createdById: admin.id,
          note: "Annual revision",
        },
      });
    }
    await db.salaryStructure.create({
      data: {
        userId: userIds[i],
        effectiveFrom: new Date(Date.UTC(TODAY.getUTCFullYear(), 3, 1)),
        basic: dec(split.basic),
        hra: dec(split.hra),
        specialAllowance: dec(split.specialAllowance),
        pfApplicable: person.type !== "CONSULTANT",
        esiApplicable: true,
        ptApplicable: true,
        createdById: admin.id,
        note: hasHistory ? "Annual revision" : "On joining",
      },
    });
  }
  console.log(`Salary structures: ${ROSTER.length} current`);

  // ── Payroll, through the real engine ───────────────────────────────────────
  for (const [index, { month, year }] of MONTHS.entries()) {
    const isLast = index === MONTHS.length - 1;
    const run = await db.payrollRun.create({
      data: {
        month,
        year,
        status: isLast ? "DRAFT" : "PAID",
        createdById: admin.id,
        lockedAt: isLast ? null : new Date(Date.UTC(year, month, 1)),
        lockedById: isLast ? null : admin.id,
        paidAt: isLast ? null : new Date(Date.UTC(year, month, 2)),
      },
      select: { id: true },
    });

    const slips: Prisma.PayslipCreateManyInput[] = [];
    const monthDays = daysInMonth(year, month);

    for (const [i, userId] of userIds.entries()) {
      const { to } = monthRange(year, month);
      const structure = await db.salaryStructure.findFirst({
        where: { userId, effectiveFrom: { lte: to } },
        orderBy: { effectiveFrom: "desc" },
      });
      if (!structure) continue;

      // The real reader, over the attendance written above — so the payslip and the grid agree.
      const lop = await lossOfPayDays(userId, year, month);
      const result = computePayslip({
        components: {
          basic: Number(structure.basic),
          hra: Number(structure.hra),
          conveyance: Number(structure.conveyance),
          medical: Number(structure.medical),
          specialAllowance: Number(structure.specialAllowance),
          otherAllowance: Number(structure.otherAllowance),
        },
        flags: { pfApplicable: structure.pfApplicable, esiApplicable: structure.esiApplicable, ptApplicable: structure.ptApplicable },
        monthDays,
        lopDays: lop,
        state: ROSTER[i].state,
        month,
        // Entered by payroll in the app; seeded here for the locked months so they look finished.
        incomeTax: isLast ? 0 : Math.round((ROSTER[i].gross > 60000 ? ROSTER[i].gross * 0.08 : 0) / 10) * 10,
      });

      const totalDeductions = result.totalDeductions;
      slips.push({
        runId: run.id,
        userId,
        monthDays: dec(result.monthDays),
        paidDays: dec(result.paidDays),
        lopDays: dec(result.lopDays),
        basic: dec(result.components.basic),
        hra: dec(result.components.hra),
        conveyance: dec(result.components.conveyance),
        medical: dec(result.components.medical),
        specialAllowance: dec(result.components.specialAllowance),
        otherAllowance: dec(result.components.otherAllowance),
        grossEarnings: dec(result.grossEarnings),
        pfEmployee: dec(result.pfEmployee),
        pfEmployer: dec(result.pfEmployer),
        esiEmployee: dec(result.esiEmployee),
        esiEmployer: dec(result.esiEmployer),
        professionalTax: dec(result.professionalTax),
        incomeTax: dec(result.incomeTax),
        totalDeductions: dec(totalDeductions),
        netPay: dec(result.netPay),
        employerCost: dec(result.employerCost),
        note: result.warnings.length ? result.warnings.join(" ") : null,
      });
    }

    await db.payslip.createMany({ data: slips });
    const net = slips.reduce((a, s) => a + Number(s.netPay), 0);
    console.log(
      `Payroll ${year}-${String(month).padStart(2, "0")}: ${slips.length} payslip(s), ₹${Math.round(net).toLocaleString("en-IN")} net — ${isLast ? "DRAFT" : "PAID"}`,
    );
  }

  // ── Previous employment ────────────────────────────────────────────────────
  let historyCount = 0;
  for (const [i, userId] of userIds.entries()) {
    // Somebody three months out of college has no history; a sales head has two jobs behind them.
    const jobs = ROSTER[i].joinedMonthsAgo < 6 ? 0 : ROSTER[i].joinedMonthsAgo > 40 ? 2 : 1;
    for (let n = 0; n < jobs; n++) {
      const endYear = TODAY.getUTCFullYear() - Math.floor(ROSTER[i].joinedMonthsAgo / 12) - n * 3;
      await db.employmentHistory.create({
        data: {
          userId,
          companyName: pick(PREVIOUS_EMPLOYERS),
          designation: pick(["Executive", "Senior Executive", "Associate", "Engineer", "Analyst"]),
          location: pick(["Mumbai", "Pune", "Bengaluru", "Delhi", "Chennai"]),
          fromDate: new Date(Date.UTC(endYear - int(2, 4), int(0, 11), 1)),
          toDate: new Date(Date.UTC(endYear, int(0, 11), 28)),
          lastDrawnCtc: dec(Math.round(ROSTER[i].gross * 12 * (0.6 + rnd() * 0.25))),
          reasonForLeaving: pick(LEAVING_REASONS),
          referenceName: pick(["Mr. Sharma", "Ms. Nair", "Mr. Gupta", "Ms. Fernandes"]),
          referenceContact: `9${int(100000000, 999999999)}`,
          // Verified for about half — so the queue of unchecked references is not empty.
          verifiedAt: chance(0.55) ? new Date() : null,
          verifiedById: chance(0.55) ? admin.id : null,
        },
      });
      historyCount += 1;
    }
  }
  console.log(`Previous employment: ${historyCount} record(s)`);

  // ── Letters ────────────────────────────────────────────────────────────────
  const org = await db.organisationSettings.findUnique({ where: { id: "global" } });
  let letterCount = 0;
  // Numbered per type per year, the same way draftLetter does it — letterNumber is unique, and two
  // schemes writing to it would collide the first time HR drafted a letter by hand.
  const sequenceByType = new Map<LetterType, number>();
  for (const [i, userId] of userIds.entries()) {
    const profile = await db.employeeProfile.findUniqueOrThrow({ where: { userId } });
    const structure = await db.salaryStructure.findFirstOrThrow({ where: { userId }, orderBy: { effectiveFrom: "desc" } });
    const gross = monthlyGross({
      basic: Number(structure.basic),
      hra: Number(structure.hra),
      conveyance: 0,
      medical: 0,
      specialAllowance: Number(structure.specialAllowance),
      otherAllowance: 0,
    });

    const payload: LetterPayload = {
      employeeName: ROSTER[i].name,
      designation: ROSTER[i].designation,
      department: ROSTER[i].dept,
      employeeCode: profile.employeeCode,
      companyName: org?.legalName || "Wroffy Technologies",
      companyAddress: [org?.addressLine1, org?.city, org?.state].filter(Boolean).join("\n") || null,
      annualCtc: Math.round(gross * 12),
      monthlyGross: gross,
      joinedOn: profile.joinedOn?.toISOString().slice(0, 10) ?? null,
      probationMonths: 6,
      confirmedOn: profile.confirmedOn?.toISOString().slice(0, 10) ?? null,
      reportingTo: ROSTER[i].managerIndex === -1 ? admin.name : ROSTER[ROSTER[i].managerIndex].name,
      workLocation: profile.workLocation,
      signatoryName: admin.name,
      signatoryTitle: "For " + (org?.legalName || "Wroffy Technologies"),
    };

    // Everyone gets an appointment letter; the confirmed also get a confirmation letter.
    const types = profile.confirmedOn ? (["APPOINTMENT", "CONFIRMATION"] as const) : (["APPOINTMENT"] as const);
    for (const type of types) {
      letterCount += 1;
      const sequence = (sequenceByType.get(type) ?? 0) + 1;
      sequenceByType.set(type, sequence);
      const number = letterNumberFor(type, TODAY.getUTCFullYear(), sequence);
      const letter = await db.employeeLetter.create({
        data: {
          userId,
          type,
          letterNumber: number,
          subject: subjectFor(type, payload),
          issuedOn: profile.joinedOn ?? TODAY,
          payload: payload as unknown as Prisma.InputJsonValue,
          body: renderLetter(type, payload),
          status: "ISSUED",
          issuedById: admin.id,
        },
        select: { id: true },
      });
      await db.employeeDocument.create({
        data: {
          userId,
          type: type === "APPOINTMENT" ? "APPOINTMENT_LETTER" : "OTHER",
          name: `${subjectFor(type, payload)} (${number})`,
          fileDataUrl: `letter:${letter.id}`,
          mimeType: "text/letter",
          sizeBytes: 0,
          letterId: letter.id,
          uploadedById: admin.id,
        },
      });
    }
  }
  console.log(`Letters issued: ${letterCount}`);

  // ── Candidates ─────────────────────────────────────────────────────────────
  //
  // Nobody here has a login, which is the whole point of the model: an offer can be made, a form
  // sent and a letter drafted for somebody who may still say no.
  let candidateCount = 0;
  let offerCount = 0;
  for (const c of CANDIDATES) {
    const expectedJoining = new Date(TODAY.getTime() + c.joiningInDays * 86400000);
    const offeredOn = c.status === "PROSPECT" ? null : new Date(TODAY.getTime() - int(8, 25) * 86400000);
    const live = c.linkLive && c.status !== "DECLINED" && c.status !== "WITHDRAWN";
    const city = c.dept === "Support" || c.dept === "Field Ops" ? "Bengaluru" : "Mumbai";

    const candidate = await db.candidate.create({
      data: {
        name: c.name,
        email: c.email,
        phone: `+9198${String(int(10000000, 99999999))}`,
        designation: c.designation,
        departmentId: deptByName.get(c.dept) ?? null,
        employmentType: c.type,
        workLocation: city,
        managerId: c.managerIndex === -1 ? admin.id : userIds[c.managerIndex],
        role: c.role,
        status: c.status,
        source: c.source,
        offeredCtc: dec(c.ctc),
        expectedJoining: dateOnly(expectedJoining),
        offeredOn: offeredOn ? dateOnly(offeredOn) : null,
        acceptedOn: c.status === "ACCEPTED" ? dateOnly(new Date(TODAY.getTime() - int(2, 7) * 86400000)) : null,
        declinedReason: c.declinedReason ?? null,
        notes: c.notes ?? null,
        ownerId: admin.id,
        // A live link is a real token; a submitted form has had its token cleared, which is what
        // the action does and what makes a forwarded link worthless afterwards.
        intakeToken: live ? randomBytes(24).toString("base64url") : null,
        intakeExpiresAt: live ? new Date(TODAY.getTime() + 14 * 86400000) : null,
        intakeSubmittedAt: c.intake ? new Date(TODAY.getTime() - int(1, 5) * 86400000) : null,
        intakeData: c.intake
          ? {
              personalEmail: c.email,
              personalPhone: `+9197${String(int(10000000, 99999999))}`,
              dateOfBirth: `199${int(0, 8)}-0${int(1, 9)}-1${int(0, 8)}`,
              bloodGroup: pick(["O+", "B+", "A+", "AB+"]),
              maritalStatus: pick(["Single", "Married"]),
              addressLine1: `${int(1, 90)}, ${pick(["Shanti Nagar", "Green Park", "MG Road", "Model Colony"])}`,
              city,
              state: city === "Bengaluru" ? "Karnataka" : "Maharashtra",
              pincode: String(int(400001, 400099)),
              emergencyContactName: pick(["Sunita", "Rajesh", "Meena", "Anil"]) + " " + c.name.split(" ")[1],
              emergencyContactPhone: `+9196${String(int(10000000, 99999999))}`,
              emergencyContactRelation: pick(["Spouse", "Father", "Mother"]),
              panNumber: panFor(c.name, candidateCount + 40),
              aadhaarLast4: String(int(1000, 9999)),
              bankName: pick(["HDFC Bank", "ICICI Bank", "Axis Bank"]),
              bankAccountNumber: String(int(10000000000, 99999999999)),
              bankIfsc: pick(["HDFC0001234", "ICIC0004321", "UTIB0000456"]),
            }
          : Prisma.JsonNull,
      },
      select: { id: true },
    });
    candidateCount += 1;

    // A CV for everybody who got as far as an offer — it is what you hired on, and at conversion
    // this same row moves onto their personnel file rather than being copied.
    if (c.status !== "PROSPECT") {
      await db.employeeDocument.create({
        data: {
          candidateId: candidate.id,
          type: "CV",
          name: `${c.name} — CV.pdf`,
          fileDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
          mimeType: "application/pdf",
          sizeBytes: 9,
          uploadedById: admin.id,
        },
      });
    }

    // And an offer letter, drafted against the candidate rather than a user — the thing the
    // candidate record exists to make possible.
    if (c.status === "OFFERED" || c.status === "ACCEPTED") {
      const offerPayload: LetterPayload = {
        employeeName: c.name,
        designation: c.designation,
        department: c.dept,
        employeeCode: null,
        companyName: org?.legalName || "Wroffy Technologies",
        companyAddress: [org?.addressLine1, org?.city, org?.state].filter(Boolean).join("\n") || null,
        annualCtc: c.ctc,
        monthlyGross: Math.round(c.ctc / 12),
        joinedOn: dateOnly(expectedJoining).toISOString().slice(0, 10),
        probationMonths: 6,
        reportingTo: c.managerIndex === -1 ? admin.name : ROSTER[c.managerIndex].name,
        workLocation: city,
        offerValidUntil: new Date(TODAY.getTime() + 14 * 86400000).toISOString().slice(0, 10),
        signatoryName: admin.name,
        signatoryTitle: "For " + (org?.legalName || "Wroffy Technologies"),
      };
      const sequence = (sequenceByType.get("OFFER") ?? 0) + 1;
      sequenceByType.set("OFFER", sequence);
      const offerLetter = await db.employeeLetter.create({
        data: {
          candidateId: candidate.id,
          type: "OFFER",
          letterNumber: letterNumberFor("OFFER", TODAY.getUTCFullYear(), sequence),
          subject: subjectFor("OFFER", offerPayload),
          issuedOn: offeredOn ? dateOnly(offeredOn) : TODAY,
          payload: offerPayload as unknown as Prisma.InputJsonValue,
          body: renderLetter("OFFER", offerPayload),
          // Issued rather than draft: the candidate has it in their hand. An offer sitting in draft
          // would mean nobody has actually been offered anything.
          status: "ISSUED",
          issuedById: admin.id,
        },
        select: { id: true, letterNumber: true },
      });
      // Filed against the candidate, exactly as issueLetter does — an issued letter that is not on
      // a file is a letter nobody can produce when it is asked for.
      await db.employeeDocument.create({
        data: {
          candidateId: candidate.id,
          type: "OFFER_LETTER",
          name: `${subjectFor("OFFER", offerPayload)} (${offerLetter.letterNumber})`,
          fileDataUrl: `letter:${offerLetter.id}`,
          mimeType: "text/letter",
          sizeBytes: 0,
          letterId: offerLetter.id,
          uploadedById: admin.id,
        },
      });
      offerCount += 1;
    }
  }
  console.log(`Candidates: ${candidateCount} (${offerCount} with an offer letter)`);

  // ── Celebrations ───────────────────────────────────────────────────────────
  //
  // Only the ones nobody can compute. Birthdays and anniversaries are already on the employee
  // records seeded above, and holidays are on the calendar — seeding them again as celebration rows
  // would be seeding the same fact twice and inviting the two to disagree.
  const celebrations = [
    {
      kind: "MILESTONE" as const,
      audience: "EVERYONE" as const,
      title: "We crossed 500 customers",
      message: "Eleven years, and the five hundredth company signed this week. Thank you, all of you.",
      accent: "#3b82f6",
      subjectUserId: null as string | null,
      departmentId: null as string | null,
      from: -2,
      to: 2,
    },
    {
      kind: "ACHIEVEMENT" as const,
      audience: "EVERYONE" as const,
      title: "Biggest renewal of the year",
      message: "A three-year Microsoft 365 renewal, closed against two other bidders.",
      accent: "#10b981",
      subjectUserId: userIds[5],
      departmentId: null,
      from: 0,
      to: 3,
    },
    {
      kind: "ACHIEVEMENT" as const,
      audience: "DEPARTMENT" as const,
      title: "Every ticket cleared",
      message: "Support closed the queue for the first time since March. Not one ticket older than a day.",
      accent: "#06b6d4",
      subjectUserId: null,
      departmentId: deptByName.get("Support") ?? null,
      from: 0,
      to: 1,
    },
    {
      kind: "FESTIVAL" as const,
      audience: "EVERYONE" as const,
      title: "Happy Diwali",
      message: "The office is closed on Monday and Tuesday. Have a good one, and stay safe with the fireworks.",
      accent: "#f59e0b",
      subjectUserId: null,
      departmentId: null,
      from: 30,
      to: 33,
    },
    {
      kind: "WELCOME" as const,
      audience: "EVERYONE" as const,
      title: "A new face in Sales",
      message: "Joining us as an Account Executive. Say hello if you pass the third floor.",
      accent: "#8b5cf6",
      subjectUserId: null,
      departmentId: null,
      from: 12,
      to: 14,
    },
  ];

  for (const c of celebrations) {
    await db.celebration.create({
      data: {
        kind: c.kind,
        audience: c.audience,
        title: c.title,
        message: c.message,
        accent: c.accent,
        subjectUserId: c.subjectUserId,
        departmentId: c.departmentId,
        startsOn: dateOnly(new Date(TODAY.getTime() + c.from * 86400000)),
        endsOn: dateOnly(new Date(TODAY.getTime() + c.to * 86400000)),
        createdById: admin.id,
      },
    });
  }
  console.log(`Celebrations: ${celebrations.length}`);

  // ── Letterhead ─────────────────────────────────────────────────────────────
  //
  // Set so a letter prints on something that looks like company paper out of the box. The logo is
  // left alone — it is an image somebody has to supply, and a placeholder mark on a real
  // appointment letter would be worse than none.
  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      legalName: org?.legalName || "Wroffy Technologies Private Limited",
      letterNumberPrefix: "WRF",
      letterSignatoryName: ROSTER[3].name,
      letterSignatoryTitle: ROSTER[3].designation,
    },
    update: {
      letterNumberPrefix: "WRF",
      // The HR manager on the roster, so letters are signed by the person who would really sign
      // them rather than by whichever colleague pressed the button.
      letterSignatoryName: ROSTER[3].name,
      letterSignatoryTitle: ROSTER[3].designation,
    },
  });
  console.log(`Letterhead: signed by ${ROSTER[3].name}`);
}



// ─── Verify ───────────────────────────────────────────────────────────────────

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };

  console.log("\n— Verifying —");

  const people = await db.user.count({ where: { email: { in: ROSTER.map((r) => r.email) } } });
  ok("everyone was created", people === ROSTER.length, `${people}/${ROSTER.length}`);

  const withProfile = await db.employeeProfile.count({ where: { employeeCode: { startsWith: CODE_PREFIX } } });
  ok("everyone has an employee record", withProfile === ROSTER.length, `${withProfile}`);

  const orphanManagers = await db.user.count({
    where: { email: { in: ROSTER.map((r) => r.email) }, managerId: null },
  });
  ok("everyone reports to somebody", orphanManagers === 0, `${orphanManagers} without a manager`);

  // Every approved leave day that has already happened has an attendance row.
  //
  // Only the past ones: leave booked for next month is approved but not yet attended, and demanding
  // a row for it would be demanding a record of a day nobody has lived through. That distinction is
  // the same one the rest of the app makes — an unrecorded future day is not a missing day.
  const approvedLeave = await db.leaveRequest.findMany({
    where: { status: "APPROVED" },
    select: { id: true, fromDate: true, toDate: true },
  });
  const holidayKeys = new Set(
    (await db.holiday.findMany({ where: { optional: false }, select: { date: true } })).map((h) => toKey(h.date)),
  );
  const expectedLeaveDays = approvedLeave.reduce(
    (total, r) =>
      total +
      eachDay(r.fromDate, r.toDate).filter(
        (d) => d <= TODAY && !isWeekOff(d) && !holidayKeys.has(toKey(d)),
      ).length,
    0,
  );
  const leaveAttendance = await db.attendanceDay.count({ where: { leaveRequestId: { not: null } } });
  ok(
    "every past approved leave day wrote its attendance",
    leaveAttendance === expectedLeaveDays,
    `${leaveAttendance} rows for ${expectedLeaveDays} elapsed day(s)`,
  );

  // A balance can never be overdrawn on a paid type.
  const overdrawn = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM leave_balances b
    JOIN leave_types t ON t.id = b."typeId"
    WHERE t.paid = true AND b.used > b.opening + b.credited + b.adjustment`;
  ok("no paid balance is overdrawn", Number(overdrawn[0].count) === 0, `${overdrawn[0].count} overdrawn`);

  // No attendance on a weekend or a company holiday.
  const holidays = await db.holiday.findMany({ where: { optional: false }, select: { date: true } });
  const closedKeys = new Set(holidays.map((h) => toKey(h.date)));
  const allDays = await db.attendanceDay.findMany({ select: { date: true } });
  const onOffDays = allDays.filter((d) => isWeekOff(dateOnly(d.date)) || closedKeys.has(toKey(d.date))).length;
  ok("nothing recorded on a weekend or holiday", onOffDays === 0, `${onOffDays} row(s)`);

  // Every payslip's arithmetic still adds up.
  const slips = await db.payslip.findMany({
    select: { grossEarnings: true, totalDeductions: true, netPay: true, paidDays: true, lopDays: true, monthDays: true, pfEmployee: true, basic: true },
  });
  const badNet = slips.filter((s) => Math.abs(Number(s.grossEarnings) - Number(s.totalDeductions) - Number(s.netPay)) > 0.01).length;
  ok("net = gross − deductions on every payslip", badNet === 0, `${slips.length} checked`);

  const badDays = slips.filter((s) => Math.abs(Number(s.paidDays) + Number(s.lopDays) - Number(s.monthDays)) > 0.01).length;
  ok("paid days + LOP = days in the month", badDays === 0);

  const badPf = slips.filter((s) => Number(s.pfEmployee) > 1800.01).length;
  ok("no PF above the ₹15,000 ceiling", badPf === 0, `${badPf} over`);

  // The payslip's LOP must match what the attendance actually says.
  let lopMismatch = 0;
  for (const { month, year } of MONTHS) {
    const runSlips = await db.payslip.findMany({
      where: { run: { month, year } },
      select: { userId: true, lopDays: true },
    });
    for (const slip of runSlips) {
      const actual = await lossOfPayDays(slip.userId, year, month);
      if (Math.abs(actual - Number(slip.lopDays)) > 0.01) lopMismatch += 1;
    }
  }
  ok("every payslip's LOP matches the attendance behind it", lopMismatch === 0, `${lopMismatch} mismatch(es)`);

  // Biometric punches line up with the day they were rolled into.
  const punches = await db.biometricPunch.count({ where: { userId: { not: null } } });
  const unmatched = await db.biometricPunch.count({ where: { userId: null } });
  ok("punches are matched to people", unmatched === 0, `${punches} matched, ${unmatched} unmatched`);

  // Only issued ones: a draft is HR's working copy and is filed at the moment it is issued, so
  // counting drafts here would demand a document for a letter nobody has sent yet.
  const issued = await db.employeeLetter.count({ where: { status: "ISSUED" } });
  const letterDocs = await db.employeeDocument.count({ where: { letterId: { not: null } } });
  ok("every issued letter is filed on the personnel file", issued === letterDocs, `${issued} issued, ${letterDocs} filed`);

  const numbers = await db.employeeLetter.findMany({ select: { letterNumber: true } });
  ok("every letter number is unique", new Set(numbers.map((l) => l.letterNumber)).size === numbers.length, `${numbers.length} letter(s)`);

  const frozen = await db.employeeLetter.findFirst({ where: { type: "APPOINTMENT" }, select: { payload: true, body: true } });
  const payloadCtc = (frozen?.payload as { annualCtc?: number } | null)?.annualCtc ?? 0;
  ok("a letter froze the salary it asserts", payloadCtc > 0, `₹${payloadCtc.toLocaleString("en-IN")} in the payload`);
  ok("and the body actually quotes it", !!frozen?.body.includes(payloadCtc.toLocaleString("en-IN")), "so re-rendering cannot restate it");

  const history = await db.employmentHistory.count();
  const verified = await db.employmentHistory.count({ where: { verifiedAt: { not: null } } });
  ok("previous employment recorded", history > 0, `${history} record(s), ${verified} verified`);

  const runs = await db.payrollRun.findMany({ select: { month: true, year: true, status: true, _count: { select: { payslips: true } } }, orderBy: [{ year: "asc" }, { month: "asc" }] });
  ok("three payroll runs, the last a draft", runs.length === 3 && runs.at(-1)?.status === "DRAFT", runs.map((r) => `${r.year}-${r.month} ${r.status} (${r._count.payslips})`).join(", "));


  // ── Hiring ─────────────────────────────────────────────────────────────────

  const candidates = await db.candidate.findMany({
    where: { email: { in: CANDIDATES.map((c) => c.email) } },
    select: { id: true, name: true, email: true, status: true, intakeToken: true, intakeSubmittedAt: true, convertedUserId: true },
  });
  ok("the hiring pipeline was seeded", candidates.length === CANDIDATES.length, `${candidates.length}/${CANDIDATES.length}`);

  // Nobody in the pipeline has a login. This is the property the whole candidate model exists for:
  // an offer to somebody who may decline must not leave an account behind.
  const candidateLogins = await db.user.count({ where: { email: { in: CANDIDATES.map((c) => c.email) } } });
  ok("no candidate has a login", candidateLogins === 0, candidateLogins === 0 ? "none, as it should be" : `${candidateLogins} account(s) exist`);

  // A submitted form has had its token cleared — which is what makes a forwarded link worthless the
  // day after it is used.
  const submittedWithLiveToken = candidates.filter((c) => c.intakeSubmittedAt && c.intakeToken).length;
  ok("a submitted intake link is dead", submittedWithLiveToken === 0, `${submittedWithLiveToken} still live`);

  const deadEndsWithToken = candidates.filter(
    (c) => (c.status === "DECLINED" || c.status === "WITHDRAWN") && c.intakeToken,
  ).length;
  ok("nobody out of the process holds a live link", deadEndsWithToken === 0, `${deadEndsWithToken} still live`);

  const offers = await db.employeeLetter.findMany({
    where: { type: "OFFER" },
    select: { candidateId: true, userId: true, payload: true },
  });
  ok(
    "offer letters belong to a candidate, not a user",
    offers.length > 0 && offers.every((l) => l.candidateId && !l.userId),
    `${offers.length} offer letter(s)`,
  );

  const offerCtc = (offers[0]?.payload as { annualCtc?: number } | null)?.annualCtc ?? 0;
  ok("an offer letter states the pay", offerCtc > 0, `₹${offerCtc.toLocaleString("en-IN")}`);

  // A candidate's document is HR-only by construction: access() answers "HR" for a row with no
  // userId, so this asserts the rows really are owned that way rather than by a user.
  const candidateDocs = await db.employeeDocument.findMany({
    where: { candidateId: { not: null } },
    select: { userId: true },
  });
  ok(
    "candidate documents have no employee owner",
    candidateDocs.length > 0 && candidateDocs.every((d) => d.userId === null),
    `${candidateDocs.length} document(s)`,
  );

  const accepted = candidates.filter((c) => c.status === "ACCEPTED").length;
  ok("somebody is ready to convert", accepted > 0, `${accepted} accepted offer(s)`);


  // ── Celebrations ───────────────────────────────────────────────────────────

  const posted = await db.celebration.count();
  ok("celebrations were posted", posted > 0, `${posted}`);

  // Only what cannot be computed. A birthday stored as a celebration row would be the same fact in
  // two places, and the day somebody corrects a date of birth the two would disagree.
  const derivedAsRows = await db.celebration.count({
    where: { OR: [{ title: { contains: "birthday", mode: "insensitive" } }, { title: { contains: "anniversary", mode: "insensitive" } }] },
  });
  ok("no birthday or anniversary was stored as a row", derivedAsRows === 0, "they come off the employee record");

  const misdirected = await db.celebration.count({
    where: { OR: [{ audience: "DEPARTMENT", departmentId: null }, { audience: "PERSON", subjectUserId: null }] },
  });
  ok("every targeted celebration has a target", misdirected === 0, `${misdirected} with nobody to show it to`);

  const backwards = (await db.celebration.findMany({ select: { startsOn: true, endsOn: true } })).filter(
    (c) => c.endsOn < c.startsOn,
  ).length;
  ok("none of them end before they start", backwards === 0);

  // Somebody has to have a birthday on file, or the whole feature is invisible.
  const withDob = await db.employeeProfile.count({ where: { dateOfBirth: { not: null } } });
  ok("people have birthdays on file", withDob > 0, `${withDob}/${ROSTER.length}`);

  const settings = await db.organisationSettings.findUnique({
    where: { id: "global" },
    select: { letterNumberPrefix: true, letterSignatoryName: true },
  });
  ok("the letterhead is configured", !!settings?.letterSignatoryName, `${settings?.letterNumberPrefix}, signed by ${settings?.letterSignatoryName}`);

  const numbered = await db.employeeLetter.findMany({ select: { letterNumber: true }, take: 5 });
  ok(
    "letter numbers carry the prefix",
    numbered.every((l) => l.letterNumber.startsWith(settings?.letterNumberPrefix ?? "WRF")),
    numbered[0]?.letterNumber,
  );

  console.log(failures === 0 ? "\nAll HR seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});

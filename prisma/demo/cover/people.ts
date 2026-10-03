import { randomUUID } from "node:crypto";
import { Prisma, type EmploymentType, type ExitType, type ExpenseCategory, type ExpensePaymentMode, type Gender, type LetterType, type PrismaClient } from "@prisma/client";
import type { DemoContext } from "../context";
import { chance, daysAgo, DEMO_EMAIL_DOMAIN, int, log, pick, rnd, some, TODAY, FIRST_NAMES, LAST_NAMES, phone } from "../shared";
import { addDays, closedDates, countLeaveDays, dateOnly, daysInMonth, eachDay, financialYearOf, isWeekOff, monthLabel, monthRange, toKey } from "../../../src/lib/hr/calendar";
import { computePayslip, monthlyGross, type SalaryComponents } from "../../../src/lib/hr/payroll";
import { letterNumberFor, renderLetter, subjectFor, type LetterPayload } from "../../../src/lib/hr/letters";
import { OFFBOARDING_TASKS, ONBOARDING_TASKS } from "../../../src/lib/hr/onboarding";
import { computeSettlement } from "../../../src/lib/hr/settlement";
import { indiaClock } from "../../../src/lib/time/zone";
import { HANDOVER_AREAS } from "../../../src/lib/handover/areas";
import { postPayrollPaymentToLedger, postPayrollToLedger, postExpenseReimbursementToLedger, postExpenseToLedger } from "../../../src/lib/ledger/journal";
import { computeIncentive, validateScheme, type Scheme } from "../../../src/lib/incentives/compute";
import { measure, subjectUserIds } from "../../../src/lib/targets/measure";
import { metricByKey, monthWindow, quarterWindow, yearWindow } from "../../../src/lib/targets/metrics";
import { areaLeader, entryOf, announcementCopy, winnerCopy, fortnightByKey, rank, type ActivityCounts, type Fortnight, NO_ACTIVITY } from "../../../src/lib/performance/awards";
import { periodByKey, prizesFor, RACE_LABEL, slotLabel, upForGrabsCopy, topSellerNote, type Slot } from "../../../src/lib/wins/prizes";
import { dealWonCopy, firstOrderCopy, inrSpoken, targetHitCopy, topPerformerCopy } from "../../../src/lib/wins/copy";
import { birthdayKey, anniversaryKey, celebrationKey, holidayKey } from "../../../src/lib/hr/celebrations";
import { formatTicketId, SLA_HOURS } from "../../../src/lib/tickets";
import { formatVisitId } from "../../../src/lib/visits";
import { tradeDocumentLabels } from "../../../src/lib/trade-documents";
import { expenseCategoryLabels, formatExpenseId } from "../../../src/lib/expenses";
import { checkLink } from "../../../src/lib/help/links";
import { generateCode } from "../../../src/lib/visitors/invite-code";
import { normaliseCompany } from "../../../src/lib/visitors/company-name";
import { deviceKindFrom, deviceLabel } from "../../../src/lib/access/device";
import { hashDeviceToken, newDeviceToken } from "../../../src/lib/access/device-token";
import { getPermissionDefinition } from "../../../src/lib/permissions";
import type { Tenant } from "../../../src/lib/tenancy/state";

/**
 * Fifty people and the year they have actually had.
 *
 * The demo seed puts fifty people on the payroll and gives them sixty days of attendance and two
 * payslips. That is a snapshot, not a year: nobody joined, nobody was confirmed, promoted, moved or
 * let go, and a payroll register with two months in it cannot answer the question anybody asks of one
 * ("what did we pay in March?"). This fills the year in, hanging everything off the same people:
 *
 *   · **Journeys** — joining dates spread across the year (and before it, for the people who built the
 *     place), probation and confirmation, the April appraisal, promotions and transfers, interns,
 *     contractors and a consultant, a maternity leave on the way, and four people who left in four
 *     different ways — each made inactive, handed over and offboarded the way the app does it.
 *   · **Attendance and leave** — every working day of the year for everybody employed on it, on the
 *     app's own calendar (Saturday and Sunday off, closed holidays, approved leave on the days it
 *     covers), with corrections in every state.
 *   · **Payroll** — a run for every month, through the app's own engine (`computePayslip`, loss of pay
 *     read from the attendance written here, approved incentives paid with the salary), posted to the
 *     books by the app's own posting functions; this month's run is still a draft.
 *   · **Paperwork, hiring, targets and incentives, wins, engagement, expenses, reception, vault, the
 *     company's own news and guides**, and the **activity trail** all of that would have left behind.
 *
 * ## Why the app's own pieces, and only the pure ones
 *
 * Everything computed here is computed by the app's code — letters by `renderLetter`, payslips by
 * `computePayslip`, settlements by `computeSettlement`, incentives by `computeIncentive` over
 * `measure`, rankings by `rank` — so a figure on any screen reconciles with the records under it.
 * But only the pieces that are pure or take a client: the app's server-side helpers that write
 * (`recordAudit`, `notifyUser`, `lossOfPayDays` …) go through the workspace proxy, which outside a
 * request resolves the *default workspace* — the real one, not the database this seed was pointed at.
 * Those writes are reproduced here, row for row, on this seed's own client. The one app function used
 * here that asks for the workspace at all — `measure`, for the workspace's clock — runs inside
 * `runAsTenant` with this database as the workspace (`pinned`), so it never looks anywhere else.
 *
 * ## Re-running
 *
 * Each part checks for the rows it writes and steps aside when they are already there.
 */

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────────

const dec = (v: number) => new Prisma.Decimal(Math.round(v * 100) / 100);
const num = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : Number(v));
const DAY = 86_400_000;
/** A `yyyy-mm-dd` as a `@db.Date` holds it. */
const D = (key: string) => new Date(`${key}T00:00:00.000Z`);
/** Today on the workspace's calendar (India's — the demo workspace's zone), as a `@db.Date`. */
const TODAY_D = indiaClock.calendarDate(TODAY);
const TODAY_KEY = toKey(TODAY_D);
/** The first day of the year this seed fills in — the day the demo company opened. */
const START_D = indiaClock.calendarDate(daysAgo(365));
/** A wall-clock time in India on a calendar day — how every typed time in the app is read. */
const at = (day: Date, hour: number, minute = 0) =>
  indiaClock.at(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
/** A moment during the working day, on a calendar day. */
const workMoment = (day: Date, from = 10, to = 18) => at(day, int(from, to - 1), int(0, 59));
const iso = (d: Date | null | undefined) => (d ? toKey(d) : null);
const yearsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (365.25 * DAY);
const minDate = (...ds: Date[]) => new Date(Math.min(...ds.map((d) => d.getTime())));
const maxDate = (...ds: Date[]) => new Date(Math.max(...ds.map((d) => d.getTime())));
/** Monday to Friday, not a closed holiday — the days an attendance row is expected on. */
let CLOSED = new Set<string>();
const isWorkingDay = (d: Date) => !isWeekOff(d) && !CLOSED.has(toKey(d));
/** The working day on or before a date. */
function workingOnOrBefore(d: Date): Date {
  let day = dateOnly(d);
  while (!isWorkingDay(day)) day = addDays(day, -1);
  return day;
}
function workingOnOrAfter(d: Date): Date {
  let day = dateOnly(d);
  while (!isWorkingDay(day)) day = addDays(day, 1);
  return day;
}

async function inChunks<T>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

/** The 1–12 month and year an instant falls in, on India's calendar (payroll stays on India's clock). */
function monthOf(d: Date) {
  const p = indiaClock.parts(d);
  return { month: p.month + 1, year: p.year };
}

const FEMALE = new Set([
  "Aditi", "Ananya", "Bhavna", "Deepa", "Divya", "Jyoti", "Kavya", "Lakshmi", "Meera", "Neha", "Nisha",
  "Pooja", "Priya", "Riya", "Shalini", "Shreya", "Sneha", "Swati", "Tanvi", "Zoya",
]);

// ─── Who is here ─────────────────────────────────────────────────────────────────────────────────

type Person = {
  id: string;
  name: string;
  first: string;
  email: string;
  role: string;
  active: boolean;
  deptId: string | null;
  dept: string;
  title: string;
  managerId: string | null;
  isManager: boolean;
  createdAt: Date;
  /** What the record says now — re-read after the journeys are written. */
  joinedOn: Date;
  confirmedOn: Date | null;
  probationEndsOn: Date | null;
  exitedOn: Date | null;
  exitType: ExitType | null;
  type: EmploymentType;
  state: string | null;
  workLocation: string | null;
  employeeCode: string | null;
  noticePeriodDays: number;
  gender: Gender | null;
};

async function loadPeople(db: PrismaClient): Promise<Person[]> {
  const users = await db.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      departmentId: true,
      managerId: true,
      createdAt: true,
      department: { select: { name: true } },
      employeeProfile: true,
      _count: { select: { directReports: true } },
    },
  });
  return users.map((u) => {
    const p = u.employeeProfile;
    return {
      id: u.id,
      name: u.name,
      first: u.name.split(" ")[0]!,
      email: u.email,
      role: u.role,
      active: u.active,
      deptId: u.departmentId,
      dept: u.department?.name ?? "",
      title: p?.designation ?? "",
      managerId: u.managerId,
      isManager: u._count.directReports > 0,
      createdAt: u.createdAt,
      joinedOn: p?.joinedOn ?? START_D,
      confirmedOn: p?.confirmedOn ?? null,
      probationEndsOn: p?.probationEndsOn ?? null,
      exitedOn: p?.exitedOn ?? null,
      exitType: p?.exitType ?? null,
      type: p?.employmentType ?? "FULL_TIME",
      state: p?.state ?? null,
      workLocation: p?.workLocation ?? null,
      employeeCode: p?.employeeCode ?? null,
      noticePeriodDays: p?.noticePeriodDays ?? 30,
      gender: p?.gender ?? null,
    };
  });
}

/** Employed on a calendar day: joined by then, and not yet gone. */
const employedOn = (p: Person, day: Date) => p.joinedOn <= day && (!p.exitedOn || p.exitedOn >= day);

/**
 * This database as the workspace, for the app functions that ask `currentTenant()` — in this file only
 * `measure`, which reads the workspace's clock. Outside a request the app resolves the *default*
 * workspace (DESKZO_TENANCY_FALLBACK); inside `runAsTenant` it is this one, so nothing is read from
 * anywhere but the database this seed was pointed at.
 */
async function pinnedToThisDatabase(): Promise<<T>(fn: () => Promise<T>) => Promise<T>> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL — the people cover seed runs against the database the demo seed was given.");
  const { runAsTenant } = await import("../../../src/lib/tenancy/resolve");
  const tenant: Tenant = {
    id: "demo-seed-people",
    slug: "demo",
    name: "Demo",
    status: "ACTIVE",
    dbUrl: url,
    primaryHost: "demo.localhost",
    hosts: ["demo.localhost"],
    source: "env",
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    timezone: indiaClock.zone,
    entitlements: { v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  return (fn) => runAsTenant(tenant, async () => await fn());
}

/** Everything the seed shares between its parts. */
type Run = {
  db: PrismaClient;
  ctx: DemoContext;
  /** Runs an app function as this database's workspace — see `pinnedToThisDatabase`. */
  ws: <T>(fn: () => Promise<T>) => Promise<T>;
  people: Person[];
  byId: Map<string, Person>;
  hr: Person;
  hrExec: Person;
  controller: Person;
  director: Person;
  org: { companyName: string; companyAddress: string | null; prefix: string; signatoryName: string | null; signatoryTitle: string | null };
  holidays: { id: string; name: string; date: Date; optional: boolean }[];
  /** What the journeys decided, for the letters written later. Null when an earlier run wrote them. */
  facts: JourneyFacts | null;
  /** Each target's achievement when it was set, by target id — the wins reuse it rather than measure twice. */
  achieved: Map<string, number>;
  audits: Prisma.AuditLogCreateManyInput[];
  notes: Prisma.NotificationCreateManyInput[];
};

function find(people: Person[], title: string, fallback?: Person): Person {
  const found = people.find((p) => p.title === title) ?? fallback ?? people[0];
  if (!found) throw new Error("No demo people.");
  return found;
}

/** An audit row, exactly as `recordAudit` writes it — no impersonation, the moment it happened. */
function audit(run: Run, userId: string, action: "CREATE" | "UPDATE" | "DELETE", entityType: string, entityId: string, entityLabel: string, createdAt: Date) {
  run.audits.push({ userId, action, entityType, entityId, entityLabel, createdAt });
}

/** A notification, as `notifyUser` writes it. Read when it is old enough that anybody would have. */
function notify(run: Run, userId: string, type: Prisma.NotificationCreateManyInput["type"], title: string, message: string | null, link: string | null, createdAt: Date, dedupeKey?: string) {
  const ageDays = (TODAY.getTime() - createdAt.getTime()) / DAY;
  const read = ageDays > 6 ? chance(0.93) : ageDays > 1 ? chance(0.5) : chance(0.15);
  run.notes.push({
    userId,
    type,
    title,
    message,
    link,
    createdAt,
    read,
    readAt: read ? new Date(Math.min(TODAY.getTime() - 60_000, createdAt.getTime() + int(5, 60 * 30) * 60_000)) : null,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
}

async function flushTrail(run: Run) {
  const audits = run.audits.splice(0);
  const notes = run.notes.splice(0);
  await inChunks(audits, 1000, (c) => run.db.auditLog.createMany({ data: c }));
  await inChunks(notes, 1000, (c) => run.db.notification.createMany({ data: c }));
  return { audits: audits.length, notes: notes.length };
}

// ─── The entry point ─────────────────────────────────────────────────────────────────────────────

export default async function seedPeopleYear(db: PrismaClient, ctx: DemoContext): Promise<void> {
  const people = await loadPeople(db);
  if (people.length === 0) return;

  const orgRow = await db.organisationSettings.findUnique({ where: { id: "global" } });
  const companyName = orgRow?.legalName || "the company";
  const run: Run = {
    db,
    ctx,
    ws: await pinnedToThisDatabase(),
    people,
    byId: new Map(people.map((p) => [p.id, p])),
    hr: find(people, "HR Manager"),
    hrExec: find(people, "HR Executive", find(people, "HR Manager")),
    controller: find(people, "Finance Controller"),
    director: find(people, "Director"),
    org: {
      companyName,
      companyAddress: [orgRow?.addressLine1, orgRow?.addressLine2, orgRow?.city, orgRow?.state, orgRow?.pincode].filter(Boolean).join("\n") || null,
      prefix: orgRow?.letterNumberPrefix || "WRF",
      signatoryName: orgRow?.letterSignatoryName ?? null,
      signatoryTitle: orgRow?.letterSignatoryTitle ?? null,
    },
    holidays: [],
    facts: null,
    achieved: new Map(),
    audits: [],
    notes: [],
  };

  await calendar(run);
  await journeys(run);
  await leave(run);
  await attendance(run);
  await targetsAndIncentives(run);
  await payroll(run);
  await settlements(run);
  await paperwork(run);
  await hiring(run);
  await engagement(run);
  await expenses(run);
  await reception(run);
  await vault(run);
  await companyContent(run);
  await trails(run);
  await wins(run);
}

// ─── The calendar ────────────────────────────────────────────────────────────────────────────────

/**
 * Last year's part of the holiday calendar.
 *
 * The demo writes this year's holidays only, so the three months of last year that the company has
 * existed had no Diwali and no Christmas — and every one of those days would have read as a working
 * day nobody turned up for. The same list, a year earlier, for the dates inside the year being filled.
 */
async function calendar(run: Run) {
  const { db } = run;
  const thisYear = TODAY_D.getUTCFullYear();
  const current = await db.holiday.findMany({ select: { name: true, date: true, optional: true } });
  let added = 0;
  for (const h of current.filter((x) => x.date.getUTCFullYear() === thisYear)) {
    const earlier = new Date(Date.UTC(thisYear - 1, h.date.getUTCMonth(), h.date.getUTCDate()));
    if (earlier < START_D) continue;
    const exists = await db.holiday.findUnique({ where: { date_name: { date: earlier, name: h.name } }, select: { id: true } });
    if (exists) continue;
    await db.holiday.create({ data: { name: h.name, date: earlier, optional: h.optional } });
    added += 1;
  }
  run.holidays = await db.holiday.findMany({ select: { id: true, name: true, date: true, optional: true }, orderBy: { date: "asc" } });
  CLOSED = closedDates(run.holidays);
  log("Holiday calendar", `${added} of last year's holidays added — ${run.holidays.length} on the calendar`);
}

// ─── Journeys ────────────────────────────────────────────────────────────────────────────────────

/** Where people sit. State matters: professional tax is by the state somebody works in. */
const OFFICES = {
  hq: { label: "Mumbai — Andheri East (head office)", city: "Mumbai", state: "Maharashtra", pin: "4000" },
  pune: { label: "Pune office", city: "Pune", state: "Maharashtra", pin: "4110" },
  blr: { label: "Bengaluru office", city: "Bengaluru", state: "Karnataka", pin: "5600" },
  ncr: { label: "Delhi NCR — field", city: "Delhi", state: "Delhi", pin: "1100" },
} as const;
type OfficeKey = keyof typeof OFFICES;

const LOCALITIES = ["MG Road", "Shanti Nagar", "Green Park", "Model Colony", "Lake View Society", "Sector 21", "Station Road", "Rose Apartments", "Hill View", "Gandhi Nagar"];
const BANKS: [string, string][] = [["HDFC Bank", "HDFC0001234"], ["ICICI Bank", "ICIC0004321"], ["Axis Bank", "UTIB0000456"], ["State Bank of India", "SBIN0001888"], ["Kotak Mahindra Bank", "KKBK0000652"]];

/** Years of service before the year began, for the people who built the place. */
const BEFORE: Record<string, number> = {
  Director: 7.6,
  "General Manager": 5.2,
  "Head of Sales": 3.4,
  "Finance Controller": 2.7,
  "HR Manager": 2.2,
  "Inside Sales Lead": 1.9,
  "Purchase Manager": 1.6,
  "Office Admin": 12.3,
};

/** What somebody in that seat was warned for, and let go over — in that seat's own terms. */
function misconductOf(title: string): { short: string; warning: string; termination: string } {
  if (/Support|Field/.test(title)) {
    return {
      short: "repeated SLA breaches on assigned tickets",
      warning: "Three priority tickets breached their response time in one week, and you were absent on two working days without informing your lead.",
      termination: "Continued SLA breaches after the final written warning of last month.",
    };
  }
  if (/Calling/.test(title)) {
    return {
      short: "call logs recorded for calls that were never made",
      warning: "Eleven calls logged as connected last week have no matching call on the dialler records.",
      termination: "Call logs continued to be recorded for calls that were never made, after the final written warning.",
    };
  }
  return {
    short: "work not done after repeated reminders",
    warning: "Month-end reconciliations were missed twice in a row without telling your manager.",
    termination: "The work set out in last month's written warning was again not done.",
  };
}

function panFor(name: string, i: number) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const [first, last] = name.toUpperCase().split(" ");
  return `${letters[i % 26]}${letters[(i * 7) % 26]}${letters[(i * 11) % 26]}P${(last ?? "X")[0]}${String(1000 + ((i * 37) % 9000)).padStart(4, "0")}${(first ?? "X")[0]}`;
}

/** What the journeys decided, for the letters written later. */
type JourneyFacts = {
  hikes: Map<string, { previousGross: number; gross: number; on: Date }>;
  promotions: Map<string, { from: string; to: string }>;
  transfers: Map<string, { from: string; to: string }>;
  extension: { person: Person; originalEnd: Date; until: Date } | null;
  exits: Map<string, { type: ExitType; on: Date; recordedOn: Date; reason: string }>;
  appraisal: Date;
  transferOn: Date;
  maternity: { person: Person; from: Date; to: Date; letterOn: Date } | null;
};

async function journeys(run: Run) {
  const { db, people } = run;
  if (people.some((p) => p.gender)) {
    log("Journeys", "already written — left as they are");
    return;
  }

  // What each person did themselves, first and last — a joining date after somebody's first call, or a
  // leaving date before their last one, is the kind of thing a demo is caught out by.
  const acts = await db.$queryRaw<{ u: string; first: Date; last: Date }[]>`
    with a as (
      select "createdByUserId" u, "createdAt" t from leads
      union all select "userId", "createdAt" from call_logs
      union all select "userId", "createdAt" from visits
      union all select "createdByUserId", "createdAt" from tasks
      union all select "userId", "spentOn" from expenses
      union all select "createdByUserId", "createdAt" from tickets
      union all select "userId", "createdAt" from activities
      union all select "createdById", "createdAt" from trade_documents
      union all select "userId", "fromDate" from leave_requests
      union all select "ownerUserId", "createdAt" from sticky_notes
      union all select "recordedByUserId", "createdAt" from payments
      union all select "createdById", "createdAt" from projects
      union all select "createdByUserId", "createdAt" from contacts
      union all select "userId", "date" from attendance_regularisations
    )
    select u, min(t) as first, max(t) as last from a where u is not null group by u`;
  const firstAct = new Map(acts.map((a) => [a.u, dateOnly(a.first)]));
  const lastAct = new Map(acts.map((a) => [a.u, dateOnly(a.last)]));

  const serving = people.find((p) => p.exitedOn && p.exitedOn > TODAY_D) ?? null;
  const lastMonthStart = new Date(Date.UTC(TODAY_D.getUTCFullYear(), TODAY_D.getUTCMonth() - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(TODAY_D.getUTCFullYear(), TODAY_D.getUTCMonth(), 0));
  const yesterday = workingOnOrBefore(addDays(TODAY_D, -1));

  // ── Who leaves, and how ─────────────────────────────────────────────────────────────────────
  /**
   * Four people, in the last completed month and no earlier — on purpose. The two payroll runs the demo
   * already locked and posted to the books paid everybody, and the app pays anybody who was still here
   * on the first of a month (src/actions/payroll.ts). Somebody gone in June with a September payslip on
   * the ledger is a state the app cannot produce; somebody who left in September and was paid for it
   * is exactly the state it does produce.
   */
  const POOL = ["Support Engineer", "Field Engineer", "Calling Executive", "Data Profiler", "Accounts Executive", "Purchase Executive"];
  const seatCount = (title: string) => people.filter((p) => p.title === title).length;
  const lastOf = (p: Person) => lastAct.get(p.id) ?? START_D;
  const retiree = people.find((p) => p.title === "Office Admin" && !p.isManager && !p.exitedOn) ?? null;
  const byLastActivity = (a: Person, b: Person) => lastOf(a).getTime() - lastOf(b).getTime();
  // The intern whose term ran out came in during the year, on the floor that takes interns.
  const internLeaver = people
    .filter((p) => ["Data Profiler", "Calling Executive"].includes(p.title) && !p.isManager && !p.exitedOn && (firstAct.get(p.id) ?? START_D) >= START_D)
    .sort(byLastActivity)[0];
  const takenTitles = new Set<string>(internLeaver ? [internLeaver.title] : []);
  const others = people
    .filter((p) => POOL.includes(p.title) && !p.isManager && !p.exitedOn && p !== retiree && p !== internLeaver && seatCount(p.title) >= 3)
    .sort(byLastActivity)
    .filter((p) => {
      // Never two from the same seat — a team that loses two people in a month is a different story.
      if (takenTitles.has(p.title)) return false;
      takenTitles.add(p.title);
      return true;
    })
    .slice(0, 2);
  const [absconder, terminated] = others;
  const exits: JourneyFacts["exits"] = new Map();
  const clampExit = (d: Date) => minDate(workingOnOrBefore(d), yesterday);
  if (absconder) {
    const on = clampExit(maxDate(workingOnOrAfter(addDays(lastMonthStart, 3)), workingOnOrAfter(lastOf(absconder))));
    exits.set(absconder.id, {
      type: "ABSCONDED",
      on,
      recordedOn: minDate(workingOnOrAfter(addDays(on, 12)), TODAY_D),
      reason: `Stopped attending after ${indiaClock.date(at(on, 12))} without notice; did not answer two letters to the address on file.`,
    });
  }
  if (terminated) {
    const on = clampExit(maxDate(workingOnOrAfter(addDays(lastMonthStart, 16)), workingOnOrAfter(addDays(lastOf(terminated), 1))));
    exits.set(terminated.id, { type: "TERMINATED", on, recordedOn: on, reason: `Terminated after a final written warning — ${misconductOf(terminated.title).short}.` });
  }
  if (internLeaver) {
    const on = clampExit(maxDate(workingOnOrAfter(addDays(lastMonthStart, 22)), workingOnOrAfter(addDays(lastOf(internLeaver), 1))));
    exits.set(internLeaver.id, { type: "CONTRACT_ENDED", on, recordedOn: on, reason: "Internship completed — the term in the internship letter ended." });
  }
  if (retiree) {
    const on = clampExit(maxDate(workingOnOrBefore(lastMonthEnd), workingOnOrAfter(addDays(lastOf(retiree), 1))));
    exits.set(retiree.id, { type: "RETIRED", on, recordedOn: workingOnOrBefore(addDays(on, -10)), reason: "Retired on reaching sixty, after twelve years with the company." });
  }
  const leaverIds = new Set(exits.keys());

  // ── Employment types ────────────────────────────────────────────────────────────────────────
  const typeOf = new Map<string, EmploymentType>();
  if (internLeaver) typeOf.set(internLeaver.id, "INTERN");
  const free = (title: string) => people.filter((p) => p.title === title && !p.isManager && !leaverIds.has(p.id) && p !== serving && !typeOf.has(p.id));
  const lastJoiner = (list: Person[]) => [...list].sort((a, b) => (firstAct.get(b.id) ?? START_D).getTime() - (firstAct.get(a.id) ?? START_D).getTime())[0];
  const currentIntern = lastJoiner([...free("Data Profiler"), ...free("Calling Executive")]);
  if (currentIntern) typeOf.set(currentIntern.id, "INTERN");
  const contractor = lastJoiner(free("Field Engineer"));
  if (contractor) typeOf.set(contractor.id, "CONTRACT");
  const consultant = lastJoiner(free("Presales Consultant"));
  if (consultant) typeOf.set(consultant.id, "CONSULTANT");
  const partTimer = lastJoiner(free("Accounts Executive"));
  if (partTimer) typeOf.set(partTimer.id, "PART_TIME");

  // ── Joining dates ───────────────────────────────────────────────────────────────────────────
  const joined = new Map<string, Date>();
  const supportLead = people.find((p) => p.title === "Support Lead");
  // The regional managers and one key-account manager were here before the year began too.
  const earlyHands = new Set<string>([
    ...people.filter((p) => p.title === "Regional Sales Manager").map((p) => p.id),
    ...people.filter((p) => p.title === "Key Account Manager").slice(0, 1).map((p) => p.id),
  ]);
  const rest = people.filter((p) => !(p.title in BEFORE) && p !== supportLead && !earlyHands.has(p.id));
  for (const p of people) {
    let target: Date;
    if (p.title in BEFORE) target = dateOnly(new Date(TODAY_D.getTime() - BEFORE[p.title]! * 365.25 * DAY));
    // Three years ago today — somebody's work anniversary is on the greeting strip this morning.
    else if (p === supportLead) target = new Date(Date.UTC(TODAY_D.getUTCFullYear() - 3, TODAY_D.getUTCMonth(), TODAY_D.getUTCDate()));
    else if (earlyHands.has(p.id)) target = dateOnly(new Date(TODAY_D.getTime() - (1.2 + rnd() * 1.4) * 365.25 * DAY));
    else {
      // Spread evenly through the year, up to ten weeks ago — the newest joiners are still on probation.
      const i = rest.indexOf(p);
      target = addDays(START_D, Math.round((i / Math.max(1, rest.length - 1)) * 290) + int(-6, 6));
    }
    const first = firstAct.get(p.id);
    // Never after the first thing they did here. Somebody already at work in the first fortnight was
    // there on the day the doors opened — the founding staff.
    if (first && first <= target) target = first < START_D ? addDays(first, -int(2, 12)) : maxDate(START_D, addDays(first, -int(2, 12)));
    const day = p === supportLead && (!first || first > target) ? target : target <= START_D && !(p.title in BEFORE) && !earlyHands.has(p.id) && (!first || first >= START_D) ? workingOnOrAfter(START_D) : workingOnOrBefore(target);
    joined.set(p.id, first && day > first ? workingOnOrBefore(first) : day);
  }

  // ── Probation, and the one that was extended ────────────────────────────────────────────────
  const probation = new Map<string, { ends: Date | null; confirmed: Date | null }>();
  for (const p of people) {
    const type = typeOf.get(p.id) ?? "FULL_TIME";
    if (type === "INTERN" || type === "CONTRACT" || type === "CONSULTANT") {
      probation.set(p.id, { ends: null, confirmed: null });
      continue;
    }
    const ends = addDays(joined.get(p.id)!, 180);
    const confirmed = workingOnOrAfter(addDays(ends, int(0, 4)));
    probation.set(p.id, { ends, confirmed: confirmed <= TODAY_D ? confirmed : null });
  }
  const extendable = people
    .filter((p) => !leaverIds.has(p.id) && p !== serving && (typeOf.get(p.id) ?? "FULL_TIME") === "FULL_TIME" && !(p.title in BEFORE))
    .filter((p) => {
      const ends = probation.get(p.id)!.ends!;
      return ends <= addDays(TODAY_D, -5) && ends >= addDays(TODAY_D, -150);
    })
    .sort((a, b) => joined.get(b.id)!.getTime() - joined.get(a.id)!.getTime())[0];
  let extension: JourneyFacts["extension"] = null;
  if (extendable) {
    const originalEnd = probation.get(extendable.id)!.ends!;
    const until = addDays(originalEnd, 90);
    probation.set(extendable.id, { ends: until, confirmed: until <= TODAY_D ? workingOnOrAfter(addDays(until, 1)) : null });
    extension = { person: extendable, originalEnd, until };
  }

  // ── Where they work ─────────────────────────────────────────────────────────────────────────
  const officeOf = new Map<string, OfficeKey>();
  for (const [i, p] of people.entries()) {
    let office: OfficeKey = "hq";
    if (p.dept === "Sales" && !p.isManager && p.title !== "Head of Sales") office = (["hq", "pune", "blr", "ncr", "hq"] as const)[i % 5]!;
    else if (p.title === "Regional Sales Manager") office = (["pune", "blr", "ncr"] as const)[i % 3]!;
    else if (p.dept === "Support" && !p.isManager) office = (["hq", "blr", "pune", "hq"] as const)[i % 4]!;
    else if (p.dept === "Inside Sales" && !p.isManager) office = i % 3 === 0 ? "pune" : "hq";
    else if (p.dept === "Presales & Solutions") office = i % 2 === 0 ? "blr" : "hq";
    officeOf.set(p.id, office);
  }

  // ── Promotions at the April appraisal, transfers in June ────────────────────────────────────
  const fyStart = financialYearOf(TODAY_D);
  const APPRAISAL = D(`${fyStart}-04-01`);
  // Everybody with six months behind them by April is in the appraisal — confirmation comes the same week.
  const appraised = (p: Person) =>
    joined.get(p.id)! <= addDays(APPRAISAL, -150) &&
    !["INTERN", "CONTRACT", "CONSULTANT"].includes(typeOf.get(p.id) ?? "FULL_TIME") &&
    !!probation.get(p.id)?.confirmed &&
    probation.get(p.id)!.confirmed! <= addDays(APPRAISAL, 10);
  const PROMOTE: [from: string, to: string][] = [
    ["Support Engineer", "Senior Support Engineer"],
    ["Calling Executive", "Senior Calling Executive"],
    ["Account Manager", "Senior Account Manager"],
  ];
  const promotions: JourneyFacts["promotions"] = new Map();
  for (const [from, to] of PROMOTE) {
    const who = people.find((p) => p.title === from && !leaverIds.has(p.id) && p !== serving && appraised(p) && !typeOf.has(p.id) && !promotions.has(p.id));
    if (who) promotions.set(who.id, { from, to });
  }
  const TRANSFER_ON = workingOnOrAfter(D(`${fyStart}-06-01`));
  const transfers: JourneyFacts["transfers"] = new Map();
  for (const [from, to] of [["pune", "blr"], ["hq", "pune"]] as const) {
    const who = people.find(
      (p) => officeOf.get(p.id) === from && !p.isManager && !leaverIds.has(p.id) && p !== serving && !promotions.has(p.id) && !transfers.has(p.id) &&
        joined.get(p.id)! < addDays(TRANSFER_ON, -120) && (p.dept === "Sales" || p.dept === "Support"),
    );
    if (who) {
      transfers.set(who.id, { from: OFFICES[from].label, to: OFFICES[to].label });
      officeOf.set(who.id, to);
    }
  }

  // ── Gender, birthdays and the rest of the record ───────────────────────────────────────────
  const otherGender = people.find((p) => p.title === "Data Profiler" && !typeOf.has(p.id) && !leaverIds.has(p.id));
  const undisclosed = new Set(people.filter((p) => !p.isManager && p.dept === "Sales" && !FEMALE.has(p.first) && p !== serving).slice(1, 3).map((p) => p.id));
  const birthdayToday = people.find((p) => p.dept === "Support" && !p.isManager && !leaverIds.has(p.id));
  const birthdaySoon = people.find((p) => p.dept === "Sales" && !p.isManager && !leaverIds.has(p.id) && p !== serving);
  const ages = new Map(people.map((p) => [p.id,
    p.title === "Director" ? int(48, 54) : p.title === "Office Admin" ? 60 : p.isManager || p.title in BEFORE ? int(34, 46) : typeOf.get(p.id) === "INTERN" ? int(21, 22) : int(23, 34)]));

  for (const [i, p] of people.entries()) {
    const type = typeOf.get(p.id) ?? "FULL_TIME";
    const exit = exits.get(p.id);
    const office = OFFICES[officeOf.get(p.id)!];
    const age = ages.get(p.id)!;
    const gender: Gender = p === otherGender ? "OTHER" : undisclosed.has(p.id) ? "UNDISCLOSED" : FEMALE.has(p.first) ? "FEMALE" : "MALE";
    let dob: Date;
    if (p === retiree && exit) dob = new Date(Date.UTC(exit.on.getUTCFullYear() - 60, exit.on.getUTCMonth(), int(1, Math.min(28, exit.on.getUTCDate()))));
    else if (p === birthdayToday) dob = new Date(Date.UTC(TODAY_D.getUTCFullYear() - age, TODAY_D.getUTCMonth(), TODAY_D.getUTCDate()));
    else if (p === birthdaySoon) dob = addDays(new Date(Date.UTC(TODAY_D.getUTCFullYear() - age, TODAY_D.getUTCMonth(), TODAY_D.getUTCDate())), 3);
    else dob = new Date(Date.UTC(TODAY_D.getUTCFullYear() - age, int(0, 11), int(1, 28)));
    const [bank, ifsc] = pick(BANKS);
    const promo = promotions.get(p.id);
    const married = age > 28 ? chance(0.7) : chance(0.15);
    const surname = p.name.split(" ")[1] ?? pick(LAST_NAMES);
    await db.employeeProfile.update({
      where: { userId: p.id },
      data: {
        employeeCode: p.employeeCode ?? `DZO-${1001 + i}`,
        designation: promo ? promo.to : p.title,
        employmentType: type,
        workLocation: office.label,
        noticePeriodDays: type === "INTERN" || type === "CONTRACT" || type === "CONSULTANT" ? 15 : p.title === "Director" ? 90 : p.title in BEFORE || p.isManager ? 60 : 30,
        joinedOn: joined.get(p.id)!,
        probationEndsOn: probation.get(p.id)!.ends,
        confirmedOn: probation.get(p.id)!.confirmed,
        ...(exit ? { exitedOn: exit.on, exitType: exit.type, exitReason: exit.reason } : {}),
        dateOfBirth: dob,
        gender,
        bloodGroup: pick(["O+", "B+", "A+", "AB+", "O-", "B-", "A-"]),
        maritalStatus: married ? "Married" : "Single",
        personalEmail: `${p.first.toLowerCase()}.${surname.toLowerCase()}${int(10, 99)}@personal.example`,
        personalPhone: phone(),
        addressLine1: `${int(1, 400)}, ${pick(LOCALITIES)}`,
        addressLine2: chance(0.4) ? `Flat ${int(101, 1204)}` : null,
        city: office.city,
        state: office.state,
        pincode: `${office.pin}${String(int(1, 99)).padStart(2, "0")}`,
        emergencyContactName: `${pick(FIRST_NAMES)} ${surname}`,
        emergencyContactPhone: phone(),
        emergencyContactRelation: married ? "Spouse" : pick(["Father", "Mother", "Brother", "Sister"]),
        panNumber: panFor(p.name, i + 3),
        aadhaarLast4: String(int(1000, 9999)),
        uanNumber: type === "CONSULTANT" ? null : `10${int(10000000, 99999999)}${int(10, 99)}`,
        pfNumber: type === "CONSULTANT" ? null : `MH/BAN/0048213/000/${String(1000 + i).padStart(7, "0")}`,
        esicNumber: chance(0.3) ? `31${int(100000000, 999999999)}` : null,
        bankName: bank,
        bankAccountNumber: String(int(10000000000, 99999999999)),
        bankIfsc: ifsc,
      },
    });
    if (exit) await db.user.update({ where: { id: p.id }, data: { active: false } });
  }

  // ── Maternity leave, starting soon ──────────────────────────────────────────────────────────
  const mother = people.find((p) => FEMALE.has(p.first) && !p.isManager && !leaverIds.has(p.id) && p !== serving && probation.get(p.id)?.confirmed && ages.get(p.id)! >= 26 && p.dept !== "HR & Admin");
  let maternity: JourneyFacts["maternity"] = null;
  if (mother) {
    const from = workingOnOrAfter(addDays(TODAY_D, 16));
    maternity = { person: mother, from, to: addDays(from, 26 * 7 - 1), letterOn: workingOnOrBefore(addDays(TODAY_D, -5)) };
    await db.employeeProfile.update({ where: { userId: mother.id }, data: { maritalStatus: "Married", gender: "FEMALE" } });
  }

  // ── Salary history: what they joined on, and the April revision ─────────────────────────────
  const structures = await db.salaryStructure.findMany({ orderBy: { effectiveFrom: "desc" } });
  const latest = new Map<string, (typeof structures)[number]>();
  for (const s of structures) if (!latest.has(s.userId)) latest.set(s.userId, s);
  let revised = 0;
  const hikes: JourneyFacts["hikes"] = new Map();
  for (const p of people) {
    const s = latest.get(p.id);
    if (!s) continue;
    const joinedOn = joined.get(p.id)!;
    const comps: SalaryComponents = {
      basic: num(s.basic), hra: num(s.hra), conveyance: num(s.conveyance), medical: num(s.medical),
      specialAllowance: num(s.specialAllowance), otherAllowance: num(s.otherAllowance),
    };
    const gross = monthlyGross(comps);
    if (!appraised(p)) {
      await db.salaryStructure.update({ where: { id: s.id }, data: { effectiveFrom: joinedOn, note: "On joining", createdAt: at(addDays(joinedOn, -int(3, 10)), 11) } });
      continue;
    }
    const promo = promotions.has(p.id);
    const hike = promo ? 0.18 + rnd() * 0.07 : 0.06 + rnd() * 0.08;
    const scale = 1 / (1 + hike);
    const before = {
      basic: Math.round(comps.basic * scale),
      hra: Math.round(comps.hra * scale),
      specialAllowance: Math.max(0, Math.round(comps.specialAllowance * scale)),
    };
    const enteredOn = at(workingOnOrBefore(addDays(APPRAISAL, -int(4, 9))), 11, int(0, 59));
    await db.salaryStructure.update({
      where: { id: s.id },
      data: { effectiveFrom: APPRAISAL, note: promo ? "Promotion and annual revision" : "Annual revision", createdAt: enteredOn },
    });
    await db.salaryStructure.create({
      data: {
        userId: p.id,
        effectiveFrom: joinedOn,
        basic: dec(before.basic),
        hra: dec(before.hra),
        conveyance: s.conveyance,
        medical: s.medical,
        specialAllowance: dec(before.specialAllowance),
        otherAllowance: s.otherAllowance,
        pfApplicable: s.pfApplicable,
        esiApplicable: s.esiApplicable,
        ptApplicable: s.ptApplicable,
        note: "On joining",
        createdById: run.controller.id,
        createdAt: at(addDays(joinedOn, -int(3, 10)), 11),
      },
    });
    hikes.set(p.id, { previousGross: monthlyGross({ ...comps, ...before }), gross, on: APPRAISAL });
    audit(run, run.controller.id, "CREATE", "SalaryStructure", s.id, `Salary set for ${p.name} from ${toKey(APPRAISAL)}`, enteredOn);
    revised += 1;
  }

  // ── The record changes HR made along the way ────────────────────────────────────────────────
  for (const p of people) {
    const conf = probation.get(p.id)?.confirmed;
    if (conf && conf >= START_D && conf <= TODAY_D) audit(run, run.hr.id, "UPDATE", "EmployeeProfile", p.id, `Employee record for ${p.name}`, workMoment(conf));
    if (promotions.has(p.id)) audit(run, run.hr.id, "UPDATE", "EmployeeProfile", p.id, `Employee record for ${p.name}`, workMoment(workingOnOrBefore(addDays(APPRAISAL, -2))));
    if (transfers.has(p.id)) audit(run, run.hr.id, "UPDATE", "EmployeeProfile", p.id, `Employee record for ${p.name}`, workMoment(workingOnOrBefore(addDays(TRANSFER_ON, -7))));
  }
  if (extension) audit(run, run.hr.id, "UPDATE", "EmployeeProfile", extension.person.id, `Employee record for ${extension.person.name}`, workMoment(workingOnOrBefore(extension.originalEnd)));

  // ── Leaving: recorded, offboarded and handed over, as the app does each ─────────────────────
  let handedOver = 0;
  for (const p of people) {
    const exit = exits.get(p.id);
    if (!exit) continue;
    const recorded = workMoment(exit.recordedOn, 11, 17);
    audit(run, run.hr.id, "UPDATE", "EmployeeProfile", p.id, `${p.name} marked as exited (${exit.type.toLowerCase().replaceAll("_", " ")}), login deactivated`, recorded);

    // The six offboarding steps, assigned the way raiseOffboardingTasksFor assigns them.
    const manager = p.managerId ? run.byId.get(p.managerId) : undefined;
    for (const t of OFFBOARDING_TASKS) {
      const due = new Date(exit.on.getTime() + t.dueDayOffset * DAY);
      const finished = due < addDays(TODAY_D, -2) ? chance(0.85) : chance(0.3);
      await db.task.create({
        data: {
          title: `${t.title} — ${p.name}`,
          description: t.description,
          dueDate: due,
          assignedToUserId: t.role === "MANAGER" ? (manager?.id ?? run.hr.id) : run.hr.id,
          createdByUserId: run.hr.id,
          aboutUserId: p.id,
          hrStage: "OFFBOARDING",
          done: finished,
          doneAt: finished ? workMoment(minDate(maxDate(due, exit.recordedOn), TODAY_D)) : null,
          createdAt: recorded,
        },
      });
    }
    audit(run, run.hr.id, "CREATE", "Task", p.id, `Raised ${OFFBOARDING_TASKS.length} offboarding task(s) for ${p.name}`, new Date(recorded.getTime() + 60_000));

    // Their open work, moved to a colleague through the real handover areas.
    const successor =
      people.find((x) => x.title === p.title && x.id !== p.id && !exits.has(x.id) && x !== serving) ??
      (manager && !exits.has(manager.id) ? manager : run.hr);
    const when = new Date(recorded.getTime() + 2 * 3_600_000);
    const lines: { areaKey: string; areaLabel: string; toUserId: string; count: number }[] = [];
    for (const area of HANDOVER_AREAS) {
      const held = await area.hold(db, p.id);
      if (held.length === 0) continue;
      await area.give(db, held.map((h) => h.id), successor.id, { actorId: run.hr.id, fromUserId: p.id });
      lines.push({ areaKey: area.key, areaLabel: area.label, toUserId: successor.id, count: held.length });
    }
    if (lines.length > 0) {
      const why = exit.type === "RETIRED" ? "Retired" : exit.type === "ABSCONDED" ? "Absconded" : exit.type === "TERMINATED" ? "Terminated" : "Internship ended";
      await db.handover.create({
        data: { fromUserId: p.id, performedById: run.hr.id, reason: `${why} — last day ${toKey(exit.on)}`, createdAt: when, lines: { create: lines } },
      });
      audit(run, run.hr.id, "UPDATE", "User", p.id, `Handover from ${p.name} — ${lines.map((l) => `${l.areaLabel.toLowerCase()} ×${l.count}`).join(", ")}`, when);
      const total = lines.reduce((s, l) => s + l.count, 0);
      notify(run, successor.id, "TASK_ASSIGNED", `${total} item${total === 1 ? "" : "s"} moved to you from ${p.name}`, lines.map((l) => `${l.areaLabel}: ${l.count}`).join(" · "), "/dashboard", when);
      handedOver += 1;
    }
  }

  run.facts = { hikes, promotions, transfers, extension, exits, appraisal: APPRAISAL, transferOn: TRANSFER_ON, maternity };

  const fresh = await loadPeople(db);
  run.people.splice(0, run.people.length, ...fresh);
  run.byId = new Map(fresh.map((p) => [p.id, p]));
  const t = await flushTrail(run);
  const before = fresh.filter((p) => p.joinedOn < START_D).length;
  log(
    "Journeys",
    `${fresh.length} people — ${before} joined before the year, ${fresh.length - before} during it; ${revised} April revisions, ` +
      `${promotions.size} promotions, ${transfers.size} transfers, ${extension ? 1 : 0} probation extended; ` +
      `${exits.size} left (${[...exits.values()].map((e) => e.type.toLowerCase().replaceAll("_", " ")).join(", ")}), ${handedOver} handed over; ${t.audits} audit rows`,
  );
}

// ─── Leave ───────────────────────────────────────────────────────────────────────────────────────

const LEAVE_REASONS: Record<string, string[]> = {
  CL: ["Family function", "Personal work", "Bank and property paperwork", "Child's school event", "Travelling home"],
  SL: ["Fever", "Not well — doctor's advice to rest", "Viral infection", "Migraine", "Dental procedure"],
  EL: ["Family holiday", "Wedding in the family", "Trip home for the festival", "Vacation booked in advance", "House move"],
  LOP: ["Extra days after the family wedding — no leave left", "Personal emergency, balance exhausted"],
};

/**
 * A year of leave that adds up.
 *
 * The demo applied for one or two leaves a head, counted calendar days rather than working ones, and
 * set the balances' "used" to a random number. Here every request is counted the way `applyLeave`
 * counts it (`countLeaveDays` — no week-offs, no closed holidays, half days), decided by the person's
 * manager, and the balances are what the approvals add up to, for both financial years the year spans.
 */
async function leave(run: Run) {
  const { db, people } = run;
  const fyStart = financialYearOf(TODAY_D);
  if (await db.leaveBalance.findFirst({ where: { year: fyStart - 1, user: { email: { endsWith: DEMO_EMAIL_DOMAIN } } }, select: { id: true } })) {
    log("Leave", "already written — left as it is");
    return;
  }

  const ml = await db.leaveType.upsert({
    where: { code: "ML" },
    create: { code: "ML", name: "Maternity leave", annualQuota: dec(182), accrual: "ANNUAL", paid: true, encashable: false, sortOrder: 5, colour: "#ec4899", proofAfterDays: 1 },
    update: {},
  });
  void ml;
  const types = await db.leaveType.findMany();
  const byCode = new Map(types.map((t) => [t.code, t]));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const span = (from: Date, to: Date, fromHalfDay = false, toHalfDay = false) => countLeaveDays({ from, to, fromHalfDay, toHalfDay }, run.holidays);

  // ── The demo's own requests, counted properly ───────────────────────────────────────────────
  const existing = await db.leaveRequest.findMany({ where: { userId: { in: people.map((p) => p.id) } }, orderBy: { fromDate: "asc" } });
  const taken = new Map<string, Set<string>>(); // userId → working dates already asked for
  const takenBy = (userId: string) => taken.get(userId) ?? (taken.set(userId, new Set()), taken.get(userId)!);
  let removed = 0;
  const usedBy = new Map<string, number>(); // `${userId}:${code}:${fy}` → days
  const balanceKey = (u: string, code: string, fy: number) => `${u}:${code}:${fy}`;
  for (const r of existing) {
    const p = run.byId.get(r.userId);
    if (!p) continue;
    const counted = span(r.fromDate, r.toDate, r.fromHalfDay, r.toHalfDay);
    const clash = counted.workingDates.some((d) => takenBy(r.userId).has(d));
    const outside = r.fromDate < p.joinedOn || (!!p.exitedOn && r.fromDate > p.exitedOn) || maternityClash(run, p, r.fromDate, r.toDate);
    if (counted.days === 0 || outside || (clash && (r.status === "APPROVED" || r.status === "PENDING"))) {
      await db.leaveRequest.delete({ where: { id: r.id } });
      removed += 1;
      continue;
    }
    if (r.status === "APPROVED" || r.status === "PENDING") for (const d of counted.workingDates) takenBy(r.userId).add(d);
    const manager = p.managerId ?? run.hr.id;
    const asked = at(addDays(r.fromDate, -int(3, 12)), int(10, 17), int(0, 59));
    const future = r.fromDate > TODAY_D;
    // The demo's PENDING leave in the past is leave nobody decided on — the manager did, eventually.
    const status = r.status === "PENDING" && !future ? "APPROVED" : r.status;
    await db.leaveRequest.update({
      where: { id: r.id },
      data: {
        days: dec(counted.days),
        status,
        approverId: manager,
        decidedAt: status === "APPROVED" || status === "REJECTED" ? new Date(asked.getTime() + int(2, 30) * 3_600_000) : null,
        decisionNote: status === "REJECTED" ? "Two others are out that week — can you move it?" : null,
        cancelledAt: status === "CANCELLED" ? new Date(asked.getTime() + int(24, 60) * 3_600_000) : null,
        createdAt: asked,
      },
    });
    const rt = typeById.get(r.typeId);
    if (status === "APPROVED" && rt?.paid) {
      const k = balanceKey(r.userId, rt.code, financialYearOf(r.fromDate));
      usedBy.set(k, (usedBy.get(k) ?? 0) + counted.days);
    }
  }

  // ── More of it: about what people actually take in a year ───────────────────────────────────
  const quotaFor = (code: string) => num(byCode.get(code)?.annualQuota);
  // A month the demo already paid and locked: its payslips deducted what they deducted, so no unpaid
  // leave is added to it after the fact.
  const locked = new Set((await db.payrollRun.findMany({ where: { status: { not: "DRAFT" } }, select: { month: true, year: true } })).map((r) => `${r.year}-${r.month}`));
  let added = 0;
  for (const p of people) {
    if (!["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"].includes(p.type)) continue;
    const from = maxDate(p.joinedOn, START_D);
    const to = p.exitedOn ? minDate(p.exitedOn, TODAY_D) : addDays(TODAY_D, 30);
    if (to <= from) continue;
    const months = (to.getTime() - from.getTime()) / (30.4 * DAY);
    const wanted = Math.round(months * (p.type === "INTERN" ? 0.6 : 1.1));
    let asked = 0;
    for (let attempt = 0; attempt < 40 && asked < wanted; attempt++) {
      const code = chance(0.06) ? "LOP" : pick(["CL", "CL", "SL", "SL", "EL"]);
      const type = byCode.get(code);
      if (!type) continue;
      const start = workingOnOrAfter(addDays(from, int(5, Math.max(6, Math.floor((to.getTime() - from.getTime()) / DAY) - 3))));
      const length = code === "EL" ? int(2, 5) : code === "SL" ? int(1, 2) : 1;
      const end = workingOnOrAfter(addDays(start, length - 1));
      const half = code === "CL" && length === 1 && chance(0.25);
      if (end > to) continue;
      const counted = span(start, end, half, false);
      if (counted.days === 0 || counted.workingDates.some((d) => takenBy(p.id).has(d))) continue;
      if (!type.paid && (locked.has(`${start.getUTCFullYear()}-${start.getUTCMonth() + 1}`) || locked.has(`${end.getUTCFullYear()}-${end.getUTCMonth() + 1}`))) continue;
      if (maternityClash(run, p, start, end)) continue;
      const fy = financialYearOf(start);
      if (type.paid && code !== "LOP") {
        const already = usedBy.get(balanceKey(p.id, code, fy)) ?? 0;
        if (already + counted.days > quotaFor(code)) continue;
      }
      const future = start > TODAY_D;
      const status = future ? (chance(0.5) ? "PENDING" : "APPROVED") : chance(0.07) ? "REJECTED" : chance(0.05) ? "CANCELLED" : "APPROVED";
      const askedAt = at(workingOnOrBefore(addDays(start, -int(2, 14))), int(10, 17), int(0, 59));
      if (askedAt > TODAY) continue;
      const decidedAt = status === "APPROVED" || status === "REJECTED" ? minDate(new Date(askedAt.getTime() + int(2, 40) * 3_600_000), new Date(TODAY.getTime() - 3_600_000)) : null;
      await db.leaveRequest.create({
        data: {
          userId: p.id,
          typeId: type.id,
          fromDate: start,
          toDate: end,
          fromHalfDay: half,
          days: dec(counted.days),
          reason: pick(LEAVE_REASONS[code] ?? LEAVE_REASONS.CL!),
          status,
          approverId: p.managerId ?? run.hr.id,
          decidedAt,
          decisionNote: status === "REJECTED" ? "Quarter-end week — please pick another date." : status === "APPROVED" && chance(0.2) ? "Enjoy." : null,
          cancelledAt: status === "CANCELLED" ? new Date(askedAt.getTime() + int(20, 70) * 3_600_000) : null,
          createdAt: askedAt,
        },
      });
      if (status === "APPROVED" || status === "PENDING") for (const d of counted.workingDates) takenBy(p.id).add(d);
      if (status === "APPROVED" && type.paid) usedBy.set(balanceKey(p.id, code, fy), (usedBy.get(balanceKey(p.id, code, fy)) ?? 0) + counted.days);
      asked += counted.days;
      added += 1;
    }
  }

  // ── The approvals queue today: leave asked for, not yet decided ─────────────────────────────
  for (const p of some(people.filter((x) => x.active && x.managerId && !x.exitedOn), 8)) {
    const start = workingOnOrAfter(addDays(TODAY_D, int(6, 26)));
    const code = pick(["CL", "EL", "EL"]);
    const type = byCode.get(code);
    if (!type) continue;
    const end = workingOnOrAfter(addDays(start, code === "EL" ? int(1, 4) : 0));
    const counted = span(start, end);
    if (counted.days === 0 || counted.workingDates.some((d) => takenBy(p.id).has(d)) || maternityClash(run, p, start, end)) continue;
    await db.leaveRequest.create({
      data: { userId: p.id, typeId: type.id, fromDate: start, toDate: end, days: dec(counted.days), reason: pick(LEAVE_REASONS[code] ?? LEAVE_REASONS.CL!), status: "PENDING", approverId: p.managerId, createdAt: new Date(TODAY.getTime() - int(2, 60) * 3_600_000) },
    });
    for (const d of counted.workingDates) takenBy(p.id).add(d);
    added += 1;
  }

  // ── Maternity leave, approved ahead of time ─────────────────────────────────────────────────
  const m = run.facts?.maternity;
  const mlType = byCode.get("ML");
  if (m && mlType) {
    const counted = span(m.from, m.to);
    const askedAt = at(workingOnOrBefore(addDays(m.letterOn, -6)), 11, 20);
    await db.leaveRequest.create({
      data: {
        userId: m.person.id,
        typeId: mlType.id,
        fromDate: m.from,
        toDate: m.to,
        days: dec(counted.days),
        reason: "Maternity leave — 26 weeks, as the Act provides. Doctor's certificate attached to my file.",
        status: "APPROVED",
        approverId: m.person.managerId ?? run.hr.id,
        decidedAt: at(workingOnOrBefore(addDays(m.letterOn, -2)), 15, 5),
        decisionNote: "Approved — wishing you the very best.",
        createdAt: askedAt,
      },
    });
    added += 1;
  }

  // ── The trail every request leaves ──────────────────────────────────────────────────────────
  const all = await db.leaveRequest.findMany({ where: { userId: { in: people.map((p) => p.id) } }, include: { type: true } });
  for (const r of all) {
    const p = run.byId.get(r.userId);
    if (!p) continue;
    const days = num(r.days);
    audit(run, p.id, "CREATE", "LeaveRequest", r.id, `${days} day(s) ${r.type.code} from ${toKey(r.fromDate)}`, r.createdAt);
    if (p.managerId) notify(run, p.managerId, "LEAVE_REQUESTED", "Leave request", `${p.name} has applied for ${days} day(s) of ${r.type.name} from ${toKey(r.fromDate)}.`, "/people/leave?view=approvals", r.createdAt);
    if ((r.status === "APPROVED" || r.status === "REJECTED") && r.decidedAt && r.approverId) {
      const approver = run.byId.get(r.approverId);
      const approve = r.status === "APPROVED";
      audit(run, r.approverId, "UPDATE", "LeaveRequest", r.id, `${approve ? "Approved" : "Rejected"} ${days} day(s) ${r.type.code} for ${p.name}`, r.decidedAt);
      notify(run, p.id, "LEAVE_DECIDED", approve ? "Leave approved" : "Leave rejected",
        `${approver?.name ?? "Your manager"} ${approve ? "approved" : "rejected"} your ${days} day(s) of ${r.type.name}${r.decisionNote ? `: ${r.decisionNote}` : "."}`, "/people/leave", r.decidedAt);
    }
    if (r.status === "CANCELLED" && r.cancelledAt) audit(run, p.id, "UPDATE", "LeaveRequest", r.id, `Cancelled ${days} day(s) ${r.type.code}`, r.cancelledAt);
  }

  // ── Balances: what each year credited, and what the approvals used ──────────────────────────
  const used = new Map<string, number>();
  for (const r of all) {
    if (r.status !== "APPROVED" || !r.type.paid) continue;
    const k = balanceKey(r.userId, r.type.code, financialYearOf(r.fromDate));
    used.set(k, (used.get(k) ?? 0) + num(r.days));
  }
  let balances = 0;
  for (const p of people) {
    for (const fy of [fyStart - 1, fyStart]) {
      const fyFrom = D(`${fy}-04-01`);
      const fyTo = D(`${fy + 1}-03-31`);
      const from = maxDate(p.joinedOn, fyFrom);
      const to = minDate(p.exitedOn ?? fyTo, fyTo, fy === fyStart ? TODAY_D : fyTo);
      if (to < from || to < START_D) continue;
      for (const type of types) {
        if (!type.paid || !type.active) continue;
        const k = balanceKey(p.id, type.code, fy);
        if (type.code === "ML" && !used.has(k)) continue;
        const months = Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + 1);
        const credited = type.accrual === "MONTHLY" ? Math.round(((num(type.annualQuota) / 12) * Math.min(12, months)) * 100) / 100 : num(type.annualQuota);
        await db.leaveBalance.upsert({
          where: { userId_typeId_year: { userId: p.id, typeId: type.id, year: fy } },
          create: { userId: p.id, typeId: type.id, year: fy, opening: dec(0), credited: dec(credited), used: dec(used.get(k) ?? 0) },
          update: { opening: type.carryForward ? undefined : dec(0), credited: dec(credited), used: dec(used.get(k) ?? 0) },
        });
        balances += 1;
      }
    }
  }
  const t = await flushTrail(run);
  log("Leave", `${added} requests added, ${removed} of the demo's removed (weekends, overlaps, after leaving); ${balances} balances over two financial years; ${t.notes} notifications`);
}

/** Nothing else is asked for during somebody's maternity leave. */
function maternityClash(run: Run, p: Person, from: Date, to: Date) {
  const m = run.facts?.maternity;
  return !!m && m.person.id === p.id && from <= m.to && to >= addDays(m.from, -3);
}

// ─── Attendance ──────────────────────────────────────────────────────────────────────────────────

type DayRow = Prisma.AttendanceDayCreateManyInput & { date: Date };
const STATUS_WORDS = (s: string) => s.toLowerCase().replaceAll("_", " ");

/**
 * Every working day of the year, for everybody employed on it.
 *
 * Written on the app's calendar rather than the demo's: Saturday and Sunday are off
 * (`DEFAULT_WEEK_OFFS`), a closed holiday has no row, an approved leave puts ON_LEAVE (or HALF_DAY on a
 * half-day end) on exactly the working dates `countLeaveDays` gives and points at the request, a day
 * with biometric punches is what the roll-up makes of them, and an approved correction is the day as
 * corrected. Check-in times are India's wall clock.
 *
 * The sixty days the demo wrote are rewritten, because they disagree with all of that: they kept
 * Saturdays as working days, put check-ins at half past two in the afternoon and leave on days with no
 * leave behind it. What survives from them is the one thing a locked payroll fixed in place: for the
 * months the demo paid, each person has exactly as many unpaid days as their payslip deducted.
 */
async function attendance(run: Run) {
  const { db, people } = run;
  const ids = people.map((p) => p.id);
  if (await db.attendanceDay.findFirst({ where: { userId: { in: ids }, date: { lt: addDays(TODAY_D, -100) } }, select: { id: true } })) {
    log("Attendance", "already written — left as it is");
    return;
  }

  // ── What fixes a day before anything is invented ────────────────────────────────────────────
  const leaves = await db.leaveRequest.findMany({ where: { userId: { in: ids }, status: "APPROVED" }, include: { type: true } });
  const leaveDay = new Map<string, { status: "ON_LEAVE" | "HALF_DAY"; requestId: string; unpaid: boolean }>();
  for (const r of leaves) {
    const counted = countLeaveDays({ from: r.fromDate, to: r.toDate, fromHalfDay: r.fromHalfDay, toHalfDay: r.toHalfDay }, run.holidays);
    for (const k of counted.workingDates) {
      const half = (r.fromHalfDay && k === toKey(r.fromDate)) || (r.toHalfDay && k === toKey(r.toDate));
      leaveDay.set(`${r.userId}:${k}`, { status: half ? "HALF_DAY" : "ON_LEAVE", requestId: r.id, unpaid: !r.type.paid });
    }
  }

  // Punches the roll-up has processed — grouped by the day it groups them by.
  const punches = await db.biometricPunch.findMany({ where: { userId: { in: ids }, processedAt: { not: null } }, select: { userId: true, punchedAt: true }, orderBy: { punchedAt: "asc" } });
  const punchDay = new Map<string, { first: Date; last: Date; count: number }>();
  for (const pu of punches) {
    const k = `${pu.userId}:${toKey(pu.punchedAt)}`;
    const cur = punchDay.get(k);
    if (cur) {
      cur.last = pu.punchedAt;
      cur.count += 1;
    } else punchDay.set(k, { first: pu.punchedAt, last: pu.punchedAt, count: 1 });
  }

  // Unpaid days the locked runs already deducted.
  const lockedSlips = await db.payslip.findMany({ where: { userId: { in: ids }, run: { status: { not: "DRAFT" } } }, select: { userId: true, lopDays: true, run: { select: { month: true, year: true } } } });
  const lockedLop = new Map(lockedSlips.map((s) => [`${s.userId}:${s.run.year}-${s.run.month}`, num(s.lopDays)]));
  const lockedMonths = new Set(lockedSlips.map((s) => `${s.run.year}-${s.run.month}`));
  const monthKeyOf = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;

  // An office closure HR marked by hand: a rain day in July at the head office.
  const julyFirst = D(`${financialYearOf(TODAY_D)}-07-01`);
  const rainDay = julyFirst >= START_D && !lockedMonths.has(monthKeyOf(julyFirst)) ? workingOnOrAfter(addDays(julyFirst, int(6, 12))) : null;

  const existing = await db.attendanceRegularisation.findMany({ where: { userId: { in: ids } } });
  const correctedDay = new Set(existing.filter((r) => r.status === "APPROVED").map((r) => `${r.userId}:${toKey(r.date)}`));

  // ── Build each person's year ────────────────────────────────────────────────────────────────
  const rows = new Map<string, DayRow>();
  const put = (r: DayRow) => rows.set(`${r.userId}:${toKey(r.date)}`, r);
  const present = (userId: string, day: Date, status: "PRESENT" | "WORK_FROM_HOME" | "HALF_DAY"): DayRow => {
    const inAt = at(day, 9, int(0, 80));
    const outAt = status === "HALF_DAY" ? at(day, 13, int(15, 80)) : at(day, 17, int(45, 165));
    return { userId, date: day, status, checkInAt: inAt, checkOutAt: outAt, workedMinutes: Math.max(0, Math.round((outAt.getTime() - inAt.getTime()) / 60000)) };
  };
  let handMarked = 0;
  for (const p of people) {
    const from = maxDate(p.joinedOn, START_D);
    const to = p.exitedOn ? minDate(p.exitedOn, TODAY_D) : TODAY_D;
    const absentDue = new Map<string, number>(); // locked month → unpaid days still to place
    for (const m of lockedMonths) absentDue.set(m, lockedLop.get(`${p.id}:${m}`) ?? 0);
    const days = to >= from ? eachDay(from, to) : [];
    // Lay the locked months' unpaid days on working days with nothing else on them, spread out.
    const absentOn = new Set<string>();
    for (const [m, due] of absentDue) {
      if (due <= 0) continue;
      const free = days.filter((d) => monthKeyOf(d) === m && isWorkingDay(d) && !leaveDay.has(`${p.id}:${toKey(d)}`) && !punchDay.has(`${p.id}:${toKey(d)}`) && !correctedDay.has(`${p.id}:${toKey(d)}`) && toKey(d) !== TODAY_KEY);
      for (const d of some(free, Math.ceil(due))) absentOn.add(toKey(d));
    }
    for (const day of days) {
      const k = toKey(day);
      const lv = leaveDay.get(`${p.id}:${k}`);
      if (lv) {
        put({ userId: p.id, date: day, status: lv.status, leaveRequestId: lv.requestId });
        continue;
      }
      if (!isWorkingDay(day)) continue;
      if (rainDay && k === toKey(rainDay) && p.workLocation === OFFICES.hq.label) {
        put({ userId: p.id, date: day, status: "HOLIDAY", note: "Office closed — heavy rain warning for Mumbai", regularisedById: run.hr.id, regularisedAt: at(day, 8, 10) });
        audit(run, run.hr.id, "UPDATE", "AttendanceDay", p.id, `${p.name} marked holiday on ${k}`, at(day, 8, 10));
        handMarked += 1;
        continue;
      }
      const pu = punchDay.get(`${p.id}:${k}`);
      if (pu) {
        const out = pu.count > 1 ? pu.last : null;
        put({ userId: p.id, date: day, status: "PRESENT", checkInAt: pu.first, checkOutAt: out, workedMinutes: out ? Math.max(0, Math.round((out.getTime() - pu.first.getTime()) / 60000)) : null });
        continue;
      }
      if (k === TODAY_KEY) {
        // Today: in, not out yet — what clockIn writes.
        if (TODAY.getTime() > at(day, 10, 30).getTime() && chance(0.85)) put({ userId: p.id, date: day, status: "PRESENT", checkInAt: at(day, 9, int(0, 80)) });
        continue;
      }
      const m = monthKeyOf(day);
      if (lockedMonths.has(m)) {
        if (absentOn.has(k)) put({ userId: p.id, date: day, status: "ABSENT" });
        else put(present(p.id, day, chance(0.9) ? "PRESENT" : "WORK_FROM_HOME"));
        continue;
      }
      const roll = rnd();
      if (roll < 0.006) continue; // Nobody marked it — "not recorded" is honest, and costs nothing.
      if (roll < 0.018) put({ userId: p.id, date: day, status: "ABSENT" });
      else if (roll < 0.045) put(present(p.id, day, "HALF_DAY"));
      else if (roll < 0.125) put(present(p.id, day, "WORK_FROM_HOME"));
      else put(present(p.id, day, "PRESENT"));
    }
  }

  // Approved leave still to come — approving it wrote these days already.
  for (const [k, lv] of leaveDay) {
    const [userId, day] = k.split(":") as [string, string];
    if (D(day) > TODAY_D) put({ userId, date: D(day), status: lv.status, leaveRequestId: lv.requestId });
  }

  // ── Comp-offs: a Saturday worked, a weekday given back — both marked by HR ─────────────────
  const fieldTeam = people.filter((p) => p.title === "Field Engineer" && p.active);
  for (const p of fieldTeam) {
    const saturdays = eachDay(maxDate(p.joinedOn, START_D), addDays(TODAY_D, -10)).filter((d) => d.getUTCDay() === 6 && !lockedMonths.has(monthKeyOf(d)));
    for (const sat of some(saturdays, 2)) {
      const worked = present(p.id, sat, "PRESENT");
      put({ ...worked, note: "Weekend deployment at the customer's site", regularisedById: run.hr.id, regularisedAt: at(addDays(sat, 2), 10, 5) });
      audit(run, run.hr.id, "UPDATE", "AttendanceDay", p.id, `${p.name} marked present on ${toKey(sat)}`, at(addDays(sat, 2), 10, 5));
      const off = workingOnOrAfter(addDays(sat, int(3, 9)));
      if (off >= TODAY_D || lockedMonths.has(monthKeyOf(off)) || leaveDay.has(`${p.id}:${toKey(off)}`)) continue;
      put({ userId: p.id, date: off, status: "WEEK_OFF", note: `Compensatory off for ${toKey(sat)}`, regularisedById: run.hr.id, regularisedAt: at(addDays(off, -1), 16, 40) });
      audit(run, run.hr.id, "UPDATE", "AttendanceDay", p.id, `${p.name} marked week off on ${toKey(off)}`, at(addDays(off, -1), 16, 40));
      handMarked += 2;
    }
  }

  // ── Corrections asked for: the demo's, and one of every kind ────────────────────────────────
  let corrections = 0;
  const decide = async (
    r: { id: string; userId: string; date: Date; requestedStatus: DayRow["status"]; requestedCheckIn: Date | null; requestedCheckOut: Date | null; reason: string },
    status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
    askedAt: Date,
    note: string | null,
  ) => {
    const p = run.byId.get(r.userId)!;
    const decider = p.managerId && run.byId.get(p.managerId)?.active ? p.managerId : run.hr.id;
    const decidedAt = status === "APPROVED" || status === "REJECTED" ? minDate(new Date(askedAt.getTime() + int(3, 50) * 3_600_000), new Date(TODAY.getTime() - 3_600_000)) : null;
    await db.attendanceRegularisation.update({
      where: { id: r.id },
      data: {
        status,
        approverId: status === "PENDING" || status === "CANCELLED" ? (p.managerId ?? null) : decider,
        decidedAt,
        decisionNote: status === "REJECTED" ? (note ?? "No supporting record for that day.") : status === "APPROVED" ? note : null,
        createdAt: askedAt,
      },
    });
    audit(run, p.id, "CREATE", "AttendanceRegularisation", r.id, `Asked for ${toKey(r.date)} to be marked ${STATUS_WORDS(r.requestedStatus)}`, askedAt);
    if (p.managerId) notify(run, p.managerId, "REGULARISATION_REQUESTED", "Attendance correction requested", `${p.name} has asked for ${toKey(r.date)} to be marked ${STATUS_WORDS(r.requestedStatus)}.`, "/people/me", askedAt);
    if (decidedAt) {
      const approve = status === "APPROVED";
      audit(run, decider, "UPDATE", "AttendanceRegularisation", r.id, `${approve ? "Approved" : "Rejected"} ${p.name}'s correction for ${toKey(r.date)}`, decidedAt);
      const dn = status === "REJECTED" ? (note ?? "No supporting record for that day.") : note;
      notify(run, p.id, "REGULARISATION_DECIDED", `Attendance correction ${approve ? "approved" : "rejected"}`, `${run.byId.get(decider)?.name ?? "Your manager"} ${approve ? "approved" : "rejected"} your correction for ${toKey(r.date)}${dn ? `: ${dn}` : "."}`, "/people/me", decidedAt);
      if (approve) {
        const inAt = r.requestedCheckIn;
        const outAt = r.requestedCheckOut;
        put({
          userId: p.id,
          date: r.date,
          status: r.requestedStatus,
          checkInAt: inAt,
          checkOutAt: outAt,
          workedMinutes: inAt && outAt ? Math.max(0, Math.round((outAt.getTime() - inAt.getTime()) / 60000)) : null,
          note: `Corrected: ${r.reason}`,
          regularisedById: decider,
          regularisedAt: decidedAt,
        });
      }
    }
    corrections += 1;
  };

  for (const r of existing) {
    const p = run.byId.get(r.userId);
    const k = `${r.userId}:${toKey(r.date)}`;
    // The app refuses a correction on a leave day, or for a day somebody did not work here.
    if (!p || leaveDay.has(k) || r.date < p.joinedOn || (p.exitedOn && r.date > p.exitedOn) || r.date > TODAY_D) {
      await db.attendanceRegularisation.delete({ where: { id: r.id } });
      continue;
    }
    await decide(r, r.status, at(addDays(r.date, int(0, 2)), int(10, 18), int(0, 59)), r.status === "REJECTED" ? r.decisionNote : null);
  }

  // One of every requested status, and one withdrawn — on days that make each request make sense.
  const candidates = people.filter((p) => p.active && p.managerId);
  const openMonthDays = (p: Person, status: DayRow["status"] | "none") =>
    [...rows.values()].filter((r) => r.userId === p.id && !lockedMonths.has(monthKeyOf(r.date)) && r.date < TODAY_D && (status === "none" ? false : r.status === status) && !r.regularisedAt && !r.leaveRequestId);
  const plan: { requested: DayRow["status"]; from: DayRow["status"]; status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; reason: string; note: string | null; times: boolean }[] = [
    { requested: "PRESENT", from: "ABSENT", status: "APPROVED", reason: "Biometric did not read my finger; security has the register entry.", note: null, times: true },
    { requested: "PRESENT", from: "ABSENT", status: "PENDING", reason: "Was at the customer's site all day — no punch at the door.", note: null, times: true },
    { requested: "WORK_FROM_HOME", from: "ABSENT", status: "APPROVED", reason: "Worked from home with my manager's approval — internet outage at the office.", note: "Okay, noted.", times: true },
    { requested: "HALF_DAY", from: "ABSENT", status: "REJECTED", reason: "Came in for the afternoon after the doctor's appointment.", note: "The register shows no entry that afternoon.", times: true },
    { requested: "ON_LEAVE", from: "ABSENT", status: "APPROVED", reason: "I was on leave that day and forgot to apply — my manager knew.", note: "Approved this once; please apply in advance next time.", times: false },
    { requested: "ABSENT", from: "PRESENT", status: "APPROVED", reason: "Marked present by mistake — I was not in that day.", note: null, times: false },
    { requested: "WEEK_OFF", from: "PRESENT", status: "APPROVED", reason: "Compensatory off for the Saturday deployment the week before.", note: null, times: false },
    { requested: "HOLIDAY", from: "PRESENT", status: "REJECTED", reason: "Local holiday in Pune — the office was shut.", note: "The Pune office was open; it isn't on our calendar.", times: false },
    { requested: "PRESENT", from: "HALF_DAY", status: "CANCELLED", reason: "Forgot to punch out after the evening deployment.", note: null, times: true },
    { requested: "WORK_FROM_HOME", from: "PRESENT", status: "CANCELLED", reason: "Asked by mistake — the day was right.", note: null, times: true },
  ];
  if (rainDay) plan.push({ requested: "HOLIDAY", from: "ABSENT", status: "APPROVED", reason: "The office was closed for the rain day but I am shown absent.", note: null, times: false });
  for (const [i, step] of plan.entries()) {
    for (let tries = 0; tries < candidates.length; tries++) {
      const p = candidates[(i * 7 + tries) % candidates.length]!;
      const options = openMonthDays(p, step.from).filter((r) => step.status !== "PENDING" || r.date >= addDays(TODAY_D, -20));
      if (options.length === 0) continue;
      const day = pick(options).date;
      const created = await db.attendanceRegularisation.create({
        data: {
          userId: p.id,
          date: day,
          requestedStatus: step.requested,
          requestedCheckIn: step.times ? at(day, 9, int(20, 50)) : null,
          requestedCheckOut: step.times ? (step.requested === "HALF_DAY" ? at(day, 13, int(30, 59)) : at(day, 18, int(10, 50))) : null,
          reason: step.reason,
        },
      });
      await decide(created, step.status, at(addDays(day, int(0, 2)), int(10, 18), int(0, 59)), step.note);
      break;
    }
  }

  // ── Write it ────────────────────────────────────────────────────────────────────────────────
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  const all = [...rows.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  await inChunks(all, 2000, (c) => db.attendanceDay.createMany({ data: c }));
  const t = await flushTrail(run);
  const byStatus = new Map<string, number>();
  for (const r of all) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  log("Attendance", `${all.length} days across ${people.length} people (${[...byStatus].map(([s, n]) => `${n} ${STATUS_WORDS(s)}`).join(", ")})`);
  log("Corrections", `${corrections} regularisations, ${handMarked} days marked by HR; ${t.audits} audit rows, ${t.notes} notifications`);
}

// ─── Targets and incentives ──────────────────────────────────────────────────────────────────────

type SchemeSeed = {
  name: string;
  description: string;
  metric: Prisma.IncentiveSchemeCreateInput["metric"];
  basis: Prisma.IncentiveSchemeCreateInput["basis"];
  thresholdPercent?: number;
  ratePercent?: number;
  fixedAmount?: number;
  perUnitAmount?: number;
  capAmount?: number;
  slabs?: { fromPercent: number; toPercent: number | null; ratePercent?: number; fixedAmount?: number }[];
};

/** One scheme for every metric the app measures, across every way a scheme can pay. */
const SCHEMES: SchemeSeed[] = [
  { name: "Monthly invoicing — banded", description: "Paid on what was invoiced in the month; the further past target, the better the rate.", metric: "INVOICED_VALUE", basis: "SLAB",
    slabs: [{ fromPercent: 0, toPercent: 80, ratePercent: 0.5 }, { fromPercent: 80, toPercent: 100, ratePercent: 1.5 }, { fromPercent: 100, toPercent: 120, ratePercent: 2.5 }, { fromPercent: 120, toPercent: null, ratePercent: 3.5 }] },
  { name: "Collections — flat on target", description: "A flat amount for collecting the month's target in full.", metric: "COLLECTED_VALUE", basis: "FIXED_ON_ACHIEVEMENT", thresholdPercent: 100, fixedAmount: 10000 },
  { name: "Order booking — 1% of target", description: "One per cent of the target, once 90% of it is booked. Overachievement is its own reward.", metric: "ORDER_VALUE", basis: "PERCENT_OF_TARGET", thresholdPercent: 90, ratePercent: 1 },
  { name: "Regional margin share", description: "Five per cent of the margin the region books, from 70% of target, capped.", metric: "ORDER_MARGIN", basis: "PERCENT_OF_ACHIEVEMENT", thresholdPercent: 70, ratePercent: 5, capAmount: 50000 },
  { name: "Leads raised — per lead", description: "For the calling floor: every qualified lead handed to sales.", metric: "LEADS_CREATED", basis: "PER_UNIT", perUnitAmount: 150, capAmount: 6000 },
  { name: "Deals closed — quarter bonus", description: "A flat bonus for closing the quarter's number of deals.", metric: "LEADS_WON", basis: "FIXED_ON_ACHIEVEMENT", thresholdPercent: 100, fixedAmount: 7500 },
  { name: "Value won — banded", description: "Presales share in the value of what they helped win.", metric: "LEAD_VALUE_WON", basis: "SLAB",
    slabs: [{ fromPercent: 0, toPercent: 100, ratePercent: 0.5 }, { fromPercent: 100, toPercent: null, ratePercent: 1.5 }] },
  { name: "Talk time — monthly bonus", description: "For hitting the month's talk-time target.", metric: "CALL_MINUTES", basis: "FIXED_ON_ACHIEVEMENT", thresholdPercent: 100, fixedAmount: 2000 },
  { name: "Field visits — per visit", description: "Every completed visit with a check-out.", metric: "VISITS_COMPLETED", basis: "PER_UNIT", perUnitAmount: 250 },
  { name: "Profiling — per company", description: "Every company added to the book, once.", metric: "COMPANIES_ADDED", basis: "PER_UNIT", perUnitAmount: 40, capAmount: 4000 },
  { name: "Profiling — per contact", description: "Every contact added under a company the profiler created.", metric: "CONTACTS_ADDED", basis: "PER_UNIT", perUnitAmount: 15, capAmount: 3000 },
  { name: "Support resolution — banded", description: "A flat amount by how much of the month's ticket target was resolved.", metric: "TICKETS_RESOLVED", basis: "SLAB", thresholdPercent: 80,
    slabs: [{ fromPercent: 80, toPercent: 100, fixedAmount: 1500 }, { fromPercent: 100, toPercent: null, fixedAmount: 3500 }] },
  { name: "New logo bonus", description: "For winning the quarter's number of new customers.", metric: "NEW_CUSTOMERS", basis: "FIXED_ON_ACHIEVEMENT", thresholdPercent: 100, fixedAmount: 15000 },
  { name: "Seats added — 3%", description: "Three per cent of the value of seats added to existing subscriptions.", metric: "ADDON_VALUE", basis: "PERCENT_OF_ACHIEVEMENT", ratePercent: 3 },
  { name: "Purchase savings — 2% of target", description: "Two per cent of the savings target, for meeting it.", metric: "PURCHASE_SAVINGS", basis: "PERCENT_OF_TARGET", thresholdPercent: 100, ratePercent: 2 },
];

type TargetSeed = { metric: SchemeSeed["metric"]; period: "MONTH" | "QUARTER" | "YEAR"; scope: "USER" | "DEPARTMENT" | "COMPANY"; userId?: string; departmentId?: string; win: { fromDate: string; toDate: string; label: string }; schemeId?: string | null; createdById: string; userIds: string[] };

/** A target worth having: near what the person actually managed, so about half are met. */
function targetValueFor(metric: SchemeSeed["metric"], achieved: number) {
  const unit = metricByKey[metric].unit;
  const base = achieved > 0 ? achieved * (0.75 + rnd() * 0.6) : unit === "CURRENCY" ? int(2, 8) * 100000 : int(5, 25);
  if (unit === "CURRENCY") return Math.max(10000, Math.round(base / 10000) * 10000);
  if (unit === "MINUTES") return Math.max(15, Math.round(base / 5) * 5);
  return Math.max(1, Math.round(base));
}

async function targetsAndIncentives(run: Run) {
  const { db, people } = run;
  if (await db.incentiveScheme.findFirst({ where: { name: SCHEMES[0]!.name }, select: { id: true } })) {
    log("Targets & incentives", "already written — left as they are");
    return;
  }
  const headOfSales = find(people, "Head of Sales", run.director);
  const insideLead = find(people, "Inside Sales Lead", headOfSales);
  const supportLead = find(people, "Support Lead", run.director);
  const purchaseHead = find(people, "Purchase Manager", run.controller);

  // ── Schemes ─────────────────────────────────────────────────────────────────────────────────
  const schemeOf = new Map<string, { id: string; scheme: Scheme; requiresCollection: boolean }>();
  for (const s of SCHEMES) {
    const scheme: Scheme = {
      name: s.name, basis: s.basis, thresholdPercent: s.thresholdPercent ?? null, ratePercent: s.ratePercent ?? null,
      fixedAmount: s.fixedAmount ?? null, perUnitAmount: s.perUnitAmount ?? null, capAmount: s.capAmount ?? null,
      slabs: (s.slabs ?? []).map((b) => ({ fromPercent: b.fromPercent, toPercent: b.toPercent, ratePercent: b.ratePercent ?? null, fixedAmount: b.fixedAmount ?? null })),
    };
    const problems = validateScheme(scheme).filter((p) => !p.includes("unusually high"));
    if (problems.length) throw new Error(`Scheme "${s.name}": ${problems.join(" ")}`);
    const createdAt = at(workingOnOrAfter(addDays(START_D, int(2, 20))), 12, int(0, 59));
    const row = await db.incentiveScheme.create({
      data: {
        name: s.name, description: s.description, metric: s.metric, basis: s.basis,
        thresholdPercent: s.thresholdPercent != null ? dec(s.thresholdPercent) : null,
        ratePercent: s.ratePercent != null ? new Prisma.Decimal(s.ratePercent) : null,
        fixedAmount: s.fixedAmount != null ? dec(s.fixedAmount) : null,
        perUnitAmount: s.perUnitAmount != null ? dec(s.perUnitAmount) : null,
        capAmount: s.capAmount != null ? dec(s.capAmount) : null,
        requiresCollection: false,
        createdById: run.controller.id,
        createdAt,
        slabs: { create: (s.slabs ?? []).map((b) => ({ fromPercent: dec(b.fromPercent), toPercent: b.toPercent === null ? null : dec(b.toPercent), ratePercent: b.ratePercent != null ? new Prisma.Decimal(b.ratePercent) : null, fixedAmount: b.fixedAmount != null ? dec(b.fixedAmount) : null })) },
      },
    });
    schemeOf.set(s.metric, { id: row.id, scheme, requiresCollection: false });
    audit(run, run.controller.id, "CREATE", "IncentiveScheme", row.id, s.name, createdAt);
  }
  // The demo's own per-call scheme pays the calling floor, as it was written to.
  const callingScheme = await db.incentiveScheme.findFirst({ where: { metric: "CALLS_CONNECTED", basis: "PER_UNIT" }, include: { slabs: true } });
  if (callingScheme) {
    schemeOf.set("CALLS_CONNECTED", {
      id: callingScheme.id,
      requiresCollection: callingScheme.requiresCollection,
      scheme: { name: callingScheme.name, basis: callingScheme.basis, thresholdPercent: numOrNull(callingScheme.thresholdPercent), ratePercent: numOrNull(callingScheme.ratePercent), fixedAmount: numOrNull(callingScheme.fixedAmount), perUnitAmount: numOrNull(callingScheme.perUnitAmount), capAmount: numOrNull(callingScheme.capAmount), slabs: [] },
    });
  }

  // ── Who carries which number ────────────────────────────────────────────────────────────────
  const fy = financialYearOf(TODAY_D);
  const months: { year: number; month: number }[] = [];
  for (let d = new Date(Date.UTC(START_D.getUTCFullYear(), START_D.getUTCMonth(), 1)); d <= TODAY_D; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  const quarters: { fyStart: number; q: number }[] = [];
  for (const m of months) {
    const f = m.month >= 4 ? m.year : m.year - 1;
    const q = m.month >= 4 ? Math.floor((m.month - 4) / 3) + 1 : 4;
    if (!quarters.some((x) => x.fyStart === f && x.q === q)) quarters.push({ fyStart: f, q });
  }
  const sellers = people.filter((p) => ["Account Manager", "Senior Account Manager", "Key Account Manager"].includes(p.title));
  const kams = people.filter((p) => p.title === "Key Account Manager");
  const rsms = people.filter((p) => p.title === "Regional Sales Manager");
  const callers = people.filter((p) => ["Calling Executive", "Senior Calling Executive"].includes(p.title));
  const profilers = people.filter((p) => p.title === "Data Profiler");
  const fieldEngineers = people.filter((p) => p.title === "Field Engineer");
  const supportEngineers = people.filter((p) => ["Support Engineer", "Senior Support Engineer"].includes(p.title));
  const presales = people.filter((p) => p.dept === "Presales & Solutions");
  const buyers = people.filter((p) => p.title === "Purchase Executive");
  const everybody = people.map((p) => p.id);
  const deptIds = (name: string) => people.filter((p) => p.deptId === run.ctx.departments.get(name)).map((p) => p.id);

  const seeds: TargetSeed[] = [];
  const onBoard = (p: Person, from: string, to: string) => p.joinedOn <= D(to) && (!p.exitedOn || p.exitedOn >= D(from));
  for (const { year, month } of months) {
    const w = monthWindow(year, month);
    const monthly = (list: Person[], metric: SchemeSeed["metric"], by: Person, every = 1) =>
      list.filter((p, i) => onBoard(p, w.fromDate, w.toDate) && (i + month) % every === 0).forEach((p) =>
        seeds.push({ metric, period: "MONTH", scope: "USER", userId: p.id, win: w, schemeId: schemeOf.get(metric)?.id ?? null, createdById: by.id, userIds: [p.id] }));
    monthly(sellers, "INVOICED_VALUE", headOfSales);
    monthly(sellers, "COLLECTED_VALUE", headOfSales, 3);
    monthly(sellers, "ORDER_VALUE", headOfSales, 2);
    monthly(callers, "CALLS_CONNECTED", insideLead);
    monthly(callers, "LEADS_CREATED", insideLead);
    monthly(callers, "CALL_MINUTES", insideLead, 2);
    monthly(profilers, "COMPANIES_ADDED", insideLead);
    monthly(profilers, "CONTACTS_ADDED", insideLead);
    monthly(fieldEngineers, "VISITS_COMPLETED", supportLead);
    monthly(supportEngineers, "TICKETS_RESOLVED", supportLead);
    // Two company-wide monthly numbers, for the dashboard tiles.
    for (const metric of ["CONTACTS_ADDED", "COMPANIES_ADDED"] as const) seeds.push({ metric, period: "MONTH", scope: "COMPANY", win: w, createdById: run.director.id, userIds: everybody });
  }
  for (const { fyStart, q } of quarters) {
    const w = quarterWindow(fyStart, q);
    const quarterly = (list: Person[], metric: SchemeSeed["metric"], by: Person) =>
      list.filter((p) => onBoard(p, w.fromDate, w.toDate)).forEach((p) =>
        seeds.push({ metric, period: "QUARTER", scope: "USER", userId: p.id, win: w, schemeId: schemeOf.get(metric)?.id ?? null, createdById: by.id, userIds: [p.id] }));
    quarterly(rsms, "ORDER_MARGIN", headOfSales);
    quarterly(sellers, "LEADS_WON", headOfSales);
    quarterly(presales, "LEAD_VALUE_WON", headOfSales);
    quarterly(kams, "NEW_CUSTOMERS", headOfSales);
    quarterly(kams, "ADDON_VALUE", headOfSales);
    quarterly(buyers, "PURCHASE_SAVINGS", purchaseHead);
    for (const metric of ["ORDER_VALUE", "LEAD_VALUE_WON"] as const) seeds.push({ metric, period: "QUARTER", scope: "COMPANY", win: w, createdById: run.director.id, userIds: everybody });
    const support = run.ctx.departments.get("Support");
    if (support) seeds.push({ metric: "VISITS_COMPLETED", period: "QUARTER", scope: "DEPARTMENT", departmentId: support, win: w, createdById: supportLead.id, userIds: deptIds("Support") });
  }
  for (const f of [fy - 1, fy]) {
    const w = yearWindow(f);
    if (D(w.toDate) < START_D) continue;
    for (const metric of ["INVOICED_VALUE", "COLLECTED_VALUE", "NEW_CUSTOMERS", "ORDER_MARGIN", "CALLS_CONNECTED"] as const) {
      seeds.push({ metric, period: "YEAR", scope: "COMPANY", win: w, createdById: run.director.id, userIds: everybody });
    }
    const support = run.ctx.departments.get("Support");
    if (support) seeds.push({ metric: "TICKETS_RESOLVED", period: "YEAR", scope: "DEPARTMENT", departmentId: support, win: w, createdById: supportLead.id, userIds: deptIds("Support") });
  }

  // ── Set them, near what was actually achieved ───────────────────────────────────────────────
  const created: { id: string; seed: TargetSeed; value: number; achieved: number; label: string }[] = [];
  // What each holder managed in the periods before — what a target for a period still running is set from.
  const history = new Map<string, number[]>();
  const metricsSet = new Set<string>();
  for (const s of seeds) {
    const from = D(s.win.fromDate);
    const to = D(s.win.toDate);
    const achieved = await run.ws(() => measure(db, s.metric, { from, to, userIds: s.userIds }));
    const holder = `${s.metric}|${s.period}|${s.scope}|${s.userId ?? s.departmentId ?? "company"}`;
    const past = history.get(holder) ?? [];
    const finishedPeriod = to < TODAY_D;
    // Nobody sets a monthly number for work a person does not do: a past target with nothing at all
    // behind it is mostly left out — but every metric keeps at least one, so the screens show all of them.
    if (finishedPeriod && s.scope === "USER" && achieved === 0 && metricsSet.has(s.metric) && !chance(0.12)) continue;
    metricsSet.add(s.metric);
    if (finishedPeriod) history.set(holder, [...past, achieved]);
    const basis = finishedPeriod ? achieved : past.length ? past.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, past.length) : achieved;
    const value = targetValueFor(s.metric, basis);
    const createdAt = at(workingOnOrBefore(addDays(maxDate(from, START_D), -int(0, 3))), int(10, 12), int(0, 59));
    const label = s.scope === "USER" ? `${run.byId.get(s.userId!)?.first ?? "—"} — ${s.win.label}` : s.scope === "DEPARTMENT" ? `${[...run.ctx.departments].find(([, id]) => id === s.departmentId)?.[0] ?? "Team"} — ${s.win.label}` : `Company — ${s.win.label}`;
    const row = await db.target.create({
      data: {
        metric: s.metric, period: s.period, scope: s.scope, userId: s.userId ?? null, departmentId: s.departmentId ?? null,
        fromDate: from, toDate: to, label, value: dec(value), incentiveSchemeId: s.schemeId ?? null,
        createdById: s.createdById, createdAt,
      },
    });
    created.push({ id: row.id, seed: s, value, achieved, label });
    run.achieved.set(row.id, achieved);
    audit(run, s.createdById, "CREATE", "Target", row.id, `${metricByKey[s.metric].label} · ${label} · ${value}`, createdAt);
    if (s.userId && s.userId !== s.createdById) notify(run, s.userId, "TASK_ASSIGNED", `${metricByKey[s.metric].label} target for ${label}`, "A new target has been set for you.", "/targets/mine", createdAt);
  }

  // ── What the finished periods earned — generateEarnings, month by month ─────────────────────
  let raised = 0;
  let nil = 0;
  const statusCount = new Map<string, number>();
  const finished = created.filter((c) => c.seed.scope === "USER" && c.seed.schemeId && D(c.seed.win.toDate) < TODAY_D);
  const approverFor = (p: Person) => (p.dept === "Sales" || p.dept === "Presales & Solutions" ? headOfSales : run.controller);
  for (const c of finished) {
    const p = run.byId.get(c.seed.userId!)!;
    const s = [...schemeOf.values()].find((x) => x.id === c.seed.schemeId)!;
    const result = computeIncentive({ scheme: s.scheme, targetValue: c.value, achievedValue: c.achieved });
    const toDate = D(c.seed.win.toDate);
    const worked = minDate(at(workingOnOrAfter(addDays(toDate, int(2, 5))), 11, int(0, 59)), new Date(TODAY.getTime() - 2 * 3_600_000));
    const pct = c.value > 0 ? Math.round((c.achieved / c.value) * 10000) / 100 : 0;
    let status: "DUE" | "APPROVED" | "HELD" | "CANCELLED" = result.amount > 0 ? "DUE" : "CANCELLED";
    let heldReason: string | null = null;
    let approvedAt: Date | null = null;
    const recent = toDate >= addDays(TODAY_D, -35);
    if (result.amount > 0) {
      const roll = rnd();
      if (recent && roll < 0.35) status = "DUE";
      else if (roll < 0.06) {
        status = "HELD";
        heldReason = pick(["Waiting for the customer's payment to clear.", "Two invoices under dispute — held until they are settled.", "Under review: the order was booked twice."]);
      } else if (roll < 0.09) {
        status = "CANCELLED";
        heldReason = pick(["Order cancelled by the customer — the invoice was credited.", "Duplicate of an earning already paid."]);
      } else {
        status = "APPROVED";
        approvedAt = minDate(new Date(worked.getTime() + int(20, 70) * 3_600_000), new Date(TODAY.getTime() - 3_600_000));
      }
    }
    const approver = approverFor(p);
    const row = await db.incentiveEarning.create({
      data: {
        userId: p.id, targetId: c.id, schemeId: c.seed.schemeId!, metric: c.seed.metric,
        fromDate: D(c.seed.win.fromDate), toDate, label: c.label,
        targetValue: dec(c.value), achievedValue: dec(c.achieved), achievedPercent: dec(pct),
        amount: dec(result.amount), workings: result.workings,
        status, heldReason,
        note: result.amount > 0 ? null : "Nothing was due under the scheme.",
        approvedById: approvedAt ? (approver.id === p.id ? run.controller.id : approver.id) : null,
        approvedAt,
        createdById: run.controller.id,
        createdAt: worked,
      },
    });
    raised += 1;
    if (result.amount <= 0) nil += 1;
    statusCount.set(status, (statusCount.get(status) ?? 0) + 1);
    if (status === "APPROVED" || status === "HELD" || (status === "CANCELLED" && result.amount > 0)) {
      const decider = approvedAt ? (approver.id === p.id ? run.controller : approver) : approver;
      const when = approvedAt ?? new Date(worked.getTime() + int(20, 70) * 3_600_000);
      const word = status === "APPROVED" ? "approved" : status === "HELD" ? "on hold" : "cancelled";
      audit(run, decider.id, "UPDATE", "IncentiveEarning", row.id, `${p.name} — ${row.label} — ${status.toLowerCase()}${heldReason ? `: ${heldReason}` : ""}`, when);
      notify(run, p.id, "EXPENSE_DECIDED", `Incentive ${word} — ${row.label}`, heldReason ?? `₹${Math.round(result.amount).toLocaleString("en-IN")}`, "/incentives/mine", when);
    }
  }
  // The batch audit generateEarnings writes, one per month it was run.
  const byMonth = new Map<string, { at: Date; n: number; nil: number }>();
  for (const e of await db.incentiveEarning.findMany({ where: { targetId: { in: finished.map((c) => c.id) } }, select: { createdAt: true, amount: true } })) {
    const k = toKey(e.createdAt).slice(0, 7);
    const cur = byMonth.get(k) ?? { at: e.createdAt, n: 0, nil: 0 };
    cur.n += 1;
    if (num(e.amount) <= 0) cur.nil += 1;
    byMonth.set(k, cur);
  }
  for (const [, v] of byMonth) audit(run, run.controller.id, "CREATE", "IncentiveEarning", "batch", `Worked out ${v.n} incentive(s), ${v.nil} of them nil`, v.at);

  // ── A one-off award, the way awardOneOff writes it ──────────────────────────────────────────
  const star = supportEngineers.find((p) => p.active) ?? people.find((p) => p.active)!;
  const awardDay = workingOnOrBefore(addDays(TODAY_D, -int(40, 60)));
  const reason = "Weekend recovery of a customer's mail server after the ransomware scare";
  const oneOff = await db.incentiveEarning.create({
    data: {
      userId: star.id, fromDate: awardDay, toDate: awardDay, label: "One-off award", amount: dec(5000),
      workings: `One-off award: ${reason}`, note: reason, status: "APPROVED",
      approvedById: run.controller.id, approvedAt: at(addDays(awardDay, 1), 12, 15),
      createdById: supportLead.id, createdAt: at(awardDay, 17, 40),
    },
  });
  audit(run, supportLead.id, "CREATE", "IncentiveEarning", oneOff.id, `One-off award of ₹${(5000).toLocaleString("en-IN")} — ${reason}`, at(awardDay, 17, 40));

  const t = await flushTrail(run);
  log("Targets", `${created.length} — every metric; month, quarter and year; user, department and company`);
  log("Incentives", `${SCHEMES.length} schemes on every basis; ${raised} earnings worked out (${nil} nil) — ${[...statusCount].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")}, 1 one-off; ${t.notes} notifications`);
}

// ─── Payroll ─────────────────────────────────────────────────────────────────────────────────────

/** `lossOfPayDays`, on this seed's client: ABSENT days, and days of unpaid leave (a half day is half). */
async function lossOfPay(db: PrismaClient, userId: string, year: number, month: number) {
  const { from, to } = monthRange(year, month);
  const rows = await db.attendanceDay.findMany({ where: { userId, date: { gte: from, lte: to } }, select: { status: true, leaveRequestId: true } });
  const ids = rows.map((r) => r.leaveRequestId).filter((v): v is string => !!v);
  const unpaid = new Set((await db.leaveRequest.findMany({ where: { id: { in: ids }, type: { paid: false } }, select: { id: true } })).map((r) => r.id));
  let lop = 0;
  for (const r of rows) {
    if (r.status === "ABSENT") lop += 1;
    else if (r.leaveRequestId && unpaid.has(r.leaveRequestId)) lop += r.status === "HALF_DAY" ? 0.5 : 1;
  }
  return lop;
}

/**
 * TDS the way payroll would enter it on a draft before locking: the new regime's slabs on the year's
 * pay, less the standard deduction, with the rebate that takes everybody under ₹12 lakh to nothing.
 * Entered by hand in the app (`adjustPayslip`) — the engine deliberately does not guess it.
 */
function monthlyTds(gross: number) {
  const income = gross * 12 - 75000;
  if (income <= 1200000) return 0;
  const slabs: [number, number][] = [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]];
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of slabs) {
    if (income > lower) tax += (Math.min(income, upper) - lower) * rate;
    lower = upper;
  }
  return Math.round((tax * 1.04) / 12 / 10) * 10;
}

/**
 * A run for every month of the year, through the engine the app runs (`runPayroll` → `computePayslip`).
 *
 * Who is paid is who the action pays: everybody here on the first of the month, and nobody who had
 * not joined by its end. Loss of pay is read from the attendance written above, so a payslip's paid
 * days match the grid. Incentives approved by the time a run is made go out with it, and are marked
 * paid against the payslip — `attachToPayslips`. Past months are locked, paid and posted to the books
 * by the app's own posting functions; this month's run is still a draft.
 */
async function payroll(run: Run) {
  const { db, people } = run;
  const first = monthOf(at(START_D, 12));
  if (await db.payrollRun.findUnique({ where: { month_year: { month: first.month, year: first.year } }, select: { id: true } })) {
    log("Payroll", "already written — left as it is");
    return;
  }
  const current = monthOf(TODAY);
  const runs: { month: number; year: number }[] = [];
  for (let y = first.year, m = first.month; y < current.year || (y === current.year && m <= current.month); m === 12 ? ((m = 1), (y += 1)) : (m += 1)) runs.push({ month: m, year: y });

  const existing = new Set((await db.payrollRun.findMany({ select: { month: true, year: true } })).map((r) => `${r.year}-${r.month}`));
  // The demo's two runs were locked before their month was out, and one was marked paid the day before
  // it was locked. Made at the month's end, locked the next working day, paid on the 7th — the payday
  // its payment entry in the books already carries.
  for (const r of await db.payrollRun.findMany({ where: { status: { not: "DRAFT" } }, include: { _count: { select: { payslips: true } } } })) {
    const { to } = monthRange(r.year, r.month);
    const createdAt = at(workingOnOrBefore(addDays(to, -2)), 16, int(0, 50));
    const lockedAt = minDate(at(workingOnOrAfter(addDays(to, 1)), 11, int(0, 50)), new Date(TODAY.getTime() - 3_600_000));
    const paidAt = r.status === "PAID" ? new Date(Date.UTC(r.year, r.month, 7, 12)) : null;
    await db.payrollRun.update({ where: { id: r.id }, data: { createdAt, lockedAt, lockedById: run.controller.id, paidAt, createdById: r.createdById ?? run.controller.id } });
    audit(run, run.controller.id, "CREATE", "PayrollRun", r.id, `Payroll for ${monthLabel(r.month, r.year)} — ${r._count.payslips} payslip(s)`, createdAt);
    audit(run, run.controller.id, "UPDATE", "PayrollRun", r.id, `${monthLabel(r.month, r.year)} payroll marked locked`, lockedAt);
    if (paidAt) audit(run, run.controller.id, "UPDATE", "PayrollRun", r.id, `${monthLabel(r.month, r.year)} payroll marked paid`, paidAt);
  }
  const structures = await db.salaryStructure.findMany({ where: { userId: { in: people.map((p) => p.id) } }, orderBy: { effectiveFrom: "desc" } });
  let made = 0;
  let slips = 0;
  let paidIncentives = 0;
  let posted = 0;
  for (const { month, year } of runs) {
    if (existing.has(`${year}-${month}`)) continue;
    const isDraft = month === current.month && year === current.year;
    const { from, to } = monthRange(year, month);
    const createdAt = isDraft ? at(workingOnOrBefore(TODAY_D), 11, 30) : at(workingOnOrBefore(addDays(to, -2)), 16, int(0, 50));
    const lockedAt = isDraft ? null : at(workingOnOrAfter(addDays(to, 1)), 11, int(0, 50));
    const paidOn = new Date(Date.UTC(year, month, 7, 12));
    const runRow = await db.payrollRun.create({
      data: {
        month, year, status: isDraft ? "DRAFT" : "PAID",
        lockedAt, lockedById: isDraft ? null : run.controller.id,
        paidAt: isDraft ? null : paidOn,
        createdById: run.controller.id, createdAt,
      },
    });

    // Incentives approved by the time the run was made, for periods ending by its last day.
    const due = await db.incentiveEarning.findMany({
      where: { status: "APPROVED", payslipId: null, toDate: { lte: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)) }, approvedAt: { lte: createdAt } },
      include: { scheme: { select: { requiresCollection: true } } },
    });
    const incentiveBy = new Map<string, { total: number; ids: string[] }>();
    for (const e of due) {
      if (e.scheme?.requiresCollection) continue; // Never collected in full — the app would not pay it.
      const cur = incentiveBy.get(e.userId) ?? { total: 0, ids: [] };
      cur.total = Math.round((cur.total + num(e.amount)) * 100) / 100;
      cur.ids.push(e.id);
      incentiveBy.set(e.userId, cur);
    }

    const paid = people.filter((p) => p.joinedOn <= to && (!p.exitedOn || p.exitedOn >= from)).sort((a, b) => a.name.localeCompare(b.name));
    const rows: Prisma.PayslipCreateManyInput[] = [];
    const tdsFor: { userId: string; name: string }[] = [];
    for (const p of paid) {
      const s = structures.find((x) => x.userId === p.id && x.effectiveFrom <= to);
      if (!s) continue;
      const lopDays = await lossOfPay(db, p.id, year, month);
      const incentive = incentiveBy.get(p.id)?.total ?? 0;
      const result = computePayslip({
        components: { basic: num(s.basic), hra: num(s.hra), conveyance: num(s.conveyance), medical: num(s.medical), specialAllowance: num(s.specialAllowance), otherAllowance: num(s.otherAllowance) },
        flags: { pfApplicable: s.pfApplicable, esiApplicable: s.esiApplicable, ptApplicable: s.ptApplicable },
        monthDays: daysInMonth(year, month),
        lopDays,
        state: p.state,
        month,
        year,
        incentive,
      });
      // Payroll's own hand-entered TDS on the months it locked, as adjustPayslip writes it.
      const tds = isDraft ? 0 : monthlyTds(result.grossEarnings - result.incentive);
      const totalDeductions = result.pfEmployee + result.esiEmployee + result.professionalTax + tds;
      if (tds > 0) tdsFor.push({ userId: p.id, name: p.name });
      rows.push({
        runId: runRow.id,
        userId: p.id,
        monthDays: dec(result.monthDays),
        paidDays: dec(result.paidDays),
        lopDays: dec(result.lopDays),
        basic: dec(result.components.basic),
        hra: dec(result.components.hra),
        conveyance: dec(result.components.conveyance),
        medical: dec(result.components.medical),
        specialAllowance: dec(result.components.specialAllowance),
        otherAllowance: dec(result.components.otherAllowance),
        incentive: dec(result.incentive),
        grossEarnings: dec(result.grossEarnings),
        pfEmployee: dec(result.pfEmployee),
        pfEmployer: dec(result.pfEmployer),
        esiEmployee: dec(result.esiEmployee),
        esiEmployer: dec(result.esiEmployer),
        professionalTax: dec(result.professionalTax),
        incomeTax: dec(tds),
        totalDeductions: dec(totalDeductions),
        netPay: dec(result.grossEarnings - totalDeductions),
        employerCost: dec(result.employerCost),
        note: tds > 0 ? `TDS as per the declaration for FY ${financialYearOf(from)}-${String((financialYearOf(from) + 1) % 100).padStart(2, "0")}.` : result.warnings.join(" ") || null,
        createdAt,
      });
    }
    await db.payslip.createMany({ data: rows });
    slips += rows.length;
    audit(run, run.controller.id, "CREATE", "PayrollRun", runRow.id, `Payroll for ${monthLabel(month, year)} — ${rows.length} payslip(s)`, createdAt);
    for (const t of tdsFor) audit(run, run.controller.id, "UPDATE", "Payslip", runRow.id, `Adjusted ${t.name}'s payslip for ${monthLabel(month, year)}`, new Date(createdAt.getTime() + int(10, 90) * 60_000));

    // attachToPayslips: the incentives go out with the salary.
    const slipIds = new Map((await db.payslip.findMany({ where: { runId: runRow.id }, select: { id: true, userId: true } })).map((s) => [s.userId, s.id]));
    for (const [userId, inc] of incentiveBy) {
      const payslipId = slipIds.get(userId);
      if (!payslipId) continue;
      await db.incentiveEarning.updateMany({ where: { id: { in: inc.ids } }, data: { status: "PAID", paidAt: createdAt, payslipId } });
      paidIncentives += inc.ids.length;
    }

    if (!isDraft && lockedAt) {
      audit(run, run.controller.id, "UPDATE", "PayrollRun", runRow.id, `${monthLabel(month, year)} payroll marked locked`, lockedAt);
      audit(run, run.controller.id, "UPDATE", "PayrollRun", runRow.id, `${monthLabel(month, year)} payroll marked paid`, paidOn);
      if (await postPayrollToLedger(db, runRow.id, run.controller.id)) posted += 1;
      if (await postPayrollPaymentToLedger(db, runRow.id, run.controller.id, paidOn)) posted += 1;
    }
    made += 1;
  }
  const t = await flushTrail(run);
  log("Payroll", `${made} runs (${made - 1} paid and posted, this month's a draft), ${slips} payslips, ${paidIncentives} incentives paid with salary; ${posted} ledger entries; ${t.audits} audit rows`);
}

// ─── Full and final ──────────────────────────────────────────────────────────────────────────────

/**
 * A settlement for everybody with a last working day, worked out by `computeSettlement` from the
 * same inputs `buildSettlement` reads: the latest salary structure, the final month's loss of pay,
 * the latest year's leave balances, the notice period. Then taken as far through approval as each
 * case would be by now. The demo's settlement for the person still serving notice said PAID — money
 * paid out a fortnight before somebody's last day — so it is prepared again, as the draft it would be.
 */
async function settlements(run: Run) {
  const { db, people } = run;
  const leavers = people.filter((p) => p.exitedOn);
  if (await db.finalSettlement.findFirst({ where: { userId: { in: leavers.filter((p) => p.exitType !== "RESIGNED").map((p) => p.id) } }, select: { id: true } })) {
    log("Settlements", "already written — left as they are");
    return;
  }
  const counts = new Map<string, number>();
  for (const p of leavers) {
    const structure = await db.salaryStructure.findFirst({ where: { userId: p.id }, orderBy: { effectiveFrom: "desc" } });
    if (!structure) continue;
    const last = p.exitedOn!;
    const basic = num(structure.basic);
    const gross = monthlyGross({ basic, hra: num(structure.hra), conveyance: num(structure.conveyance), medical: num(structure.medical), specialAllowance: num(structure.specialAllowance), otherAllowance: num(structure.otherAllowance) });
    const month = last.getUTCMonth() + 1;
    const year = last.getUTCFullYear();
    const lop = await lossOfPay(db, p.id, year, month);
    const salaryDays = Math.max(0, last.getUTCDate() - lop);
    const balances = await db.leaveBalance.findMany({ where: { userId: p.id }, include: { type: true }, orderBy: { year: "desc" } });
    const latestYear = balances[0]?.year;
    const encashable = balances
      .filter((b) => b.year === latestYear && b.type.paid)
      .map((b) => ({ code: b.type.code, name: b.type.name, days: Math.max(0, num(b.opening) + num(b.credited) + num(b.adjustment) - num(b.used)), encashable: b.type.encashable }));

    // What whoever prepares it enters by hand, case by case.
    const ptState = p.state && p.state !== "Delhi";
    const pf = structure.pfApplicable ? Math.round(Math.min(basic, 15000) * 0.12 * (salaryDays / daysInMonth(year, month))) : 0;
    let overrides: { resignedOn?: Date; otherEarnings?: number; otherEarningsNote?: string; assetRecovery?: number; otherDeductionNote?: string; note?: string; bonusAmount?: number } = {};
    let status: "DRAFT" | "APPROVED" | "PAID" = "DRAFT";
    if (p.exitType === "ABSCONDED") {
      overrides = { resignedOn: last, assetRecovery: 48500, otherDeductionNote: undefined, note: "Absconded — no notice served and the laptop was not returned. Recovery letter sent; nothing is paid until it is answered." };
      status = "DRAFT";
    } else if (p.exitType === "TERMINATED") {
      overrides = { otherEarnings: Math.round(gross), otherEarningsNote: "One month's pay in lieu of notice" };
      status = "APPROVED";
    } else if (p.exitType === "RETIRED") {
      overrides = { bonusAmount: Math.round(Math.min(basic, 7000) * 0.0833 * 6) };
      status = "APPROVED";
    } else if (p.exitType === "CONTRACT_ENDED") {
      status = "PAID";
    }
    const resignedOn = overrides.resignedOn ?? new Date(last.getTime() - p.noticePeriodDays * DAY);
    const result = computeSettlement({
      monthlyBasic: basic, monthlyGross: gross, joinedOn: p.joinedOn, resignedOn, lastWorkingDay: last,
      noticePeriodDays: p.noticePeriodDays, salaryDays, daysInFinalMonth: daysInMonth(year, month), balances: encashable,
      bonusAmount: overrides.bonusAmount, otherEarnings: overrides.otherEarnings, assetRecovery: overrides.assetRecovery,
      pfDeduction: pf, professionalTax: ptState ? 200 : 0,
    });
    const prepared = at(workingOnOrAfter(addDays(minDate(last, TODAY_D), last > TODAY_D ? -int(1, 3) : int(1, 4))), 15, int(0, 59));
    const preparedAt = minDate(prepared, new Date(TODAY.getTime() - 2 * 3_600_000));
    const approvedAt = status !== "DRAFT" ? minDate(new Date(preparedAt.getTime() + int(20, 60) * 3_600_000), new Date(TODAY.getTime() - 3_600_000)) : null;
    const paidAt = status === "PAID" && approvedAt ? minDate(new Date(approvedAt.getTime() + int(24, 72) * 3_600_000), new Date(TODAY.getTime() - 1_800_000)) : null;
    const data = {
      userId: p.id,
      lastWorkingDay: last,
      serviceYears: dec(result.serviceYears),
      salaryDays: dec(salaryDays),
      salaryAmount: dec(result.salaryAmount),
      leaveEncashDays: dec(result.encashment.days),
      leaveEncashAmount: dec(result.encashment.amount),
      gratuityAmount: dec(result.gratuity.amount),
      gratuityNote: result.gratuity.note,
      bonusAmount: dec(result.bonusAmount),
      otherEarnings: dec(result.otherEarnings),
      otherEarningsNote: overrides.otherEarningsNote ?? null,
      grossPayable: dec(result.grossPayable),
      noticeShortfallDays: dec(result.notice.shortfallDays),
      noticeRecovery: dec(result.notice.recovery),
      pfDeduction: dec(pf),
      professionalTax: dec(ptState ? 200 : 0),
      incomeTax: dec(0),
      advanceRecovery: dec(0),
      assetRecovery: dec(overrides.assetRecovery ?? 0),
      otherDeduction: dec(0),
      otherDeductionNote: null,
      totalDeductions: dec(result.totalDeductions),
      netPayable: dec(result.netPayable),
      note: overrides.note ?? (result.warnings.length ? result.warnings.join(" ") : null),
      status,
      approvedAt,
      approvedById: approvedAt ? run.controller.id : null,
      paidAt,
      createdById: run.controller.id,
      createdAt: preparedAt,
    };
    const before = await db.finalSettlement.findUnique({ where: { userId: p.id }, select: { id: true } });
    const row = await db.finalSettlement.upsert({ where: { userId: p.id }, create: data, update: data, select: { id: true } });
    audit(run, run.controller.id, before ? "UPDATE" : "CREATE", "FinalSettlement", row.id, `Settlement for ${p.name} — net ${result.netPayable < 0 ? "recoverable" : "payable"} ₹${Math.abs(result.netPayable).toLocaleString("en-IN")}`, preparedAt);
    if (approvedAt) audit(run, run.controller.id, "UPDATE", "FinalSettlement", p.id, `${p.name}'s settlement marked approved`, approvedAt);
    if (paidAt) audit(run, run.controller.id, "UPDATE", "FinalSettlement", p.id, `${p.name}'s settlement marked paid`, paidAt);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const t = await flushTrail(run);
  log("Settlements", `${leavers.length} full & final — ${[...counts].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")}; ${t.audits} audit rows`);
}

// ─── Paperwork: letters and the employment file ──────────────────────────────────────────────────

const PDF_STUB = "data:application/pdf;base64,JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0YK";
const JPEG_STUB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const stubSize = (url: string) => Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);

const DOC_TYPE_FOR: Partial<Record<LetterType, "OFFER_LETTER" | "APPOINTMENT_LETTER">> = { OFFER: "OFFER_LETTER", APPOINTMENT: "APPOINTMENT_LETTER" };

/**
 * Letters, written the way the app writes them: the payload frozen at issue, the body from
 * `renderLetter`, the subject from `subjectFor`, the number from `letterNumberFor` in the per-type,
 * per-year sequence `draftLetter` counts — and an issued letter filed as a document on the person's
 * file (`letter:<id>`, `text/letter`), exactly as `issueLetter` files it. A revoked letter keeps its
 * number and loses its document, as `revokeLetter` leaves it.
 *
 * The demo's own letters are replaced rather than kept beside these: their bodies were a sentence
 * written for no particular type, their numbers ran in a scheme the app does not use, and the issued
 * ones had nothing on the file.
 */
async function paperwork(run: Run) {
  const { db, people } = run;
  if (await db.employeeLetter.findFirst({ where: { type: "GRATUITY_STATEMENT" }, select: { id: true } })) {
    log("Paperwork", "already written — left as it is");
    return;
  }
  const ids = people.map((p) => p.id);
  const replaced = await db.employeeLetter.deleteMany({ where: { userId: { in: ids }, document: { is: null } } });

  const structures = await db.salaryStructure.findMany({ where: { userId: { in: ids } }, orderBy: { effectiveFrom: "desc" } });
  const grossOn = (userId: string, day: Date) => {
    const s = structures.find((x) => x.userId === userId && x.effectiveFrom <= day) ?? structures.filter((x) => x.userId === userId).at(-1);
    return s ? monthlyGross({ basic: num(s.basic), hra: num(s.hra), conveyance: num(s.conveyance), medical: num(s.medical), specialAllowance: num(s.specialAllowance), otherAllowance: num(s.otherAllowance) }) : null;
  };
  const basicOn = (userId: string, day: Date) => num((structures.find((x) => x.userId === userId && x.effectiveFrom <= day) ?? structures.find((x) => x.userId === userId))?.basic);
  const numbers = new Set((await db.employeeLetter.findMany({ select: { letterNumber: true } })).map((l) => l.letterNumber));
  const seq = new Map<string, number>();
  const nextNumber = async (type: LetterType, issuedOn: Date) => {
    const year = issuedOn.getUTCFullYear();
    const key = `${type}:${year}`;
    let n = seq.get(key) ?? (await db.employeeLetter.count({ where: { type, issuedOn: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } } }));
    let number: string;
    do {
      n += 1;
      number = letterNumberFor(type, year, n, run.org.prefix);
    } while (numbers.has(number));
    seq.set(key, n);
    numbers.add(number);
    return number;
  };
  const signatory = { signatoryName: run.org.signatoryName || run.hr.name, signatoryTitle: run.org.signatoryTitle || `For ${run.org.companyName}` };
  const base = (p: Person, on: Date, designation = p.title): LetterPayload => {
    const gross = grossOn(p.id, on);
    return {
      employeeName: p.name,
      designation,
      department: p.dept || null,
      employeeCode: p.employeeCode,
      companyName: run.org.companyName,
      companyAddress: run.org.companyAddress,
      annualCtc: gross ? Math.round(gross * 12) : null,
      monthlyGross: gross,
      joinedOn: iso(p.joinedOn),
      probationMonths: 6,
      confirmedOn: p.confirmedOn && p.confirmedOn <= on ? iso(p.confirmedOn) : null,
      lastWorkingDay: p.exitedOn && p.exitedOn <= addDays(on, 60) ? iso(p.exitedOn) : null,
      reportingTo: p.managerId ? (run.byId.get(p.managerId)?.name ?? null) : null,
      workLocation: p.workLocation,
      noticePeriodDays: p.noticePeriodDays,
      ...signatory,
    };
  };

  let issued = 0;
  let drafts = 0;
  const write = async (p: Person, type: LetterType, issuedOn: Date, payload: LetterPayload, status: "DRAFT" | "ISSUED" | "REVOKED" = "ISSUED") => {
    if (issuedOn > TODAY_D) issuedOn = TODAY_D;
    const letterNumber = await nextNumber(type, issuedOn);
    const subject = subjectFor(type, payload);
    const drafted = at(issuedOn, int(10, 13), int(0, 59));
    const letter = await db.employeeLetter.create({
      data: { userId: p.id, type, letterNumber, subject, issuedOn, payload: payload as unknown as Prisma.InputJsonValue, body: renderLetter(type, payload), status, issuedById: run.hr.id, createdAt: drafted },
    });
    if (status === "DRAFT") {
      drafts += 1;
      return letter;
    }
    const issuedAt = new Date(drafted.getTime() + int(20, 180) * 60_000);
    if (status === "ISSUED") {
      await db.employeeDocument.create({
        data: { userId: p.id, type: DOC_TYPE_FOR[type] ?? "OTHER", name: `${subject} (${letterNumber})`, fileDataUrl: `letter:${letter.id}`, mimeType: "text/letter", sizeBytes: 0, visibleToEmployee: true, letterId: letter.id, uploadedById: run.hr.id, createdAt: issuedAt },
      });
    }
    audit(run, run.hr.id, "UPDATE", "EmployeeLetter", letter.id, `Issued ${letterNumber} — ${subject}`, issuedAt);
    notify(run, p.id, "LETTER_ISSUED", subject, `${letterNumber} is on your file.`, `/people/${p.id}?tab=documents`, issuedAt);
    if (status === "REVOKED") audit(run, run.hr.id, "UPDATE", "EmployeeLetter", letter.id, `Revoked ${letterNumber}`, new Date(issuedAt.getTime() + int(2, 30) * 3_600_000));
    issued += 1;
    return letter;
  };

  const f = run.facts;
  // ── Joining ─────────────────────────────────────────────────────────────────────────────────
  for (const p of people) {
    if (p.joinedOn < START_D) continue;
    const offerOn = workingOnOrBefore(addDays(p.joinedOn, -int(15, 25)));
    if (p.type === "INTERN") {
      await write(p, "INTERNSHIP", offerOn, { ...base(p, p.joinedOn), stipend: grossOn(p.id, p.joinedOn), internshipFrom: iso(p.joinedOn), internshipTo: iso(p.exitedOn ?? addDays(p.joinedOn, 364)), projectArea: p.dept === "Inside Sales" ? "Lead research and data quality" : "Customer onboarding" });
      continue;
    }
    if (p.type === "CONTRACT" || p.type === "CONSULTANT") {
      await write(p, "CONTRACT_AGREEMENT", workingOnOrBefore(addDays(p.joinedOn, -5)), { ...base(p, p.joinedOn), contractMonths: 12 });
      continue;
    }
    await write(p, "OFFER", offerOn, { ...base(p, p.joinedOn), offerValidUntil: iso(addDays(offerOn, 14)) });
    await write(p, "APPOINTMENT", p.joinedOn, base(p, p.joinedOn));
  }
  // ── While employed ──────────────────────────────────────────────────────────────────────────
  for (const p of people) {
    if (p.confirmedOn && p.confirmedOn >= START_D && p.confirmedOn <= TODAY_D) await write(p, "CONFIRMATION", p.confirmedOn, { ...base(p, p.confirmedOn), confirmedOn: iso(p.confirmedOn) });
  }
  if (f?.extension) {
    const p = run.byId.get(f.extension.person.id)!;
    await write(p, "PROBATION_EXTENSION", workingOnOrBefore(f.extension.originalEnd), { ...base(p, f.extension.originalEnd), confirmedOn: null, extendedUntil: iso(f.extension.until) });
  }
  const letterDay = f ? workingOnOrBefore(addDays(f.appraisal, -4)) : null;
  for (const [userId, h] of f?.hikes ?? []) {
    const p = run.byId.get(userId);
    if (!p || !letterDay) continue;
    const promo = f!.promotions.get(userId);
    if (promo) {
      await write(p, "PROMOTION", letterDay, { ...base(p, h.on, promo.to), previousDesignation: promo.from, effectiveFrom: iso(h.on), annualCtc: Math.round(h.gross * 12), monthlyGross: h.gross });
    } else {
      await write(p, "INCREMENT", letterDay, { ...base(p, h.on), previousCtc: Math.round(h.previousGross * 12), annualCtc: Math.round(h.gross * 12), monthlyGross: h.gross, effectiveFrom: iso(h.on) });
    }
  }
  for (const [userId, tr] of f?.transfers ?? []) {
    const p = run.byId.get(userId);
    if (p && f) await write(p, "TRANSFER", workingOnOrBefore(addDays(f.transferOn, -14)), { ...base(p, f.transferOn), workLocation: tr.to, previousLocation: tr.from, effectiveFrom: iso(f.transferOn) });
  }
  const terminated = people.find((p) => p.exitType === "TERMINATED");
  if (terminated?.exitedOn) {
    const warned = workingOnOrBefore(addDays(terminated.exitedOn, -int(35, 50)));
    await write(terminated, "WARNING", warned, { ...base(terminated, warned), incidentDate: iso(workingOnOrBefore(addDays(warned, -3))), incidentSummary: misconductOf(terminated.title).warning });
  }
  const current = people.filter((p) => p.active && p.joinedOn < addDays(TODAY_D, -120));
  const second = current.find((p) => p.dept === "Inside Sales" && p.type === "FULL_TIME");
  if (second) {
    const warned = workingOnOrBefore(addDays(TODAY_D, -int(20, 40)));
    await write(second, "WARNING", warned, { ...base(second, warned), incidentDate: iso(workingOnOrBefore(addDays(warned, -2))), incidentSummary: "Customer data was exported to a personal email address, against the data-handling policy you signed." });
  }
  const praised = some(current.filter((p) => !p.isManager), 4);
  for (const [i, p] of praised.entries()) {
    const on = workingOnOrBefore(addDays(TODAY_D, -int(15, 250)));
    const letter = await write(p, "APPRECIATION", on, { ...base(p, on), incidentDate: iso(on), incidentSummary: pick(["Recovered a key account's failed backup over a weekend", "Closed the largest renewal of the quarter", "Ninety-eight per cent first-call resolution for the month", "Rebuilt the lead list that doubled the calling floor's connect rate"]) }, i === 0 ? "REVOKED" : "ISSUED");
    // The revoked one was issued with the wrong month on it, and issued again the next day.
    if (i === 0) await write(p, "APPRECIATION", workingOnOrAfter(addDays(letter.issuedOn, 1)), { ...base(p, on), incidentDate: iso(on), incidentSummary: (letter.payload as unknown as LetterPayload).incidentSummary ?? null });
  }
  if (f?.maternity) {
    const p = run.byId.get(f.maternity.person.id)!;
    await write(p, "MATERNITY_LEAVE", f.maternity.letterOn, { ...base(p, f.maternity.letterOn), leaveFrom: iso(f.maternity.from), leaveTo: iso(f.maternity.to), leaveWeeks: 26 });
  }
  // ── Asked for by a third party ──────────────────────────────────────────────────────────────
  const slips = await db.payslip.findMany({ where: { userId: { in: ids }, run: { status: { in: ["LOCKED", "PAID"] } } }, include: { run: { select: { month: true, year: true } } } });
  const latestSlip = (userId: string, before: Date) =>
    slips.filter((s) => s.userId === userId && new Date(Date.UTC(s.run.year, s.run.month, 1)) <= before).sort((a, b) => b.run.year * 12 + b.run.month - (a.run.year * 12 + a.run.month))[0];
  const third = some(current, 6);
  const [loan, rent, travel, verify, loan2, draftVerify] = third;
  for (const p of [loan, loan2].filter((x): x is Person => !!x)) {
    const on = workingOnOrBefore(addDays(TODAY_D, -int(5, 90)));
    const slip = latestSlip(p.id, on);
    if (slip) await write(p, "SALARY_CERTIFICATE", on, { ...base(p, on), forMonth: slip.run.month, forYear: slip.run.year, netPay: num(slip.netPay) });
  }
  if (rent) {
    const on = workingOnOrBefore(addDays(TODAY_D, -int(10, 120)));
    await write(rent, "ADDRESS_PROOF", on, base(rent, on));
  }
  if (travel) {
    const on = workingOnOrBefore(addDays(TODAY_D, -int(20, 60)));
    await write(travel, "TRAVEL_NOC", on, { ...base(travel, on), travelCountry: pick(["Singapore", "Thailand", "United Arab Emirates", "Japan"]), travelFrom: iso(addDays(on, 30)), travelTo: iso(addDays(on, 39)) });
  }
  if (verify) {
    const on = workingOnOrBefore(addDays(TODAY_D, -int(30, 90)));
    await write(verify, "EMPLOYMENT_VERIFICATION", on, base(verify, on));
  }
  if (draftVerify) await write(draftVerify, "EMPLOYMENT_VERIFICATION", workingOnOrBefore(TODAY_D), base(draftVerify, TODAY_D), "DRAFT");
  // ── Leaving ─────────────────────────────────────────────────────────────────────────────────
  for (const p of people.filter((x) => x.exitedOn)) {
    const last = p.exitedOn!;
    const lastKey = iso(last);
    if (p.exitType === "RESIGNED") {
      const resignedOn = workingOnOrBefore(addDays(last, -p.noticePeriodDays));
      await write(p, "RESIGNATION_ACCEPTANCE", workingOnOrAfter(addDays(resignedOn, 1)), { ...base(p, resignedOn), resignedOn: iso(resignedOn), lastWorkingDay: lastKey });
      await write(p, "RELIEVING", workingOnOrBefore(TODAY_D), { ...base(p, TODAY_D), lastWorkingDay: lastKey }, "DRAFT");
      continue;
    }
    const after = workingOnOrAfter(addDays(last, int(3, 8)));
    if (p.exitType === "TERMINATED") {
      await write(p, "TERMINATION", last, { ...base(p, last), incidentDate: iso(last), incidentSummary: misconductOf(p.title).termination, lastWorkingDay: lastKey });
      await write(p, "NO_DUES", after, { ...base(p, last), lastWorkingDay: lastKey });
      await write(p, "RELIEVING", after, { ...base(p, last), lastWorkingDay: lastKey });
    } else if (p.exitType === "RETIRED") {
      const years = yearsBetween(p.joinedOn, last);
      const gratuity = Math.round((basicOn(p.id, last) * 15 * Math.floor(years + (years % 1 > 0.5 ? 1 : 0))) / 26);
      await write(p, "NO_DUES", after, { ...base(p, last), lastWorkingDay: lastKey });
      await write(p, "RELIEVING", after, { ...base(p, last), lastWorkingDay: lastKey });
      await write(p, "EXPERIENCE", after, { ...base(p, last), lastWorkingDay: lastKey });
      const settlement = await db.finalSettlement.findUnique({ where: { userId: p.id }, select: { gratuityAmount: true, serviceYears: true } });
      await write(p, "GRATUITY_STATEMENT", after, { ...base(p, last), lastWorkingDay: lastKey, gratuityAmount: settlement ? num(settlement.gratuityAmount) : gratuity, serviceYears: settlement ? num(settlement.serviceYears) : Math.round(years) });
    } else if (p.exitType === "CONTRACT_ENDED") {
      await write(p, "INTERNSHIP_COMPLETION", last, { ...base(p, last), internshipFrom: iso(p.joinedOn), internshipTo: lastKey, projectArea: "Lead research and data quality", lastWorkingDay: lastKey });
      await write(p, "NO_DUES", after, { ...base(p, last), lastWorkingDay: lastKey });
    } else if (p.exitType === "ABSCONDED") {
      // Nothing issued: no-dues waits on the laptop coming back.
      await write(p, "NO_DUES", workingOnOrBefore(TODAY_D), { ...base(p, last), lastWorkingDay: lastKey }, "DRAFT");
    }
  }

  // ── The rest of the file: what people handed in ─────────────────────────────────────────────
  const docs: Prisma.EmployeeDocumentCreateManyInput[] = [];
  const upload = (p: Person, type: Prisma.EmployeeDocumentCreateManyInput["type"], name: string, on: Date, opts: { image?: boolean; internal?: boolean; self?: boolean } = {}) => {
    const url = opts.image ? JPEG_STUB : PDF_STUB;
    const createdAt = at(maxDate(on, addDays(START_D, -400)), int(10, 17), int(0, 59));
    docs.push({ userId: p.id, type, name, fileDataUrl: url, mimeType: opts.image ? "image/png" : "application/pdf", sizeBytes: stubSize(url), visibleToEmployee: opts.internal ? false : true, uploadedById: opts.self ? p.id : run.hr.id, createdAt });
    audit(run, opts.self ? p.id : run.hr.id, "CREATE", "EmployeeDocument", p.id, `${name} added to ${p.name}'s file`, createdAt);
  };
  for (const p of people) {
    const onJoining = maxDate(p.joinedOn, START_D);
    if (p.joinedOn >= START_D) {
      upload(p, "PHOTO", `${p.first} — passport photo.png`, onJoining, { image: true, self: chance(0.5) });
      if (!["INTERN"].includes(p.type) && chance(0.8)) {
        upload(p, "EXPERIENCE_CERTIFICATE", "Experience certificate — previous employer.pdf", onJoining);
        upload(p, "RELIEVING_LETTER", "Relieving letter — previous employer.pdf", onJoining);
        upload(p, "PAYSLIP_PREVIOUS", "Last three payslips — previous employer.pdf", onJoining, { self: true });
      }
    } else if (chance(0.5)) upload(p, "PHOTO", `${p.first} — ID card photo.png`, onJoining, { image: true });
    if (p.type === "CONTRACT" || p.type === "CONSULTANT") upload(p, "CONTRACT", `Signed ${p.type === "CONSULTANT" ? "consultancy" : "contract"} agreement — ${p.name}.pdf`, addDays(onJoining, 2));
    if (chance(0.25)) upload(p, "OTHER", pick(["Form 11 (EPF declaration).pdf", "Nomination form — gratuity.pdf", "Investment declaration FY.pdf", "Medical fitness certificate.pdf"]), workingOnOrBefore(addDays(TODAY_D, -int(5, 200))), { self: chance(0.6) });
  }
  if (terminated) upload(terminated, "INTERNAL", "Disciplinary hearing notes.pdf", workingOnOrBefore(addDays(terminated.exitedOn ?? TODAY_D, -10)), { internal: true });
  await inChunks(docs, 500, (c) => db.employeeDocument.createMany({ data: c }));

  const t = await flushTrail(run);
  log("Paperwork", `${issued} letters issued (one revoked), ${drafts} drafts, ${replaced.count} of the demo's replaced; ${docs.length} documents uploaded; ${t.notes} notifications`);
}

// ─── Hiring and onboarding ───────────────────────────────────────────────────────────────────────

const INTAKE_STUB = (name: string, city: string) => ({
  personalEmail: `${name.toLowerCase().replace(" ", ".")}@personal.example`,
  personalPhone: phone(),
  dateOfBirth: `${int(1994, 2003)}-0${int(1, 9)}-1${int(0, 8)}`,
  bloodGroup: pick(["O+", "B+", "A+", "AB+"]),
  maritalStatus: pick(["Single", "Married"]),
  addressLine1: `${int(1, 90)}, ${pick(LOCALITIES)}`,
  city,
  state: city === "Bengaluru" ? "Karnataka" : "Maharashtra",
  pincode: String(int(400001, 400099)),
  emergencyContactName: `${pick(FIRST_NAMES)} ${name.split(" ")[1] ?? ""}`.trim(),
  emergencyContactPhone: phone(),
  emergencyContactRelation: pick(["Spouse", "Father", "Mother"]),
  aadhaarLast4: String(int(1000, 9999)),
  bankName: pick(BANKS)[0],
  bankAccountNumber: String(int(10000000000, 99999999999)),
  bankIfsc: pick(BANKS)[1],
});

/**
 * Everybody who joined during the year came through the hiring pipeline, and the record says so: a
 * candidate converted into them on their first day (`convertCandidate`), the offer accepted before
 * that, and the six onboarding tasks the conversion raises. The pipeline today has somebody at every
 * stage and on every kind of contract, with offer letters drafted against the candidate rather than a
 * login, and the intake form both sent and returned.
 */
async function hiring(run: Run) {
  const { db, people } = run;
  if (await db.task.findFirst({ where: { hrStage: "ONBOARDING", aboutUser: { email: { endsWith: DEMO_EMAIL_DOMAIN } } }, select: { id: true } })) {
    log("Hiring", "already written — left as it is");
    return;
  }
  const owner = run.hr;
  const sources = ["Naukri", "LinkedIn", "Referral", "Walk-in", "Campus", "Consultant — TalentBridge"];

  // ── The year's joiners, as the candidates they were ─────────────────────────────────────────
  let converted = 0;
  let tasks = 0;
  for (const p of people.filter((x) => x.joinedOn >= START_D)) {
    const structure = await db.salaryStructure.findFirst({ where: { userId: p.id }, orderBy: { effectiveFrom: "asc" } });
    const gross = structure ? monthlyGross({ basic: num(structure.basic), hra: num(structure.hra), conveyance: num(structure.conveyance), medical: num(structure.medical), specialAllowance: num(structure.specialAllowance), otherAllowance: num(structure.otherAllowance) }) : 0;
    const offeredOn = workingOnOrBefore(addDays(p.joinedOn, -int(15, 25)));
    const acceptedOn = workingOnOrAfter(addDays(offeredOn, int(1, 4)));
    const convertedAt = at(p.joinedOn, 9, int(30, 59));
    const candidate = await db.candidate.create({
      data: {
        name: p.name, email: `${p.first.toLowerCase()}.${(p.name.split(" ")[1] ?? "x").toLowerCase()}@applicant.example`, phone: phone(),
        designation: p.title, departmentId: p.deptId, employmentType: p.type, workLocation: p.workLocation, managerId: p.managerId, role: p.role,
        status: "JOINED", source: pick(sources), offeredCtc: dec(Math.round(gross * 12)), expectedJoining: p.joinedOn, offeredOn, acceptedOn,
        intakeSubmittedAt: at(addDays(acceptedOn, 2), 20, 15), intakeData: INTAKE_STUB(p.name, p.state === "Karnataka" ? "Bengaluru" : "Mumbai"),
        convertedUserId: p.id, convertedAt, ownerId: owner.id, createdAt: at(addDays(offeredOn, -int(10, 30)), 12, 0),
      },
    });
    audit(run, owner.id, "CREATE", "Candidate", candidate.id, `${p.name} — ${p.title}`, candidate.createdAt);
    audit(run, owner.id, "UPDATE", "Candidate", candidate.id, `${p.name} — offered`, at(offeredOn, 15, 0));
    audit(run, owner.id, "UPDATE", "Candidate", candidate.id, `${p.name} — accepted`, at(acceptedOn, 12, 0));
    audit(run, owner.id, "CREATE", "User", p.id, `${p.name} converted from candidate to employee, joining ${toKey(p.joinedOn)}`, convertedAt);

    // convertCandidate's onboarding tasks.
    for (const t of ONBOARDING_TASKS) {
      const due = new Date(p.joinedOn.getTime() + t.dueDayOffset * DAY);
      const done = due < addDays(TODAY_D, -3) ? chance(0.95) : due < TODAY_D ? chance(0.5) : false;
      await db.task.create({
        data: {
          title: `${t.title} — ${p.name}`, description: t.description, dueDate: due,
          assignedToUserId: t.role === "MANAGER" ? (p.managerId ?? owner.id) : owner.id,
          createdByUserId: owner.id, aboutUserId: p.id, hrStage: "ONBOARDING",
          done, doneAt: done ? workMoment(workingOnOrBefore(minDate(maxDate(due, p.joinedOn), addDays(TODAY_D, -1)))) : null,
          createdAt: convertedAt,
        },
      });
      tasks += 1;
    }
    if (p.managerId) notify(run, p.managerId, "TASK_ASSIGNED", `${p.name} joins on ${toKey(p.joinedOn)}`, "Onboarding tasks have been raised — first-week plan is yours.", `/people/${p.id}`, convertedAt);
    // The CV they were hired on moved across with them.
    await db.employeeDocument.create({ data: { userId: p.id, type: "CV", name: `${p.name} — CV.pdf`, fileDataUrl: PDF_STUB, mimeType: "application/pdf", sizeBytes: stubSize(PDF_STUB), uploadedById: owner.id, createdAt: candidate.createdAt } });
    converted += 1;
  }

  // ── The demo's candidates, made consistent with their status ────────────────────────────────
  for (const c of await db.candidate.findMany({ where: { convertedUserId: null, ownerId: { in: people.map((p) => p.id) } } })) {
    const status = c.status === "JOINED" ? "ACCEPTED" : c.status; // JOINED is only ever reached by converting.
    const offeredOn = status === "PROSPECT" ? null : workingOnOrBefore(addDays(TODAY_D, -int(6, 30)));
    await db.candidate.update({
      where: { id: c.id },
      data: {
        status,
        offeredOn,
        acceptedOn: status === "ACCEPTED" && offeredOn ? workingOnOrAfter(addDays(offeredOn, int(1, 4))) : null,
        declinedReason: status === "DECLINED" ? pick(["Accepted a counter-offer from the current employer.", "Relocation didn't work out.", "Expected a higher CTC."]) : null,
        createdAt: at(workingOnOrBefore(addDays(offeredOn ?? TODAY_D, -int(5, 25))), 12, 0),
      },
    });
  }

  // ── Today's pipeline: every contract type, every stage ──────────────────────────────────────
  const dept = (name: string) => run.ctx.departments.get(name) ?? null;
  const lead = (title: string) => people.find((p) => p.title === title && p.active)?.id ?? run.director.id;
  const pipeline: { name: string; designation: string; dept: string; type: EmploymentType; role: string; status: "PROSPECT" | "OFFERED" | "ACCEPTED" | "DECLINED" | "WITHDRAWN"; ctc: number; manager: string; letter?: LetterType; intake?: "sent" | "returned" }[] = [
    { name: "Ira Fernandes", designation: "Sales Intern", dept: "Inside Sales", type: "INTERN", role: "CALLING", status: "OFFERED", ctc: 180000, manager: lead("Inside Sales Lead"), letter: "INTERNSHIP", intake: "sent" },
    { name: "Mihir Kale", designation: "Field Engineer (contract)", dept: "Support", type: "CONTRACT", role: "SUPPORT", status: "ACCEPTED", ctc: 420000, manager: lead("Support Lead"), letter: "CONTRACT_AGREEMENT", intake: "returned" },
    { name: "Naina Rao", designation: "Solutions Consultant", dept: "Presales & Solutions", type: "CONSULTANT", role: "SALES", status: "OFFERED", ctc: 1500000, manager: lead("Head of Sales"), letter: "CONTRACT_AGREEMENT" },
    { name: "Tushar Bhosale", designation: "Accounts Assistant (part-time)", dept: "Accounts", type: "PART_TIME", role: "ACCOUNTS", status: "DECLINED", ctc: 240000, manager: lead("Finance Controller") },
    { name: "Ayesha Siddiqui", designation: "Account Manager", dept: "Sales", type: "FULL_TIME", role: "SALES", status: "ACCEPTED", ctc: 900000, manager: lead("Regional Sales Manager"), letter: "OFFER", intake: "returned" },
    { name: "Rohit Wagh", designation: "Support Engineer", dept: "Support", type: "FULL_TIME", role: "SUPPORT", status: "PROSPECT", ctc: 480000, manager: lead("Support Lead") },
    { name: "Kunal Shah", designation: "Data Profiler", dept: "Inside Sales", type: "INTERN", role: "PROFILE", status: "WITHDRAWN", ctc: 150000, manager: lead("Inside Sales Lead") },
    { name: "Esha Pillai", designation: "Presales Consultant", dept: "Presales & Solutions", type: "CONTRACT", role: "SALES", status: "PROSPECT", ctc: 1100000, manager: lead("Head of Sales") },
  ];
  const letterNumbers = new Set((await db.employeeLetter.findMany({ select: { letterNumber: true } })).map((l) => l.letterNumber));
  let pipelineLetters = 0;
  for (const c of pipeline) {
    const created = at(workingOnOrBefore(addDays(TODAY_D, -int(12, 40))), 12, 0);
    const offeredOn = ["OFFERED", "ACCEPTED", "DECLINED"].includes(c.status) ? workingOnOrBefore(addDays(TODAY_D, -int(4, 10))) : null;
    const acceptedOn = c.status === "ACCEPTED" && offeredOn ? workingOnOrAfter(addDays(offeredOn, 2)) : null;
    const expectedJoining = workingOnOrAfter(addDays(TODAY_D, int(10, 35)));
    const city = c.dept === "Support" || c.dept === "Presales & Solutions" ? "Bengaluru" : "Mumbai";
    const row = await db.candidate.create({
      data: {
        name: c.name, email: `${c.name.toLowerCase().replace(" ", ".")}@applicant.example`, phone: phone(), designation: c.designation, departmentId: dept(c.dept),
        employmentType: c.type, workLocation: city === "Bengaluru" ? OFFICES.blr.label : OFFICES.hq.label, managerId: c.manager, role: c.role, status: c.status,
        source: pick(sources), offeredCtc: dec(c.ctc), expectedJoining, offeredOn, acceptedOn,
        declinedReason: c.status === "DECLINED" ? "Took up a full-time role closer to home." : null,
        notes: c.status === "WITHDRAWN" ? "Withdrew after the second round — going back to college for a master's." : null,
        intakeToken: c.intake === "sent" ? newDeviceToken() : null,
        intakeExpiresAt: c.intake === "sent" ? addDays(TODAY_D, 12) : null,
        intakeSubmittedAt: c.intake === "returned" ? at(addDays(TODAY_D, -2), 21, 5) : null,
        intakeData: c.intake === "returned" ? INTAKE_STUB(c.name, city) : Prisma.JsonNull,
        ownerId: run.hrExec.id, createdAt: created,
      },
    });
    audit(run, run.hrExec.id, "CREATE", "Candidate", row.id, `${c.name} — ${c.designation}`, created);
    if (offeredOn) audit(run, run.hrExec.id, "UPDATE", "Candidate", row.id, `${c.name} — offered`, at(offeredOn, 16, 0));
    if (acceptedOn) audit(run, run.hrExec.id, "UPDATE", "Candidate", row.id, `${c.name} — accepted`, at(acceptedOn, 11, 0));
    if (c.status === "DECLINED" || c.status === "WITHDRAWN") audit(run, run.hrExec.id, "UPDATE", "Candidate", row.id, `${c.name} — ${c.status.toLowerCase()}${c.status === "DECLINED" ? ": Took up a full-time role closer to home." : ""}`, at(addDays(offeredOn ?? created, 3), 12, 0));
    if (c.intake === "sent") audit(run, run.hrExec.id, "UPDATE", "Candidate", row.id, `Issued an intake link for ${c.name}`, at(addDays(TODAY_D, -2), 11, 0));
    // The CV — and for the offered, the letter drafted against the candidate, issued and filed.
    if (c.status !== "PROSPECT") {
      await db.employeeDocument.create({ data: { candidateId: row.id, type: "CV", name: `${c.name} — CV.pdf`, fileDataUrl: PDF_STUB, mimeType: "application/pdf", sizeBytes: stubSize(PDF_STUB), uploadedById: run.hrExec.id, createdAt: created } });
      audit(run, run.hrExec.id, "CREATE", "EmployeeDocument", row.id, `${c.name} — CV.pdf filed against candidate ${c.name}`, created);
    }
    if (c.letter && offeredOn) {
      const payload: LetterPayload = {
        employeeName: c.name, designation: c.designation, department: c.dept, employeeCode: null,
        companyName: run.org.companyName, companyAddress: run.org.companyAddress,
        annualCtc: c.ctc, monthlyGross: Math.round(c.ctc / 12), joinedOn: iso(expectedJoining), probationMonths: 6,
        reportingTo: run.byId.get(c.manager)?.name ?? null, workLocation: city === "Bengaluru" ? OFFICES.blr.label : OFFICES.hq.label,
        offerValidUntil: iso(addDays(offeredOn, 14)),
        stipend: c.type === "INTERN" ? Math.round(c.ctc / 12) : null, internshipFrom: iso(expectedJoining), internshipTo: iso(addDays(expectedJoining, 182)), projectArea: "Lead research and data quality",
        contractMonths: c.type === "CONTRACT" || c.type === "CONSULTANT" ? 12 : null,
        signatoryName: run.org.signatoryName || run.hr.name, signatoryTitle: run.org.signatoryTitle || `For ${run.org.companyName}`,
      };
      const year = offeredOn.getUTCFullYear();
      let n = await db.employeeLetter.count({ where: { type: c.letter, issuedOn: { gte: new Date(Date.UTC(year, 0, 1)) } } });
      let letterNumber: string;
      do letterNumber = letterNumberFor(c.letter, year, ++n, run.org.prefix);
      while (letterNumbers.has(letterNumber));
      letterNumbers.add(letterNumber);
      const issue = c.status !== "DECLINED";
      const letter = await db.employeeLetter.create({
        data: { candidateId: row.id, type: c.letter, letterNumber, subject: subjectFor(c.letter, payload), issuedOn: offeredOn, payload: payload as unknown as Prisma.InputJsonValue, body: renderLetter(c.letter, payload), status: issue ? "ISSUED" : "DRAFT", issuedById: run.hrExec.id, createdAt: at(offeredOn, 14, 0) },
      });
      audit(run, run.hrExec.id, "CREATE", "EmployeeLetter", row.id, `Drafted ${c.letter.toLowerCase()} letter for candidate ${c.name}`, at(offeredOn, 14, 0));
      if (issue) {
        await db.employeeDocument.create({ data: { candidateId: row.id, type: DOC_TYPE_FOR[c.letter] ?? "OTHER", name: `${letter.subject} (${letterNumber})`, fileDataUrl: `letter:${letter.id}`, mimeType: "text/letter", sizeBytes: 0, letterId: letter.id, uploadedById: run.hrExec.id, createdAt: at(offeredOn, 15, 30) } });
        audit(run, run.hrExec.id, "UPDATE", "EmployeeLetter", letter.id, `Issued ${letterNumber} — ${letter.subject}`, at(offeredOn, 15, 30));
      }
      pipelineLetters += 1;
    }
  }

  const t = await flushTrail(run);
  log("Hiring", `${converted} of the year's joiners converted from candidates with ${tasks} onboarding tasks; ${pipeline.length} in today's pipeline (${pipelineLetters} candidate letters); ${t.audits} audit rows`);
}

// ─── Engagement ──────────────────────────────────────────────────────────────────────────────────

/**
 * The surveys a year leaves behind: a vote that closed, a named form with multiple-choice answers,
 * and one still in draft — answered the way `submitResponse` stores answers (a choice is the option's
 * text; an anonymous survey's participation never points at the response). And more of the speak-up
 * channel, including the "something else" kind, reviewed or waiting.
 */
async function engagement(run: Run) {
  const { db, people } = run;
  if (await db.survey.findFirst({ where: { kind: "VOTE", createdById: run.hr.id }, select: { id: true } })) {
    log("Engagement", "already written — left as it is");
    return;
  }
  const active = people.filter((p) => p.active);
  type Q = { kind: "SINGLE_CHOICE" | "MULTI_CHOICE" | "RATING" | "YES_NO" | "TEXT"; prompt: string; options?: string[]; helpText?: string };
  const make = async (s: { kind: "FORM" | "POLL" | "VOTE"; title: string; description: string; anonymous: boolean; mandatory?: boolean; audience: "EVERYONE" | "DEPARTMENT" | "INDIVIDUAL"; status: "DRAFT" | "OPEN" | "CLOSED"; opens: Date | null; closes: Date | null; questions: Q[]; created: Date; departments?: string[]; users?: string[] }) => {
    const survey = await db.survey.create({
      data: {
        kind: s.kind, title: s.title, description: s.description, anonymous: s.anonymous, mandatory: s.mandatory ?? false, audience: s.audience, status: s.status,
        opensAt: s.opens ? at(s.opens, 0, 0) : null, expiresAt: s.closes ? new Date(at(addDays(s.closes, 1), 0, 0).getTime() - 1000) : null,
        createdById: run.hr.id, createdAt: s.created,
        questions: { create: s.questions.map((q, i) => ({ kind: q.kind, prompt: q.prompt, helpText: q.helpText ?? null, required: q.kind !== "TEXT", options: q.options ?? [], sortOrder: i })) },
      },
      include: { questions: { orderBy: { sortOrder: "asc" } } },
    });
    for (const d of s.departments ?? []) await db.surveyTarget.create({ data: { surveyId: survey.id, departmentId: d } });
    for (const u of s.users ?? []) await db.surveyTarget.create({ data: { surveyId: survey.id, userId: u } });
    audit(run, run.hr.id, "CREATE", "Survey", survey.id, s.title, s.created);
    return survey;
  };
  const answerAll = async (survey: Awaited<ReturnType<typeof make>>, audienceIds: string[], from: Date, to: Date, share: number) => {
    let n = 0;
    for (const userId of audienceIds) {
      if (!chance(share)) continue;
      const day = workingOnOrBefore(addDays(from, int(0, Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY)))));
      const when = at(day, int(10, 18), int(0, 59));
      const response = await db.surveyResponse.create({
        data: {
          surveyId: survey.id,
          submittedOn: day,
          answers: {
            create: survey.questions.map((q) => ({
              questionId: q.id,
              number: q.kind === "RATING" ? int(2, 5) : q.kind === "YES_NO" ? (chance(0.7) ? 1 : 0) : q.kind === "SCALE_1_10" ? int(4, 10) : null,
              text: q.kind === "TEXT" && chance(0.5) ? pick(["More training on the new product lines, please.", "A quieter room for long calls would help.", "Happy with how the quarter went.", "Faster laptop replacements."]) : null,
              choices: q.kind === "SINGLE_CHOICE" ? [pick(q.options)] : q.kind === "MULTI_CHOICE" ? some(q.options, int(1, Math.min(3, q.options.length))) : [],
            })),
          },
        },
      });
      await db.surveyParticipation.create({ data: { surveyId: survey.id, userId, respondedAt: when, responseId: survey.anonymous ? null : response.id } });
      if (!survey.anonymous) audit(run, userId, "CREATE", "SurveyResponse", survey.id, `Answered ${survey.title}`, when);
      n += 1;
    }
    return n;
  };

  // A vote, closed: where the annual offsite goes. Anonymous, everybody.
  const voteOpen = workingOnOrBefore(addDays(TODAY_D, -75));
  const voteClose = addDays(voteOpen, 10);
  const vote = await make({
    kind: "VOTE", title: "Annual offsite — where do we go?", description: "Two days, everybody, in December. Pick the place and what we do there.", anonymous: true,
    audience: "EVERYONE", status: "CLOSED", opens: voteOpen, closes: voteClose, created: at(addDays(voteOpen, -1), 16, 0),
    questions: [
      { kind: "SINGLE_CHOICE", prompt: "Where should we go?", options: ["Lonavala", "Alibaug", "Coorg", "Udaipur"] },
      { kind: "MULTI_CHOICE", prompt: "What should the two days include?", helpText: "Pick as many as you like.", options: ["Team games", "A trek", "Awards night", "Strategy session", "Pool party", "Cooking competition"] },
    ],
  });
  const votes = await answerAll(vote, active.filter((p) => p.joinedOn <= voteOpen).map((p) => p.id), voteOpen, voteClose, 0.8);
  audit(run, run.hr.id, "UPDATE", "Survey", vote.id, "Marked open", at(voteOpen, 9, 30));
  audit(run, run.hr.id, "UPDATE", "Survey", vote.id, "Marked closed", at(addDays(voteClose, 1), 10, 0));
  for (const p of active.filter((x) => x.joinedOn <= voteOpen)) notify(run, p.id, "SURVEY_ASSIGNED", `${vote.title} is waiting for you`, "Your answers are anonymous.", `/surveys/${vote.id}`, at(voteOpen, 9, 31));

  // A named form, closed: what training people want. Multiple choice, attributed, to the sales floor.
  const trainees = active.filter((p) => p.dept === "Sales" || p.dept === "Presales & Solutions").map((p) => p.id);
  const formOpen = workingOnOrBefore(addDays(TODAY_D, -130));
  const formClose = addDays(formOpen, 14);
  const form = await make({
    kind: "FORM", title: "Training needs — H2", description: "We are booking vendor training for the second half. Tell us what would help you sell.", anonymous: false,
    audience: "INDIVIDUAL", status: "CLOSED", opens: formOpen, closes: formClose, created: at(addDays(formOpen, -2), 15, 0), users: trainees,
    questions: [
      { kind: "MULTI_CHOICE", prompt: "Which certifications would you take?", options: ["Microsoft 365 Fundamentals", "AWS Cloud Practitioner", "Sophos Firewall", "Autodesk Sales", "Adobe Creative Cloud for teams"] },
      { kind: "RATING", prompt: "How useful was last half's training?" },
      { kind: "YES_NO", prompt: "Would you attend on a Saturday?" },
      { kind: "TEXT", prompt: "Anything else?" },
    ],
  });
  const forms = await answerAll(form, trainees, formOpen, formClose, 0.85);
  audit(run, run.hr.id, "UPDATE", "Survey", form.id, "Marked open", at(formOpen, 9, 30));
  audit(run, run.hr.id, "UPDATE", "Survey", form.id, "Marked closed", at(addDays(formClose, 1), 10, 0));
  for (const id of trainees) notify(run, id, "SURVEY_ASSIGNED", `${form.title} is waiting for you`, "Your answers are attributed to you.", `/surveys/${form.id}`, at(formOpen, 9, 31));

  // And one being written: the next pulse survey, for two departments.
  const draftDepts = ["Support", "Inside Sales"].map((d) => run.ctx.departments.get(d)).filter((d): d is string => !!d);
  await make({
    kind: "FORM", title: "Quarterly pulse — Q3", description: "Five minutes. Anonymous. What's working and what isn't.", anonymous: true, mandatory: true,
    audience: "DEPARTMENT", status: "DRAFT", opens: workingOnOrAfter(addDays(TODAY_D, 5)), closes: addDays(TODAY_D, 19), created: at(workingOnOrBefore(addDays(TODAY_D, -1)), 17, 10), departments: draftDepts,
    questions: [
      { kind: "RATING", prompt: "How was your workload this quarter?" },
      { kind: "MULTI_CHOICE", prompt: "What got in your way?", options: ["Too many meetings", "Waiting on other teams", "Tools and laptops", "Unclear priorities", "Nothing — it was a good quarter"] },
      { kind: "SINGLE_CHOICE", prompt: "Would you recommend working here to a friend?", options: ["Definitely", "Probably", "Not sure", "Probably not"] },
      { kind: "TEXT", prompt: "One thing we should change" },
    ],
  });

  // ── The speak-up channel: more of it, "something else" included ─────────────────────────────
  const readers = people.filter((p) => p.title === "HR Manager" && p.active);
  const FEEDBACK: [kind: "PRAISE" | "CONCERN" | "SUGGESTION" | "GRIEVANCE" | "OTHER", body: string, about: boolean][] = [
    ["OTHER", "Can the cafeteria vendor be asked to label what has nuts in it? Two of us are allergic.", false],
    ["OTHER", "The second-floor washroom has been out of order for a week and nobody seems to know who to tell.", false],
    ["OTHER", "Is there a policy on taking the office laptop abroad on holiday? I couldn't find one anywhere.", false],
    ["OTHER", "Please share the holiday list for next year before October — people want to book tickets.", false],
    ["PRAISE", "The support lead stayed until midnight to get a customer's site back up. That deserves to be said out loud.", true],
    ["SUGGESTION", "A shared calendar of customer visits would stop two of us turning up at the same office on the same day.", false],
    ["CONCERN", "Commission statements arrive three weeks after month end — hard to plan around.", false],
  ];
  let feedback = 0;
  const quota = new Map<string, number>();
  for (const [kind, body, about] of FEEDBACK) {
    const day = workingOnOrBefore(addDays(TODAY_D, -int(3, 200)));
    const reviewed = day < addDays(TODAY_D, -10) && chance(0.7);
    const reviewer = readers[0] ?? run.hr;
    await db.internalFeedback.create({
      data: {
        kind, body, aboutUserId: about ? (people.find((p) => p.title === "Support Lead")?.id ?? null) : null, rating: kind === "PRAISE" ? 5 : kind === "CONCERN" ? 2 : null,
        submittedOn: day, reviewedAt: reviewed ? at(addDays(day, int(1, 5)), 11, 30) : null, reviewedById: reviewed ? reviewer.id : null,
        reviewNote: reviewed ? pick(["Raised with facilities — fixed.", "Shared with the leadership team.", "Policy being written; will circulate.", "Thanks — passed on."]) : null,
      },
    });
    // Whoever wrote it used one of their ten for the day — the only trace of them there is.
    const writer = pick(active);
    const k = `${writer.id}|${toKey(day)}`;
    quota.set(k, (quota.get(k) ?? 0) + 1);
    for (const r of readers) notify(run, r.id, "FEEDBACK_SUBMITTED", "New anonymous feedback", "Something has come in through the anonymous channel.", "/people/feedback", at(day, int(10, 19), int(0, 59)));
    feedback += 1;
  }
  for (const [k, count] of quota) {
    const [userId, day] = k.split("|") as [string, string];
    await db.feedbackQuota.upsert({ where: { user_day: { userId, onDate: D(day) } }, create: { userId, onDate: D(day), count }, update: { count: { increment: count } } });
  }
  const t = await flushTrail(run);
  log("Engagement", `a closed vote (${votes} votes), a closed named form (${forms} answers), a draft pulse survey; ${feedback} feedback items; ${t.notes} notifications`);
}

// ─── Expenses ────────────────────────────────────────────────────────────────────────────────────

const EXPENSES: [category: ExpenseCategory, description: string, min: number, max: number, modes: ExpensePaymentMode[]][] = [
  ["TRAVEL", "Train tickets — customer visit in Nashik", 600, 4200, ["UPI", "PERSONAL_CARD"]],
  ["FUEL", "Fuel — field visits this week", 800, 3500, ["CASH", "UPI"]],
  ["MILEAGE", "Own car — 142 km at ₹9/km for the Thane site visits", 400, 2600, ["BANK_TRANSFER"]],
  ["TOLL_PARKING", "Toll and parking — Pune expressway", 150, 900, ["CASH", "UPI"]],
  ["ACCOMMODATION", "Hotel — two nights for the Bengaluru deployment", 3500, 12000, ["COMPANY_CARD", "PERSONAL_CARD"]],
  ["MEALS", "Working dinner — late deployment", 300, 1800, ["UPI", "CASH"]],
  ["CLIENT_ENTERTAINMENT", "Lunch with the customer's IT head", 1500, 6500, ["PERSONAL_CARD", "COMPANY_CARD"]],
  ["COURIER", "Courier — signed agreement to the customer", 120, 650, ["CASH", "UPI"]],
  ["PHONE_INTERNET", "Mobile data top-up — field work", 299, 799, ["UPI"]],
  ["OFFICE_SUPPLIES", "Printer toner and stationery", 450, 3800, ["COMPANY_CARD", "CASH"]],
  ["SOFTWARE_SUBSCRIPTION", "Screen-recording tool — annual plan", 1200, 9000, ["COMPANY_CARD"]],
  ["MARKETING", "Standee and brochures for the dealer meet", 2500, 15000, ["BANK_TRANSFER", "COMPANY_CARD"]],
  ["TRAINING", "Exam fee — vendor certification", 4000, 14000, ["PERSONAL_CARD", "BANK_TRANSFER"]],
  ["REPAIRS_MAINTENANCE", "Laptop keyboard replacement", 900, 4500, ["CASH", "UPI"]],
  ["PROFESSIONAL_FEES", "Notary and stamp paper for the tender", 500, 3000, ["CASH", "BANK_TRANSFER"]],
  ["OTHER", "Visa fee — partner conference", 1500, 8000, ["PERSONAL_CARD", "UPI"]],
];

/**
 * Claims in every category and every way of paying, taken through the claim's whole life as the
 * actions take it: submitted to the claimant's manager, decided by them (never by the claimant), the
 * approved ones posted to the books and the reimbursable ones paid back — each by the app's own
 * posting functions. Company-card spend is not reimbursable, so it stops at approved, as it should.
 */
async function expenses(run: Run) {
  const { db, people } = run;
  if (await db.expense.findFirst({ where: { category: "PROFESSIONAL_FEES", userId: { in: people.map((p) => p.id) } }, select: { id: true } })) {
    log("Expenses", "already written — left as they are");
    return;
  }
  const claimants = people.filter((p) => ["Sales", "Support", "Presales & Solutions", "Inside Sales", "Purchase", "HR & Admin", "Accounts"].includes(p.dept));
  const counts = new Map<string, number>();
  let posted = 0;
  for (const [i, [category, description, min, max, modes]] of [...EXPENSES, ...EXPENSES, ...EXPENSES].entries()) {
    const p = claimants[(i * 5 + 3) % claimants.length]!;
    const last = p.exitedOn ? minDate(p.exitedOn, TODAY_D) : TODAY_D;
    const first = maxDate(p.joinedOn, START_D);
    if (last <= addDays(first, 5)) continue;
    // Most of the year's claims are long settled; a few are this week's, still being written up.
    const recentClaim = i % 12 === 5 && !p.exitedOn;
    const spentOn = recentClaim ? workingOnOrBefore(addDays(TODAY_D, -int(0, 3))) : workingOnOrBefore(addDays(first, int(3, Math.max(4, Math.floor((last.getTime() - first.getTime()) / DAY)))));
    const paymentMode = modes[i % modes.length]!;
    const reimbursable = paymentMode !== "COMPANY_CARD";
    const age = (TODAY_D.getTime() - spentOn.getTime()) / DAY;
    let status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "REIMBURSED";
    if (age < 4) status = chance(0.5) ? "DRAFT" : "SUBMITTED";
    else if (age < 12) status = pick(["SUBMITTED", "APPROVED", "REJECTED"] as const);
    else status = !reimbursable ? (chance(0.85) ? "APPROVED" : "REJECTED") : chance(0.1) ? "REJECTED" : chance(0.15) ? "APPROVED" : "REIMBURSED";
    if (p.exitedOn && status === "SUBMITTED") status = "REJECTED";
    const amount = Math.round(int(min, max) / 10) * 10;
    const createdAt = at(spentOn, int(18, 21), int(0, 59));
    const submittedAt = status === "DRAFT" ? null : new Date(createdAt.getTime() + int(1, 40) * 3_600_000);
    const manager = p.managerId ? run.byId.get(p.managerId) : undefined;
    const approver = manager && manager.active && manager.id !== p.id ? manager : run.controller.id === p.id ? run.director : run.controller;
    const decidedAt = submittedAt && status !== "SUBMITTED" ? minDate(new Date(submittedAt.getTime() + int(4, 60) * 3_600_000), new Date(TODAY.getTime() - 3_600_000)) : null;
    let reimbursedAt = status === "REIMBURSED" && decidedAt ? D(toKey(workingOnOrAfter(addDays(decidedAt, int(3, 12))))) : null;
    if (status === "REIMBURSED" && (!reimbursedAt || reimbursedAt > TODAY_D)) {
      status = "APPROVED";
      reimbursedAt = null;
    }
    const note = status === "REJECTED" ? pick(["No receipt attached — please resubmit with the bill.", "Personal expense — not claimable.", "Over the meal limit for the city."]) : status === "APPROVED" && chance(0.3) ? "Okay." : null;
    const row = await db.expense.create({
      data: {
        userId: p.id, category, amount: dec(amount), taxAmount: ["ACCOMMODATION", "SOFTWARE_SUBSCRIPTION", "MARKETING", "PROFESSIONAL_FEES"].includes(category) ? dec(Math.round((amount * 18) / 118)) : null,
        spentOn, description, paymentMode, reimbursable,
        receiptDataUrl: status === "DRAFT" || chance(0.3) ? null : PDF_STUB, receiptName: status === "DRAFT" ? null : "receipt.pdf",
        status, submittedAt, approverUserId: submittedAt ? approver.id : null, decidedAt, decisionNote: note,
        reimbursedAt,
        reimbursementRef: reimbursedAt ? `NEFT/${toKey(reimbursedAt).replaceAll("-", "")}/${int(1000, 9999)}` : null,
        createdAt,
      },
    });
    const ref = formatExpenseId(row.expenseSeq);
    audit(run, p.id, "CREATE", "Expense", row.id, ref, createdAt);
    if (submittedAt) notify(run, approver.id, "EXPENSE_SUBMITTED", "An expense claim needs your approval", `${expenseCategoryLabels[category]} — ₹${amount.toFixed(2)}`, `/expenses/${row.id}`, submittedAt);
    if (decidedAt) {
      const ok = status !== "REJECTED";
      audit(run, approver.id, "UPDATE", "Expense", row.id, `${ref} ${ok ? "approved" : "rejected"}`, decidedAt);
      notify(run, p.id, "EXPENSE_DECIDED", ok ? "Your expense claim was approved" : "Your expense claim was rejected", `${ref} — ${expenseCategoryLabels[category]}${note ? `: ${note}` : ""}`, `/expenses/${row.id}`, decidedAt);
    }
    if (status === "APPROVED" || status === "REIMBURSED") {
      if (await postExpenseToLedger(db, row.id, run.controller.id)) posted += 1;
    }
    if (status === "REIMBURSED" && row.reimbursedAt) {
      if (await postExpenseReimbursementToLedger(db, row.id, run.controller.id, row.reimbursedAt)) posted += 1;
      notify(run, p.id, "EXPENSE_REIMBURSED", "Your expenses were reimbursed", `1 claim(s) paid out — ref ${row.reimbursementRef}`, "/expenses", at(row.reimbursedAt, 15, 0));
    }
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const t = await flushTrail(run);
  log("Expenses", `${[...counts.values()].reduce((a, b) => a + b, 0)} claims in all ${EXPENSES.length} categories and every payment mode — ${[...counts].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")}; ${posted} ledger entries; ${t.notes} notifications`);
}

// ─── Reception ───────────────────────────────────────────────────────────────────────────────────

/**
 * The front desk's year, finished: the vendors on the books brought across as companies visitors come
 * from, a few typed in by hand, visitors in the building right now, and invitations in every state —
 * one that turned into a visit, one called off, two that nobody turned up for — for every purpose.
 */
async function reception(run: Run) {
  const { db, people, ctx } = run;
  if (await db.visitorCompany.findFirst({ where: { source: "MANUAL" }, select: { id: true } })) {
    log("Reception", "already written — left as it is");
    return;
  }
  const kiosk = await db.visitorKiosk.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
  if (!kiosk) {
    log("Reception", "no kiosk — skipped");
    return;
  }
  const desk = people.find((p) => p.title === "Office Admin" && p.active) ?? people.find((p) => p.title === "Support Lead") ?? run.hr;

  // ── Companies visitors come from: the vendors, then a few by hand ───────────────────────────
  const vendors = await db.company.findMany({ where: { id: { in: ctx.companies.map((c) => c.id) }, relationshipType: { in: ["VENDOR", "OEM", "DISTRIBUTOR"] } }, select: { id: true, name: true } });
  let added = 0;
  let adopted = 0;
  const importedAt = at(workingOnOrBefore(addDays(TODAY_D, -int(60, 120))), 11, 0);
  for (const v of vendors) {
    const normalizedName = normaliseCompany(v.name);
    if (!normalizedName) continue;
    const existing = await db.visitorCompany.findUnique({ where: { normalizedName } });
    if (existing) {
      if (existing.source === "VISITOR") {
        await db.visitorCompany.update({ where: { id: existing.id }, data: { source: "VENDOR", companyId: v.id, name: v.name } });
        adopted += 1;
      }
      continue;
    }
    await db.visitorCompany.create({ data: { name: v.name, normalizedName, source: "VENDOR", companyId: v.id, createdAt: importedAt } });
    added += 1;
  }
  audit(run, desk.id, "CREATE", "VisitorCompany", "import", `Brought ${added} vendors across, adopted ${adopted}`, importedAt);
  for (const name of ["Spotless Facility Management", "Aquaguard Service Centre", "Mumbai Fire Safety Services", "Gupta Stationers", "PestFree Solutions"]) {
    const normalizedName = normaliseCompany(name);
    if (!normalizedName || (await db.visitorCompany.findUnique({ where: { normalizedName }, select: { id: true } }))) continue;
    await db.visitorCompany.create({ data: { name, normalizedName, source: "MANUAL", createdAt: at(workingOnOrBefore(addDays(TODAY_D, -int(20, 90))), 12, 0) } });
  }

  const resolveCompany = async (name: string | null, seen: Date) => {
    if (!name) return null;
    const normalizedName = normaliseCompany(name);
    if (!normalizedName) return null;
    const found = await db.visitorCompany.findUnique({ where: { normalizedName }, select: { id: true } });
    if (found) {
      await db.visitorCompany.update({ where: { id: found.id }, data: { visitCount: { increment: 1 }, lastSeenAt: seen } });
      return found.id;
    }
    return (await db.visitorCompany.create({ data: { name, normalizedName, source: "VISITOR", visitCount: 1, lastSeenAt: seen } })).id;
  };
  const badge = async (when: Date) => {
    const day = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
    return (await db.visitorEntry.count({ where: { checkedInAt: { gte: day, lte: when } } })) + 1;
  };
  const hostOf = (title: string) => people.find((p) => p.title === title && p.active) ?? desk;

  // ── In the building now ─────────────────────────────────────────────────────────────────────
  const nowish = (h: number, m: number) => minDate(at(TODAY_D, h, m), new Date(TODAY.getTime() - int(15, 40) * 60_000));
  const inNow: { name: string; company: string; purpose: "OTHER" | "INTERVIEW" | "VENDOR"; host: Person; note: string | null; photo: boolean; at: Date }[] = [
    { name: "Sanjay Patil", company: "PestFree Solutions", purpose: "OTHER", host: desk, note: "Quarterly pest control — all floors.", photo: true, at: nowish(9, 40) },
    { name: "Ritika Joshi", company: "Self", purpose: "INTERVIEW", host: run.hr, note: "No photo — camera unavailable at the desk", photo: false, at: nowish(10, 5) },
    { name: "Arvind Menon", company: vendors[0]?.name ?? "Ingram Micro", purpose: "VENDOR", host: hostOf("Purchase Manager"), note: null, photo: true, at: nowish(10, 20) },
  ];
  let entries = 0;
  for (const v of inNow) {
    const visitorCompanyId = v.company === "Self" ? null : await resolveCompany(v.company, v.at);
    await db.visitorEntry.create({
      data: { kioskId: kiosk.id, purpose: v.purpose, hostUserId: v.host.id, departmentId: v.host.deptId, name: v.name, phone: phone(), company: v.company, visitorCompanyId,
        email: `${v.name.toLowerCase().replace(" ", ".")}@visitor.example`, note: v.note, photoDataUrl: v.photo ? JPEG_STUB : null, checkedInAt: v.at, status: "IN", badgeNo: await badge(v.at) },
    });
    notify(run, v.host.id, "VISITOR_ARRIVED", `${v.name} is at ${kiosk.name}`, [v.company === "Self" ? null : v.company, v.purpose === "INTERVIEW" ? "Interview" : null].filter(Boolean).join(" · ") || null, "/visitors", v.at);
    entries += 1;
  }
  // And the "anything else" visits of the year, signed out.
  for (let i = 0; i < 6; i++) {
    const day = workingOnOrBefore(addDays(TODAY_D, -int(3, 300)));
    const inAt = at(day, int(10, 16), int(0, 59));
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    const company = pick(["Spotless Facility Management", "Aquaguard Service Centre", "Mumbai Fire Safety Services", "Gupta Stationers"]);
    await db.visitorEntry.create({
      data: { kioskId: kiosk.id, purpose: "OTHER", hostUserId: desk.id, departmentId: desk.deptId, name, phone: phone(), company, visitorCompanyId: await resolveCompany(company, inAt),
        email: `${name.toLowerCase().replace(" ", ".")}@visitor.example`, note: pick(["Fire extinguisher refill.", "Water purifier service.", "Deep cleaning of the pantry.", "Stationery delivery and invoice."]),
        photoDataUrl: JPEG_STUB, checkedInAt: inAt, checkedOutAt: new Date(inAt.getTime() + int(30, 150) * 60_000), status: "OUT", closedById: desk.id, badgeNo: await badge(inAt) },
    });
    entries += 1;
  }

  // ── Invitations, every purpose and every state ──────────────────────────────────────────────
  const codes = new Set((await db.visitorInvite.findMany({ select: { code: true } })).map((i) => i.code));
  const uniqueCode = () => {
    let c = generateCode();
    while (codes.has(c)) c = generateCode();
    codes.add(c);
    return c;
  };
  const INVITES: { purpose: "MEETING" | "INTERVIEW" | "DELIVERY" | "VENDOR" | "OTHER"; status: "ARRIVED" | "CANCELLED" | "EXPIRED" | "PENDING"; host: Person; name: string; company: string | null; daysAgo: number }[] = [
    { purpose: "MEETING", status: "ARRIVED", host: hostOf("Head of Sales"), name: "Deepak Rao", company: ctx.companies.find((c) => c.stage === "CUSTOMER")?.name ?? "A customer", daysAgo: int(10, 40) },
    { purpose: "INTERVIEW", status: "ARRIVED", host: run.hr, name: "Ayesha Siddiqui", company: null, daysAgo: int(12, 30) },
    { purpose: "VENDOR", status: "CANCELLED", host: hostOf("Purchase Manager"), name: "Harish Iyer", company: vendors[1]?.name ?? "Redington", daysAgo: int(5, 20) },
    { purpose: "DELIVERY", status: "EXPIRED", host: desk, name: "Blue Dart courier", company: "Blue Dart", daysAgo: int(8, 25) },
    { purpose: "OTHER", status: "EXPIRED", host: run.hr, name: "Neelam Shah", company: "Health Plus diagnostics", daysAgo: int(30, 60) },
    { purpose: "VENDOR", status: "ARRIVED", host: hostOf("Support Lead"), name: "Prakash Kumar", company: vendors[2]?.name ?? "Sophos", daysAgo: int(40, 90) },
    { purpose: "OTHER", status: "PENDING", host: run.hr, name: "Dr. Kavita Sen", company: "Health Plus diagnostics", daysAgo: -int(3, 9) },
    { purpose: "DELIVERY", status: "PENDING", host: desk, name: "Dell — laptop delivery", company: "Dell Technologies", daysAgo: -int(1, 4) },
  ];
  let invites = 0;
  for (const inv of INVITES) {
    const expectedDay = inv.daysAgo >= 0 ? workingOnOrBefore(addDays(TODAY_D, -inv.daysAgo)) : workingOnOrAfter(addDays(TODAY_D, -inv.daysAgo));
    const expectedAt = at(expectedDay, int(10, 16), pick([0, 15, 30, 45]));
    const createdBy = inv.host.id === desk.id ? run.hr : desk;
    const createdAt = at(workingOnOrBefore(addDays(expectedDay, -int(1, 5))), int(10, 17), int(0, 59));
    let entryId: string | null = null;
    if (inv.status === "ARRIVED") {
      const inAt = new Date(expectedAt.getTime() + int(-10, 20) * 60_000);
      const entry = await db.visitorEntry.create({
        data: { kioskId: kiosk.id, purpose: inv.purpose, hostUserId: inv.host.id, departmentId: inv.host.deptId, name: inv.name, phone: "—", company: inv.company, visitorCompanyId: await resolveCompany(inv.company, inAt),
          email: inv.purpose === "DELIVERY" ? null : `${inv.name.toLowerCase().replaceAll(" ", ".").replaceAll(".", "")}@visitor.example`, note: "Expected visitor", photoDataUrl: JPEG_STUB,
          checkedInAt: inAt, checkedOutAt: new Date(inAt.getTime() + int(40, 180) * 60_000), status: "OUT", closedById: inv.host.id, badgeNo: await badge(inAt) },
      });
      entryId = entry.id;
      entries += 1;
      notify(run, inv.host.id, "VISITOR_ARRIVED", `${inv.name} has arrived at ${kiosk.name}`, [inv.company, "You were expecting them"].filter(Boolean).join(" · "), "/visitors", inAt);
    }
    const row = await db.visitorInvite.create({
      data: { code: uniqueCode(), purpose: inv.purpose, hostUserId: inv.host.id, name: inv.name, phone: chance(0.7) ? phone() : null, email: inv.purpose === "DELIVERY" ? null : `${inv.name.split(" ")[0]!.toLowerCase()}@visitor.example`,
        company: inv.company, note: inv.purpose === "INTERVIEW" ? "Second round — bring ID proof." : null, expectedAt, expectedCompanions: inv.purpose === "MEETING" ? 1 : 0, status: inv.status, entryId, createdById: createdBy.id, createdAt },
    });
    audit(run, createdBy.id, "CREATE", "VisitorInvite", row.id, `${inv.name} for ${inv.host.name}`, createdAt);
    if (createdBy.id !== inv.host.id) notify(run, inv.host.id, "VISITOR_EXPECTED", `${createdBy.name} booked a visitor for you`, `${inv.name} — ${indiaClock.dateTime(expectedAt)}`, "/visitors/expected", createdAt);
    if (inv.status === "CANCELLED") audit(run, inv.host.id, "UPDATE", "VisitorInvite", row.id, `Cancelled — ${inv.name}`, new Date(createdAt.getTime() + int(20, 60) * 3_600_000));
    invites += 1;
  }
  const t = await flushTrail(run);
  log("Reception", `${added} vendors brought across (${adopted} adopted), 5 typed in; ${entries} visits (3 in the building now); ${invites} invitations in every state; ${t.notes} notifications`);
}

// ─── Vault ───────────────────────────────────────────────────────────────────────────────────────

const TAGS: Record<"CATEGORY" | "ACCESS_TYPE", string[]> = {
  CATEGORY: ["Domain", "Hosting", "Partner portal", "Vendor portal", "Government & tax", "Banking & payments", "Internal tool", "Email & collaboration", "Social & marketing"],
  ACCESS_TYPE: ["Admin", "User", "Billing", "cPanel"],
};
/** Which tags the demo's own logins were written for (prisma/demo/modules.ts), by login name. */
const TAGGED: [match: RegExp, category: string, access: string][] = [
  [/GoDaddy|BigRock/, "Domain", "Admin"], [/Hostinger|AWS/, "Hosting", "Admin"], [/cPanel/, "Hosting", "cPanel"],
  [/Partner Center|Sophos/, "Partner portal", "Admin"], [/Adobe/, "Partner portal", "Billing"], [/Autodesk/, "Partner portal", "User"],
  [/Ingram|Redington/, "Vendor portal", "Billing"], [/GST|Income Tax|EPFO/, "Government & tax", "Admin"], [/MCA21/, "Government & tax", "User"],
  [/HDFC/, "Banking & payments", "User"], [/Razorpay/, "Banking & payments", "Admin"], [/Zoho/, "Internal tool", "Admin"],
  [/Google Workspace/, "Email & collaboration", "Admin"], [/LinkedIn/, "Social & marketing", "Admin"],
];

/**
 * The vault's categories — the demo filed its logins under categories nobody had created, so every
 * one was uncategorised — and a standing share with a whole team, opened by people on it (via
 * DEPARTMENT, the entitlement `entitlementFor` grants when a live share names the opener's team).
 */
async function vault(run: Run) {
  const { db, people } = run;
  if (await db.vaultReveal.findFirst({ where: { via: "DEPARTMENT" }, select: { id: true } })) {
    log("Vault", "already written — left as it is");
    return;
  }
  const tagId = new Map<string, string>();
  for (const kind of ["CATEGORY", "ACCESS_TYPE"] as const) {
    for (const [i, name] of TAGS[kind].entries()) {
      const row = await db.credentialTag.upsert({ where: { kind_name: { kind, name } }, create: { kind, name, sortOrder: i }, update: {} });
      tagId.set(`${kind}:${name}`, row.id);
    }
  }
  let tagged = 0;
  for (const c of await db.vaultCredential.findMany({ where: { OR: [{ categoryId: null }, { accessTypeId: null }] }, select: { id: true, loginName: true, ownership: true } })) {
    const match = TAGGED.find(([re]) => re.test(c.loginName));
    const category = match?.[1] ?? (c.ownership === "CLIENT" ? "Hosting" : "Internal tool");
    const access = match?.[2] ?? "Admin";
    await db.vaultCredential.update({ where: { id: c.id }, data: { categoryId: tagId.get(`CATEGORY:${category}`) ?? null, accessTypeId: tagId.get(`ACCESS_TYPE:${access}`) ?? null } });
    tagged += 1;
  }

  // ── A standing share with a team, and the people on it opening it ───────────────────────────
  const supportDept = run.ctx.departments.get("Support");
  let reveals = 0;
  if (supportDept) {
    let share = await db.vaultShare.findFirst({ where: { departmentId: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: TODAY } }] }, include: { credential: true }, orderBy: { createdAt: "asc" } });
    // The demo stamps its shares with the moment it ran, so a standing team share looks a minute old
    // and nobody could have opened through it before today. Shared when the login was stored, instead.
    if (share && share.createdAt > addDays(TODAY_D, -30)) {
      const since = at(workingOnOrBefore(addDays(TODAY_D, -int(90, 140))), 12, 10);
      if (share.credential.createdAt > since) await db.vaultCredential.update({ where: { id: share.credentialId }, data: { createdAt: minDate(since, share.credential.passwordChangedAt ?? since) } });
      share = await db.vaultShare.update({ where: { id: share.id }, data: { createdAt: since }, include: { credential: true } });
    }
    if (!share) {
      const credential = await db.vaultCredential.findFirst({ where: { archivedAt: null, ownership: "OURS", owner: { email: { endsWith: DEMO_EMAIL_DOMAIN }, departmentId: { not: supportDept } } }, orderBy: { createdAt: "asc" } });
      if (credential) {
        const sharedAt = at(workingOnOrBefore(addDays(TODAY_D, -int(60, 120))), 12, 10);
        share = await db.vaultShare.create({ data: { credentialId: credential.id, departmentId: supportDept, level: "VIEW", sharedById: credential.ownerId, createdAt: sharedAt }, include: { credential: true } });
        audit(run, credential.ownerId, "UPDATE", "VaultCredential", credential.id, `Shared ${credential.loginName}`, sharedAt);
      }
    }
    if (share?.departmentId) {
      const named = new Set((await db.vaultShare.findMany({ where: { credentialId: share.credentialId, userId: { not: null } }, select: { userId: true } })).map((s) => s.userId));
      const team = people.filter((p) => p.active && p.deptId === share!.departmentId && p.id !== share!.credential.ownerId && !named.has(p.id));
      for (const p of some(team, Math.min(5, team.length))) {
        for (let k = 0; k < int(1, 3); k++) {
          const when = at(workingOnOrBefore(addDays(TODAY_D, -int(1, 50))), int(10, 18), int(0, 59));
          if (when < share.createdAt) continue;
          const field = share.credential.recoveryKeyCipher && chance(0.2) ? "RECOVERY_KEY" : "PASSWORD";
          await db.vaultReveal.create({ data: { credentialId: share.credentialId, userId: p.id, via: "DEPARTMENT", field, at: when } });
          audit(run, p.id, "UPDATE", "VaultCredential", share.credentialId, `Opened ${field === "RECOVERY_KEY" ? "recovery key" : "password"} for ${share.credential.loginName} (department)`, when);
          notify(run, share.credential.ownerId, "VAULT_CREDENTIAL_OPENED", `${p.name} opened ${share.credential.loginName}`, `${field === "RECOVERY_KEY" ? "Recovery key" : "Password"}, via department access.`, "/vault", when);
          reveals += 1;
        }
      }
    }
  }
  const t = await flushTrail(run);
  log("Vault", `${TAGS.CATEGORY.length + TAGS.ACCESS_TYPE.length} categories and access types, ${tagged} logins filed under them; ${reveals} openings via a team share; ${t.audits} audit rows`);
}

// ─── The company's own news and guides ───────────────────────────────────────────────────────────

/**
 * What's new and the help rail, from the company — never Deskzo's own posts, which live in the
 * platform console and are read from there (src/actions/help.ts). Links pass the app's own check.
 */
async function companyContent(run: Run) {
  const { db } = run;
  if (await db.announcement.findFirst({ where: { createdById: { in: run.people.map((p) => p.id) } }, select: { id: true } })) {
    log("Company news", "already written — left as it is");
    return;
  }
  const NEWS: [title: string, body: string, link: string | null, daysAgo: number, pinned: boolean, by: Person][] = [
    ["Leave policy for the new financial year", "Casual leave stays at 12 days and sick leave at 8. Earned leave now accrues monthly — 1.5 days a month — instead of being credited in April. Your balance on Leave shows what you have today.", "/people/leave", 185, false, run.hr],
    ["Appraisal letters are out", "Revised salaries take effect from 1 April and show on your April payslip. Letters are on your file under Documents.", "/people/me", 182, false, run.hr],
    ["New office in Bengaluru", "From 1 June the Bengaluru team works out of our own office in Indiranagar. Visitors sign in at the new reception tablet.", null, 125, false, run.director],
    ["Attendance: use the biometric at the door", "Both terminals now feed attendance directly. If a punch is missed, raise a correction from your own page the same week — not at month end.", "/people/me", 60, false, run.hr],
    ["Diwali — office closed", "The office is closed on the Diwali holidays on the calendar. Wishing everybody and their families a happy and safe festival.", null, 12, true, run.director],
    ["Annual offsite — the votes are in", "Thank you for voting. Dates and travel in next week's update.", null, 0, false, run.hr],
  ];
  let posts = 0;
  for (const [title, body, link, ago, pinned, by] of NEWS) {
    const checked = link ? checkLink(link) : null;
    const publishedAt = ago === 0 ? at(workingOnOrAfter(addDays(TODAY_D, 3)), 10, 0) : at(workingOnOrBefore(addDays(TODAY_D, -ago)), 10, 0);
    const createdAt = ago === 0 ? new Date(TODAY.getTime() - 2 * 3_600_000) : new Date(publishedAt.getTime() - int(1, 20) * 3_600_000);
    const row = await db.announcement.create({ data: { title, body, linkUrl: checked && checked.ok ? checked.url : null, pinned, publishedAt, createdById: by.id, createdAt } });
    audit(run, by.id, "CREATE", "Announcement", row.id, `What's new: ${title}`, createdAt);
    posts += 1;
  }
  const GUIDES: [kind: "ARTICLE" | "VIDEO", title: string, url: string, description: string][] = [
    ["ARTICLE", "How to apply for leave", "/people/leave", "Balances, half days, and who approves what."],
    ["ARTICLE", "Raising an attendance correction", "/people/me", "Missed a punch? Ask for the day to be corrected the same week."],
    ["ARTICLE", "Claiming expenses", "/expenses", "What needs a receipt, the meal limits by city, and when you are paid back."],
    ["ARTICLE", "Sales playbook — renewals", "https://wiki.example.com/sales/renewals-playbook", "The 90/60/30-day renewal rhythm, with the email templates."],
    ["VIDEO", "Logging a field visit from your phone", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Two minutes: check in, add notes, check out."],
    ["VIDEO", "Quoting with the new price list", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "Building a quotation, applying the partner discount and sending it."],
  ];
  let guides = 0;
  for (const [i, [kind, title, url, description]] of GUIDES.entries()) {
    const checked = checkLink(url);
    if (!checked.ok) continue;
    const createdAt = at(workingOnOrBefore(addDays(TODAY_D, -int(30, 300))), 12, int(0, 59));
    const row = await db.helpLink.create({ data: { kind, title, url: checked.url, description, sortOrder: i, active: i !== GUIDES.length - 1 || chance(0.5), createdById: run.hr.id, createdAt } });
    audit(run, run.hr.id, "CREATE", "HelpLink", row.id, `${kind === "VIDEO" ? "Video" : "Help article"}: ${title}`, createdAt);
    guides += 1;
  }
  const t = await flushTrail(run);
  log("Company news", `${posts} What's new posts (one pinned, one scheduled) and ${guides} guides of the company's own; ${t.audits} audit rows`);
}

// ─── Activity trails ─────────────────────────────────────────────────────────────────────────────

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
};
/** The offices' public addresses, and where a GeoIP lookup puts them. */
const NETWORKS: Record<string, { ip: string; city: string; region: string }> = {
  [OFFICES.hq.label]: { ip: "103.21.58.14", city: "Mumbai", region: "Maharashtra" },
  [OFFICES.pune.label]: { ip: "49.36.120.7", city: "Pune", region: "Maharashtra" },
  [OFFICES.blr.label]: { ip: "106.51.73.22", city: "Bengaluru", region: "Karnataka" },
  [OFFICES.ncr.label]: { ip: "122.176.40.9", city: "New Delhi", region: "Delhi" },
};
const placeText = (n: { city: string; region: string }) => [...new Set([n.city, n.region, "India"].filter(Boolean))].join(", ");
const KIND_WORD: Record<string, string> = { MOBILE: "phone", TABLET: "tablet", COMPUTER: "laptop or desktop" };

/**
 * What a year of people using the app leaves behind, shaped exactly as each writer shapes it.
 *
 *   · **Sign-ins** (`recordSignIn`): one per session, on the device and network it came from, with
 *     NEW_DEVICE / NEW_NETWORK the first time each is seen — and the LOGIN, LOGOUT and refused
 *     sign-in lines the activity log gets alongside.
 *   · **Devices** (the gate): created on first use, approved automatically (no device-approval policy),
 *     revoked for the people who left — which ends their sessions, as `decideDevice` does.
 *   · **Daily activity** (`recordHeartbeat`): seconds active on each day somebody worked, keyed by the
 *     day on the workspace's calendar.
 *   · **Audit rows** for the records the demo's people created over the year — the companies,
 *     contacts, leads, tasks, tickets, quotes and payments the demo wrote without the trail the actions
 *     would have left — so the performance screen and the Most Active ranking have work to count.
 *   · **Permission changes** that agree with the overrides people actually hold.
 */
async function trails(run: Run) {
  const { db, people } = run;
  const ids = people.map((p) => p.id);
  if (await db.signIn.findFirst({ where: { userId: { in: ids } }, select: { id: true } })) {
    log("Activity trails", "already written — left as they are");
    return;
  }
  const days = await db.attendanceDay.findMany({ where: { userId: { in: ids }, status: { in: ["PRESENT", "WORK_FROM_HOME", "HALF_DAY"] }, date: { lte: TODAY_D } }, orderBy: { date: "asc" } });
  const byUser = new Map<string, typeof days>();
  for (const d of days) (byUser.get(d.userId) ?? byUser.set(d.userId, []).get(d.userId)!).push(d);

  const signIns: Prisma.SignInCreateManyInput[] = [];
  const activity: Prisma.ActivityLogCreateManyInput[] = [];
  const daily: Prisma.UserDailyActivityCreateManyInput[] = [];
  let devices = 0;
  const log2 = (p: Person, row: Omit<Prisma.ActivityLogCreateManyInput, "userId" | "userName" | "userEmail">) =>
    activity.push({ userId: p.id, userName: p.name, userEmail: p.email, ...row });

  for (const p of people) {
    const mine = byUser.get(p.id) ?? [];
    if (mine.length === 0) continue;
    const office = NETWORKS[p.workLocation ?? ""] ?? NETWORKS[OFFICES.hq.label]!;
    const home = { ip: `49.${int(32, 47)}.${int(1, 254)}.${int(1, 254)}`, city: office.city, region: office.region };
    // A phone comes in through the carrier, from one of a handful of addresses.
    const carrier = Array.from({ length: 3 }, () => `106.${int(192, 223)}.${int(1, 254)}.${int(1, 254)}`);
    const field = ["Sales", "Support", "Presales & Solutions"].includes(p.dept) && !p.isManager;
    const laptopUa = pick([UA.chromeWin, UA.chromeWin, UA.edgeWin, UA.safariMac]);
    const phoneUa = field || chance(0.4) ? pick([UA.iphone, UA.android, UA.android]) : null;
    const tabletUa = p.title === "Office Admin" || p.title === "Support Lead" ? UA.ipad : null;

    // ── Devices, as the gate creates them on first use ───────────────────────────────────────
    const made: { id: string; ua: string; kind: "MOBILE" | "TABLET" | "COMPUTER"; label: string; first: Date | null; last: Date | null; ips: Set<string> }[] = [];
    for (const ua of [laptopUa, phoneUa, tabletUa].filter((u): u is string => !!u)) {
      const kind = deviceKindFrom(ua);
      const row = await db.userDevice.create({
        data: { userId: p.id, tokenHash: hashDeviceToken(newDeviceToken()), kind, label: deviceLabel(ua), userAgent: ua.slice(0, 500), status: "APPROVED", lastIp: office.ip, lastPlace: placeText(office) },
      });
      made.push({ id: row.id, ua, kind, label: row.label, first: null, last: null, ips: new Set() });
      devices += 1;
    }
    const seenIps = new Set<string>();
    const sessionFor = (device: (typeof made)[number], when: Date, net: { ip: string; city: string; region: string }, until: Date) => {
      const flags: string[] = [];
      if (!device.first) {
        flags.push("NEW_DEVICE");
        device.first = when;
        log2(p, { kind: "NEW_DEVICE", severity: "INFO", summary: `${p.name} used a new device: ${device.label} (${KIND_WORD[device.kind]})`, entityType: "UserDevice", entityId: device.id, ipAddress: net.ip, userAgent: device.ua, metadata: { deviceId: device.id, kind: device.kind, place: placeText(net) }, createdAt: new Date(when.getTime() + 2000) });
      }
      if (!seenIps.has(net.ip)) {
        flags.push("NEW_NETWORK");
        seenIps.add(net.ip);
      }
      device.last = until;
      const sid = randomUUID();
      signIns.push({
        sid, userId: p.id, deviceId: device.id, provider: "credentials", at: when, lastSeenAt: until, ip: net.ip, userAgent: device.ua.slice(0, 500), deviceKind: device.kind,
        city: net.city, region: net.region, countryCode: "IN", country: "India", flags,
      });
      log2(p, { kind: "LOGIN", severity: "INFO", summary: `${p.name} signed in`, ipAddress: net.ip, userAgent: device.ua, path: "/login", metadata: { provider: "credentials" }, createdAt: when });
      return sid;
    };

    // ── Sessions and daily activity, day by day ──────────────────────────────────────────────
    let sinceLaptop = 99;
    for (const d of mine) {
      const inAt = d.checkInAt ?? at(d.date, 9, 45);
      const outAt = d.checkOutAt ?? (d.date.getTime() === TODAY_D.getTime() ? new Date(TODAY.getTime() - 5 * 60_000) : at(d.date, d.status === "HALF_DAY" ? 13 : 18, int(0, 45)));
      const net = d.status === "WORK_FROM_HOME" ? home : office;
      const laptop = made[0]!;
      sinceLaptop += 1;
      if (sinceLaptop >= int(3, 6) || !laptop.ips.has(net.ip)) {
        sessionFor(laptop, new Date(inAt.getTime() + int(3, 25) * 60_000), net, outAt);
        laptop.ips.add(net.ip);
        sinceLaptop = 0;
        if (chance(0.15)) log2(p, { kind: "LOGOUT", severity: "INFO", summary: `${p.name} signed out`, ipAddress: net.ip, userAgent: laptop.ua, createdAt: outAt });
      } else laptop.last = outAt;
      const phoneDevice = made.find((m) => m.kind === "MOBILE");
      if (phoneDevice && chance(field ? 0.12 : 0.04)) {
        const mob = { ip: pick(carrier), city: office.city, region: office.region };
        const t = at(d.date, int(11, 17), int(0, 59));
        sessionFor(phoneDevice, t, mob, new Date(t.getTime() + int(10, 90) * 60_000));
      }
      const tablet = made.find((m) => m.kind === "TABLET");
      if (tablet && chance(0.08)) sessionFor(tablet, at(d.date, 9, int(5, 30)), office, at(d.date, 18, 0));
      if (chance(0.006)) {
        log2(p, { kind: "LOGIN_FAILED", severity: "WARNING", summary: `Sign-in refused for ${p.name}: wrong password`, ipAddress: net.ip, userAgent: laptop.ua, metadata: { reason: "wrong password", email: p.email }, createdAt: new Date(inAt.getTime() + 60_000) });
      }
      // recordHeartbeat: the seconds the tab was in front of them.
      const worked = Math.max(0, (outAt.getTime() - inAt.getTime()) / 1000);
      const share = d.status === "HALF_DAY" ? 0.55 + rnd() * 0.25 : 0.4 + rnd() * 0.4;
      const activeSeconds = Math.round((worked * share) / 30) * 30;
      if (activeSeconds > 0) daily.push({ userId: p.id, date: d.date, activeSeconds, lastHeartbeatAt: new Date(outAt.getTime() - int(1, 20) * 60_000) });
    }
    for (const m of made) {
      if (!m.first) continue;
      await db.userDevice.update({ where: { id: m.id }, data: { firstSeenAt: m.first, lastSeenAt: m.last ?? m.first } });
    }

    // ── Leaving: devices revoked and sessions ended, as decideDevice does ─────────────────────
    if (p.exitedOn && p.exitedOn <= TODAY_D && !p.active) {
      const when = at(workingOnOrAfter(addDays(p.exitedOn, 1)), 10, int(0, 59));
      const ended = signIns.filter((s) => s.userId === p.id && !s.endedAt && (s.at as Date) <= when && (s.lastSeenAt as Date) > addDays(when, -14));
      for (const m of made.filter((x) => x.first)) {
        const mineEnded = ended.filter((s) => s.deviceId === m.id);
        for (const s of mineEnded) {
          s.endedAt = when;
          s.endedById = run.director.id;
        }
        await db.userDevice.update({ where: { id: m.id }, data: { status: "REVOKED", decidedById: run.director.id, decidedAt: when, decisionNote: "Left the company — device returned to IT." } });
        log2(run.director, { kind: "DEVICE_BLOCKED", severity: "WARNING", summary: `Revoked ${p.name}'s ${m.label}${mineEnded.length ? ` and ended ${mineEnded.length} session${mineEnded.length === 1 ? "" : "s"} on it` : ""}`, entityType: "UserDevice", entityId: m.id, metadata: { owner: p.id, note: "Left the company — device returned to IT." }, createdAt: when });
      }
      // Somebody who left trying their old login a few days later.
      if (p.exitType === "ABSCONDED") {
        log2(p, { kind: "LOGIN_FAILED", severity: "WARNING", summary: `Sign-in refused for ${p.name}: the account is deactivated`, ipAddress: home.ip, userAgent: laptopUa, metadata: { reason: "the account is deactivated", email: p.email }, createdAt: at(addDays(p.exitedOn, int(6, 9)), 22, 14) });
      }
    }
  }
  // One lost phone, revoked by an admin — its open session ended with it.
  const lostPhone = await db.userDevice.findFirst({ where: { userId: { in: people.filter((p) => p.active && p.dept === "Sales").map((p) => p.id) }, kind: "MOBILE", status: "APPROVED" } });
  if (lostPhone) {
    const owner = run.byId.get(lostPhone.userId)!;
    const when = new Date(Math.min(TODAY.getTime() - 3 * 3_600_000, (lostPhone.lastSeenAt?.getTime() ?? TODAY.getTime()) + 20 * 3_600_000));
    const open = signIns.filter((s) => s.deviceId === lostPhone.id && !s.endedAt && (s.lastSeenAt as Date) > addDays(when, -14));
    for (const s of open) {
      s.endedAt = when;
      s.endedById = run.director.id;
    }
    await db.userDevice.update({ where: { id: lostPhone.id }, data: { status: "REVOKED", decidedById: run.director.id, decidedAt: when, decisionNote: "Phone lost on the train — reported the same evening." } });
    log2(run.director, { kind: "DEVICE_BLOCKED", severity: "WARNING", summary: `Revoked ${owner.name}'s ${lostPhone.label}${open.length ? ` and ended ${open.length} session${open.length === 1 ? "" : "s"} on it` : ""}`, entityType: "UserDevice", entityId: lostPhone.id, metadata: { owner: owner.id, note: "Phone lost on the train — reported the same evening." }, createdAt: when });
  }
  // A session somebody ended themselves, and one HR ended for somebody.
  const recentOpen = signIns.filter((s) => !s.endedAt && (s.at as Date) > addDays(TODAY_D, -20));
  for (const [i, s] of some(recentOpen, 2).entries()) {
    const owner = run.byId.get(s.userId)!;
    const by = i === 0 ? owner : run.director;
    s.endedAt = new Date((s.at as Date).getTime() + int(30, 200) * 60_000);
    s.endedById = by.id;
    log2(by, { kind: "SESSION_ENDED", severity: "NOTICE", summary: by.id === owner.id ? `${owner.name} ended one of their own sessions` : `Ended ${owner.name}'s session`, entityType: "SignIn", entityId: s.sid, createdAt: s.endedAt as Date });
  }

  // Exports, now and then, by the people allowed to make them.
  for (const p of people.filter((x) => x.isManager || x.dept === "Accounts" || x.dept === "HR & Admin")) {
    for (let i = 0; i < int(1, 4); i++) {
      const day = workingOnOrBefore(addDays(TODAY_D, -int(1, 330)));
      if (!employedOn(p, day)) continue;
      const area = p.dept === "Accounts" ? pick(["invoices", "payments", "ledger"]) : p.dept === "HR & Admin" ? pick(["people", "attendance", "payslips"]) : pick(["companies", "leads", "orders"]);
      const rows = int(40, 900);
      log2(p, { kind: "EXPORT", severity: "NOTICE", summary: `${p.name} exported ${rows} ${area} rows`, ipAddress: (NETWORKS[p.workLocation ?? ""] ?? NETWORKS[OFFICES.hq.label]!).ip, userAgent: UA.chromeWin, metadata: { area, rows, format: pick(["xlsx", "csv"]) }, createdAt: at(day, int(11, 18), int(0, 59)) });
    }
  }

  // Reports run, an export refused, an admin viewing the app as somebody, a locked-out address.
  const SOURCES = ["Orders", "Leads", "Invoices", "Payments", "Tickets"];
  for (const p of people.filter((x) => x.isManager || x.title === "Finance Controller")) {
    for (let i = 0; i < int(2, 6); i++) {
      const day = workingOnOrBefore(addDays(TODAY_D, -int(1, 330)));
      if (!employedOn(p, day)) continue;
      const rows = int(120, 4800);
      const source = pick(SOURCES);
      log2(p, { kind: "SEARCH", severity: "INFO", summary: `${p.name} ran a ${source.toLowerCase()} report over ${rows.toLocaleString("en-IN")} rows`, ipAddress: (NETWORKS[p.workLocation ?? ""] ?? NETWORKS[OFFICES.hq.label]!).ip, userAgent: UA.chromeWin, metadata: { source: source.toLowerCase(), measure: "value", by: pick(["month", "owner", "brand"]), across: null, rows, truncated: false }, createdAt: at(day, int(10, 18), int(0, 59)) });
    }
  }
  for (const p of some(people.filter((x) => x.active && !x.isManager && x.dept === "Sales"), 2)) {
    const day = workingOnOrBefore(addDays(TODAY_D, -int(5, 120)));
    log2(p, { kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${p.name} tried to export Companies without permission`, ipAddress: (NETWORKS[p.workLocation ?? ""] ?? NETWORKS[OFFICES.hq.label]!).ip, userAgent: UA.chromeWin, metadata: { area: "companies" }, createdAt: at(day, int(11, 18), int(0, 59)) });
  }
  for (const target of some(people.filter((x) => x.active && x.id !== run.director.id && x.role !== "ADMIN"), 2)) {
    const day = workingOnOrBefore(addDays(TODAY_D, -int(3, 90)));
    const from = at(day, int(11, 16), int(0, 59));
    const to = new Date(from.getTime() + int(4, 25) * 60_000);
    log2(run.director, { kind: "IMPERSONATION_STARTED", severity: "WARNING", summary: `${run.director.name} started viewing the app as ${target.name}`, entityType: "User", entityId: target.id, metadata: { targetUserId: target.id, targetName: target.name }, createdAt: from });
    log2(run.director, { kind: "IMPERSONATION_ENDED", severity: "NOTICE", summary: `${run.director.name} stopped viewing the app as ${target.name}`, entityType: "User", entityId: target.id, createdAt: to });
    audit(run, run.director.id, "UPDATE", "User", target.id, `Started viewing the app as ${target.name}`, from);
    audit(run, run.director.id, "UPDATE", "User", target.id, `Stopped viewing the app as ${target.name}`, to);
  }
  const lockedOut = people.find((x) => !x.active) ?? people[people.length - 1]!;
  activity.push({ userId: null, userName: null, userEmail: lockedOut.email, kind: "RATE_LIMITED", severity: "WARNING", summary: `Sign-in locked out for ${lockedOut.email} after 5 failed attempts`, ipAddress: `49.${int(32, 47)}.${int(1, 254)}.${int(1, 254)}`, metadata: { failures: 5, lockedOut: true }, createdAt: at(workingOnOrBefore(addDays(TODAY_D, -int(2, 8))), 23, int(0, 59)) });

  await inChunks(signIns, 1000, (c) => db.signIn.createMany({ data: c }));
  // The devices the signs-ins point at already exist; the daily rows are one per person per day.
  await inChunks(daily, 2000, (c) => db.userDailyActivity.createMany({ data: c, skipDuplicates: true }));

  // ── The bell's own notices, as syncSystemNotifications writes them when somebody looks ───────
  // Birthdays, work anniversaries, the next holiday and tasks falling due — each to the people who
  // were in that day, keyed exactly as the sync keys them, so it finds them and adds no second copy.
  const inOn = new Map<string, Map<string, Date>>(); // day → who was in, and when they arrived
  for (const d of days) {
    const k = toKey(d.date);
    (inOn.get(k) ?? inOn.set(k, new Map()).get(k)!).set(d.userId, d.checkInAt ?? at(d.date, 9, 45));
  }
  const profiles = await db.employeeProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, dateOfBirth: true, joinedOn: true, designation: true } });
  const dedupe = new Set<string>();
  const systemNote = (userId: string, type: Prisma.NotificationCreateManyInput["type"], title: string, message: string | null, link: string, when: Date, key: string) => {
    if (dedupe.has(`${userId}|${key}`)) return;
    dedupe.add(`${userId}|${key}`);
    notify(run, userId, type, title, message, link, new Date(when.getTime() + int(2, 40) * 60_000), key);
  };
  let systemNotes = 0;
  for (const [k, present] of inOn) {
    const day = D(k);
    const year = day.getUTCFullYear();
    for (const pr of profiles) {
      const c = run.byId.get(pr.userId);
      if (!c || !employedOn(c, day)) continue;
      if (pr.dateOfBirth && pr.dateOfBirth.getUTCMonth() === day.getUTCMonth() && pr.dateOfBirth.getUTCDate() === day.getUTCDate()) {
        for (const [userId, when] of present) {
          systemNote(userId, "BIRTHDAY_TODAY", userId === c.id ? "Happy birthday!" : `It's ${c.name}'s birthday`, userId === c.id ? "From everyone at the company." : pr.designation, `/people/${c.id}`, when, `birthday:${c.id}:${year}`);
          systemNotes += 1;
        }
      }
      const years = pr.joinedOn ? year - pr.joinedOn.getUTCFullYear() : 0;
      if (pr.joinedOn && years >= 1 && pr.joinedOn.getUTCMonth() === day.getUTCMonth() && pr.joinedOn.getUTCDate() === day.getUTCDate()) {
        for (const [userId, when] of present) {
          if (userId === c.id) continue;
          systemNote(userId, "WORK_ANNIVERSARY", `${c.name} — ${years} year${years === 1 ? "" : "s"} today`, pr.designation, `/people/${c.id}`, when, `anniversary:${c.id}:${year}`);
          systemNotes += 1;
        }
      }
    }
    const holiday = run.holidays.find((h) => !h.optional && h.date >= day && h.date <= addDays(day, 3));
    if (holiday) {
      const daysTo = Math.round((holiday.date.getTime() - day.getTime()) / DAY);
      for (const [userId, when] of present) {
        systemNote(userId, "HOLIDAY_UPCOMING", daysTo === 0 ? `${holiday.name} — the office is closed today` : `${holiday.name} in ${daysTo} day${daysTo === 1 ? "" : "s"}`, toKey(holiday.date), "/people/holidays", when, `holiday:${holiday.id}`);
        systemNotes += 1;
      }
    }
  }
  for (const t of await db.task.findMany({ where: { assignedToUserId: { in: ids }, dueDate: { gte: START_D, lt: TODAY_D } }, select: { id: true, title: true, dueDate: true, done: true, doneAt: true, assignedToUserId: true } })) {
    const due = indiaClock.calendarDate(t.dueDate!);
    const dueIn = inOn.get(toKey(due))?.get(t.assignedToUserId!);
    if (dueIn && (!t.doneAt || t.doneAt > dueIn)) systemNote(t.assignedToUserId!, "TASK_DUE", "Task due today", t.title, "/tasks", dueIn, `task-due:${t.id}`);
    for (let d = addDays(due, 1); d < TODAY_D && d <= addDays(due, 10); d = addDays(d, 1)) {
      const seen = inOn.get(toKey(d))?.get(t.assignedToUserId!);
      if (!seen) continue;
      if (!t.doneAt || t.doneAt > seen) systemNote(t.assignedToUserId!, "TASK_OVERDUE", "Task overdue", t.title, "/tasks", seen, `task-overdue:${t.id}`);
      break;
    }
  }

  // ── Things removed along the way — the DELETE rows the actions leave ───────────────────────
  const removedOn = (lo: number, hi: number) => at(workingOnOrBefore(addDays(TODAY_D, -int(lo, hi))), int(11, 17), int(0, 59));
  const gone = () => randomUUID().replaceAll("-", "").slice(0, 25);
  for (const p of some(people.filter((x) => x.active), 3)) audit(run, run.hrExec.id, "DELETE", "EmployeeDocument", gone(), `Removed ${p.first} — Aadhaar (duplicate upload).pdf`, removedOn(10, 200));
  audit(run, run.hr.id, "DELETE", "HelpLink", gone(), "Help link removed: Old leave policy (2025)", removedOn(150, 200));
  audit(run, run.hr.id, "DELETE", "Holiday", gone(), "Diwali (Bhai Dooj) removed from the calendar", removedOn(250, 300));
  audit(run, run.hr.id, "DELETE", "Survey", gone(), "Canteen menu poll", removedOn(40, 80));
  for (let i = 0; i < 2; i++) audit(run, run.hrExec.id, "DELETE", "EmploymentHistory", gone(), `Removed previous employment at ${pick(["Infotech Solutions", "Globe Systems", "Prime Retail"])}`, removedOn(20, 300));

  // ── Permission changes that agree with what people hold ────────────────────────────────────
  const changes: Prisma.PermissionChangeCreateManyInput[] = [];
  const change = (row: Prisma.PermissionChangeCreateManyInput, critical: boolean) => {
    changes.push(row);
    log2(run.director, { kind: "SECURITY_POLICY_CHANGED", severity: "CRITICAL", summary: row.detail ?? row.changeKind.toLowerCase().replaceAll("_", " "), entityType: row.subjectType === "USER" ? "User" : "Role", entityId: row.subjectUserId ?? row.subjectRole ?? "", metadata: { changeKind: row.changeKind, permission: row.permission ?? null, from: row.fromAllowed ?? null, to: row.toAllowed ?? null }, createdAt: row.createdAt as Date });
    if (critical) for (const a of people.filter((x) => x.role === "ADMIN" && x.active)) notify(run, a.id, "SECURITY_ALERT", "A critical permission was changed", row.detail ?? `${row.changeKind} on ${row.permission ?? "an account"}`, "/settings/access", row.createdAt as Date);
  };
  const actor = run.director;
  // The individual exceptions somebody wrote a reason for.
  for (const o of await db.userPermission.findMany({ where: { userId: { in: ids }, reason: { not: null } } })) {
    const p = run.byId.get(o.userId);
    const def = getPermissionDefinition(o.permission);
    if (!p || !def || p.id === actor.id) continue;
    change({ actorUserId: actor.id, subjectType: "USER", subjectUserId: p.id, permission: o.permission, fromAllowed: null, toAllowed: o.allowed, changeKind: o.allowed ? "GRANT" : "REVOKE", detail: `${def.label} ${o.allowed ? "granted to" : "denied to"} ${p.name}${o.reason ? ` — ${o.reason}` : ""}`, createdAt: at(workingOnOrAfter(addDays(maxDate(p.joinedOn, START_D), int(5, 40))), 12, int(0, 59)) }, def.tier === "critical");
  }
  // Reception cover for a fortnight: granted, then handed back.
  const cover = people.find((p) => p.title === "HR Executive" && p.active);
  const visitorsDef = getPermissionDefinition("visitors.manage");
  if (cover && visitorsDef) {
    const from = workingOnOrBefore(addDays(TODAY_D, -int(70, 100)));
    change({ actorUserId: actor.id, subjectType: "USER", subjectUserId: cover.id, permission: "visitors.manage", fromAllowed: null, toAllowed: true, changeKind: "GRANT", detail: `${visitorsDef.label} granted to ${cover.name} — Covering reception while the office admin is on leave`, createdAt: at(from, 10, 5) }, visitorsDef.tier === "critical");
    change({ actorUserId: actor.id, subjectType: "USER", subjectUserId: cover.id, permission: "visitors.manage", changeKind: "RESET_TO_DEFAULT", detail: `visitors.manage for ${cover.name} returned to their role default`, createdAt: at(addDays(from, 14), 10, 40) }, false);
  }
  // No exports while serving notice — a deny that is still in force.
  const leaving = people.find((p) => p.exitType === "RESIGNED" && p.active);
  if (leaving) {
    const held = await db.userPermission.findFirst({ where: { userId: leaving.id, allowed: true, permission: { in: ["data.exportCrm", "companies.viewAll", "documents.send", "marketing.viewAll", "targets.viewAll"] } } });
    const key = held?.permission ?? "data.exportCrm";
    const def = getPermissionDefinition(key);
    if (def) {
      const reason = "Serving notice — nothing leaves the building";
      await db.userPermission.upsert({ where: { user_permission: { userId: leaving.id, permission: key } }, create: { userId: leaving.id, permission: key, allowed: false, reason }, update: { allowed: false, reason } });
      change({ actorUserId: actor.id, subjectType: "USER", subjectUserId: leaving.id, permission: key, fromAllowed: held ? true : null, toAllowed: false, changeKind: "REVOKE", detail: `${def.label} denied to ${leaving.name} — ${reason}`, createdAt: at(workingOnOrBefore(addDays(TODAY_D, -int(2, 6))), 11, 20) }, def.tier === "critical");
    }
  }
  // A role made for seasonal help, renamed, then removed once nobody held it.
  const tempKey = "SEASONAL_STAFF";
  const roleDay = workingOnOrBefore(addDays(TODAY_D, -int(150, 200)));
  change({ actorUserId: actor.id, subjectType: "ROLE", subjectRole: tempKey, changeKind: "ROLE_CREATED", detail: `${actor.name} created the role "Temp staff" (${tempKey}), holding no permissions yet`, createdAt: at(roleDay, 15, 0) }, false);
  change({ actorUserId: actor.id, subjectType: "ROLE", subjectRole: tempKey, changeKind: "ROLE_RENAMED", detail: `${actor.name} renamed "Temp staff" to "Seasonal staff"`, createdAt: at(addDays(roleDay, 1), 11, 0) }, false);
  change({ actorUserId: actor.id, subjectType: "ROLE", subjectRole: tempKey, changeKind: "ROLE_DELETED", detail: `${actor.name} deleted the role "Seasonal staff" (${tempKey}), which nobody held`, createdAt: at(workingOnOrAfter(addDays(roleDay, 60)), 16, 30) }, false);
  await db.permissionChange.createMany({ data: changes });
  await inChunks(activity, 1000, (c) => db.activityLog.createMany({ data: c }));

  // ── The audit trail of the work the demo wrote without one ──────────────────────────────────
  const backfill = await auditTheYearsWork(run);
  const t = await flushTrail(run);
  log("Activity trails", `${signIns.length} sign-ins on ${devices} devices, ${daily.length} days of activity, ${activity.length} activity-log lines, ${changes.length} permission changes, ${systemNotes} system notices`);
  log("Audit trail", `${backfill} rows for the year's records, ${t.audits} more here; ${t.notes} notifications`);
}

/** CREATE rows for what the demo's people made, exactly as each action labels them. */
async function auditTheYearsWork(run: Run): Promise<number> {
  const { db, people } = run;
  const ids = people.map((p) => p.id);
  const mine = (id: string | null | undefined): id is string => !!id && run.byId.has(id);
  const rows: Prisma.AuditLogCreateManyInput[] = [];
  // A record another seed already wrote its own trail for keeps that one.
  const traced = new Set((await db.auditLog.findMany({ where: { action: "CREATE" }, select: { entityType: true, entityId: true } })).map((a) => `${a.entityType}:${a.entityId}`));
  const add = (userId: string | null | undefined, action: "CREATE" | "UPDATE", entityType: string, entityId: string, entityLabel: string, createdAt: Date) => {
    if (action === "CREATE" && traced.has(`${entityType}:${entityId}`)) return;
    if (mine(userId) && createdAt >= at(START_D, 0) && createdAt <= TODAY) rows.push({ userId, action, entityType, entityId, entityLabel, createdAt });
  };
  for (const c of await db.company.findMany({ where: { createdById: { in: ids } }, select: { id: true, name: true, createdById: true, createdAt: true } })) add(c.createdById, "CREATE", "Company", c.id, c.name, c.createdAt);
  for (const c of await db.contact.findMany({ where: { createdByUserId: { in: ids } }, select: { id: true, name: true, createdByUserId: true, createdAt: true } })) add(c.createdByUserId, "CREATE", "Contact", c.id, c.name, c.createdAt);
  for (const l of await db.lead.findMany({ where: { createdByUserId: { in: ids } }, select: { id: true, title: true, createdByUserId: true, createdAt: true } })) add(l.createdByUserId, "CREATE", "Lead", l.id, l.title, l.createdAt);
  for (const a of await db.activity.findMany({ where: { type: "STAGE_CHANGE", userId: { in: ids } }, select: { userId: true, occurredAt: true, lead: { select: { id: true, title: true } } } })) add(a.userId, "UPDATE", "Lead", a.lead.id, a.lead.title, a.occurredAt);
  for (const t of await db.task.findMany({ where: { createdByUserId: { in: ids }, hrStage: null }, select: { id: true, title: true, createdByUserId: true, createdAt: true } })) add(t.createdByUserId, "CREATE", "Task", t.id, t.title, t.createdAt);
  for (const t of await db.ticket.findMany({ where: { createdByUserId: { in: ids } }, select: { id: true, ticketSeq: true, title: true, createdByUserId: true, createdAt: true } })) add(t.createdByUserId, "CREATE", "Ticket", t.id, `${formatTicketId(t.ticketSeq)} — ${t.title}`, t.createdAt);
  for (const d of await db.tradeDocument.findMany({ where: { createdById: { in: ids } }, select: { id: true, docType: true, createdById: true, createdAt: true, company: { select: { name: true } } } })) add(d.createdById, "CREATE", "TradeDocument", d.id, `${tradeDocumentLabels[d.docType]} for ${d.company?.name ?? "a company"}`, d.createdAt);
  for (const pay of await db.payment.findMany({ where: { recordedByUserId: { in: ids } }, select: { id: true, amount: true, recordedByUserId: true, createdAt: true, company: { select: { name: true } } } })) add(pay.recordedByUserId, "CREATE", "Payment", pay.id, `Payment of ₹${Number(pay.amount)} — ${pay.company.name}`, pay.createdAt);
  for (const o of await db.companyProduct.findMany({ where: { addedByUserId: { in: ids } }, select: { id: true, addedByUserId: true, createdAt: true, company: { select: { name: true } } } })) add(o.addedByUserId, "CREATE", "Order", o.id, `Order for ${o.company.name}`, o.createdAt);
  for (const c of await db.callLog.findMany({ where: { userId: { in: ids } }, select: { id: true, userId: true, outcome: true, createdAt: true, company: { select: { name: true } } } })) add(c.userId, "CREATE", "CallLog", c.id, `Call to ${c.company?.name ?? "a company"} — ${String(c.outcome).replaceAll("_", " ").toLowerCase()}`, c.createdAt);
  for (const v of await db.visit.findMany({ where: { userId: { in: ids } }, select: { id: true, visitSeq: true, userId: true, createdAt: true, company: { select: { name: true } } } })) add(v.userId, "CREATE", "Visit", v.id, `${formatVisitId(v.visitSeq)} — ${v.company?.name ?? "a company"}`, v.createdAt);
  await inChunks(rows, 2000, (c) => db.auditLog.createMany({ data: c }));
  return rows.length;
}

// ─── Wins ────────────────────────────────────────────────────────────────────────────────────────

/** `activityCounts` (src/lib/performance/announce.ts), on this seed's client. */
async function activityCountsFor(db: PrismaClient, f: Fortnight): Promise<Map<string, ActivityCounts>> {
  const within = { gte: f.from, lt: f.to };
  const [audits, calls, visits, tickets, won, active] = await Promise.all([
    db.auditLog.findMany({ where: { createdAt: within, action: { in: ["CREATE", "UPDATE"] }, entityType: { notIn: ["CallLog", "Visit"] }, impersonatedByUserId: null }, select: { userId: true, action: true, entityType: true, entityId: true, createdAt: true } }),
    db.callLog.groupBy({ by: ["userId"], where: { startedAt: within }, _count: { _all: true } }),
    db.visit.findMany({ where: { status: "COMPLETED", OR: [{ checkOutAt: within }, { checkOutAt: null, scheduledFor: within }] }, select: { userId: true } }),
    db.ticket.findMany({ where: { assignedToUserId: { not: null }, resolvedAt: within }, select: { assignedToUserId: true, priority: true, createdAt: true, resolvedAt: true } }),
    db.activity.findMany({ where: { type: "STAGE_CHANGE", notes: { contains: " to WON" }, occurredAt: within }, select: { leadId: true, userId: true, lead: { select: { status: true, ownerUserId: true } } } }),
    db.userDailyActivity.groupBy({ by: ["userId"], where: { date: { gte: f.firstDay, lte: f.lastDay } }, _sum: { activeSeconds: true } }),
  ]);
  const counts = new Map<string, ActivityCounts>();
  const of = (userId: string) => counts.get(userId) ?? (counts.set(userId, { ...NO_ACTIVITY }), counts.get(userId)!);
  const edits = new Set<string>();
  for (const a of audits) {
    if (a.action === "CREATE") of(a.userId).created += 1;
    else {
      const key = `${a.userId}|${a.entityType}|${a.entityId}|${indiaClock.dateKey(a.createdAt)}`;
      if (edits.has(key)) continue;
      edits.add(key);
      of(a.userId).edited += 1;
    }
  }
  for (const c of calls) of(c.userId).calls += c._count._all;
  for (const v of visits) of(v.userId).visits += 1;
  for (const t of tickets) {
    const c = of(t.assignedToUserId!);
    c.ticketsResolved += 1;
    if (t.resolvedAt!.getTime() <= t.createdAt.getTime() + SLA_HOURS[t.priority] * 3_600_000) c.ticketsInSla += 1;
  }
  const deals = new Map<string, string>();
  for (const w of won) {
    if (w.lead.status !== "WON" || deals.has(w.leadId)) continue;
    deals.set(w.leadId, w.lead.ownerUserId ?? w.userId);
  }
  for (const owner of deals.values()) of(owner).dealsWon += 1;
  for (const a of active) of(a.userId).activeSeconds += a._sum.activeSeconds ?? 0;
  return counts;
}

const MONTH_LONG = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

/**
 * The wins add-on's year, the way its own detectors and announcers would have written it as the year
 * went: the standing prizes, every fortnight's Most Active ranked by the app's own scoring over the
 * work the year actually holds (`rank`, `areaLeader`), every month's top sellers, each period's prizes
 * announced as it opened, the deals, first orders and targets celebrated as they happened — and the
 * hand-written occasions, of every kind, for every audience, with who has already dismissed what.
 */
async function wins(run: Run) {
  const { db, people } = run;
  // The demo's own first prize marks its wins as written. Not "any award": a workspace that has been
  // used has the app's own, and the demo's year goes beside them.
  if (await db.prize.findFirst({ where: { name: "Amazon voucher — ₹5,000", period: "", updatedById: { in: people.map((p) => p.id) } }, select: { id: true } })) {
    log("Wins", "already written — left as they are");
    return;
  }
  // Fortnights the workspace has already awarded, and periods it has already announced: kept as they are.
  const awardedAlready = new Set((await db.activityAward.findMany({ select: { period: true } })).map((a) => a.period));
  const announcedAlready = new Set((await db.prizeAnnouncement.findMany({ where: { autoKey: { not: null } }, select: { autoKey: true } })).map((a) => a.autoKey!));
  const celebrations: Prisma.CelebrationCreateManyInput[] = [];
  const keys = new Set((await db.celebration.findMany({ where: { occasionKey: { not: null } }, select: { occasionKey: true } })).map((c) => c.occasionKey!));
  const celebrate = (row: Prisma.CelebrationCreateManyInput) => {
    if (row.occasionKey && keys.has(row.occasionKey)) return;
    if (row.occasionKey) keys.add(row.occasionKey);
    celebrations.push({ id: randomUUID(), ...row });
  };
  const hereAt = (when: Date) => people.filter((p) => p.joinedOn <= when && (!p.exitedOn || p.exitedOn >= dateOnly(when)));

  // ── Prizes: the standing ones, and one planned for a special month ──────────────────────────
  const PRIZES: [race: "MOST_ACTIVE" | "TOP_SELLERS", slot: Slot, name: string, note: string | null][] = [
    ["MOST_ACTIVE", "1", "Amazon voucher — ₹5,000", "Handed over at the Monday huddle."],
    ["MOST_ACTIVE", "2", "Dinner for two", null],
    ["MOST_ACTIVE", "3", "Movie tickets for two", null],
    ["MOST_ACTIVE", "sales", "Sales star trophy", "Kept on your desk until the next fortnight."],
    ["MOST_ACTIVE", "support", "Support hero mug", null],
    ["TOP_SELLERS", "1", "Weekend getaway voucher", "Two nights, anywhere in the partner hotel list."],
    ["TOP_SELLERS", "2", "Noise-cancelling headphones", null],
    ["TOP_SELLERS", "3", "Amazon voucher — ₹3,000", null],
  ];
  const prizeAt = at(workingOnOrAfter(addDays(START_D, 8)), 12, 0);
  for (const [race, slot, name, note] of PRIZES) {
    // A prize somebody has already set for this place stays theirs.
    if (await db.prize.findUnique({ where: { race_period_slot: { race, period: "", slot } }, select: { id: true } })) continue;
    await db.prize.create({ data: { race, period: "", slot, name, note, updatedById: run.hr.id, updatedAt: prizeAt } });
    audit(run, run.hr.id, "CREATE", "Prize", `${race}:${slot}`, `${slotLabel(race, slot)} prize: ${name}`, prizeAt);
  }
  const nextMonth = new Date(Date.UTC(TODAY_D.getUTCFullYear(), TODAY_D.getUTCMonth() + 1, 1));
  const plannedKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  const planned = periodByKey("TOP_SELLERS", plannedKey, indiaClock);
  if (planned && !(await db.prize.findUnique({ where: { race_period_slot: { race: "TOP_SELLERS", period: plannedKey, slot: "1" } }, select: { id: true } }))) {
    await db.prize.create({ data: { race: "TOP_SELLERS", period: plannedKey, slot: "1", name: "Gold coin — 5 grams", note: "The festival-month special.", updatedById: run.hr.id } });
    audit(run, run.hr.id, "CREATE", "Prize", `TOP_SELLERS:${plannedKey}:1`, `${slotLabel("TOP_SELLERS", "1")} prize, ${planned.label}: Gold coin — 5 grams`, new Date(TODAY.getTime() - 26 * 3_600_000));
  }
  const prizeRows = await db.prize.findMany();

  const announcements: { race: "MOST_ACTIVE" | "TOP_SELLERS"; key: string; label: string; at: Date }[] = [];
  const winnerRows: Prisma.PrizeWinnerCreateManyInput[] = [];

  // ── Most Active, every fortnight that has closed ────────────────────────────────────────────
  const fortnights: Fortnight[] = [];
  for (let d = new Date(Date.UTC(START_D.getUTCFullYear(), START_D.getUTCMonth(), START_D.getUTCDate() > 15 ? 16 : 1)); ; ) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCDate() > 15 ? "B" : "A"}`;
    const f = fortnightByKey(key, indiaClock);
    if (!f) break;
    if (f.from >= at(START_D, 0) && f.to <= TODAY) fortnights.push(f);
    if (f.to > TODAY) {
      announcements.push({ race: "MOST_ACTIVE", key: f.key, label: f.label, at: at(f.firstDay, 9, int(0, 20)) });
      break;
    }
    d = f.lastDay.getUTCDate() === 15 ? new Date(Date.UTC(f.lastDay.getUTCFullYear(), f.lastDay.getUTCMonth(), 16)) : new Date(Date.UTC(f.lastDay.getUTCFullYear(), f.lastDay.getUTCMonth() + 1, 1));
  }
  let awards = 0;
  // The award was tried quietly first — told to the managers, then to the winners alone — before it
  // went to everybody. The settings say EVERYONE today; each award keeps the audience it went out to.
  const managersOnly = new Set(people.filter((p) => p.isManager || p.role === "ADMIN" || p.role === "MANAGEMENT").map((p) => p.id));
  for (const f of fortnights) {
    const announcedAt = at(addDays(f.lastDay, 1), 9, int(0, 40));
    if (announcedAt > TODAY || awardedAlready.has(f.key)) continue;
    const audience = awards < 2 ? "MANAGERS" : awards < 4 ? "WINNERS" : "EVERYONE";
    const counts = await activityCountsFor(db, f);
    const here = hereAt(announcedAt);
    const standings = rank(here.filter((p) => counts.has(p.id)).map((p) => ({ userId: p.id, name: p.name, counts: counts.get(p.id)! })));
    const named = standings.slice(0, 3);
    const salesLeader = areaLeader(standings, "sales");
    const supportLeader = areaLeader(standings, "support");
    await db.activityAward.create({
      data: { period: f.key, label: f.label, from: f.from, to: f.to, overall: { named: named.length, ranking: standings.slice(0, 10) } as unknown as Prisma.InputJsonValue, areas: { sales: salesLeader, support: supportLeader } as unknown as Prisma.InputJsonValue, audience, announcedAt },
    });
    awards += 1;
    announcements.push({ race: "MOST_ACTIVE", key: f.key, label: f.label, at: at(f.firstDay, 9, int(0, 20)) });
    if (named.length === 0) continue;
    const prizes = prizesFor("MOST_ACTIVE", f.key, prizeRows);
    const names = Object.fromEntries([...prizes].map(([slot, p]) => [slot, p.name]));
    const entries = named.map(entryOf);
    const sales = salesLeader ? entryOf(salesLeader) : null;
    const support = supportLeader ? entryOf(supportLeader) : null;
    // winnersOf: the named places, and the area leaders folded in.
    const winners = new Map<string, { entry: ReturnType<typeof entryOf>; place: number | null; ledSales: boolean; ledSupport: boolean }>();
    entries.forEach((entry, i) => winners.set(entry.userId, { entry, place: i + 1, ledSales: false, ledSupport: false }));
    for (const [leader, area] of [[sales, "ledSales"], [support, "ledSupport"]] as const) {
      if (!leader) continue;
      const w = winners.get(leader.userId) ?? { entry: leader, place: null, ledSales: false, ledSupport: false };
      w[area] = true;
      winners.set(leader.userId, w);
    }
    const handed = announcedAt < new Date(TODAY.getTime() - 10 * DAY);
    const slotRows = [
      ...entries.map((e, i) => ({ slot: String(i + 1), userId: e.userId, score: e.points })),
      ...(sales ? [{ slot: "sales", userId: sales.userId, score: sales.sales }] : []),
      ...(support ? [{ slot: "support", userId: support.userId, score: support.support }] : []),
    ];
    for (const w of slotRows) {
      const prize = prizes.get(w.slot as Slot);
      const handedAt = handed && prize ? at(workingOnOrAfter(addDays(announcedAt, int(1, 5))), 11, 0) : null;
      winnerRows.push({ race: "MOST_ACTIVE", period: f.key, periodLabel: f.label, slot: w.slot, userId: w.userId, score: dec(w.score), prizeName: prize?.name ?? null, prizeNote: prize?.note ?? null, prizeImage: prize?.imageDataUrl ?? null, audience, announcedAt, handedOverAt: handedAt, handedOverById: handedAt ? run.hr.id : null });
      if (handedAt) audit(run, run.hr.id, "UPDATE", "PrizeWinner", `${f.key}:${w.slot}`, `${prize?.name ?? "Prize"}, ${f.label}: handed over`, handedAt);
    }
    const short = `${f.firstDay.getUTCDate()}–${f.lastDay.getUTCDate()} ${new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short" }).format(f.lastDay)}`;
    const theirPrizes = (w: { place: number | null; ledSales: boolean; ledSupport: boolean }) =>
      [...(w.place && w.place <= 3 ? [String(w.place)] : []), ...(w.ledSales ? ["sales"] : []), ...(w.ledSupport ? ["support"] : [])].flatMap((s) => (prizes.get(s as Slot) ? [prizes.get(s as Slot)!] : []));
    // tell(): winners hear it personally unless only managers are told; then everybody, or the managers.
    if (audience !== "MANAGERS") {
      for (const w of winners.values()) {
        const copy = winnerCopy({ label: short, ...w, prizes: theirPrizes(w).map((p) => p.name) });
        notify(run, w.entry.userId, "ACTIVITY_AWARD", copy.title, copy.message, "/wins/most-active", announcedAt);
      }
    }
    if (audience !== "WINNERS") {
      const everybody = announcementCopy({ label: short, winners: entries, sales, support, prizes: names });
      for (const p of here) {
        if (audience === "EVERYONE" && winners.has(p.id)) continue;
        if (audience === "MANAGERS" && !managersOnly.has(p.id)) continue;
        notify(run, p.id, "ACTIVITY_AWARD", everybody.title, everybody.message, "/wins/most-active", announcedAt);
      }
    }
    const today = indiaClock.calendarDate(announcedAt);
    const shown = { kind: "ACHIEVEMENT" as const, source: "MOST_ACTIVE" as const, startsOn: today, endsOn: addDays(today, 1), createdById: null, details: { period: f.key }, createdAt: announcedAt };
    if (audience === "EVERYONE") {
      celebrate({
        ...shown, audience: "EVERYONE", occasionKey: `active:${f.key}`,
        ...announcementCopy({ label: f.label, winners: entries, sales, support, prizes: names }),
        imageDataUrl: prizes.get("1")?.imageDataUrl ?? null, subjectUserId: entries[0]!.userId, splashFor: "EVERYONE",
      });
    } else if (audience === "WINNERS") {
      for (const w of winners.values()) {
        celebrate({
          ...shown, audience: "PERSON", occasionKey: `active:${f.key}:${w.entry.userId}`,
          ...winnerCopy({ label: f.label, ...w, prizes: theirPrizes(w).map((p) => p.name) }),
          imageDataUrl: theirPrizes(w).find((p) => p.imageDataUrl)?.imageDataUrl ?? null, subjectUserId: w.entry.userId, splashFor: "SUBJECT",
        });
      }
    }
  }

  // ── Top sellers, every month that has closed ────────────────────────────────────────────────
  let months = 0;
  for (let d = new Date(Date.UTC(START_D.getUTCFullYear(), START_D.getUTCMonth(), 1)); d <= TODAY_D; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const period = periodByKey("TOP_SELLERS", monthKey, indiaClock);
    if (!period) continue;
    announcements.push({ race: "TOP_SELLERS", key: monthKey, label: period.label, at: at(dateOnly(indiaClock.calendarDate(period.from)), 9, int(0, 20)) });
    if (period.to > TODAY) continue;
    const announceDay = workingOnOrAfter(indiaClock.calendarDate(period.to));
    const announcedAt = at(announceDay, 10, int(0, 59));
    if (announcedAt > TODAY) continue;
    const orders = await db.companyProduct.findMany({ where: { bookedAt: { gte: period.from, lt: period.to }, orderStatus: { notIn: ["PENDING_APPROVAL", "CANCELLED"] } }, select: { addedByUserId: true, quantity: true, unitPrice: true } });
    const totals = new Map<string, number>();
    for (const o of orders) totals.set(o.addedByUserId, (totals.get(o.addedByUserId) ?? 0) + num(o.unitPrice) * o.quantity);
    const here = new Set(hereAt(announcedAt).map((p) => p.id));
    const ranking = [...totals].filter(([u, v]) => here.has(u) && v > 0).map(([userId, v]) => ({ userId, name: run.byId.get(userId)!.name, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value).slice(0, 3);
    if (ranking.length === 0) continue;
    const monthLabelText = MONTH_LONG.format(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15)));
    const prizes = prizesFor("TOP_SELLERS", monthKey, prizeRows);
    const prizeOf = (i: number) => prizes.get(String(i + 1) as Slot) ?? null;
    celebrate({
      kind: "ACHIEVEMENT", audience: "EVERYONE", source: "TOP_PERFORMER", occasionKey: `top:${monthKey}`,
      ...topPerformerCopy({ monthLabel: monthLabelText, ranking: ranking.map((r, i) => ({ ...r, prize: prizeOf(i)?.name ?? null })) }),
      subjectUserId: ranking[0]!.userId, splashFor: "EVERYONE", amount: dec(ranking[0]!.value), details: { month: monthKey, ranking } as unknown as Prisma.InputJsonValue,
      imageDataUrl: prizeOf(0)?.imageDataUrl ?? null, startsOn: announceDay, endsOn: addDays(announceDay, 2), createdById: null, createdAt: announcedAt,
    });
    const handed = announcedAt < new Date(TODAY.getTime() - 10 * DAY);
    for (const [i, r] of ranking.entries()) {
      const prize = prizeOf(i);
      const handedAt = handed && prize ? at(workingOnOrAfter(addDays(announcedAt, int(2, 6))), 12, 0) : null;
      winnerRows.push({ race: "TOP_SELLERS", period: monthKey, periodLabel: monthLabelText, slot: String(i + 1), userId: r.userId, score: dec(r.value), prizeName: prize?.name ?? null, prizeNote: prize?.note ?? null, prizeImage: prize?.imageDataUrl ?? null, audience: "EVERYONE", announcedAt, handedOverAt: handedAt, handedOverById: handedAt ? run.hr.id : null });
      const note = topSellerNote({ monthLabel: monthLabelText, place: i + 1, booked: inrSpoken(r.value), prize: prize?.name ?? null });
      notify(run, r.userId, "ACTIVITY_AWARD", note.title, note.message, "/wins/hall-of-fame", announcedAt);
    }
    months += 1;
  }
  await db.prizeWinner.createMany({ data: winnerRows, skipDuplicates: true });

  // ── Each period's prizes, announced as it opened (and once by hand) ─────────────────────────
  let announced = 0;
  for (const a of announcements) {
    if (a.at > TODAY || a.at < at(START_D, 9) || a.at < prizeAt) continue;
    const prizes = prizesFor(a.race, a.key, prizeRows);
    if (prizes.size === 0 || announcedAlready.has(`auto:${a.race}:${a.key}`)) continue;
    const row = await db.prizeAnnouncement.create({ data: { race: a.race, period: a.key, autoKey: `auto:${a.race}:${a.key}`, announcedAt: a.at } });
    const copy = upForGrabsCopy(a.race, a.label, prizes);
    for (const p of hereAt(a.at)) notify(run, p.id, "ACTIVITY_AWARD", copy.title, copy.message, a.race === "TOP_SELLERS" ? "/wins" : "/wins/most-active", a.at);
    const day = indiaClock.calendarDate(a.at);
    celebrate({ kind: "ACHIEVEMENT", audience: "EVERYONE", source: "PRIZES", occasionKey: `prizes:${row.id}`, ...copy, imageDataUrl: prizes.get("1")?.imageDataUrl ?? null, splashFor: "EVERYONE", subjectUserId: null, startsOn: day, endsOn: addDays(day, 1), createdById: null, details: { race: a.race, period: a.key }, createdAt: a.at });
    announced += 1;
  }
  const lastMonthly = announcements.filter((a) => a.race === "TOP_SELLERS" && a.at <= TODAY).at(-2);
  if (lastMonthly) {
    const when = new Date(lastMonthly.at.getTime() + int(4, 9) * DAY);
    const row = await db.prizeAnnouncement.create({ data: { race: "TOP_SELLERS", period: lastMonthly.key, autoKey: null, announcedById: run.hr.id, announcedAt: when } });
    audit(run, run.hr.id, "CREATE", "PrizeAnnouncement", row.id, `Prizes announced: ${RACE_LABEL.TOP_SELLERS}, ${lastMonthly.label}`, when);
    announced += 1;
  }

  // ── Deals won, as they were won ─────────────────────────────────────────────────────────────
  // Won when the stage change says so (`stageChangedAt`, or the STAGE_CHANGE note the detector reads).
  // The demo's leads carry neither, so for those the win is dated a month after the lead was opened.
  const changes = await db.activity.findMany({ where: { type: "STAGE_CHANGE", notes: { contains: " to WON" } }, orderBy: { occurredAt: "asc" }, select: { leadId: true, occurredAt: true } });
  const wonLeads = await db.lead.findMany({
    where: { status: "WON", company: { tags: { has: "seed-demo" } } },
    select: { id: true, title: true, estimatedValue: true, stageChangedAt: true, createdAt: true, owner: { select: { id: true, name: true } }, company: { select: { name: true } }, documents: { where: { docType: "PROPOSAL", status: { notIn: ["CANCELLED", "REJECTED"] } }, orderBy: { issueDate: "desc" }, take: 1, select: { taxableValue: true, exchangeRate: true } } },
  });
  let deals = 0;
  for (const l of wonLeads) {
    const guess = new Date(l.createdAt.getTime() + int(20, 45) * DAY);
    const when = l.stageChangedAt ?? changes.find((c) => c.leadId === l.id)?.occurredAt ?? (guess < new Date(TODAY.getTime() - DAY) ? guess : new Date(l.createdAt.getTime() + rnd() * (TODAY.getTime() - DAY - l.createdAt.getTime())));
    if (when < at(START_D, 0) || when > TODAY || when < l.createdAt) continue;
    const proposal = l.documents[0];
    const fromProposal = proposal ? num(proposal.taxableValue) * (Number(proposal.exchangeRate) || 1) : 0;
    const value = fromProposal > 0 ? fromProposal : num(l.estimatedValue);
    if (value < 500000) continue;
    const day = indiaClock.calendarDate(when);
    celebrate({ kind: "ACHIEVEMENT", audience: "EVERYONE", source: "DEAL_WON", occasionKey: `deal:${l.id}`, ...dealWonCopy({ owner: l.owner?.name ?? null, company: l.company.name, deal: l.title, value }), subjectUserId: l.owner?.id ?? null, splashFor: "EVERYONE", amount: dec(value), details: { leadId: l.id }, startsOn: day, endsOn: addDays(day, 1), createdById: null, createdAt: new Date(when.getTime() + int(5, 90) * 60_000) });
    deals += 1;
  }

  // ── First orders from new customers ─────────────────────────────────────────────────────────
  const booked = await db.companyProduct.findMany({
    where: { orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] }, bookedAt: { not: null }, company: { relationshipType: { in: ["CLIENT", "RESELLER"] } } },
    orderBy: { bookedAt: "asc" },
    select: { companyId: true, quantity: true, unitPrice: true, bookedAt: true, accountsApprovedAt: true, addedBy: { select: { id: true, name: true } }, company: { select: { name: true } } },
  });
  const firstOf = new Map<string, (typeof booked)[number][]>();
  for (const o of booked) {
    const list = firstOf.get(o.companyId) ?? [];
    if (list.length === 0 || o.bookedAt!.getTime() - list[0]!.bookedAt!.getTime() < 2 * DAY) list.push(o);
    firstOf.set(o.companyId, list);
  }
  let firsts = 0;
  for (const [companyId, list] of firstOf) {
    const first = list[0]!;
    const when = maxDate(first.bookedAt!, first.accountsApprovedAt ?? first.bookedAt!);
    if (when < at(START_D, 0) || when > TODAY || !run.byId.has(first.addedBy.id)) continue;
    const value = list.reduce((t, o) => t + num(o.unitPrice) * o.quantity, 0);
    const day = indiaClock.calendarDate(when);
    celebrate({ kind: "ACHIEVEMENT", audience: "EVERYONE", source: "FIRST_ORDER", occasionKey: `first-order:${companyId}`, ...firstOrderCopy({ owner: first.addedBy.name, company: first.company.name, value }), subjectUserId: first.addedBy.id, splashFor: "SUBJECT", amount: dec(value), details: { companyId }, startsOn: day, endsOn: addDays(day, 1), createdById: null, createdAt: new Date(when.getTime() + int(10, 120) * 60_000) });
    firsts += 1;
  }

  // ── Targets reached ─────────────────────────────────────────────────────────────────────────
  let hits = 0;
  for (const t of await db.target.findMany({ where: { active: true, fromDate: { gte: START_D }, toDate: { lt: TODAY_D } }, include: { user: { select: { name: true } }, department: { select: { name: true } } } })) {
    const got = run.achieved.get(t.id) ?? (await run.ws(async () => measure(db, t.metric, { from: t.fromDate, to: t.toDate, userIds: await subjectUserIds(db, { scope: t.scope, userId: t.userId, departmentId: t.departmentId }) })));
    const goal = num(t.value);
    if (goal <= 0 || got < goal) continue;
    const who = t.scope === "USER" ? (t.user?.name ?? "Somebody") : t.scope === "DEPARTMENT" ? `The ${t.department?.name ?? "team"} team` : "The company";
    const day = maxDate(t.fromDate, addDays(t.toDate, -int(0, 6)));
    celebrate({ kind: "ACHIEVEMENT", audience: "EVERYONE", source: "TARGET_HIT", occasionKey: `target:${t.id}`, ...targetHitCopy({ who, metric: t.metric, periodLabel: t.label, achieved: got, target: goal }), subjectUserId: t.scope === "USER" ? t.userId : null, splashFor: "EVERYONE", amount: dec(got), details: { targetId: t.id, metric: t.metric, target: goal, achieved: got }, startsOn: day, endsOn: addDays(day, 1), createdById: null, createdAt: at(day, int(10, 17), int(0, 59)) });
    hits += 1;
  }

  // ── The ones people wrote: every kind, every audience ───────────────────────────────────────
  const support = run.ctx.departments.get("Support") ?? null;
  const confirmed = people.find((p) => p.active && p.confirmedOn && p.confirmedOn >= addDays(TODAY_D, -20)) ?? people.find((p) => p.active && p.confirmedOn) ?? people[0]!;
  const newest = [...people].filter((p) => p.active).sort((a, b) => b.joinedOn.getTime() - a.joinedOn.getTime())[0]!;
  const MANUAL: { kind: "ACHIEVEMENT" | "FESTIVAL" | "MILESTONE" | "WELCOME" | "ANNOUNCEMENT"; audience: "EVERYONE" | "DEPARTMENT" | "PERSON"; title: string; message: string; accent: string; subject?: string | null; dept?: string | null; from: number; to: number; active?: boolean }[] = [
    { kind: "MILESTONE", audience: "EVERYONE", title: "One year today", message: "A year ago we opened the doors. Thank you, every one of you.", accent: "#3b82f6", from: 0, to: 1 },
    { kind: "ANNOUNCEMENT", audience: "EVERYONE", title: "Bengaluru office is open", message: "From Monday the Bengaluru team works out of Indiranagar. Visitors sign in on the new tablet.", accent: "#0ea5e9", from: -125, to: -120 },
    { kind: "ANNOUNCEMENT", audience: "EVERYONE", title: "Payslips move to the app", message: "From this month your payslip is on your own page — no more email attachments.", accent: "#64748b", from: -200, to: -197, active: false },
    { kind: "ACHIEVEMENT", audience: "DEPARTMENT", title: "Every ticket cleared", message: "Support closed the queue — not one ticket older than a day.", accent: "#06b6d4", dept: support, from: -40, to: -39 },
    { kind: "ACHIEVEMENT", audience: "PERSON", title: "Confirmed — congratulations", message: "Your probation is complete. The letter is on your file.", accent: "#10b981", subject: confirmed.id, from: -2, to: 3 },
    { kind: "WELCOME", audience: "EVERYONE", title: `Welcome, ${newest.first}`, message: `${newest.first} joins us as ${newest.title}. Say hello.`, accent: "#8b5cf6", subject: newest.id, from: Math.round((newest.joinedOn.getTime() - TODAY_D.getTime()) / DAY), to: Math.round((newest.joinedOn.getTime() - TODAY_D.getTime()) / DAY) + 2 },
    { kind: "FESTIVAL", audience: "EVERYONE", title: "Happy Holi", message: "Colours, sweets and a long weekend. Stay safe.", accent: "#ec4899", from: -205, to: -203 },
    { kind: "FESTIVAL", audience: "EVERYONE", title: "Happy Independence Day", message: "Flag hoisting at 9 in the lobby, then breakfast.", accent: "#f97316", from: -50, to: -49 },
  ];
  for (const m of MANUAL) {
    const startsOn = addDays(TODAY_D, m.from);
    if (startsOn < START_D) continue;
    const createdAt = at(workingOnOrBefore(addDays(startsOn, -1)), 16, int(0, 59));
    celebrate({ kind: m.kind, audience: m.audience, title: m.title, message: m.message, accent: m.accent, subjectUserId: m.subject ?? null, departmentId: m.audience === "DEPARTMENT" ? (m.dept ?? null) : null, startsOn, endsOn: addDays(TODAY_D, m.to), active: m.active ?? true, source: "MANUAL", splashFor: "EVERYONE", createdById: run.hr.id, createdAt: minDate(createdAt, new Date(TODAY.getTime() - 3_600_000)) });
  }
  await inChunks(celebrations, 500, (c) => db.celebration.createMany({ data: c }));
  for (const c of celebrations.filter((x) => x.source === "MANUAL")) {
    audit(run, run.hr.id, "CREATE", "Celebration", c.id!, c.title, c.createdAt as Date);
    if (c.active === false) audit(run, run.hr.id, "UPDATE", "Celebration", c.id!, `${c.title} — hidden`, new Date((c.createdAt as Date).getTime() + 3 * DAY));
  }

  // ── Who has already dismissed what ──────────────────────────────────────────────────────────
  const seen: Prisma.CelebrationSeenCreateManyInput[] = [];
  const recent = celebrations.filter((c) => (c.startsOn as Date) >= addDays(TODAY_D, -30) && c.active !== false);
  for (const c of recent) {
    const audience = c.audience === "PERSON" ? people.filter((p) => p.id === c.subjectUserId) : c.audience === "DEPARTMENT" ? people.filter((p) => p.deptId === c.departmentId) : hereAt(c.startsOn as Date);
    for (const p of audience) {
      if (!chance(0.6)) continue;
      const when = new Date(Math.min(TODAY.getTime() - 60_000, at(c.startsOn as Date, int(9, 12), int(0, 59)).getTime()));
      seen.push({ userId: p.id, occasionKey: celebrationKey(c.id!), seenAt: when });
    }
  }
  // The derived ones: today's birthday and work anniversary, and the holiday coming up.
  const year = TODAY_D.getUTCFullYear();
  const md = (d: Date) => `${d.getUTCMonth()}-${d.getUTCDate()}`;
  const profiles = await db.employeeProfile.findMany({ where: { userId: { in: people.filter((p) => p.active).map((p) => p.id) } }, select: { userId: true, dateOfBirth: true, joinedOn: true } });
  const occasions: string[] = [];
  for (const pr of profiles) {
    if (pr.dateOfBirth && md(pr.dateOfBirth) === md(TODAY_D)) occasions.push(birthdayKey(pr.userId, year));
    if (pr.joinedOn && md(pr.joinedOn) === md(TODAY_D) && pr.joinedOn.getUTCFullYear() < year) occasions.push(anniversaryKey(pr.userId, year));
  }
  const nextHoliday = run.holidays.find((h) => !h.optional && h.date > TODAY_D);
  if (nextHoliday) occasions.push(holidayKey(nextHoliday.id, nextHoliday.date.getUTCFullYear()));
  for (const key of occasions) {
    for (const p of some(people.filter((x) => x.active), 12)) seen.push({ userId: p.id, occasionKey: key, seenAt: new Date(TODAY.getTime() - int(5, 120) * 60_000) });
  }
  await inChunks(seen, 1000, (c) => db.celebrationSeen.createMany({ data: c, skipDuplicates: true }));

  const t = await flushTrail(run);
  const bySource = new Map<string, number>();
  for (const c of celebrations) bySource.set(c.source ?? "MANUAL", (bySource.get(c.source ?? "MANUAL") ?? 0) + 1);
  log("Wins", `${PRIZES.length + (planned ? 1 : 0)} prizes; ${awards} fortnights of Most Active and ${months} months of top sellers, ${winnerRows.length} winners; ${announced} prize announcements`);
  log("Celebrations", `${celebrations.length} — ${[...bySource].map(([s, n]) => `${n} ${s.toLowerCase().replaceAll("_", " ")}`).join(", ")} (${deals} deals, ${firsts} first orders, ${hits} targets); ${seen.length} dismissed; ${t.notes} notifications`);
}

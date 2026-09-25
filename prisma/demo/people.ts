import { PrismaClient } from "@prisma/client";
import type { Role } from "@/lib/roles";
import bcrypt from "bcryptjs";
import { ROLE_PRESETS } from "../../src/lib/authz/presets";
import {
  daysAhead,
  DEMO_EMAIL_DOMAIN,
  chance,
  daysAgo,
  int,
  log,
  personName,
  phone,
  pick,
  rnd,
  workEmail,
  HEADCOUNT,
} from "./shared";

/**
 * A hundred people who have been using this CRM for a year.
 *
 * ## The shape is the point
 *
 * Not a hundred identical SALES users. A system integrator this size has a shape — a big sales
 * floor, a calling team feeding it, a handful of people in accounts, two in purchase, a support
 * desk, and four or five running the place. Reports roll up to team leads, team leads to heads,
 * heads to the directors. That shape is what makes the app's own features legible: the org chart
 * has depth, `visits.viewAll` means something because there are people whose visits it covers, and
 * a manager's dashboard has a team on it.
 *
 * ## Permissions are granted the way they actually would be
 *
 * Through the role presets the application ships, not by inventing permission rows. That means the
 * demo exercises the real resolver, and the access screen shows profiles somebody would recognise
 * rather than a hundred bespoke permission sets. A few individual overrides are added on top,
 * because in a real company somebody always has one.
 */

type Seat = {
  dept: string;
  title: string;
  role: Role;
  /** Preset keys from src/lib/authz/presets.ts. */
  presets: string[];
  count: number;
  /**
   * Whether anybody reports to them.
   *
   * Stated rather than guessed from the title, because the obvious guess is wrong: an "Account
   * Manager" manages accounts, not people, and a regex looking for "Manager" quietly classified
   * twenty-eight individual contributors as managers — which emptied the list of salespeople every
   * other part of the seed draws from.
   */
  manages: boolean;
  /** Rough monthly gross, so payroll and incentives have something sane to work from. */
  pay: [min: number, max: number];
};

const DEPARTMENTS = [
  "Management",
  "Sales",
  "Inside Sales",
  "Presales & Solutions",
  "Support",
  "Accounts",
  "Purchase",
  "HR & Admin",
];

/**
 * The roster, at full size.
 *
 * Written for 100 and scaled to `HEADCOUNT` below. Sales is the biggest because this business
 * sells; Inside Sales is next because somebody has to find the people Sales talks to.
 */
const SEATS_AT_100: Seat[] = [
  { dept: "Management", title: "Director", role: "ADMIN", presets: [], manages: true, count: 2, pay: [250000, 320000] },
  { dept: "Management", title: "General Manager", role: "MANAGEMENT", presets: ["sales-manager", "operations-manager"], manages: true, count: 2, pay: [180000, 220000] },
  { dept: "Sales", title: "Head of Sales", role: "MANAGEMENT", presets: ["sales-manager"], manages: true, count: 1, pay: [160000, 190000] },
  { dept: "Sales", title: "Regional Sales Manager", role: "SALES", presets: ["sales-manager"], manages: true, count: 5, pay: [90000, 120000] },
  { dept: "Sales", title: "Account Manager", role: "SALES", presets: ["sales-executive"], manages: false, count: 22, pay: [45000, 75000] },
  { dept: "Sales", title: "Key Account Manager", role: "SALES", presets: ["sales-executive"], manages: false, count: 6, pay: [70000, 95000] },
  { dept: "Inside Sales", title: "Inside Sales Lead", role: "SALES", presets: ["sales-manager"], manages: true, count: 2, pay: [60000, 80000] },
  { dept: "Inside Sales", title: "Calling Executive", role: "CALLING", presets: ["calling-agent"], manages: false, count: 14, pay: [22000, 34000] },
  { dept: "Inside Sales", title: "Data Profiler", role: "PROFILE", presets: ["data-profiler"], manages: false, count: 6, pay: [20000, 30000] },
  { dept: "Presales & Solutions", title: "Presales Consultant", role: "SALES", presets: ["sales-executive"], manages: false, count: 5, pay: [65000, 95000] },
  { dept: "Support", title: "Support Lead", role: "SUPPORT", presets: ["support-lead", "project-manager"], manages: true, count: 2, pay: [65000, 85000] },
  { dept: "Support", title: "Support Engineer", role: "SUPPORT", presets: ["support-agent"], manages: false, count: 12, pay: [28000, 48000] },
  { dept: "Support", title: "Field Engineer", role: "SUPPORT", presets: ["support-agent"], manages: false, count: 6, pay: [26000, 42000] },
  { dept: "Accounts", title: "Finance Controller", role: "ACCOUNTS", presets: ["accounts-manager"], manages: true, count: 1, pay: [140000, 170000] },
  { dept: "Accounts", title: "Accounts Executive", role: "ACCOUNTS", presets: ["accounts-executive"], manages: false, count: 6, pay: [30000, 50000] },
  { dept: "Purchase", title: "Purchase Manager", role: "PURCHASE", presets: ["purchase-executive"], manages: true, count: 1, pay: [80000, 100000] },
  { dept: "Purchase", title: "Purchase Executive", role: "PURCHASE", presets: ["purchase-executive"], manages: false, count: 3, pay: [32000, 48000] },
  { dept: "HR & Admin", title: "HR Manager", role: "MANAGEMENT", presets: ["hr-manager"], manages: true, count: 1, pay: [90000, 110000] },
  { dept: "HR & Admin", title: "HR Executive", role: "MANAGEMENT", presets: ["hr-manager"], manages: false, count: 2, pay: [30000, 45000] },
  { dept: "HR & Admin", title: "Office Admin", role: "SUPPORT", presets: ["support-agent"], manages: false, count: 1, pay: [24000, 32000] },
];

/**
 * The roster at whatever size the company actually is.
 *
 * Scaled proportionally, with two rules that matter more than the arithmetic:
 *
 *   · **Every seat keeps at least one person.** Halving a roster by multiplication alone deletes
 *     the Finance Controller, the Purchase Manager and the HR Manager — the single-seat roles — and
 *     a CRM with nobody holding `accounts-manager` cannot demonstrate approvals, payments or
 *     anything else those presets gate. The point of this data is that every role is represented.
 *   · **The remainder lands on the largest seat.** Rounding twenty seats independently does not add
 *     up to the target, so the difference is taken out of (or added to) Account Managers, which is
 *     the one seat big enough to absorb it without distorting the shape.
 */
function rosterFor(headcount: number): Seat[] {
  const full = SEATS_AT_100.reduce((n, s) => n + s.count, 0);
  const scaled = SEATS_AT_100.map((s) => ({ ...s, count: Math.max(1, Math.round((s.count * headcount) / full)) }));

  const biggest = scaled.reduce((a, b) => (b.count > a.count ? b : a));
  const drift = scaled.reduce((n, s) => n + s.count, 0) - headcount;
  // Never below one, even if that means missing the target by a head or two.
  biggest.count = Math.max(1, biggest.count - drift);
  return scaled;
}

const SEATS: Seat[] = rosterFor(HEADCOUNT);

export type SeededPerson = {
  id: string;
  name: string;
  role: Role;
  dept: string;
  title: string;
  isManager: boolean;
};

export async function seedPeople(db: PrismaClient): Promise<{
  people: SeededPerson[];
  byDept: Map<string, SeededPerson[]>;
  departments: Map<string, string>;
  /** Somebody working out their notice, for the seeds that need one. Null if nobody qualified. */
  leaving: SeededPerson | null;
}> {
  const departments = new Map<string, string>();
  for (const name of DEPARTMENTS) {
    const row = await db.department.upsert({
      where: { name },
      create: { name, isSupportTeam: name === "Support" },
      update: {},
      select: { id: true },
    });
    departments.set(name, row.id);
  }
  log("Departments", `${departments.size}`);

  // One hash for all of them. Nobody signs in as a demo user in anger, and hashing a hundred
  // passwords at a real cost factor is thirty seconds of nothing.
  const passwordHash = await bcrypt.hash("demo-password-not-for-real-use", 10);

  const people: SeededPerson[] = [];
  let n = 0;

  for (const seat of SEATS) {
    for (let i = 0; i < seat.count; i++) {
      n += 1;
      const name = personName();
      // Joining dates spread over four years, so tenure, leave balances and work anniversaries all
      // have something to differ over.
      const joinedOn = daysAgo(int(30, 4 * 365));

      const user = await db.user.create({
        data: {
          name,
          email: workEmail(name, n),
          passwordHash,
          role: seat.role,
          active: true,
          departmentId: departments.get(seat.dept)!,
          phone: chance(0.8) ? phone() : null,
          employeeProfile: {
            create: {
              designation: seat.title,
              joinedOn,
              confirmedOn: joinedOn < daysAgo(180) ? new Date(joinedOn.getTime() + 180 * 86400000) : null,
              employmentType: "FULL_TIME",
              workLocation: "Head office",
              personalPhone: phone(),
            },
          },
        },
        select: { id: true },
      });

      people.push({
        id: user.id,
        name,
        role: seat.role,
        dept: seat.dept,
        title: seat.title,
        isManager: seat.manages,
      });
    }
  }

  // ── Reporting lines ───────────────────────────────────────────────────────────────────────────
  const byDept = new Map<string, SeededPerson[]>();
  for (const p of people) {
    const list = byDept.get(p.dept) ?? [];
    list.push(p);
    byDept.set(p.dept, list);
  }

  const directors = people.filter((p) => p.title === "Director");
  for (const [dept, members] of byDept) {
    const heads = members.filter((m) => /Head of|Director|Controller|HR Manager|Purchase Manager|General Manager/.test(m.title));
    const leads = members.filter((m) => m.isManager && !heads.includes(m));
    const rest = members.filter((m) => !heads.includes(m) && !leads.includes(m));

    // Heads report to a director; leads to a head (or a director if the department has none);
    // everybody else to a lead, spread round-robin so no one manager has forty reports.
    for (const head of heads) {
      if (head.title === "Director") continue;
      await db.user.update({ where: { id: head.id }, data: { managerId: pick(directors).id } });
    }
    const leadParent = heads[0] ?? directors[0]!;
    for (const lead of leads) {
      await db.user.update({ where: { id: lead.id }, data: { managerId: leadParent.id } });
    }
    const parents = leads.length > 0 ? leads : heads.length > 0 ? heads : directors;
    for (const [i, member] of rest.entries()) {
      await db.user.update({ where: { id: member.id }, data: { managerId: parents[i % parents.length]!.id } });
    }
    void dept;
  }
  log("Reporting lines", `${people.length} people, ${directors.length} directors at the top`);

  // ── Permissions, through the presets the app actually ships ──────────────────────────────────
  const presetByKey = new Map(ROLE_PRESETS.map((p) => [p.key, p]));
  let grants = 0;
  for (const [seatIndex, seat] of SEATS.entries()) {
    const keys = seat.presets.map((k) => presetByKey.get(k)).filter(Boolean);
    if (keys.length === 0) continue;
    const members = people.filter((p) => p.title === seat.title && p.dept === seat.dept);
    const permissions = [...new Set(keys.flatMap((p) => p!.permissions as string[]))];

    for (const member of members) {
      await db.userPermission.createMany({
        data: permissions.map((permission) => ({ userId: member.id, permission, allowed: true })),
        skipDuplicates: true,
      });
      grants += permissions.length;
    }
    void seatIndex;
  }

  /**
   * A handful of individual overrides.
   *
   * Every real company has them: somebody covering while a colleague is on leave, one person who
   * needs the vault because they hold the registrar login, a salesperson trusted with the whole
   * pipeline. They exist here so the access screen shows what an audit would actually find rather
   * than a tidy matrix nobody has ever touched.
   */
  const extras: [match: (p: SeededPerson) => boolean, permission: string, reason: string][] = [
    [(p) => p.title === "Finance Controller", "vault.viewAll", "Holds the banking and registrar logins"],
    [(p) => p.title === "Finance Controller", "vault.credentials", "Same"],
    [(p) => p.title === "Head of Sales", "projects.viewAll", "Sits in on every delivery review"],
    [(p) => p.title === "HR Manager", "engagement.readFeedback", "Runs the speak-up channel"],
    [(p) => p.title === "Support Lead", "visitors.manage", "Owns the reception tablet"],
    [(p) => p.title === "Key Account Manager", "companies.viewAll", "Covers the whole west region"],
  ];
  for (const [match, permission, reason] of extras) {
    for (const person of people.filter(match)) {
      await db.userPermission.upsert({
        where: { user_permission: { userId: person.id, permission } },
        create: { userId: person.id, permission, allowed: true, reason },
        update: { reason },
      });
      grants += 1;
    }
  }
  log("Permission grants", `${grants} across ${SEATS.filter((s) => s.presets.length).length} job profiles`);

  // ── A few people who have left ────────────────────────────────────────────────────────────────
  // Not everybody who ever worked here still does, and the handover screen is only interesting if
  // somebody has actually gone.
  const leavers = people.filter((p) => !p.isManager && rnd() < 0.05).slice(0, 4);
  for (const leaver of leavers) {
    const exitedOn = daysAgo(int(10, 200));
    await db.employeeProfile.update({
      where: { userId: leaver.id },
      data: { exitedOn, exitType: chance(0.7) ? "RESIGNED" : "CONTRACT_ENDED", exitReason: "Moved on" },
    });
    await db.user.update({ where: { id: leaver.id }, data: { active: false } });
  }
  log("Leavers", `${leavers.length} people exited, logins deactivated`);

  /**
   * And one person working out their notice.
   *
   * The demo had nobody in this state — everybody was either working or already gone — and it is
   * the state that most of offboarding is actually about. A handover happens during the notice
   * period, not after it: once the account is deactivated the person can no longer be asked what
   * any of it was for.
   *
   * Still active, and deliberately so. They can sign in, and their own page is where they find out
   * what has been taken off them and who has it.
   */
  const leaving = people.find((p) => !p.isManager && !leavers.includes(p));
  if (leaving) {
    await db.employeeProfile.update({
      where: { userId: leaving.id },
      data: {
        exitedOn: daysAhead(int(12, 26)),
        exitType: "RESIGNED",
        exitReason: "Resigned — serving notice",
      },
    });
    log("Serving notice", `${leaving.name} — still signed in, work being handed over`);
  }

  return { people: people.filter((p) => !leavers.includes(p)), byDept, departments, leaving: leaving ?? null };
}

export { SEATS, DEPARTMENTS, DEMO_EMAIL_DOMAIN };

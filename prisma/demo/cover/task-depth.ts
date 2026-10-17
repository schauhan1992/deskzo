import type { Prisma, PrismaClient, TaskPriority, TaskRepeat, TaskStatus } from "@prisma/client";
import type { DemoContext } from "../context";
import { DEMO_EMAIL_DOMAIN, chance, int, log, pick, rnd, some } from "../shared";
import { indiaClock } from "../../../src/lib/time/zone";
import { dayKeyOf, earnsXp } from "../../../src/lib/tasks/rules";

/**
 * Tasks in depth (owner, 17 Oct 2026, after the Tasks page grew a board, challenges and XP — bd59144):
 * the demo's tasks were made before any of that existed, so every one read To do, Medium, no team, no
 * checklist, nothing logged. This goes over them once and fills in what a team using it for a few weeks
 * would have:
 *
 *   · status — the closed ones Done, a third of the open ones In progress, a handful Cancelled;
 *   · priority by what the task is on (a deal in negotiation, the owner's approvals, a ticket on hold),
 *     start dates (a few still to start, so Upcoming has something), estimates, the assignee's team;
 *   · four live challenges and one archived, each run by a manager, their tasks carrying XP and badges —
 *     earned, by the rules the app keeps (src/lib/tasks/rules.ts), where they were done on time;
 *   · checklists, comments and time logged by whoever was there at the time; stars; the back office's
 *     regular work set to repeat.
 *
 * Nothing is given to anybody who has left, nobody prices their own task, and it runs once: a second run
 * finds the demo's challenges and leaves. Runs straight after ./tasks.ts (./index.ts), or on its own with
 * `npx tsx prisma/demo/run-cover.ts task-depth`.
 */

const clock = indiaClock;
const NOW = new Date();
const DAY = 86_400_000;
const TODAY = dayKeyOf(clock.calendarDate(NOW));
const dayAt = (offset: number) => new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)) + offset));
/** The calendar day an instant falls on here, as a stored day. */
const dayOf = (at: Date) => clock.calendarDate(at);
const between = (from: Date, to: Date) => new Date(from.getTime() + rnd() * Math.max(0, to.getTime() - from.getTime()));

const ESTIMATES = [15, 30, 45, 60, 90, 120, 180, 240];
const XP_STEPS = [20, 30, 50, 80, 100, 150];
const BUMP: Record<TaskPriority, TaskPriority> = { LOW: "MEDIUM", MEDIUM: "HIGH", HIGH: "URGENT", URGENT: "URGENT" };

type Kind = "lead" | "ticket" | "desk" | "owner" | "queue";

const CHECKLISTS: Record<Kind, string[]> = {
  lead: ["Check the contact's details are current", "Pull the last quote we sent", "Note the outcome on the lead", "Set the next follow-up", "Copy the account manager in"],
  ticket: ["Confirm the serial number", "Check the warranty or AMC", "Update the customer", "Attach the service report", "Close the loop with the OEM case"],
  desk: ["Collect the documents", "Prepare the working", "Get it reviewed", "Send or file it", "Note it in the tracker"],
  owner: ["Read the note from the team", "Check the numbers", "Decide and reply"],
  queue: ["Call them back", "Log the requirement", "Hand it to an account manager"],
};

const COMMENTS: Record<Kind, string[]> = {
  lead: [
    "Spoke to them this morning — they'll confirm by Friday.",
    "Their IT head is on leave till Monday, following up then.",
    "Distributor price came in, revising now.",
    "They want the AMC shown as a separate line.",
    "Done — notes are on the lead.",
    "Can you join the call? They've asked about the migration plan.",
  ],
  ticket: [
    "Reproduced it on the test machine — it's the driver version.",
    "OEM case raised, waiting on their L2.",
    "Part is with the courier, should land tomorrow.",
    "Customer confirmed it's working. Closing the steps.",
    "Visited the site, need one more visit for the second floor.",
  ],
  desk: [
    "Two invoices are missing from the vendor — asked them again.",
    "Working is ready, sending it for review.",
    "Reviewed, a couple of small corrections inline.",
    "Filed. Acknowledgement saved in the shared folder.",
    "Can this wait till the month-end close is done?",
  ],
  owner: ["Numbers look fine, approving.", "Let's discuss in tomorrow's review.", "Need the margin on this before I sign off."],
  queue: ["Picking this up.", "Called, no answer — will try after lunch."],
};

const TIME_NOTES = ["Call and follow-up mail", "Preparing the working", "Site visit", "Review", "Research", null, null];

/** Regular back-office work, set to repeat. */
const REPEATS: [RegExp, TaskRepeat][] = [
  [/Reconcile the HDFC/, "WEEKLY"],
  [/expense claims/, "WEEKLY"],
  [/GST return working/, "MONTHLY"],
  [/monthly pipeline report/, "MONTHLY"],
  [/spare stock/, "MONTHLY"],
  [/AMC renewals due next month/, "MONTHLY"],
];

type Challenge = { name: string; description: string; dept: string; badge: string; from: number; to: number; archived?: boolean; takes: (t: TaskRow) => boolean };
type TaskRow = Awaited<ReturnType<typeof loadTasks>>[number] & { kind: Kind };

function loadTasks(db: PrismaClient) {
  return db.task.findMany({
    where: { createdBy: { email: { endsWith: DEMO_EMAIL_DOMAIN } } },
    select: {
      id: true,
      title: true,
      done: true,
      doneAt: true,
      dueDate: true,
      createdAt: true,
      updatedAt: true,
      assignedToUserId: true,
      createdByUserId: true,
      companyId: true,
      leadId: true,
      ticketId: true,
      lead: { select: { status: true } },
      ticket: { select: { status: true } },
    },
  });
}

export default async function seedTaskDepth(db: PrismaClient, ctx: DemoContext): Promise<void> {
  if ((await db.taskChallenge.count({ where: { createdBy: { email: { endsWith: DEMO_EMAIL_DOMAIN } } } })) > 0) {
    log("Tasks: depth", "already there — the demo's challenges exist; nothing added");
    return;
  }
  const loaded = await loadTasks(db);
  if (loaded.length === 0) {
    log("Tasks: depth", "no demo tasks yet; nothing to fill in");
    return;
  }

  const people = await db.user.findMany({
    where: { OR: [{ email: { endsWith: DEMO_EMAIL_DOMAIN } }, { id: ctx.admin.id }] },
    select: { id: true, departmentId: true, managerId: true, active: true, employeeProfile: { select: { exitedOn: true } } },
  });
  const person = new Map(people.map((p) => [p.id, p]));
  const demo = new Set(ctx.people.map((p) => p.id));
  /** Whether somebody was with the company at a moment — the owner always is. */
  const presentAt = (id: string | null, at: Date) => {
    if (!id) return false;
    const p = person.get(id);
    if (!p || p.active) return !!p;
    const left = p.employeeProfile?.exitedOn;
    return !!left && at.getTime() <= left.getTime() + DAY;
  };
  const managerIn = (dept: string) => ctx.people.find((p) => p.dept === dept && p.isManager && presentAt(p.id, NOW));

  const tasks: TaskRow[] = loaded.map((t) => ({
    ...t,
    kind: t.assignedToUserId === ctx.admin.id ? "owner" : !t.assignedToUserId ? "queue" : t.leadId ? "lead" : t.ticketId ? "ticket" : t.companyId ? "lead" : "desk",
  }));
  const deptOf = (t: TaskRow) => ctx.people.find((p) => p.id === t.assignedToUserId)?.dept ?? ctx.people.find((p) => p.id === t.createdByUserId)?.dept ?? null;

  // ── Challenges ───────────────────────────────────────────────────────────────────────────────
  const CHALLENGES: Challenge[] = [
    {
      name: "Festive renewals push",
      description: "Every renewal and upgrade conversation moved before Diwali, so the orders land this quarter.",
      dept: "Sales",
      badge: "Deal closer",
      from: -21,
      to: 24,
      takes: (t) => t.kind === "lead" && deptOf(t) === "Sales" && ["PROPOSAL_SENT", "NEGOTIATION", "WON"].includes(t.lead?.status ?? ""),
    },
    {
      name: "Books closed by the 7th",
      description: "Reconciliations, claims and returns done in the first week, every month.",
      dept: "Accounts",
      badge: "Books balanced",
      from: -16,
      to: 6,
      takes: (t) => t.kind === "desk" && deptOf(t) === "Accounts",
    },
    {
      name: "Zero overdue tickets",
      description: "No ticket's work left past its date for a month.",
      dept: "Support",
      badge: "Firefighter",
      from: -14,
      to: 16,
      takes: (t) => t.kind === "ticket",
    },
    {
      name: "Microsoft 365 migrations",
      description: "Sizing, BOQs and demos for the customers moving mail and files to Microsoft 365.",
      dept: "Presales & Solutions",
      badge: "Cloud mover",
      from: -30,
      to: 30,
      takes: (t) => deptOf(t) === "Presales & Solutions",
    },
    {
      name: "Pipeline clean-up",
      description: "Every stale deal either moved on or closed out.",
      dept: "Sales",
      badge: "Spring cleaner",
      from: -150,
      to: -110,
      archived: true,
      takes: (t) => t.kind === "lead" && t.done && !!t.doneAt && t.doneAt.getTime() >= dayAt(-150).getTime() && t.doneAt.getTime() < dayAt(-109).getTime(),
    },
  ];
  const challengeOf = new Map<string, { id: string; badge: string }>();
  let challengesMade = 0;
  for (const c of CHALLENGES) {
    const runner = managerIn(c.dept) ?? managerIn("Sales") ?? managerIn("Management");
    if (!runner) continue;
    const startDate = dayAt(c.from);
    const endDate = dayAt(c.to);
    const made = await db.taskChallenge.create({
      data: {
        name: c.name,
        description: c.description,
        departmentId: ctx.departments.get(c.dept) ?? null,
        startDate,
        endDate,
        createdById: runner.id,
        createdAt: new Date(startDate.getTime() - 2 * DAY),
        archivedAt: c.archived ? new Date(endDate.getTime() + 3 * DAY) : null,
      },
    });
    challengesMade += 1;
    // Work in its window: open work, or work done while it ran.
    const inWindow = (t: TaskRow) => (t.done ? !!t.doneAt && t.doneAt >= startDate && t.doneAt.getTime() < endDate.getTime() + DAY : !c.archived);
    for (const t of tasks) if (!challengeOf.has(t.id) && c.takes(t) && inWindow(t) && chance(0.85)) challengeOf.set(t.id, { id: made.id, badge: c.badge });
  }

  // ── Each task ────────────────────────────────────────────────────────────────────────────────
  const updates: { id: string; data: Prisma.TaskUncheckedUpdateInput }[] = [];
  const checklist: Prisma.TaskChecklistItemCreateManyInput[] = [];
  const comments: Prisma.TaskCommentCreateManyInput[] = [];
  const timeLogs: Prisma.TaskTimeLogCreateManyInput[] = [];
  const stars: Prisma.TaskStarCreateManyInput[] = [];
  const today = dayAt(0);
  const counts = { inProgress: 0, cancelled: 0, upcoming: 0, xp: 0, earned: 0, repeats: 0 };

  for (const t of tasks) {
    const open = !t.done;
    const overdue = open && !!t.dueDate && t.dueDate < today;

    // Status. A few open ones are dropped — the deal went another way, the visit wasn't needed.
    let status: TaskStatus = t.done ? "DONE" : "TODO";
    let done = t.done;
    // The main seed once finished some a few days after the day it ran (prisma/demo/activity.ts, fixed):
    // nothing is done later than now.
    let doneAt = t.doneAt && t.doneAt > NOW ? new Date(NOW.getTime() - int(30, 600) * 60_000) : t.doneAt;
    if (open && t.kind !== "owner" && chance(0.03)) {
      status = "CANCELLED";
      done = true;
      doneAt = between(t.createdAt, NOW);
      counts.cancelled += 1;
    } else if (open && t.createdAt < today && (!t.dueDate || t.dueDate.getTime() <= dayAt(7).getTime()) && chance(0.35)) {
      status = "IN_PROGRESS";
      counts.inProgress += 1;
    }

    // Priority, by what it's on.
    let priority: TaskPriority = "MEDIUM";
    if (t.kind === "owner") priority = t.dueDate && t.dueDate <= today ? "URGENT" : "HIGH";
    else if (t.kind === "lead") priority = t.lead?.status === "NEGOTIATION" ? "HIGH" : t.lead?.status === "NEW" || t.lead?.status === "CONTACTED" ? pick<TaskPriority>(["LOW", "MEDIUM"]) : "MEDIUM";
    else if (t.kind === "ticket") priority = t.ticket?.status === "ON_HOLD" ? "HIGH" : pick<TaskPriority>(["MEDIUM", "MEDIUM", "HIGH"]);
    else if (t.kind === "desk") priority = /GST|TDS|receivables/.test(t.title) ? "HIGH" : /Diwali|ID cards|knowledge-base/.test(t.title) ? "LOW" : "MEDIUM";
    if (overdue && status !== "CANCELLED" && chance(0.5)) priority = BUMP[priority];

    // When it was started: the day it was set, mostly; a few open ones not yet.
    let startDate: Date | null = chance(0.6) ? dayOf(t.createdAt) : null;
    if (status === "TODO" && t.dueDate && t.dueDate.getTime() >= dayAt(6).getTime() && chance(0.35)) {
      startDate = new Date(Math.max(dayAt(1).getTime(), t.dueDate.getTime() - int(1, 4) * DAY));
      counts.upcoming += 1;
    }
    if (startDate && t.dueDate && startDate > t.dueDate) startDate = t.dueDate;

    const assignee = t.assignedToUserId;
    const departmentId = (assignee && person.get(assignee)?.departmentId) || person.get(t.createdByUserId)?.departmentId || null;

    // XP: set by somebody other than whoever does it — the one who set the task, or else their manager.
    const challenge = challengeOf.get(t.id);
    const setter = t.createdByUserId !== assignee ? t.createdByUserId : assignee && person.get(assignee)?.managerId && demo.has(person.get(assignee)!.managerId!) ? person.get(assignee)!.managerId! : null;
    let xp = 0;
    if (setter && status !== "CANCELLED" && (challenge || chance(0.1))) {
      xp = challenge ? (priority === "URGENT" || priority === "HIGH" ? pick(XP_STEPS.slice(3)) : pick(XP_STEPS.slice(0, 4))) : int(1, 4) * 10;
      counts.xp += 1;
    }
    const badge = xp > 0 && challenge && chance(0.35) ? challenge.badge : xp > 0 && chance(0.1) ? pick(["Early bird", "Team player"]) : null;
    const earns = status === "DONE" && !!doneAt && xp > 0 && setter !== assignee && earnsXp({ xp, assignedToUserId: assignee, dueDate: t.dueDate }, dayKeyOf(dayOf(doneAt)));
    if (earns) counts.earned += 1;

    // Regular work repeats.
    const repeat = open && status !== "CANCELLED" && t.kind === "desk" ? (REPEATS.find(([re]) => re.test(t.title))?.[1] ?? null) : null;
    if (repeat) counts.repeats += 1;

    updates.push({
      id: t.id,
      data: {
        status,
        done,
        doneAt,
        priority,
        startDate,
        estimateMinutes: chance(0.6) ? pick(ESTIMATES) : null,
        departmentId,
        challengeId: challenge?.id ?? null,
        xp,
        xpSetById: xp > 0 ? setter : null,
        badge,
        xpEarned: earns ? xp : null,
        xpEarnedById: earns ? assignee : null,
        xpEarnedAt: earns ? doneAt : null,
        repeat,
        // When it was last touched stays as it was — or the day it was dropped.
        updatedAt: status === "CANCELLED" && doneAt ? doneAt : t.updatedAt,
      },
    });

    const until = doneAt && status !== "IN_PROGRESS" ? doneAt : NOW;
    const doer = assignee ?? t.createdByUserId;

    // A checklist on about a third: all ticked on a finished one, some on one under way.
    if (chance(0.35)) {
      const items = some(CHECKLISTS[t.kind], Math.min(CHECKLISTS[t.kind].length, int(2, 5)));
      const ticked = status === "DONE" ? items.length : status === "IN_PROGRESS" ? int(1, items.length - 1) : chance(0.3) ? 1 : 0;
      items.forEach((title, i) => {
        const tickedAt = i < ticked ? between(t.createdAt, until) : null;
        checklist.push({ taskId: t.id, title, sortOrder: i, done: !!tickedAt, doneAt: tickedAt, doneById: tickedAt && presentAt(doer, tickedAt) ? doer : null, createdAt: t.createdAt });
      });
    }

    // A conversation on about one in five, between whoever set it and whoever does it.
    if (chance(0.2)) {
      const voices = [...new Set([doer, t.createdByUserId])];
      const lines = some(COMMENTS[t.kind], Math.min(COMMENTS[t.kind].length, int(1, 3)));
      const times = lines.map(() => between(t.createdAt, until)).sort((a, b) => a.getTime() - b.getTime());
      lines.forEach((body, i) => {
        const author = voices[i % voices.length]!;
        if (presentAt(author, times[i]!)) comments.push({ taskId: t.id, userId: author, body, createdAt: times[i]! });
      });
    }

    // Time logged by whoever does it, on work that was started.
    if (assignee && (status === "DONE" ? chance(0.5) : status === "IN_PROGRESS" ? chance(0.7) : false)) {
      for (let i = int(1, 3); i > 0; i--) {
        const at = between(t.createdAt, until);
        if (!presentAt(assignee, at)) continue;
        timeLogs.push({ taskId: t.id, userId: assignee, minutes: pick([15, 30, 45, 60, 90, 120]), note: pick(TIME_NOTES), spentOn: dayOf(at), createdAt: at });
      }
    }
  }

  // Stars: the owner on what's waiting for them, a few people on what matters to them this week.
  const openMine = (id: string) => tasks.filter((t) => !t.done && t.assignedToUserId === id);
  for (const t of some(openMine(ctx.admin.id), Math.min(4, openMine(ctx.admin.id).length))) stars.push({ taskId: t.id, userId: ctx.admin.id });
  for (const p of some(ctx.people.filter((p) => presentAt(p.id, NOW)), 15)) {
    const mine = openMine(p.id);
    for (const t of some(mine, Math.min(mine.length, int(1, 2)))) stars.push({ taskId: t.id, userId: p.id });
  }

  for (let i = 0; i < updates.length; i += 50) {
    await db.$transaction(updates.slice(i, i + 50).map((u) => db.task.update({ where: { id: u.id }, data: u.data })));
  }
  for (let i = 0; i < checklist.length; i += 500) await db.taskChecklistItem.createMany({ data: checklist.slice(i, i + 500) });
  for (let i = 0; i < comments.length; i += 500) await db.taskComment.createMany({ data: comments.slice(i, i + 500) });
  for (let i = 0; i < timeLogs.length; i += 500) await db.taskTimeLog.createMany({ data: timeLogs.slice(i, i + 500) });
  if (stars.length) await db.taskStar.createMany({ data: stars, skipDuplicates: true });

  log("Tasks: depth", `${tasks.length} tasks — ${counts.inProgress} in progress, ${counts.cancelled} cancelled, ${counts.upcoming} still to start, ${counts.repeats} repeating`);
  log("Tasks: challenges", `${challengesMade} (one archived), ${challengeOf.size} tasks in them; ${counts.xp} carry XP, ${counts.earned} earned it on time`);
  log("Tasks: detail", `${checklist.length} checklist steps, ${comments.length} comments, ${timeLogs.length} time entries, ${stars.length} stars`);
}

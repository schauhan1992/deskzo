import type { LeadStatus, PrismaClient, TicketStatus, TicketType } from "@prisma/client";
import type { DemoContext } from "../context";
import type { SeededPerson } from "../people";
import { DEMO_EMAIL_DOMAIN, DEMO_TAG, chance, int, log, pick, rnd, some } from "../shared";
import { indiaClock } from "../../../src/lib/time/zone";

/**
 * Tasks (owner, 16 Oct 2026: "add seed data in tasks").
 *
 * The other areas raise tasks as a side effect — joining checklists, renewal reminders, promised
 * callbacks, calling lists — which left the places people actually work from bare: two leads of 263
 * with a task, so the leads board's task counter read nothing; no ticket with one; nothing due today;
 * nothing in the owner's own list. This adds the day-to-day work, dated from the day it runs:
 *
 *   · leads — the steps a deal goes through, the earlier ones done, the current one open (the board's
 *     "done of total" counter); a closing task or two on won and lost deals;
 *   · tickets — the work behind each open ticket, and what was done on resolved ones;
 *   · each back-office person's own work — Accounts, Purchase, HR, Management;
 *   · the owner's list — approvals and reviews their managers have asked for;
 *   · a few unassigned ones waiting for someone to pick them up, and some with no due date.
 *
 * Open work is spread overdue · today · this week · later · undated, so every filter on the Tasks page
 * has something in it. Due dates are calendar days, held at UTC midnight as the app keeps them
 * (src/actions/task.ts, dueDateFrom). Every task is created by a demo person, so the demo's reset takes
 * them with it. Runs once: a second run finds the lead tasks and leaves.
 */

const clock = indiaClock;
const NOW = new Date();
const TODAY = clock.parts(NOW);
const DAY = 86_400_000;

/** A calendar day `offset` days from today, as a due date is stored. */
const dueOn = (offset: number) => new Date(Date.UTC(TODAY.year, TODAY.month, TODAY.day + offset));

/** `offset` working days from today — Sundays skipped either way. */
function workday(offset: number): Date {
  let d = dueOn(offset);
  while (d.getUTCDay() === 0) d = new Date(d.getTime() + (offset < 0 ? -DAY : DAY));
  return d;
}

/** A moment in working hours on a calendar day, never later than now. */
function during(day: Date): Date {
  const at = clock.at(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), int(10, 18), int(0, 59));
  return at.getTime() > NOW.getTime() ? new Date(NOW.getTime() - int(5, 90) * 60_000) : at;
}

/** The calendar day an instant falls on here. */
const dayOf = (at: Date) => clock.calendarDate(at);

/** When an open task is due: mostly soon, some late, a few with no date at all. */
function openDue(): Date | null {
  const r = rnd();
  if (r < 0.12) return workday(-int(1, 6));
  if (r < 0.3) return dueOn(0);
  if (r < 0.7) return workday(int(1, 5));
  if (r < 0.95) return workday(int(6, 20));
  return null;
}

type Row = {
  title: string;
  description: string | null;
  dueDate: Date | null;
  done: boolean;
  doneAt: Date | null;
  assignedToUserId: string | null;
  createdByUserId: string;
  companyId: string | null;
  leadId: string | null;
  ticketId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Still to do. Set a few days before it is due — never before `notBefore`, the record it is on. */
function openTask({ notBefore, ...t }: Omit<Row, "done" | "doneAt" | "dueDate" | "updatedAt" | "createdAt"> & { createdAt?: Date; dueDate?: Date | null; notBefore?: Date }): Row {
  const dueDate = t.dueDate === undefined ? openDue() : t.dueDate;
  const latest = dueDate ? Math.min(NOW.getTime(), dueDate.getTime()) : NOW.getTime();
  const guess = t.createdAt ?? new Date(latest - int(1, 12) * DAY - int(0, 600) * 60_000);
  const createdAt = notBefore && guess.getTime() < notBefore.getTime() ? new Date(Math.min(NOW.getTime(), notBefore.getTime() + int(10, 240) * 60_000)) : guess;
  return { ...t, dueDate, done: false, doneAt: null, createdAt, updatedAt: createdAt };
}

function doneTask(t: Omit<Row, "done" | "doneAt" | "dueDate" | "updatedAt" | "createdAt">, doneAt: Date, createdAt?: Date): Row {
  const finished = doneAt.getTime() > NOW.getTime() ? new Date(NOW.getTime() - int(30, 600) * 60_000) : doneAt;
  const made = createdAt && createdAt.getTime() < finished.getTime() ? createdAt : new Date(finished.getTime() - int(1, 6) * DAY);
  // Due the day it was done, or a day or two after — the odd one finished late.
  const dueDate = chance(0.15) ? dayOf(new Date(finished.getTime() - int(1, 3) * DAY)) : dayOf(new Date(finished.getTime() + int(0, 2) * DAY));
  return { ...t, dueDate, done: true, doneAt: finished, createdAt: made, updatedAt: finished };
}

// ── What a deal's work looks like, stage by stage ────────────────────────────────────────────────

const OPEN_STAGES: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"];

const LEAD_STEPS: Record<LeadStatus, [title: string, note: string | null][]> = {
  NEW: [
    ["Call {contact} to introduce us", null],
    ["Look up {company} — size, sites, current IT setup", "Check LinkedIn and their website for recent hiring or new offices."],
    ["Send our capability deck to {company}", null],
  ],
  CONTACTED: [
    ["Book a discovery call with {company}", "They asked for a slot after the 15th."],
    ["Find out who signs off IT spend at {company}", null],
    ["Share two case studies from their industry", null],
  ],
  QUALIFYING: [
    ["Confirm budget and timeline with {company}", null],
    ["Map {company}'s current licences and renewal dates", "Ask for the last invoice from their current vendor."],
    ["Get the requirement from {company} in writing", null],
  ],
  QUALIFIED: [
    ["Schedule a demo for {company}", null],
    ["Bring presales in on the solution design for {company}", "Two sites, about 120 users — needs a sizing call."],
    ["Prepare a rough BOQ for {company}", null],
  ],
  PROPOSAL_SENT: [
    ["Follow up on the proposal sent to {company}", null],
    ["Walk {contact} through the commercials", "They want the AMC shown separately."],
    ["Check the proposal has reached {company}'s finance team", null],
  ],
  NEGOTIATION: [
    ["Get distributor price approval for {company}", "Need the special bid number before revising."],
    ["Revise the quote for {company} with the agreed discount", null],
    ["Send the order form to {company} for signature", null],
  ],
  WON: [
    ["Hand {company} over to delivery", "Kick-off call with the project manager and their IT head."],
    ["Raise the PO with the distributor for {company}", null],
    ["Send the welcome mail and onboarding plan to {company}", null],
  ],
  LOST: [
    ["Note why we lost {company}", null],
    ["Re-approach {company} before their next renewal", "Their contract with the other vendor runs one year."],
  ],
  DISQUALIFIED: [
    ["Close out the quote for {company}", null],
    ["Tell {contact} we'll stay in touch", null],
  ],
};

// ── The work behind a ticket ─────────────────────────────────────────────────────────────────────

const TICKET_STEPS: Record<TicketType, string[]> = {
  INSTALLATION: ["Confirm site readiness with {company}", "Schedule the engineer's visit to {company}", "Collect the installation sign-off from {company}"],
  PRODUCT_SUPPORT: ["Reproduce {company}'s issue on a test machine", "Raise a case with the OEM for {company}", "Call {company} to confirm the fix"],
  DEMO: ["Set up the demo environment for {company}", "Share the demo recording with {company}"],
  TRAINING: ["Send the training material to {company}", "Book the session link for {company}'s team", "Collect attendance and feedback from {company}"],
  OTHER: ["Check {company}'s AMC status", "Update {company} on progress"],
};
const ON_HOLD_STEP = "Chase the distributor for {company}'s replacement part";
const OPEN_TICKET: TicketStatus[] = ["OPEN", "IN_PROGRESS", "ON_HOLD"];

// ── Back-office work, by department ──────────────────────────────────────────────────────────────

const DESK_WORK: Record<string, string[]> = {
  Accounts: [
    "Prepare the GST return working for the month",
    "Reconcile the HDFC current account",
    "Chase the three oldest receivables",
    "Book last week's expense claims",
    "Send TDS certificates to vendors",
    "Match distributor credit notes to invoices",
  ],
  Purchase: [
    "Compare distributor quotes for 25 laptops",
    "Follow up on deliveries pending more than a week",
    "Renew the rate contract with our main distributor",
    "Get the warranty registration done for last month's servers",
  ],
  "HR & Admin": [
    "Collect investment declarations",
    "Plan the Diwali celebration",
    "Renew the office insurance",
    "Update the leave policy document",
    "Arrange ID cards for this month's joiners",
  ],
  Management: ["Review the monthly pipeline report", "Approve the marketing budget for next quarter", "Go through the customer escalations list"],
  Support: ["Update the knowledge-base article on VPN setup", "Check the spare stock for common parts", "Review AMC renewals due next month"],
  "Presales & Solutions": ["Refresh the standard BOQ templates", "Get the new OEM certification scheduled"],
};

// ── Asked of the owner ───────────────────────────────────────────────────────────────────────────

const FOR_THE_OWNER: { title: string; note: string | null; due: number | null; askedBy: string[]; link: "negotiation" | "escalation" | null; done?: boolean }[] = [
  { title: "Approve the special discount for {company}", note: "12% over the standard band — the distributor is matching half.", due: 0, askedBy: ["Sales"], link: "negotiation" },
  { title: "Call {company}'s director about the escalation", note: "Third visit for the same issue; they asked for someone senior.", due: 0, askedBy: ["Support"], link: "escalation" },
  { title: "Sign the distributor agreement renewal", note: null, due: 1, askedBy: ["Purchase"], link: null },
  { title: "Review the quarter's collection report", note: "Two accounts over 90 days need a decision.", due: 3, askedBy: ["Accounts"], link: null },
  { title: "Approve the incentive payout for September", note: null, due: -2, askedBy: ["HR & Admin", "Management"], link: null },
  { title: "Review the hiring plan for two inside-sales roles", note: null, due: null, askedBy: ["Inside Sales", "Management"], link: null },
  { title: "Approve the travel policy update", note: null, due: -1, askedBy: ["HR & Admin"], link: null, done: true },
];

// ── Waiting for somebody to pick up ──────────────────────────────────────────────────────────────

const UNCLAIMED: { title: string; due: number }[] = [
  { title: "Call back {company} — enquiry from the website", due: 0 },
  { title: "Quote 20 Microsoft 365 licences for {company}", due: 1 },
  { title: "AMC renewal quote asked for by {company}", due: 3 },
  { title: "Printer issue at {company}'s branch — arrange a visit", due: 2 },
  { title: "Webinar attendee from {company} wants a demo", due: 5 },
];

const fill = (text: string, company: string, contact: string | null) => text.replaceAll("{company}", company).replaceAll("{contact}", contact ?? `the contact at ${company}`);

export default async function seedTasks(db: PrismaClient, ctx: DemoContext): Promise<void> {
  const demoCreator = { createdBy: { email: { endsWith: DEMO_EMAIL_DOMAIN } } };
  if ((await db.task.count({ where: { leadId: { not: null }, ...demoCreator } })) >= 20) {
    log("Tasks", "already seeded — leads have their tasks; nothing added");
    return;
  }

  const byId = new Map(ctx.people.map((p) => [p.id, p]));
  const facts = await db.user.findMany({
    where: { id: { in: ctx.people.map((p) => p.id) } },
    select: { id: true, managerId: true, active: true, employeeProfile: { select: { exitedOn: true } } },
  });
  const managerOf = new Map(facts.map((u) => [u.id, u.managerId]));
  // Some of the demo's people have left. Their deals and tickets stay theirs, but nothing new is theirs.
  const leftOn = new Map(facts.map((u) => [u.id, u.active ? null : (u.employeeProfile?.exitedOn ?? new Date(0))]));
  const here = (id: string) => !byId.has(id) || leftOn.get(id) === null;
  /** Whether somebody was still with the company at a moment — the owner always is. */
  const presentAt = (id: string, at: Date) => {
    const left = leftOn.get(id);
    return !left || at.getTime() <= left.getTime() + DAY;
  };
  const inDept = (...depts: string[]) => ctx.people.filter((p) => depts.includes(p.dept) && here(p.id));
  const presales = inDept("Presales & Solutions");
  /** Who set it: the person themself, or now and then the manager above them — if that is a demo person. */
  const setBy = (assignee: string, delegated = 0.3) => {
    const manager = managerOf.get(assignee);
    return manager && byId.has(manager) && chance(delegated) ? manager : assignee;
  };
  const rows: Row[] = [];

  // ── Leads ────────────────────────────────────────────────────────────────────────────────────
  const leads = await db.lead.findMany({
    where: { company: { tags: { has: DEMO_TAG } }, ownerUserId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, ownerUserId: true, companyId: true, createdAt: true, stageChangedAt: true, updatedAt: true, company: { select: { name: true } }, contact: { select: { name: true } } },
  });
  for (const lead of leads) {
    const owner = lead.ownerUserId!;
    if (!byId.has(owner)) continue;
    const name = lead.company.name;
    const contact = lead.contact?.name ?? null;
    const base = { companyId: lead.companyId, leadId: lead.id, ticketId: null };
    const stage = OPEN_STAGES.indexOf(lead.status);

    if (stage >= 0) {
      if (!chance(0.8)) continue;
      // A step from each of the last two stages it came through, done when it moved on.
      const steps = OPEN_STAGES.slice(Math.max(0, stage - 2), stage);
      const since = lead.createdAt.getTime();
      const span = Math.max(DAY, NOW.getTime() - since);
      steps.forEach((s, i) => {
        if (!chance(0.75)) return;
        const [title, note] = pick(LEAD_STEPS[s]);
        const doneAt = new Date(since + span * ((i + 1) / (steps.length + 1)));
        rows.push(doneTask({ ...base, title: fill(title, name, contact), description: note, assignedToUserId: owner, createdByUserId: setBy(owner) }, doneAt, lead.createdAt));
      });
      // The stage it is at: one or two things still to do, the odd one handed to presales.
      for (const [title, note] of some(LEAD_STEPS[lead.status], chance(0.4) ? 2 : 1)) {
        const toPresales = presales.length > 0 && /presales|demo|BOQ/i.test(title) && chance(0.6);
        const assignee = toPresales ? pick(presales).id : owner;
        rows.push(openTask({ ...base, title: fill(title, name, contact), description: note, assignedToUserId: assignee, createdByUserId: toPresales ? owner : setBy(owner), notBefore: lead.createdAt }));
      }
    } else if (chance(0.4)) {
      const closedAt = lead.stageChangedAt ?? lead.updatedAt;
      for (const [title, note] of some(LEAD_STEPS[lead.status], chance(0.5) ? 2 : 1)) {
        rows.push(doneTask({ ...base, title: fill(title, name, contact), description: note, assignedToUserId: owner, createdByUserId: setBy(owner) }, new Date(closedAt.getTime() + int(1, 72) * 3_600_000), closedAt));
      }
    }
  }

  // ── Tickets ──────────────────────────────────────────────────────────────────────────────────
  const tickets = await db.ticket.findMany({
    where: { company: { tags: { has: DEMO_TAG } }, assignedToUserId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, ticketType: true, assignedToUserId: true, companyId: true, createdAt: true, resolvedAt: true, closedAt: true, updatedAt: true, company: { select: { name: true } } },
  });
  for (const ticket of tickets) {
    const engineer = ticket.assignedToUserId!;
    if (!byId.has(engineer)) continue;
    const name = ticket.company.name;
    const base = { companyId: ticket.companyId, leadId: null, ticketId: ticket.id, description: null };
    const steps = TICKET_STEPS[ticket.ticketType];
    if (OPEN_TICKET.includes(ticket.status)) {
      const [first, ...rest] = steps;
      // Under way: the first step done. On hold: waiting on a part.
      if (ticket.status !== "OPEN" && first) {
        rows.push(doneTask({ ...base, title: fill(first, name, null), assignedToUserId: engineer, createdByUserId: setBy(engineer, 0.2) }, new Date(ticket.createdAt.getTime() + int(4, 48) * 3_600_000), ticket.createdAt));
      }
      const next = ticket.status === "ON_HOLD" ? [ON_HOLD_STEP] : ticket.status === "OPEN" ? steps.slice(0, chance(0.5) ? 2 : 1) : rest.slice(0, 1 + int(0, 1));
      for (const title of next) {
        rows.push(openTask({ ...base, title: fill(title, name, null), assignedToUserId: engineer, createdByUserId: setBy(engineer, 0.2), createdAt: new Date(Math.min(NOW.getTime(), ticket.createdAt.getTime() + int(1, 24) * 3_600_000)) }));
      }
    } else if (chance(0.5)) {
      const finished = ticket.resolvedAt ?? ticket.closedAt ?? ticket.updatedAt;
      for (const [i, title] of steps.slice(0, chance(0.5) ? 2 : 1).entries()) {
        const share = (i + 1) / (steps.length + 1);
        rows.push(doneTask({ ...base, title: fill(title, name, null), assignedToUserId: engineer, createdByUserId: setBy(engineer, 0.2) }, new Date(ticket.createdAt.getTime() + (finished.getTime() - ticket.createdAt.getTime()) * share), ticket.createdAt));
      }
    }
  }

  // ── Back office ──────────────────────────────────────────────────────────────────────────────
  for (const person of ctx.people) {
    const work = DESK_WORK[person.dept];
    if (!work || !here(person.id)) continue;
    const mine = some(work, Math.min(work.length, int(2, 4)));
    mine.forEach((title, i) => {
      const base = { title, description: null, companyId: null, leadId: null, ticketId: null, assignedToUserId: person.id, createdByUserId: setBy(person.id) };
      // The first one or two finished in the last fortnight; the rest are on their plate.
      if (i < (chance(0.5) ? 2 : 1)) rows.push(doneTask(base, during(workday(-int(1, 12)))));
      else rows.push(openTask(base));
    });
  }

  // ── The owner's list ─────────────────────────────────────────────────────────────────────────
  const negotiating = leads.filter((l) => l.status === "NEGOTIATION" && byId.has(l.ownerUserId!));
  const escalated = tickets.filter((t) => OPEN_TICKET.includes(t.status));
  for (const ask of FOR_THE_OWNER) {
    const askers = ask.askedBy.flatMap((d) => inDept(d)).sort((a, b) => Number(b.isManager) - Number(a.isManager));
    const asker: SeededPerson | undefined = askers[0];
    if (!asker) continue;
    const lead = ask.link === "negotiation" ? negotiating[0] : undefined;
    const ticket = ask.link === "escalation" ? escalated[0] : undefined;
    if (ask.link && !lead && !ticket) continue;
    const company = lead?.company.name ?? ticket?.company.name ?? "";
    const base = {
      title: fill(ask.title, company, null),
      description: ask.note,
      companyId: lead?.companyId ?? ticket?.companyId ?? null,
      leadId: lead?.id ?? null,
      ticketId: ticket?.id ?? null,
      assignedToUserId: ctx.admin.id,
      createdByUserId: asker.id,
    };
    rows.push(ask.done ? doneTask(base, during(dueOn(ask.due ?? -1))) : openTask({ ...base, dueDate: ask.due === null ? null : ask.due < 0 ? workday(ask.due) : ask.due === 0 ? dueOn(0) : workday(ask.due) }));
  }

  // ── Nobody's yet ─────────────────────────────────────────────────────────────────────────────
  const queueKeeper = inDept("Inside Sales").find((p) => p.isManager) ?? inDept("Inside Sales", "Sales")[0];
  const prospects = some(
    ctx.companies.filter((c) => c.relationship === "CLIENT"),
    UNCLAIMED.length,
  );
  if (queueKeeper) {
    UNCLAIMED.forEach((u, i) => {
      const company = prospects[i];
      if (!company) return;
      rows.push(openTask({ title: fill(u.title, company.name, null), description: null, companyId: company.id, leadId: null, ticketId: null, assignedToUserId: null, createdByUserId: queueKeeper.id, dueDate: u.due === 0 ? dueOn(0) : workday(u.due) }));
    });
  }

  // Nobody does or sets work after they've left: a task they'd have finished later is dropped, and one
  // a leaver would have set is set by whoever does it instead.
  const kept = rows.flatMap((r) => {
    if (r.assignedToUserId && !presentAt(r.assignedToUserId, r.doneAt ?? NOW)) return [];
    if (presentAt(r.createdByUserId, r.createdAt)) return [r];
    return r.assignedToUserId && presentAt(r.assignedToUserId, r.createdAt) ? [{ ...r, createdByUserId: r.assignedToUserId }] : [];
  });
  for (let i = 0; i < kept.length; i += 200) await db.task.createMany({ data: kept.slice(i, i + 200) });

  const tally = (pick: (r: Row) => boolean) => {
    const these = kept.filter(pick);
    return `${these.filter((r) => !r.done).length} open and ${these.filter((r) => r.done).length} done`;
  };
  const isOwner = (r: Row) => r.assignedToUserId === ctx.admin.id;
  const open = kept.filter((r) => !r.done);
  const today = dueOn(0).getTime();
  const weekEnd = dueOn(7).getTime();
  log("Tasks: leads", `${tally((r) => r.leadId !== null && !isOwner(r))} on ${new Set(kept.map((r) => r.leadId).filter(Boolean)).size} leads`);
  log("Tasks: tickets", `${tally((r) => r.ticketId !== null && !isOwner(r))} on ${new Set(kept.map((r) => r.ticketId).filter(Boolean)).size} tickets`);
  log("Tasks: back office", `${tally((r) => !r.leadId && !r.ticketId && !r.companyId && !isOwner(r))} — Accounts, Purchase, HR, Management, Support, Presales`);
  log("Tasks: owner and queue", `${tally(isOwner)} for ${ctx.admin.name}; ${kept.filter((r) => !r.assignedToUserId).length} unassigned`);
  log(
    "Tasks: open work",
    `${open.length} open — ${open.filter((r) => r.dueDate && r.dueDate.getTime() < today).length} overdue, ${open.filter((r) => r.dueDate?.getTime() === today).length} today, ` +
      `${open.filter((r) => r.dueDate && r.dueDate.getTime() > today && r.dueDate.getTime() < weekEnd).length} this week, ${open.filter((r) => r.dueDate && r.dueDate.getTime() >= weekEnd).length} later, ${open.filter((r) => !r.dueDate).length} undated`,
  );
}

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAttachTo } from "@/lib/authz/attachments";
import { isModuleEnabled } from "@/actions/module";
import { findCompanyMatches, getCompany, listAssignableUsers } from "@/actions/company";
import { listLeadsPaged } from "@/actions/lead";
import { listOrdersPaged } from "@/actions/order";
import { listRenewalsPaged } from "@/actions/renewal";
import { listTicketsPaged } from "@/actions/ticket";
import { getDashboardSummary } from "@/actions/dashboard";
import { reportOptions, runAnalyticsReport } from "@/actions/analytics";
import { formatCompanyId, formatLeadId, formatOrderId, parseSeqQuery } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { formatIstDateTime, istDateParts, parseIstDateTime } from "@/lib/india-time";
import { PEOPLE_ONLY } from "@/lib/people";
import type { DisplayBlock, ToolSpec } from "@/lib/copilot/types";

/**
 * What the copilot can do — and the whole of the promise that it can't see or do more than the
 * person using it.
 *
 * Every read goes through an action the app's own screens use — `getCompany`, `listLeadsPaged`,
 * `runAnalyticsReport`… — which resolve the signed-in person and apply their account scope, their
 * view permissions and the reseller redaction themselves. Nothing here writes its own `where` over
 * business data, so nothing here can be wider than the screen it stands in for. The one exception,
 * the person's own tasks, is filtered to rows that are theirs by construction.
 *
 * Nothing writes, either. "Create a task" and "make a note" become proposals: a card the person
 * confirms, which then goes through the same action the app's form uses, as them.
 *
 * Each tool's input is checked against its schema before it runs, whichever provider produced it —
 * a model's arguments are untrusted text like any other request body.
 */

export type ToolContext = { userId: string; conversationId: string };
export type ToolOutcome = { output: unknown; blocks?: DisplayBlock[]; activity: string };

type CopilotTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  /** The module that has to be on — for this person, which includes its view permission. */
  module?: string;
  run(ctx: ToolContext, input: never): Promise<ToolOutcome>;
};

const tool = <S extends z.ZodType>(t: {
  name: string;
  description: string;
  schema: S;
  module?: string;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutcome>;
}): CopilotTool => t as CopilotTool;

/** Kept short: every row here is paid for in tokens on every turn after it. */
const MAX_OUTPUT_CHARS = 12_000;
export const MAX_REPORT_ROWS = 40;

const money = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const limitField = z.number().int().min(1).max(25).optional().describe("How many to return, at most 25. Default 10.");

// ─── Resolving what the model names ──────────────────────────────────────────

async function companyIdFor(userId: string, ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  const company = await db.company.findFirst({
    where: seq !== null ? { companySeq: seq } : { id: ref },
    select: { id: true, ownerUserId: true },
  });
  // Not there and not yours read the same, as they do everywhere else.
  return company && (await canSeeCompany(userId, company.ownerUserId)) ? company.id : null;
}

async function leadIdFor(ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  return (await db.lead.findFirst({ where: seq !== null ? { leadSeq: seq } : { id: ref }, select: { id: true } }))?.id ?? null;
}

async function ticketIdFor(ref: string): Promise<string | null> {
  const seq = parseSeqQuery(ref);
  return (await db.ticket.findFirst({ where: seq !== null ? { ticketSeq: seq } : { id: ref }, select: { id: true } }))?.id ?? null;
}

// ─── The tools ───────────────────────────────────────────────────────────────

const TOOLS: CopilotTool[] = [
  tool({
    name: "search_companies",
    description: "Find companies (customers, vendors, resellers…) by part of their name. Returns their COM- references. Use this before anything about a named company.",
    schema: z.object({ query: z.string().trim().min(2).max(80).describe("Part of the company's name") }),
    async run(_ctx, input) {
      const { matches } = await findCompanyMatches(input.query);
      return {
        output: matches.slice(0, 15).map((m) => ({ ref: m.ref, name: m.name, kind: m.relationshipType, city: m.city, accountManager: m.owner })),
        activity: `Searched companies for “${input.query}” — ${matches.length} found`,
      };
    },
  }),

  tool({
    name: "get_company",
    description: "Everything about one company: its details, contacts, open leads, recent orders. Takes a COM- reference from search_companies.",
    schema: z.object({ ref: z.string().trim().min(1).max(60).describe("The company's reference, e.g. COM-000123") }),
    async run(ctx, input) {
      const id = await companyIdFor(ctx.userId, input.ref);
      const company = id ? await getCompany(id) : null;
      if (!company) return { output: { error: "No such company, or not one this person can see." }, activity: `Looked for ${input.ref} — not found` };
      const primary = company.locations[0];
      return {
        output: {
          ref: formatCompanyId(company.companySeq),
          name: company.name,
          kind: company.relationshipType,
          stage: company.stage,
          category: company.customerCategory?.name ?? null,
          accountManager: company.owner?.name ?? null,
          caller: company.assignedTo?.name ?? null,
          paymentTerms: company.paymentTerms,
          website: company.website,
          address: primary ? { city: primary.city, state: primary.state, gstin: primary.gstNumber } : null,
          tags: company.tags,
          contacts: company.contacts.slice(0, 10).map((c) => ({ name: c.name, designation: c.designation, email: c.email, phone: c.phone, primary: c.isPrimary })),
          leads: company.leads.slice(0, 10).map((l) => ({ ref: formatLeadId(l.leadSeq), title: l.title, status: l.status, value: money(l.estimatedValue), owner: l.owner?.name ?? null })),
          recentOrders: company.products.slice(0, 8).map((o) => ({
            ref: formatOrderId(o.orderSeq),
            item: o.item.name,
            quantity: o.quantity,
            status: o.orderStatus,
            unitPrice: money(o.unitPrice),
            ends: day(o.endDate),
          })),
        },
        activity: `Opened ${formatCompanyId(company.companySeq)} ${company.name}`,
      };
    },
  }),

  tool({
    name: "list_leads",
    description: "Leads in the pipeline, newest or hottest first. Filter by status, by the person's own, by hot/warm/cold, or by words in the title or company.",
    schema: z.object({
      status: z.enum(["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "DISQUALIFIED"]).optional(),
      mine: z.boolean().optional().describe("Only leads owned by the person asking"),
      grade: z.enum(["HOT", "WARM", "COLD"]).optional(),
      search: z.string().trim().max(80).optional(),
      closingFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Expected close on or after, YYYY-MM-DD"),
      closingTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Expected close on or before, YYYY-MM-DD"),
      limit: limitField,
    }),
    async run(ctx, input) {
      const { rows, total } = await listLeadsPaged({
        status: input.status,
        ownerUserId: input.mine ? ctx.userId : undefined,
        grade: input.grade,
        search: input.search,
        closeFrom: input.closingFrom,
        closeTo: input.closingTo,
        sort: input.grade ? "score" : undefined,
        page: 1,
        pageSize: input.limit ?? 10,
      });
      return {
        output: {
          total,
          leads: rows.map((l) => ({
            ref: formatLeadId(l.leadSeq),
            title: l.title,
            company: l.company.name,
            status: l.status,
            value: money(l.estimatedValue),
            expectedClose: day(l.expectedCloseDate),
            score: l.score,
            owner: l.owner?.name ?? null,
          })),
        },
        activity: `Looked up leads — ${total} match`,
      };
    },
  }),

  tool({
    name: "list_orders",
    description: "Orders and subscriptions, newest first. Filter by status or by words in the company or item.",
    module: "orders",
    schema: z.object({
      status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED", "PROCESSING", "FULFILLED", "CANCELLED"]).optional(),
      search: z.string().trim().max(80).optional(),
      limit: limitField,
    }),
    async run(_ctx, input) {
      const { rows, total } = await listOrdersPaged({ status: input.status, search: input.search, page: 1, pageSize: input.limit ?? 10 });
      return {
        output: {
          total,
          orders: rows.map((o) => ({
            ref: formatOrderId(o.orderSeq),
            company: o.company.name,
            item: o.item.name,
            quantity: o.quantity,
            unitPrice: money(o.unitPrice),
            status: o.orderStatus,
            starts: day(o.startDate),
            ends: day(o.endDate),
          })),
        },
        activity: `Looked up orders — ${total} match`,
      };
    },
  }),

  tool({
    name: "list_renewals",
    description: "Subscriptions coming up for renewal in the next 30, 60 or 90 days, or already expired.",
    module: "renewals",
    schema: z.object({ window: z.enum(["expired", "30", "60", "90"]).describe("Which renewals"), search: z.string().trim().max(80).optional(), limit: limitField }),
    async run(_ctx, input) {
      const { rows, total, expired } = await listRenewalsPaged({ window: input.window, search: input.search, page: 1, pageSize: input.limit ?? 10 });
      return {
        output: {
          total,
          expired,
          renewals: rows.map((r) => ({
            ref: formatOrderId(r.orderSeq),
            company: r.company.name,
            item: r.item.name,
            quantity: r.quantity,
            ends: day(r.endDate),
            unitPrice: money(r.unitPrice),
          })),
        },
        activity: `Looked up renewals (${input.window === "expired" ? "expired" : `next ${input.window} days`}) — ${total}`,
      };
    },
  }),

  tool({
    name: "list_tickets",
    description: "Support tickets, newest first. Filter by status, priority, or words in the title or company.",
    module: "helpdesk",
    schema: z.object({
      status: z.enum(["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"]).optional(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
      search: z.string().trim().max(80).optional(),
      limit: limitField,
    }),
    async run(_ctx, input) {
      const { rows, total } = await listTicketsPaged({
        status: input.status,
        priority: input.priority,
        search: input.search,
        page: 1,
        pageSize: input.limit ?? 10,
      });
      return {
        output: {
          total,
          tickets: rows.map((t) => ({
            ref: formatTicketId(t.ticketSeq),
            title: t.title,
            company: t.company.name,
            status: t.status,
            priority: t.priority,
            assignedTo: t.assignedTo?.name ?? null,
            opened: day(t.createdAt),
          })),
        },
        activity: `Looked up tickets — ${total} match`,
      };
    },
  }),

  tool({
    name: "my_tasks",
    description: "The person's own tasks — assigned to them or created by them — open ones first, soonest due first.",
    module: "tasks",
    schema: z.object({ includeDone: z.boolean().optional(), limit: limitField }),
    async run(ctx, input) {
      // Theirs by construction: assigned to them, or written by them.
      const where: Prisma.TaskWhereInput = {
        OR: [{ assignedToUserId: ctx.userId }, { createdByUserId: ctx.userId }],
        ...(input.includeDone ? {} : { done: false }),
      };
      const [rows, total] = await Promise.all([
        db.task.findMany({
          where,
          orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
          take: input.limit ?? 10,
          select: { title: true, dueDate: true, done: true, assignedTo: { select: { name: true } }, company: { select: { name: true } } },
        }),
        db.task.count({ where }),
      ]);
      return {
        output: { total, tasks: rows.map((t) => ({ title: t.title, due: day(t.dueDate), done: t.done, assignedTo: t.assignedTo?.name ?? null, company: t.company?.name ?? null })) },
        activity: `Looked at your tasks — ${total}`,
      };
    },
  }),

  tool({
    name: "dashboard_summary",
    description: "The headline numbers on the person's dashboard — this month's bookings, pipeline, renewals, tickets and the like, for what they can see.",
    schema: z.object({}),
    async run() {
      return { output: await getDashboardSummary(), activity: "Read your dashboard figures" };
    },
  }),

  tool({
    name: "report_options",
    module: "reports",
    description: "What reports can be run: each source (orders, leads, invoices, payments, tickets, visits…) with its measures, the dimensions it can be broken down by, and its date fields. Call this before run_report.",
    schema: z.object({}),
    async run() {
      const { sources, grains } = await reportOptions();
      return {
        output: {
          grains: grains.map((g) => g.key),
          sources: sources.map((s) => ({
            source: s.key,
            label: s.label,
            measures: s.measures.map((m) => ({ key: m.key, label: m.label })),
            dimensions: s.dimensions.map((d) => ({ key: d.key, label: d.label })),
            dateFields: s.dateFields.map((d) => ({ key: d.key, label: d.label })),
          })),
        },
        activity: "Checked which reports are available",
      };
    },
  }),

  tool({
    name: "run_report",
    module: "reports",
    description:
      "Run a report and show it in the chat as a chart and table. Totals, breakdowns and trends always come from here — never add up list results yourself. Use report_options for the valid keys. For a trend over time, use the date dimension as `column` or `dimension` with a grain.",
    schema: z.object({
      title: z.string().trim().min(3).max(90).describe("A short title for the chart, e.g. 'Bookings by salesperson, Sep 2026'"),
      source: z.string().max(40),
      measure: z.string().max(60),
      dimension: z.string().max(60).describe("What the rows are broken down by"),
      column: z.string().max(60).optional().describe("Optional second breakdown, shown as columns — often the date"),
      grain: z.enum(["day", "week", "month", "quarter", "year"]).describe("How dates are bucketed"),
      dateField: z.string().max(60),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First day, YYYY-MM-DD"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Last day, YYYY-MM-DD"),
      filters: z.record(z.string(), z.array(z.string().max(120)).max(20)).optional().describe("Dimension key → values to keep"),
    }),
    async run(_ctx, input) {
      const r = await runAnalyticsReport({
        source: input.source,
        measure: input.measure,
        dimension: input.dimension,
        column: input.column,
        grain: input.grain,
        dateField: input.dateField,
        from: input.from,
        to: input.to,
        filters: input.filters,
      });
      if (!r.ok) return { output: { error: r.error }, activity: `Couldn't run the report — ${r.error}` };
      const { sources } = await reportOptions();
      const measure = sources.find((s) => s.key === input.source)?.measures.find((m) => m.key === input.measure);
      const result = r.data;
      const shown = { ...result, rows: result.rows.slice(0, MAX_REPORT_ROWS) };
      return {
        output: {
          unit: result.unit,
          grandTotal: result.grandTotal,
          records: result.rowCount,
          truncated: result.truncated,
          scope: result.scopeNote,
          columns: result.columns.map((c) => c.label),
          rows: result.rows.slice(0, 25).map((row) => ({ label: row.label, total: row.total, ...(result.columns.length > 1 ? { byColumn: row.cells } : {}) })),
          moreRows: Math.max(0, result.rows.length - 25),
          note: "The chart and table are already shown to the user — summarise what stands out rather than repeating them.",
        },
        blocks: [{ type: "report", title: input.title, measureLabel: measure?.label ?? input.measure, averaged: measure?.average === true, result: shown }],
        activity: `Ran a report: ${input.title}`,
      };
    },
  }),

  tool({
    name: "find_colleague",
    description: "Find a colleague by name, for assigning a task to them. Returns their id.",
    schema: z.object({ name: z.string().trim().min(2).max(60) }),
    async run(_ctx, input) {
      const people = await listAssignableUsers();
      const needle = input.name.toLowerCase();
      const found = people.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 8);
      return { output: found.map((p) => ({ id: p.id, name: p.name, role: p.role })), activity: `Looked for colleague “${input.name}” — ${found.length}` };
    },
  }),

  tool({
    name: "propose_task",
    description:
      "Offer to create a task. The user sees a card and must press Create — nothing is saved until they do, so never say it has been created. Link it to a company, lead or ticket by reference when the conversation is about one.",
    module: "tasks",
    schema: z.object({
      title: z.string().trim().min(2).max(200),
      description: z.string().trim().max(2000).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      assigneeUserId: z.string().max(40).optional().describe("From find_colleague; leave out to assign it to the person asking"),
      companyRef: z.string().max(60).optional(),
      leadRef: z.string().max(60).optional(),
      ticketRef: z.string().max(60).optional(),
    }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, input);
      if ("error" in attached) return { output: { error: attached.error }, activity: "Couldn't draft the task" };
      // A person only, as find_colleague offers: never a support or Automation account (src/lib/people.ts).
      const assignee = input.assigneeUserId ? await db.user.findFirst({ where: { id: input.assigneeUserId, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } }) : null;
      if (input.assigneeUserId && !assignee) return { output: { error: "That colleague isn't an active user — use find_colleague." }, activity: "Couldn't draft the task" };
      const payload = {
        title: input.title,
        description: input.description ?? "",
        dueDate: input.dueDate ?? "",
        assignedToUserId: assignee?.id ?? ctx.userId,
        companyId: attached.companyId ?? "",
        leadId: attached.leadId ?? "",
        ticketId: attached.ticketId ?? "",
      };
      const due = input.dueDate ? ` — due ${formatDay(input.dueDate)}` : "";
      const summary = `${input.title}${due}${assignee && assignee.id !== ctx.userId ? ` — for ${assignee.name}` : ""}${attached.label ? ` — on ${attached.label}` : ""}`;
      const proposal = await db.copilotProposal.create({
        data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "TASK", payload, summary },
        select: { id: true },
      });
      return {
        output: { proposed: true, note: "Shown to the user as a card. It is NOT created until they press Create." },
        blocks: [{ type: "proposal", id: proposal.id, kind: "TASK", summary, status: "PENDING" }],
        activity: "Drafted a task for you to confirm",
      };
    },
  }),

  tool({
    name: "propose_note",
    description:
      "Offer to make a private note on the person's note board, optionally with a reminder and linked to a company, lead or ticket. The user must press Save on the card — never say it has been saved.",
    module: "notes",
    schema: z.object({
      body: z.string().trim().min(1).max(2000),
      title: z.string().trim().max(80).optional(),
      remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().describe("India time, YYYY-MM-DDTHH:mm"),
      companyRef: z.string().max(60).optional(),
      leadRef: z.string().max(60).optional(),
      ticketRef: z.string().max(60).optional(),
    }),
    async run(ctx, input) {
      const attached = await attachments(ctx.userId, input);
      if ("error" in attached) return { output: { error: attached.error }, activity: "Couldn't draft the note" };
      const remindAt = input.remindAt ? parseIstDateTime(input.remindAt) : null;
      if (input.remindAt && !remindAt) return { output: { error: "That reminder time isn't valid." }, activity: "Couldn't draft the note" };
      const payload = {
        title: input.title ?? "",
        body: input.body,
        color: "YELLOW",
        // Always private: a note on everybody's board is a broadcast, and not the copilot's to make.
        visibility: "PRIVATE",
        pinned: false,
        remindAt: remindAt ? remindAt.toISOString() : "",
        companyId: attached.companyId ?? "",
        leadId: attached.leadId ?? "",
        ticketId: attached.ticketId ?? "",
      };
      const summary = `${input.title ? `${input.title}: ` : ""}${input.body.slice(0, 140)}${input.body.length > 140 ? "…" : ""}${remindAt ? ` — reminder ${formatIstDateTime(remindAt)}` : ""}${attached.label ? ` — on ${attached.label}` : ""}`;
      const proposal = await db.copilotProposal.create({
        data: { conversationId: ctx.conversationId, userId: ctx.userId, kind: "NOTE", payload, summary },
        select: { id: true },
      });
      return {
        output: { proposed: true, note: "Shown to the user as a card. It is NOT saved until they press Save." },
        blocks: [{ type: "proposal", id: proposal.id, kind: "NOTE", summary, status: "PENDING" }],
        activity: "Drafted a note for you to confirm",
      };
    },
  }),
];

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

/** The records a proposal hangs on, each resolved and checked the way the note board checks them. */
async function attachments(
  userId: string,
  input: { companyRef?: string; leadRef?: string; ticketRef?: string },
): Promise<{ companyId: string | null; leadId: string | null; ticketId: string | null; label: string | null } | { error: string }> {
  const companyId = input.companyRef ? await companyIdFor(userId, input.companyRef) : null;
  if (input.companyRef && !companyId) return { error: `No company ${input.companyRef} that this person can see.` };
  const leadId = input.leadRef ? await leadIdFor(input.leadRef) : null;
  const ticketId = input.ticketRef ? await ticketIdFor(input.ticketRef) : null;
  if ((input.leadRef && !leadId) || (input.ticketRef && !ticketId) || !(await mayAttachTo(userId, { companyId, leadId, ticketId }))) {
    return { error: "One of those records isn't there, or isn't one this person can see." };
  }
  const label = [input.companyRef, input.leadRef, input.ticketRef].filter(Boolean).join(", ") || null;
  return { companyId, leadId, ticketId, label };
}

// ─── Offering and running them ───────────────────────────────────────────────

export function toolSpec(t: CopilotTool): ToolSpec {
  const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  void $schema;
  return { name: t.name, description: t.description, parameters };
}

/** The tools this person may use, in a fixed order — a stable list keeps the model's cache warm. */
export async function toolsFor(): Promise<CopilotTool[]> {
  const on = await Promise.all(TOOLS.map((t) => (t.module ? isModuleEnabled(t.module) : Promise.resolve(true))));
  return TOOLS.filter((_, i) => on[i]);
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Runs one call: refused unless it is a tool this person was offered and its input fits the schema. */
export async function runTool(offered: CopilotTool[], ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome & { isError: boolean }> {
  const t = offered.find((x) => x.name === name);
  if (!t) return { output: { error: `There is no tool called ${name}.` }, activity: `Tried an unknown tool (${name})`, isError: true };
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { output: { error: `Invalid input: ${issue?.path.join(".") || "input"} — ${issue?.message ?? "didn't match"}` }, activity: `Retrying ${name}`, isError: true };
  }
  try {
    const outcome = await t.run(ctx, parsed.data as never);
    const error = typeof outcome.output === "object" && outcome.output !== null && "error" in outcome.output;
    return { ...outcome, isError: error };
  } catch (err) {
    console.error(`copilot tool ${name} failed`, err);
    return { output: { error: "That lookup failed on the server." }, activity: `${name} failed`, isError: true };
  }
}

/** A tool's answer as the model receives it — JSON, cut short if it would cost more than it tells. */
export function outputText(output: unknown): string {
  const text = JSON.stringify(output);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}… (cut short — narrow the question)` : text;
}

/** Today as India writes it, for the system prompt. */
export function indianToday(now = new Date()): string {
  const { year, month, day: d } = istDateParts(now);
  // `month` is 0-based, as Date has it.
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

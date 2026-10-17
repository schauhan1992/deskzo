import { z } from "zod";
import { moduleAccessFor } from "@/lib/modules-access";
import { runReportAs, type ReportRequest } from "@/lib/analytics/request";
import type { ReportResult } from "@/lib/analytics/run";
import { GRAINS, type FactSource } from "@/lib/analytics/types";
import { getSource } from "@/lib/analytics/sources";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { escapeHtml } from "@/lib/marketing/html";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { formatCurrency } from "@/lib/utils";
import type { Clock } from "@/lib/time/zone";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withOutsideEffect } from "@/lib/automate/effects";
import { activePerson, byWorkflow, personField } from "@/lib/automate/actions/shared";

/**
 * Email a report to colleagues (Deskzo Automate, Phase 2) — "every Monday, last week's won value by
 * salesperson to the sales heads". Colleagues only, never customers.
 *
 * Each person gets the report run **as them** (src/lib/analytics/request.ts), as if they had opened it
 * on the Reports page themselves: their own scope, their own fields, and nothing if Reports or the
 * report's module isn't theirs — so a workflow is never a way of sending somebody figures they couldn't
 * see. Somebody who can't is left out and named in the step's output; the run is logged as a report
 * run against each of them, as the page logs it.
 *
 * It goes through the company's mail server when one is set up for transactional mail, otherwise
 * Deskzo's alerts mail — as a notification email does.
 */

export const REPORT_PERIODS = ["yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_quarter", "last_quarter"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The period's first and last days, `yyyy-mm-dd` on the workspace's clock — both included, as on the Reports page. */
export function periodDays(clock: Clock, period: ReportPeriod, now: Date = new Date()): { from: string; to: string } {
  const t = clock.parts(now);
  const day = (y: number, m: number, d: number) => clock.dateKey(clock.at(y, m, d, 12));
  const quarter = Math.floor(t.month / 3) * 3;
  switch (period) {
    case "yesterday":
      return { from: day(t.year, t.month, t.day - 1), to: day(t.year, t.month, t.day - 1) };
    case "last_7_days":
      return { from: day(t.year, t.month, t.day - 7), to: day(t.year, t.month, t.day - 1) };
    case "last_30_days":
      return { from: day(t.year, t.month, t.day - 30), to: day(t.year, t.month, t.day - 1) };
    case "this_month":
      return { from: day(t.year, t.month, 1), to: day(t.year, t.month, t.day) };
    case "last_month":
      // Day 0 of a month is the last day of the one before.
      return { from: day(t.year, t.month - 1, 1), to: day(t.year, t.month, 0) };
    case "this_quarter":
      return { from: day(t.year, quarter, 1), to: day(t.year, t.month, t.day) };
    case "last_quarter":
      return { from: day(t.year, quarter - 3, 1), to: day(t.year, quarter, 0) };
  }
}

const PERIOD_LABELS: Record<ReportPeriod, string> = {
  yesterday: "yesterday",
  last_7_days: "the last 7 days",
  last_30_days: "the last 30 days",
  this_month: "this month so far",
  last_month: "last month",
  this_quarter: "this quarter so far",
  last_quarter: "last quarter",
};

const input = z
  .object({
    /** Which report: as the Reports page names them — "leads", "orders", "won value"… */
    source: z.string().trim().min(1).max(60),
    measure: z.string().trim().min(1).max(120),
    dimension: z.string().trim().min(1).max(120),
    column: z.string().trim().min(1).max(120).optional(),
    grain: z.enum(GRAINS.map((g) => g.key) as [string, ...string[]]).default("month"),
    /** Which date the window applies to; the report's own first date when not given. */
    dateField: z.string().trim().min(1).max(120).optional(),
    period: z.enum(REPORT_PERIODS).default("last_7_days"),
    filters: z.record(z.string(), z.array(z.string().max(200)).max(50)).optional(),
    /** Colleagues: "owner", or people's ids. */
    to: z.array(personField).min(1, "Say who gets it.").max(20).default(["owner"]),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => !/[\r\n]/.test(s), "The subject has to be one line.")
      .optional(),
  })
  .strict();

type Output = { period: { from: string; to: string }; sentTo: number; skipped: { userId: string; reason: string }[] };

type Prepared = { userId: string; name: string; email: string; subject: string; html: string; text: string };

const figure = (unit: ReportResult["unit"], n: number) => (unit === "currency" ? formatCurrency(n) : unit === "days" ? `${n.toFixed(1)} d` : n.toLocaleString("en-IN"));

/** The report as an email: a heading, the table, and what it is — the caveats the page shows included. */
function compose(source: FactSource<never>, request: ReportRequest, result: ReportResult, periodLabel: string, link: string, ownerName: string) {
  const measure = source.measures.find((m) => m.key === request.measure)?.label ?? request.measure;
  const labelOf = (key: string) => (key === "time" ? "Period" : (source.dimensions.find((d) => d.key === key)?.label ?? key));
  const title = `${measure} by ${labelOf(request.dimension).toLowerCase()} — ${periodLabel}`;
  const columns = result.columns.length > 1 || result.columns[0]?.key !== "__all__" ? result.columns : [];
  const cell = (v: string, head = false, right = false) => `<${head ? "th" : "td"} style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:${right ? "right" : "left"}">${escapeHtml(v)}</${head ? "th" : "td"}>`;
  const header = `<tr>${cell(labelOf(request.dimension), true)}${columns.map((c) => cell(c.label, true, true)).join("")}${cell("Total", true, true)}</tr>`;
  const body = result.rows
    .map((r) => `<tr>${cell(r.label)}${columns.map((c) => cell(figure(result.unit, r.cells[c.key] ?? 0), false, true)).join("")}${cell(figure(result.unit, r.total), false, true)}</tr>`)
    .join("");
  const total = `<tr>${cell("Total", true)}${columns.map((c) => cell(figure(result.unit, result.columnTotals[c.key] ?? 0), true, true)).join("")}${cell(figure(result.unit, result.grandTotal), true, true)}</tr>`;
  const notes = [
    `${source.label} · ${request.from} to ${request.to} · ${result.rowCount.toLocaleString("en-IN")} records · ${result.scopeNote}`,
    ...(result.truncated ? ["It hit the row ceiling — these are floors, not totals."] : []),
    ...(result.doubleCounted ? ["A record can fall in more than one row, so the rows add up to more than the total."] : []),
    `Sent by a workflow of ${ownerName}'s. Open the Reports page for the full picture: ${link}`,
  ];
  const html = [
    `<h2 style="font:600 18px system-ui,sans-serif;margin:0 0 12px">${escapeHtml(title)}</h2>`,
    `<table style="border-collapse:collapse;font:14px system-ui,sans-serif">${header}${body}${total}</table>`,
    ...notes.map((n) => `<p style="font:12px system-ui,sans-serif;color:#6b7280;margin:8px 0 0">${escapeHtml(n)}</p>`),
  ].join("\n");
  const text = [title, "", ...result.rows.map((r) => `${r.label}: ${figure(result.unit, r.total)}`), `Total: ${figure(result.unit, result.grandTotal)}`, "", ...notes].join("\n");
  return { title, html, text };
}

export const reportEmail = defineAction({
  key: "report.email",
  label: "Email a report",
  description: "Emails a report to colleagues, each seeing only what they could see on the Reports page.",
  module: "reports",
  permission: null,
  risk: "irreversible",
  input,
  outputs: ["period", "sentTo", "skipped"],
  preview: (i) => `Would email the ${i.source} report for ${PERIOD_LABELS[i.period]} to ${i.to.length} ${i.to.length === 1 ? "person" : "people"}.`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    const window = periodDays(ctx.clock, i.period);
    const owner = await activePerson(ctx, "owner", "workflow's owner");
    const link = `${await tenantOrigin()}/reports`;
    const source = getSource(i.source);
    if (!source) throw new ActionError("That report isn't one Deskzo has.", "PERMANENT");
    const prepared: Prepared[] = [];
    const skipped: Output["skipped"] = [];
    for (const who of [...new Set(i.to)]) {
      const person = await activePerson(ctx, who, "person to send the report to");
      if (!person.email) {
        skipped.push({ userId: person.id, reason: "No email address." });
        continue;
      }
      if ((await moduleAccessFor(person.id, "reports")) !== "available") {
        skipped.push({ userId: person.id, reason: "Reports aren't open to them." });
        continue;
      }
      const request: ReportRequest = {
        source: i.source,
        measure: i.measure,
        dimension: i.dimension,
        column: i.column,
        grain: i.grain as ReportRequest["grain"],
        dateField: i.dateField ?? source.dateFields[0]?.key ?? "",
        from: window.from,
        to: window.to,
        filters: i.filters,
      };
      // Run as them, and logged as run for them by the workflow — not as if they had opened it.
      const ran = await runReportAs({ id: person.id, name: person.name }, request, {
        moduleOn: async (key) => (await moduleAccessFor(person.id, key)) === "available",
        attributeTo: true,
        byline: byWorkflow(ctx),
      });
      if (!ran.ok) {
        skipped.push({ userId: person.id, reason: ran.error });
        continue;
      }
      const mail = compose(ran.data.source, request, ran.data.result, PERIOD_LABELS[i.period], link, owner.name);
      prepared.push({ userId: person.id, name: person.name, email: person.email, subject: i.subject ?? mail.title, html: mail.html, text: mail.text });
    }
    if (prepared.length === 0) throw new ActionError(`Nobody could be sent it: ${skipped.map((s) => s.reason).join(" ")}`, "PERMANENT");

    const company = await emailRouteFor("TRANSACTIONAL");
    const { output } = await withOutsideEffect<Output>(ctx, async () => {
      let sent = 0;
      let lastError = "";
      for (const p of prepared) {
        try {
          if (company) {
            const out = await deliverNow({ to: p.email, toName: p.name, fromName: owner.name, replyTo: owner.email, subject: p.subject, html: p.html, text: p.text }, "TRANSACTIONAL", { delivering: true });
            if (!out.ok) throw new Error(out.error);
          } else {
            await sendPlatformMail({ type: "ALERTS", to: p.email, subject: p.subject, text: p.text, html: p.html, logSubject: "A workspace's report" });
          }
          sent += 1;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          skipped.push({ userId: p.userId, reason: `Not sent: ${lastError}` });
        }
      }
      // Nobody got it: nothing went out, so it can be tried again. Somebody did: done, with who didn't.
      if (sent === 0) return { ok: false, error: `The report wasn't sent: ${lastError}`, kind: "TRANSIENT" };
      return { ok: true, output: { period: window, sentTo: sent, skipped } };
    });
    return output;
  },
});

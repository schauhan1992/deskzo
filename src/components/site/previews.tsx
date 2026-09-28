import type { ReactNode } from "react";
import type { PreviewKind } from "@/components/site/blocks/types";
import { SampleBadge } from "@/components/site/ui";
import { formatMoney } from "@/lib/billing/money";
import { cn } from "@/lib/utils";

/**
 * The product, drawn in HTML and CSS rather than screenshotted: the lead pipeline, a GST tax invoice
 * and a week's attendance, as the app shows them — with plainly made-up companies and people, and a
 * "Sample data" mark on each. Built from the theme's tokens, so each follows light and dark and the
 * brand colour, and none is an image to go stale.
 *
 * Each is one image to assistive technology (role="img" with a description): the sample figures are
 * decoration, not content.
 */

export function ProductPreview({ kind, framed = true, className }: { kind: PreviewKind; framed?: boolean; className?: string }) {
  if (kind === "invoice") return <InvoicePreview className={className} />;
  if (kind === "attendance") return <AttendancePreview framed={framed} className={className} />;
  return <PipelinePreview framed={framed} className={className} />;
}

/** An app window: a title bar, and the page inside. */
function Frame({ title, label, children, sidebar, className }: { title: string; label: string; children: ReactNode; sidebar?: boolean; className?: string }) {
  return (
    <div role="img" aria-label={label} className={cn("overflow-hidden rounded-2xl border border-line bg-surface shadow-lg", className)}>
      <div className="flex items-center gap-3 border-b border-line bg-surface-sunken px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
        </span>
        <span className="truncate text-xs font-medium text-muted">{title}</span>
        <SampleBadge className="ml-auto" />
      </div>
      <div className="flex">
        {sidebar && (
          <div className="hidden w-40 shrink-0 space-y-0.5 border-r border-line bg-surface-sunken p-3 text-[11px] md:block" aria-hidden="true">
            {["Companies", "Leads", "Quotes & invoices", "Orders", "Accounting", "People", "Tickets"].map((item) => (
              <div key={item} className={cn("rounded-md px-2 py-1.5", item === "Leads" ? "bg-brand-subtle font-medium text-brand" : "text-muted")}>
                {item}
              </div>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

const rupees = (value: number) => formatMoney(value * 100, "INR").replace(/\.00$/, "");

// ─── The lead pipeline ───────────────────────────────────────────────────────────────────────────

const PIPELINE: { stage: string; tone: string; cards: { company: string; value: number; owner: string; age: string }[] }[] = [
  {
    stage: "New",
    tone: "bg-chart-6",
    cards: [
      { company: "Acme Traders", value: 180_000, owner: "AS", age: "2d" },
      { company: "Harbour Logistics", value: 95_000, owner: "RI", age: "5d" },
    ],
  },
  {
    stage: "Qualified",
    tone: "bg-chart-1",
    cards: [
      { company: "Maple Textiles", value: 340_000, owner: "MK", age: "1w" },
      { company: "Nimbus Retail", value: 120_000, owner: "AS", age: "3d" },
    ],
  },
  {
    stage: "Proposal sent",
    tone: "bg-chart-3",
    cards: [
      { company: "Zenith Foods", value: 675_000, owner: "PN", age: "4d" },
      { company: "Cedar Engineering", value: 210_000, owner: "RI", age: "2w" },
    ],
  },
  {
    stage: "Negotiation",
    tone: "bg-chart-2",
    cards: [{ company: "Orbit Components", value: 940_000, owner: "MK", age: "6d" }],
  },
];

function PipelinePreview({ framed, className }: { framed: boolean; className?: string }) {
  return (
    <Frame title="Leads · Pipeline" label="Illustration: a lead pipeline board with sample companies in four stages" sidebar={framed} className={className}>
      <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 sm:p-4 lg:grid-cols-4">
        {PIPELINE.map((column, i) => (
          <div key={column.stage} className={cn("min-w-0 rounded-xl bg-surface-sunken p-2", i === 2 && "hidden sm:block", i === 3 && "hidden lg:block")}>
            <div className="flex items-center gap-1.5 px-1 pb-2">
              <span className={cn("h-2 w-2 rounded-full", column.tone)} aria-hidden="true" />
              <span className="truncate text-[11px] font-semibold text-text">{column.stage}</span>
              <span className="ml-auto text-[10px] text-subtle">{column.cards.length}</span>
            </div>
            <div className="space-y-2">
              {column.cards.map((card) => (
                <div key={card.company} className="rounded-lg border border-line bg-surface p-2.5 shadow-sm">
                  <div className="truncate text-[12px] font-medium text-text">{card.company}</div>
                  <div className="mt-1 text-[11px] tabular-nums text-muted">{rupees(card.value)}</div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-subtle text-[9px] font-semibold text-brand">{card.owner}</span>
                    <span className="text-[10px] text-subtle">{card.age}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ─── A GST tax invoice ───────────────────────────────────────────────────────────────────────────

const LINES = [
  { item: "Laptop, 14-inch", code: "8471", qty: 4, rate: 62_500 },
  { item: "Annual support plan", code: "998713", qty: 1, rate: 48_000 },
];

function InvoicePreview({ className }: { className?: string }) {
  const subtotal = LINES.reduce((sum, l) => sum + l.qty * l.rate, 0);
  const cgst = Math.round(subtotal * 0.09);
  const sgst = cgst;
  return (
    <div role="img" aria-label="Illustration: a GST tax invoice with sample figures, CGST and SGST, an e-invoice number and an e-way bill" className={cn("overflow-hidden rounded-2xl border border-line bg-surface shadow-lg", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-line p-4 sm:p-5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-subtle">Tax invoice</div>
          <div className="mt-1 truncate text-sm font-semibold text-text">Acme Traders Pvt Ltd</div>
          <div className="mt-0.5 text-[11px] text-muted">GSTIN 29AAAAA0000A1Z5 · Bengaluru</div>
        </div>
        <div className="shrink-0 text-right">
          <SampleBadge />
          <div className="mt-2 text-[11px] font-medium tabular-nums text-text">INV/26-27/0142</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-line bg-surface-sunken px-4 py-3 text-[11px] sm:px-5">
        <div className="min-w-0">
          <div className="text-subtle">Bill to</div>
          <div className="truncate font-medium text-text">Zenith Foods Pvt Ltd</div>
        </div>
        <div className="min-w-0">
          <div className="text-subtle">Place of supply</div>
          <div className="truncate font-medium text-text">Karnataka (29)</div>
        </div>
      </div>
      <div className="px-4 py-3 sm:px-5">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-line pb-2 text-[10px] font-semibold uppercase tracking-wider text-subtle">
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="w-20 text-right">Amount</span>
        </div>
        {LINES.map((l) => (
          <div key={l.item} className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-line py-2 text-[12px]">
            <span className="min-w-0">
              <span className="block truncate text-text">{l.item}</span>
              <span className="text-[10px] text-subtle">HSN/SAC {l.code}</span>
            </span>
            <span className="text-right tabular-nums text-muted">{l.qty}</span>
            <span className="w-20 text-right tabular-nums text-text">{rupees(l.qty * l.rate)}</span>
          </div>
        ))}
        <dl className="ml-auto mt-2 w-full max-w-[14rem] space-y-1 text-[12px]">
          {[
            ["Taxable value", subtotal],
            ["CGST 9%", cgst],
            ["SGST 9%", sgst],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular-nums text-text">{rupees(value as number)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold">
            <dt className="text-text">Total</dt>
            <dd className="tabular-nums text-text">{rupees(subtotal + cgst + sgst)}</dd>
          </div>
        </dl>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line bg-surface-sunken px-4 py-3 sm:px-5">
        <span className="rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-medium text-success">E-invoice IRN generated</span>
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-[10px] font-medium text-info">E-way bill ready</span>
      </div>
    </div>
  );
}

// ─── A week's attendance ─────────────────────────────────────────────────────────────────────────

type Mark = "P" | "W" | "H" | "L" | "A" | "O";
const MARKS: Record<Mark, { label: string; className: string }> = {
  P: { label: "Present", className: "bg-success-bg text-success" },
  W: { label: "From home", className: "bg-info-bg text-info" },
  H: { label: "Half day", className: "bg-brand-subtle text-brand" },
  L: { label: "On leave", className: "bg-warning-bg text-warning" },
  A: { label: "Absent", className: "bg-danger-bg text-danger" },
  O: { label: "Week off", className: "bg-surface-sunken text-subtle" },
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK: { name: string; marks: Mark[] }[] = [
  { name: "Asha S.", marks: ["P", "P", "W", "P", "P", "P", "O"] },
  { name: "Ravi I.", marks: ["P", "L", "L", "P", "P", "H", "O"] },
  { name: "Meera K.", marks: ["W", "P", "P", "P", "H", "P", "O"] },
  { name: "Sameer D.", marks: ["P", "P", "P", "A", "P", "P", "O"] },
  { name: "Priya N.", marks: ["P", "P", "P", "P", "W", "O", "O"] },
];

function AttendancePreview({ framed, className }: { framed: boolean; className?: string }) {
  const counts = WEEK.flatMap((w) => w.marks).reduce<Record<string, number>>((acc, m) => ({ ...acc, [m]: (acc[m] ?? 0) + 1 }), {});
  const body = (
    <div className="p-3 sm:p-4">
      <div className="grid grid-cols-[minmax(4.5rem,1fr)_repeat(7,minmax(1.5rem,2rem))] items-center gap-1 text-[10px]">
        <span />
        {DAYS.map((d) => (
          <span key={d} className="text-center font-medium text-subtle">
            {d}
          </span>
        ))}
        {WEEK.map((row) => (
          <div key={row.name} className="contents">
            <span className="truncate pr-1 text-[11px] font-medium text-text">{row.name}</span>
            {row.marks.map((m, i) => (
              <span key={i} className={cn("grid h-6 place-items-center rounded-md text-[10px] font-semibold", MARKS[m].className)}>
                {m === "O" ? "–" : m}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 text-[10px] text-muted">
        {(["P", "W", "H", "L", "A"] as Mark[]).map((m) => (
          <span key={m} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-sm", MARKS[m].className)} />
            {MARKS[m].label} {counts[m] ?? 0}
          </span>
        ))}
      </div>
    </div>
  );
  if (!framed) {
    return (
      <div role="img" aria-label="Illustration: a week of attendance for five sample people" className={cn("overflow-hidden rounded-2xl border border-line bg-surface shadow-lg", className)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-xs font-medium text-muted">People · Attendance</span>
          <SampleBadge />
        </div>
        {body}
      </div>
    );
  }
  return (
    <Frame title="People · Attendance" label="Illustration: a week of attendance for five sample people" className={className}>
      {body}
    </Frame>
  );
}

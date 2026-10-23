import { blankChart, type CalculatedField, type ChartKind, type ChartWidth, type DatePreset, type ReportChart, type ReportDefinition, type ReportFilter } from "./definition";

/**
 * Ready-made reports (Reporting & Analytics, owner 23 Oct 2026): layouts over the real sources, filled with the
 * workspace's own figures the moment one is used. Every field named here is one the source has
 * (src/lib/analytics/sources.ts, src/lib/reporting/extra-sources.ts) — check:reporting holds them to it — and a
 * template opens as a copy in the builder, so anything in it can be changed.
 */

export type TemplateCategory = "Receivables" | "Sales" | "Tax and compliance" | "Inventory" | "CRM" | "People";
export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Receivables", "Sales", "Tax and compliance", "Inventory", "CRM", "People"];

export type ReportTemplate = {
  key: string;
  name: string;
  description: string;
  category: TemplateCategory;
  definition: ReportDefinition;
};

type ChartOpts = Partial<Pick<ReportChart, "title" | "grain" | "limit" | "series" | "compare" | "showValues">> & {
  width?: ChartWidth;
  agg?: "sum" | "avg" | "min" | "max" | "count";
  more?: string[];
  sortBy?: "dimension" | "value";
  dir?: "asc" | "desc";
  filters?: ReportFilter[];
};

function chart(type: ChartKind, metric: string, dimension: string | null, o: ChartOpts = {}): ReportChart {
  // Its id is given by `def`, from where it sits — nothing here is state kept between calls.
  const base = blankChart("t", type, metric, dimension);
  return {
    ...base,
    title: o.title ?? "",
    metrics: [{ ref: metric, agg: o.agg ?? "sum" }, ...(o.more ?? []).map((ref) => ({ ref, agg: "sum" as const }))],
    grain: o.grain ?? "month",
    limit: o.limit === undefined ? base.limit : o.limit,
    series: o.series ?? null,
    compare: o.compare ?? base.compare,
    width: o.width ?? base.width,
    sort: { by: o.sortBy ?? base.sort.by, dir: o.dir ?? base.sort.dir },
    filters: o.filters ?? [],
    showValues: o.showValues ?? base.showValues,
  };
}

const score = (metric: string, title: string, compare: ReportChart["compare"] = "previousYear") => chart("score", metric, null, { title, compare, width: 3 });
const COLLECTION_RATE: CalculatedField = { id: "crate", label: "Collection rate", expression: "{received} / {net}", format: "percent" };
const AVG_INVOICE: CalculatedField = { id: "cavg", label: "Average invoice value", expression: "{net} / {count}", format: "currency" };
const isFilter = (field: string, values: string[]): ReportFilter => ({ id: "f", field, op: "in", values });

function def(source: string, dateField: string, preset: DatePreset, pages: { name: string; charts: ReportChart[] }[], calculated: CalculatedField[] = []): ReportDefinition {
  return {
    v: 1,
    source,
    dateField,
    dateRange: { preset },
    filters: [],
    calculated,
    pages: pages.map((p, i) => ({
      id: `p${i + 1}`,
      name: p.name,
      // Ids from position: the same template always makes the same ids, page by page and chart by chart.
      charts: p.charts.map((c, j) => ({ ...c, id: `p${i + 1}c${j + 1}`, filters: c.filters.map((f, k) => ({ ...f, id: `p${i + 1}c${j + 1}f${k + 1}` })) })),
    })),
  };
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: "receivables-review",
    name: "Receivables review",
    description: "Collections and outstanding balances across customers, branches and account managers.",
    category: "Receivables",
    definition: def(
      "invoices",
      "issueDate",
      "thisFy",
      [
        {
          name: "Summary",
          charts: [
            score("net", "Revenue"),
            score("received", "Amount received"),
            score("outstanding", "Outstanding"),
            score("calc:crate", "Collection rate"),
            chart("combo", "net", "time", { title: "Revenue and collection rate by month", more: ["calc:crate"], width: 7, limit: null }),
            chart("donut", "outstanding", "paymentStatus", { title: "Outstanding by payment status", width: 5, limit: 6 }),
          ],
        },
        {
          name: "Customers",
          charts: [
            chart("bar", "outstanding", "company", { title: "Customers with overdue balances", limit: 10, filters: [isFilter("paymentStatus", ["Overdue"])] }),
            chart("table", "net", "accountManager", { title: "Account manager performance", more: ["count", "outstanding", "calc:crate"], limit: 20 }),
          ],
        },
      ],
      [COLLECTION_RATE],
    ),
  },
  {
    key: "receivables-ageing",
    name: "Receivables ageing",
    description: "Outstanding by how long it is past due, customer and account manager.",
    category: "Receivables",
    definition: def("invoices", "issueDate", "thisFy", [
      {
        name: "Ageing",
        charts: [
          score("outstanding", "Outstanding", "none"),
          score("count", "Invoices", "none"),
          chart("column", "outstanding", "ageing", { title: "Outstanding by age past due", width: 6, sortBy: "dimension", dir: "asc", limit: null }),
          chart("bar", "outstanding", "company", { title: "Largest balances", width: 6, limit: 10 }),
          chart("pivot", "outstanding", "accountManager", { title: "Account manager by age", series: "ageing", width: 12, limit: 25 }),
        ],
      },
    ]),
  },
  {
    key: "monthly-sales",
    name: "Monthly sales summary",
    description: "Revenue, invoices and average invoice value month by month.",
    category: "Sales",
    definition: def(
      "invoices",
      "issueDate",
      "thisFy",
      [
        {
          name: "Summary",
          charts: [
            score("net", "Revenue"),
            score("count", "Invoices"),
            score("calc:cavg", "Average invoice value"),
            score("tax", "Tax collected"),
            chart("column", "net", "time", { title: "Revenue by month", width: 8, limit: null }),
            chart("line", "count", "time", { title: "Invoices by month", width: 4, limit: null }),
            chart("table", "net", "time", { title: "Month by month", more: ["count", "tax", "calc:cavg"], limit: null }),
          ],
        },
      ],
      [AVG_INVOICE],
    ),
  },
  {
    key: "branch-performance",
    name: "Branch performance",
    description: "Compare branches on revenue, collections and outstanding.",
    category: "Sales",
    definition: def(
      "invoices",
      "issueDate",
      "thisFy",
      [
        {
          name: "Branches",
          charts: [
            chart("bar", "net", "branch", { title: "Revenue by branch", limit: 10 }),
            chart("combo", "received", "branch", { title: "Collections and collection rate", more: ["calc:crate"], limit: 10 }),
            chart("pivot", "net", "branch", { title: "Branch revenue by month", series: "time", width: 12, limit: 20, sortBy: "value" }),
            chart("table", "net", "branch", { title: "Branch summary", more: ["received", "outstanding", "calc:crate"], limit: 20 }),
          ],
        },
      ],
      [COLLECTION_RATE],
    ),
  },
  {
    key: "top-customers",
    name: "Top customers",
    description: "Revenue ranking with what each customer has paid and still owes.",
    category: "Sales",
    definition: def(
      "invoices",
      "issueDate",
      "thisFy",
      [
        {
          name: "Customers",
          charts: [
            chart("bar", "net", "company", { title: "Top customers by revenue", limit: 10 }),
            chart("donut", "net", "industry", { title: "Revenue by industry", limit: 6 }),
            chart("table", "net", "company", { title: "Customer ranking", more: ["received", "outstanding", "calc:crate"], limit: 25 }),
          ],
        },
      ],
      [COLLECTION_RATE],
    ),
  },
  {
    key: "orders-by-product",
    name: "Order value by product",
    description: "What sold — by brand, category, salesperson and month — with margin where a cost is on file.",
    category: "Sales",
    definition: def("orders", "createdAt", "thisFy", [
      {
        name: "Products",
        charts: [
          score("value", "Order value"),
          score("margin", "Margin"),
          score("count", "Orders"),
          score("quantity", "Quantity"),
          chart("bar", "value", "brand", { title: "Order value by brand", limit: 10 }),
          chart("donut", "value", "category", { title: "Order value by category", limit: 6 }),
          chart("column", "value", "time", { title: "Order value by month", width: 12, limit: null }),
          chart("table", "value", "salesperson", { title: "Salesperson performance", more: ["margin", "count"], limit: 20 }),
        ],
      },
    ]),
  },
  {
    key: "gst-summary",
    name: "GST summary",
    description: "Tax collected by month and place of supply, ready to check against filing.",
    category: "Tax and compliance",
    definition: def("invoices", "issueDate", "thisFy", [
      {
        name: "GST",
        charts: [
          score("tax", "Tax collected"),
          score("net", "Invoiced"),
          chart("column", "tax", "time", { title: "Tax by month", width: 6, limit: null }),
          chart("bar", "tax", "placeOfSupply", { title: "Tax by place of supply", width: 6, limit: 15 }),
          chart("table", "net", "time", { title: "Month by month", more: ["tax"], limit: null }),
        ],
      },
    ]),
  },
  {
    key: "stock-by-warehouse",
    name: "Stock by warehouse",
    description: "What is on hand today, at cost — by warehouse, category and item.",
    category: "Inventory",
    definition: def("stock", "updatedAt", "thisFy", [
      {
        name: "Stock",
        charts: [
          score("value", "Stock value", "none"),
          score("quantity", "Quantity on hand", "none"),
          chart("bar", "value", "warehouse", { title: "Stock value by warehouse", limit: 10 }),
          chart("donut", "value", "category", { title: "Stock value by category", limit: 6 }),
          chart("table", "value", "item", { title: "Items by value", more: ["quantity"], limit: 50 }),
        ],
      },
    ]),
  },
  {
    key: "pipeline-by-stage",
    name: "Pipeline by stage",
    description: "Open deals and their estimated value by stage, owner and source.",
    category: "CRM",
    definition: def("leads", "createdAt", "thisFy", [
      {
        name: "Pipeline",
        charts: [
          score("count", "Leads"),
          score("value", "Estimated value"),
          score("won", "Won"),
          score("wonValue", "Won value"),
          chart("donut", "count", "status", { title: "Leads by stage", limit: 8 }),
          chart("bar", "value", "owner", { title: "Estimated value by owner", limit: 10 }),
          chart("column", "count", "time", { title: "New leads by month", width: 8, limit: null }),
          chart("bar", "count", "source", { title: "Leads by source", width: 4, limit: 8 }),
        ],
      },
    ]),
  },
  {
    key: "support-load",
    name: "Support load",
    description: "Tickets raised and resolved, by priority and assignee, with time to resolve.",
    category: "CRM",
    definition: def("tickets", "createdAt", "last90", [
      {
        name: "Support",
        charts: [
          score("count", "Tickets raised", "previousPeriod"),
          score("open", "Still open", "previousPeriod"),
          score("resolutionDays", "Days to resolve", "previousPeriod"),
          chart("column", "count", "time", { title: "Tickets by week", grain: "week", width: 8, limit: null }),
          chart("donut", "count", "priority", { title: "Tickets by priority", width: 4, limit: 6 }),
          chart("table", "count", "assignee", { title: "Assignee workload", more: ["resolved", "resolutionDays"], limit: 20 }),
        ],
      },
    ]),
  },
  {
    key: "field-visits",
    name: "Field visits",
    description: "Visits planned and completed, by person and purpose.",
    category: "CRM",
    definition: def("visits", "scheduledFor", "last90", [
      {
        name: "Visits",
        charts: [
          score("count", "Visits", "previousPeriod"),
          score("completed", "Completed", "previousPeriod"),
          chart("bar", "count", "person", { title: "Visits by person", limit: 10 }),
          chart("donut", "count", "purpose", { title: "Visits by purpose", limit: 6 }),
          chart("column", "count", "time", { title: "Visits by week", grain: "week", width: 12, limit: null }),
        ],
      },
    ]),
  },
  {
    key: "collections-by-salesperson",
    name: "Collections by salesperson",
    description: "Money received by month, method, who recorded it and customer.",
    category: "Receivables",
    definition: def("payments", "paidOn", "thisFy", [
      {
        name: "Collections",
        charts: [
          score("amount", "Collected"),
          score("count", "Receipts"),
          chart("column", "amount", "time", { title: "Collections by month", width: 8, limit: null }),
          chart("donut", "amount", "method", { title: "By method", width: 4, limit: 6 }),
          chart("table", "amount", "company", { title: "Collections by customer", more: ["count"], limit: 25 }),
        ],
      },
    ]),
  },
  {
    key: "expense-split",
    name: "Expense split by department",
    description: "Claims by category, department and person, quarter to date.",
    category: "People",
    definition: def("expenses", "spentOn", "thisQuarter", [
      {
        name: "Expenses",
        charts: [
          score("amount", "Claimed", "previousPeriod"),
          score("count", "Claims", "previousPeriod"),
          chart("donut", "amount", "category", { title: "By category", limit: 6 }),
          chart("bar", "amount", "department", { title: "By department", limit: 10 }),
          chart("table", "amount", "person", { title: "By person", more: ["count"], limit: 25 }),
        ],
      },
    ]),
  },
];

export const templateByKey = (key: string) => REPORT_TEMPLATES.find((t) => t.key === key);

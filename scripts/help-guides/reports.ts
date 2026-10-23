import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Reports — written from src/app/(dashboard)/reports (the overview, the builder, the viewer, the library, the
 * templates and the explorer with its printable sheet), src/components/reporting and src/components/reports,
 * src/actions/reporting.ts (saved reports: who may open, edit, share and download them) and
 * src/actions/analytics.ts (the explorer), src/lib/reporting (the sources a report can read, its definition,
 * calculated fields and templates), src/lib/analytics/sources.ts (every record, figure and breakdown, and whose
 * rows each reads) and src/lib/analytics/custom.ts (the workspace's own fields).
 */
export const guide: SeedGuide = {
  slug: "help/reports",
  title: "Reports",
  seo: {
    title: "Reports: build, save and share live reports",
    description: "How to build a report in {siteName}: pick a source, add charts, filters and calculated fields, then save it, share it with colleagues and download a chart as a CSV.",
    keywords: ["report builder", "custom reports", "sales reports"],
  },
  guide: {
    module: "reports",
    heading: "Reports",
    summary:
      "Reporting & Analytics: saved reports of charts over your invoices, payments, expense claims, stock, orders, leads, tickets and field visits — built in a drag-free builder, shared with colleagues who each see only their own rows — plus the explorer for any figure broken down by anything else.",
    purpose: [
      p(
        runs(
          "A report is a set of pages of charts over one source of records. The ",
          { b: "Reports" },
          " overview shows four headline figures from the sources you can open, your favourite reports, what you opened lately and who changed which report. From there you can build a report from scratch, start from a template, or open one somebody shared with you.",
        ),
      ),
      p("What a report can read, and some of what it can show:"),
      table(
        ["Source", "Figures", "Break down by, for example"],
        [
          ["Invoices", "Invoiced (net of credit notes), Tax, Amount received, Outstanding, Number of documents", "Customer, Account manager, Branch, Payment status, Age past due, Place of supply"],
          ["Payments received", "Amount collected, Number of receipts", "Customer, Account manager, Method, Recorded by"],
          ["Expense claims", "Amount claimed, Tax on claims, Number of claims", "Category, Status, Claimed by, Department, Paid by, Reimbursable"],
          ["Stock on hand", "Quantity on hand, Stock value (at cost), Stock lines", "Warehouse, Item, Item category, Brand, Product family"],
          ["Sales orders", "Order value, Margin, Quantity, Number of orders", "Salesperson, Customer, Brand, Product family, Product category"],
          ["Leads and deals", "Number of leads, Estimated value, Won, Won value, Lost", "Lead source, Status, Owner, Industry, Lost reason"],
          ["Tickets", "Tickets raised, Tickets resolved, Still open, Average days to resolve", "Priority, Status, Assigned to, Customer"],
          ["Field visits", "Visits, Completed, Distance (km)", "Person, Purpose, Status, Customer"],
        ],
      ),
      p(
        runs(
          "Every source but Stock on hand can also be charted over ",
          { b: "time" },
          " — by day, week, month, quarter or year. Stock on hand is a snapshot of today, so no date range applies to it. The workspace's own custom fields appear among the breakdowns and figures too.",
        ),
      ),
      p(
        runs(
          "The ",
          { b: "Explorer" },
          " is still there for a one-off question: pick the records, a figure and a breakdown, run it, and download a CSV or print it.",
        ),
      ),
    ],
    access: [
      p("Everybody can open Reports while the module is on, but a report never shows more than the person looking at it could see elsewhere:"),
      ul(
        "A source is offered only while its module is switched on for you and you may see those records — Invoices needs View quotes & invoices, Stock on hand needs one of the inventory permissions such as See stock, Leads and deals needs View leads, and so on. A source you can't open is shown locked, with the reason, and none of its fields are sent to you.",
        "The rows follow the same rules as the module's own screens. Somebody who sees only their own and their team's accounts gets a report on those, and every report says whose records it covers.",
        "A saved report is yours until you share it. Shared with a person or a department, it can be opened — to view, or to edit if you allow it — but sharing gives the report, never the data: each person sees the rows their own role allows, so the same report can show them different totals.",
        "Somebody a report is shared with who can't open its source sees that it reads a source their role can't open, and can ask you for access. Access itself is given in their role or permissions, not by the report.",
        "Only the person who made a report can share or delete it.",
      ),
      p("Downloading a chart as a CSV needs an export permission on top: Export customer data for orders, leads, tickets and visits, and Export financial data for invoices, payments, expense claims and stock. Every download is recorded in the activity log."),
    ],
    permissions: [
      perm("section.reports", "Shows Reports in the menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("documents.view", "Offers Invoices as a source. The Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("payments.view", "Offers Payments received as a source. The Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("expenses.viewAll", "Expense claims cover everybody's claims instead of only your own and your team's."),
      perm("inventory.view", "Offers Stock on hand as a source (so does any other inventory permission). The Accounts, Management, Purchase and Sales roles have it by default."),
      perm("orders.view", "Offers Sales orders as a source. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("leads.view", "Offers Leads and deals as a source. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("tickets.view", "Offers Tickets as a source. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("visits.view", "Offers Field visits as a source. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("fields.seeRestricted", "Offers the custom fields marked restricted as breakdowns, filters and figures. Without it they aren't offered at all."),
      perm("data.exportCrm", "Lets you download a chart or explorer result over orders, leads, tickets or field visits. No role has it by default."),
      perm("data.exportFinance", "Lets you download a chart or explorer result over invoices, payments, expense claims or stock. No role has it by default."),
    ],
    setup: [
      p("There is nothing to set up: Reports reads the records the other modules keep, so it's useful as soon as they hold data."),
      p(
        runs(
          "To report by something of your own — a region, a contract type — an admin adds it as a custom field in ",
          { b: "Settings › Custom fields" },
          ". It turns up in Reports on its own. Reports also needs the Workspace module, whose filters the explorer uses to narrow which accounts are counted.",
        ),
      ),
    ],
    tasks: [
      task(
        "Create a report",
        ol(
          runs("Open ", { b: "Performance › Reports" }, " and select ", { b: "Create report" }, "."),
          runs("Choose a ", { b: "Data source" }, ". The panel beside the list shows how many of its rows you can see and its fields."),
          runs("Choose a ", { b: "Starting point" }, ": a blank report, or one of the templates for that source."),
          runs("Under ", { b: "Details" }, ", name it, pick its date range and choose who can see it — only you, or your department to view or to edit. Select ", { b: "Create report" }, " and the builder opens on it."),
        ),
        p(runs("Or open ", { b: "Report templates" }, ", pick one and select ", { b: "Use template" }, ". A template is a starting layout; the report you make from it is yours to change.")),
      ),
      task(
        "Build it",
        ol(
          runs("Select ", { b: "Add chart" }, " and pick a kind: Score, Column, Bar, Line, Area, Combo, Pie, Donut, Table or Pivot. Or click a field on the left: a figure starts a score, a breakdown a chart broken down by it."),
          runs("Select a chart to set it up on the right, under ", { b: "Setup" }, ": its dimension, its metrics and how each is totalled (Sum, Average, Min, Max or Count, as the figure allows), the sort, how many to show, a comparison with last year or the period before for a score, and a date range of its own if it shouldn't follow the report's."),
          runs("Under ", { b: "Style" }, ", give it a title and a width, and turn the legend and values on or off."),
          runs("Use the page tabs to split the report into pages, and ", { b: "Undo" }, " and ", { b: "Redo" }, " (Ctrl+Z, Ctrl+Shift+Z) to step back and forth."),
          runs("Select ", { b: "Save" }, " (Ctrl+S). The header says when it was saved, or that there are unsaved changes; leaving with unsaved changes asks first."),
        ),
        note("If somebody else saved the report after you opened it, your save is refused rather than overwriting theirs. Your changes stay on screen until you reload."),
      ),
      task(
        "Filter a report",
        ol(
          runs("Select ", { b: "Add filter" }, " and choose a field."),
          runs("For a breakdown, pick the values to include or exclude from the list — it shows only values from rows you can see, with how many rows have each — or set a text condition such as contains or starts with."),
          runs("For a figure, set a condition on each record's own amount: greater than, less than, between and so on."),
          runs("Choose whether it applies to the ", { b: "Whole report" }, " or ", { b: "This chart only" }, ". A chart with filters of its own is marked with how many."),
        ),
      ),
      task(
        "Add a calculated field",
        ol(
          runs("In the builder, select ", { b: "New calculated field" }, "."),
          runs("Name it and write the calculation from the source's figures, numbers, + − × ÷ and brackets — for example a collection rate as amount received divided by invoiced. It is checked as you type."),
          runs("Choose to show it as rupees, a number or a percentage, and add it to a chart like any other figure."),
        ),
        note("A calculated field is worked out on each group's totals, so a collection rate by month is that month's received over that month's invoiced."),
      ),
      task(
        "Read, narrow and share a report",
        ul(
          runs("Open a report from the overview, ", { b: "My reports" }, " or ", { b: "Shared with me" }, ". Each chart runs as you, on your own rows."),
          "Change the date range or add a filter of your own to look at it differently — nothing you change while reading is saved to the report.",
          "Click a bar, a slice or a row to narrow every chart on the page to it; select the chip's cross, or Reset, to undo it.",
          runs("Star a report to add it to your favourites. The owner can select ", { b: "Share" }, " to add people or departments, each able to view or edit, or copy its link."),
        ),
      ),
      task(
        "Download a chart",
        ol(
          runs("In the viewer or the builder, select ", { b: "Export" }, " and pick the chart, or use the chart's own menu."),
          "The CSV carries the figures the chart shows, with the report, the window, whose records were counted and any filters at the top.",
        ),
      ),
      task(
        "Explore any figure",
        ol(
          runs("Open ", { b: "Performance › Explorer" }, "."),
          runs("Choose what to ", { b: "Report on" }, ", the ", { b: "Measure" }, " and what to ", { b: "Break down by" }, ", optionally a second breakdown in ", { b: "Across (optional)" }, ", the date it is ", { b: "Dated on" }, " and the window, then ", { b: "Run report" }, "."),
          runs("Select ", { b: "CSV" }, " to download every row, or ", { b: "Generate report" }, " to open a printable sheet and ", { b: "Print or save as PDF" }, "."),
        ),
      ),
    ],
    settings: [
      setting(
        "Data source and date range",
        "When you create a report, and in the builder",
        p("What the report reads, fixed once it is made — duplicate it to start one over another source — and its default window, which a chart can override and a reader can change for their own look."),
      ),
      setting(
        "Sharing",
        "Share, in the viewer or the builder",
        p("Who else can open the report and whether they can change it. Only its owner can change this."),
      ),
      setting(
        "Custom fields",
        "Settings › Custom fields",
        p("The workspace's own fields. Those on the records a report reaches appear as breakdowns and filters, and number or money fields on the record itself as figures. A retired field isn't offered."),
      ),
    ],
    faq: [
      qa(
        "I can't see Reports in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules (Reports needs the Workspace module on too), and the menu section is in Settings › Roles & Permissions."),
      ),
      qa(
        "A source is locked when I create a report.",
        p("Its module is switched off for you, or your role can't see those records — Stock on hand, for example, needs an inventory permission. The card says what it needs."),
      ),
      qa(
        "My totals are smaller than a colleague's on the same report.",
        p("You're each seeing the records you're allowed to see. Under the report's date range it says whose records were counted."),
      ),
      qa(
        "A report shared with me says No access.",
        p("It reads a source your role can't open. Select Request access and its owner is told; an admin gives the access in your role or permissions."),
      ),
      qa(
        "A chart says it isn't set up yet.",
        p("It needs something before it can draw — a metric, a dimension to break it down by, or for a combo two metrics. Select it and the setup panel shows what's missing."),
      ),
      qa("Why do the parts add up to more than the total?", p("The breakdown lets one record fall in several groups — a customer with two tags — and it's counted in each. The chart says so underneath.")),
      qa(
        "Downloading says I can read this report but not download it.",
        p("Downloading needs Export customer data or Export financial data, depending on the source. Ask an admin."),
      ),
    ],
    related: ["workspace", "orders", "sales_documents", "leads"],
  },
};

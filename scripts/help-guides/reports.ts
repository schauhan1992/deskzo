import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Reports — written from src/app/(dashboard)/reports (the explorer and the printable sheet),
 * src/components/reports (the explorer, its filters and charts), src/actions/analytics.ts (what each
 * person may report on, and the CSV's export permissions), src/lib/analytics/sources.ts (every record,
 * figure and breakdown on offer, and whose rows each reads) and src/lib/analytics/custom.ts (the
 * workspace's own fields).
 */
export const guide: SeedGuide = {
  slug: "help/reports",
  title: "Reports",
  seo: {
    title: "Reports: break any figure down by anything",
    description: "How to build a report in {siteName}: pick the records, the figure and the breakdown, filter it, chart it, then download a CSV or print it as a PDF.",
    keywords: ["sales reports", "custom reports", "report builder"],
  },
  guide: {
    module: "reports",
    heading: "Reports",
    summary:
      "One screen for any figure broken down by anything else — orders by salesperson, invoices by month, tickets by priority — with filters, charts, a CSV download and a printable sheet.",
    purpose: [
      p(
        runs(
          "Reports is one screen rather than a list of fixed reports. You choose what to report on, the figure you want and what to break it down by — every combination works, so there's nothing to request and nothing to wait for. Add a second breakdown under ",
          { b: "Across (optional)" },
          " and the result becomes a cross-tab: salespeople down the side, months across the top.",
        ),
      ),
      p("What you can report on, and some of the ways to break it down:"),
      table(
        ["Report on", "Figures", "Break down by, for example"],
        [
          ["Orders", "Order value, Margin, Quantity, Number of orders", "Salesperson, Customer, Brand, Product family, Product category, New vs renewal, Vendor, City"],
          ["Leads", "Number of leads, Estimated value, Won, Won value, Lost", "Lead source, Status, Owner, Sourced by, Industry, Lost reason"],
          ["Tickets", "Tickets raised, Tickets resolved, Still open, Average days to resolve", "Priority, Status, Assigned to, Customer"],
          ["Invoices", "Invoiced (net of credit notes), Tax, Number of documents", "Customer, Account manager, Document type, Status, Place of supply"],
          ["Payments", "Amount collected, Number of receipts", "Customer, Account manager, Method, Recorded by"],
          ["Field visits", "Visits, Completed, Distance (km)", "Person, Purpose, Status, Customer"],
        ],
      ),
      p(
        runs(
          "Every one can also be broken down by ",
          { b: "Time" },
          " — by day, week, month, quarter or year — and by the workspace's own custom fields, listed under their own heading: a field like Region on your companies becomes something to break down by, and a number or money field on the record itself (an order's own field, say) becomes a figure to add up.",
        ),
      ),
    ],
    access: [
      p("Everybody can open Reports while the module is on, but a report never shows more than the person running it could see elsewhere:"),
      ul(
        "Each kind of record is offered only while its module is switched on and you may see it — Orders needs View orders, Invoices needs View quotes & invoices, and so on.",
        "The rows follow the same rules as the module's own screens. Somebody who sees only their own and their team's accounts gets a report on those, and every result says whose records it covers.",
        "A restricted custom field is only offered to people who may see restricted custom fields.",
        "A printed sheet sent to a colleague shows them what they may see, not what the sender could.",
      ),
      p("Downloading a CSV needs an export permission on top: Export customer data for orders, leads, tickets and visits, and Export financial data for invoices and payments."),
    ],
    permissions: [
      perm("section.reports", "Shows Reports in the menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("orders.view", "Offers Orders under Report on. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("leads.view", "Offers Leads under Report on. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("documents.view", "Offers Invoices under Report on. The Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("payments.view", "Offers Payments under Report on. The Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("tickets.view", "Offers Tickets under Report on. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("visits.view", "Offers Field visits under Report on. The Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default."),
      perm("fields.seeRestricted", "Offers the custom fields marked restricted as breakdowns, filters and figures. Without it they aren't offered at all."),
      perm("data.exportCrm", "Lets the CSV button download a report on orders, leads, tickets or field visits. No role has it by default."),
      perm("data.exportFinance", "Lets the CSV button download a report on invoices or payments. No role has it by default."),
    ],
    setup: [
      p("There is nothing to set up: Reports reads the records the other modules keep, so it's useful as soon as they hold data."),
      p(
        runs(
          "To report by something of your own — a region, a contract type — an admin adds it as a custom field in ",
          { b: "Settings › Custom fields" },
          ". It turns up in Reports on its own. Reports also needs the Workspace module, whose filters it uses to narrow which accounts are counted.",
        ),
      ),
    ],
    tasks: [
      task(
        "Build a report",
        ol(
          runs("Open ", { b: "Performance › Reports" }, "."),
          runs("Choose what to ", { b: "Report on" }, ", the ", { b: "Measure" }, " (the figure), and what to ", { b: "Break down by" }, "."),
          runs("Optionally pick a second breakdown in ", { b: "Across (optional)" }, ". When either breakdown is ", { b: "Time" }, ", choose the ", { b: "Grain" }, " — Day, Week, Month, Quarter or Year."),
          runs("Choose which date the records are ", { b: "Dated on" }, " — an order's ", { b: "Punched on" }, ", ", { b: "Starts on" }, " or ", { b: "Expires on" }, ", for example — and set ", { b: "From" }, " and ", { b: "To" }, ". It starts on this month to date."),
          runs("Select ", { b: "Run report" }, "."),
        ),
      ),
      task(
        "Narrow a report with filters",
        ol(
          runs("Select ", { b: "Add filters" }, " before you run it."),
          runs("In the first panel — ", { b: "Which orders" }, ", ", { b: "Which leads" }, " and so on — pick the values to count: only some brands, one city, a few salespeople. It narrows what is counted."),
          runs("For records tied to a customer, the ", { b: "Which accounts" }, " panel narrows which accounts are included at all, with the same filters as a Workspace list."),
          runs("Each filter shows as a chip under the panels; select one to remove it, or ", { b: "Clear" }, " for all. Then select ", { b: "Run report with" }, " the number of filters."),
        ),
        p("You can also select a row's name in a result to filter to it, and run again — the quickest way from “by brand” to “just this brand”."),
      ),
      task(
        "Read the result",
        ul(
          "The heading names the figure and the breakdown, with the total and how many rows. Beside it, a note says whose records were counted — every account, or only yours and your team's.",
          "If filters removed rows, it says how many, so you know the totals are for what's left.",
          "A breakdown where one record can sit in several rows — a customer with two tags — counts it in each, so the rows add up to more than the total. The report says so.",
          "With too many columns for a cross-tab, the extra ones are gathered into one; their figures are still in every total.",
          "A very wide question can hit the report's row ceiling. It then says the figures are floors, not totals — narrow the dates.",
        ),
      ),
      task(
        "Chart it",
        p(
          runs(
            "Above the table, ",
            { b: "Table" },
            ", ",
            { b: "Columns" },
            ", ",
            { b: "Line" },
            ", ",
            { b: "Bars" },
            " and ",
            { b: "Share" },
            " show the same result different ways. ",
            { b: "Stacked" },
            " appears when the report has an ",
            { b: "Across" },
            " breakdown.",
          ),
        ),
      ),
      task(
        "Download or print a report",
        ol(
          runs("Run the report."),
          runs("Select ", { b: "CSV" }, " to download every row, or ", { b: "Generate report" }, " to open a printable sheet in a new tab."),
          runs("On the sheet, select ", { b: "Print or save as PDF" }, "."),
        ),
        note("The table on screen draws a limited number of rows and says so underneath; the CSV and the printed sheet carry them all."),
      ),
    ],
    settings: [
      setting(
        "Report on, Measure and Break down by",
        "On the Reports screen",
        p("What is counted, which figure is added up, and how the rows are grouped. Changing what you report on changes the figures and breakdowns on offer, since each kind of record has its own."),
      ),
      setting(
        "Dated on, From and To",
        "On the Reports screen",
        p("Which of the record's dates the window applies to, and the window itself. A record outside the window isn't counted at all, whatever it's broken down by."),
      ),
      setting(
        "Custom fields",
        "Settings › Custom fields",
        p("The workspace's own fields. Those on the records a report reaches — the customer behind an order or a lead, for example — appear as breakdowns and filters, and number or money fields on the record itself as figures. A retired field isn't offered."),
      ),
    ],
    faq: [
      qa(
        "I can't see Reports in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules (Reports needs the Workspace module on too), and the menu section is in Settings › Roles & Permissions."),
      ),
      qa(
        "Something I want to report on isn't in Report on.",
        p("Its module is switched off, or you don't have the permission to see those records — for example View payments for Payments. If none are available, the screen says no reportable modules are switched on."),
      ),
      qa(
        "My totals are smaller than a colleague's for the same report.",
        p("You're each seeing the records you're allowed to see. The note beside the result's heading says whose records were counted."),
      ),
      qa("Why do the rows add up to more than the total?", p("The breakdown lets one record fall in several rows — tags, for example — and it's counted in each. The total counts it once.")),
      qa(
        "Why is the margin lower than I expected?",
        p("Margin is the sale price less the purchase price on file. Order lines with no purchase price recorded add nothing, rather than counting the whole sale as profit."),
      ),
      qa(
        "The CSV button says I can read this report but not download it.",
        p("Downloading needs Export customer data or Export financial data, depending on what you're reporting on. Ask an admin."),
      ),
    ],
    related: ["workspace", "orders", "sales_documents", "leads"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Revenue & Close — written from src/app/(dashboard)/accounting/revenue (schedules, review,
 * roll-forward, the opening wizard, a schedule, the waterfall), accounting/schedules and
 * accounting/close, settings/revenue-close and settings/close-checklist, src/components/revenue and
 * src/components/close, src/actions/revenue.ts, revenue-screens.ts, accounting-schedules.ts and
 * close.ts (who may do what), src/lib/close (the default checklist, the nightly job, the settings'
 * defaults) and the revenue.* and close.* entries in src/lib/permissions.ts.
 */
export const guide: SeedGuide = {
  slug: "help/revenue-and-close",
  title: "Revenue & Close",
  seo: {
    title: "Revenue & Close: revenue recognition and the month-end close",
    description: "Recognise subscription and service revenue as it is earned (Ind AS 115), spread prepaids and accruals, and work a month-end checklist before locking the month.",
    keywords: ["revenue recognition", "month-end close", "deferred revenue"],
  },
  guide: {
    module: "revenue_close",
    heading: "Revenue & Close",
    summary:
      "Revenue recognised as it is earned rather than when it is invoiced (Ind AS 115), prepaid and accrued costs spread over their months, and a month-end checklist that mostly checks itself before the month is locked.",
    purpose: [
      p(
        runs(
          "Revenue & Close sits on top of ",
          ["Accounting", "/help/accounting"],
          " and does two jobs. The first is revenue recognition. When an invoice line has a ",
          { b: "Service period" },
          " that runs past its month — a subscription, an annual support contract — issuing the invoice makes a revenue schedule: the revenue waits in Deferred Revenue and moves into Sales month by month. A project stage invoiced before its work is delivered waits until its delivery milestone is done. The invoice line then says how it is recognised, with a link to its schedule.",
        ),
      ),
      p(
        "The second is the month-end close. Prepaid costs (a year's insurance paid up front) and accrued costs (an audit fee whose bill comes later) are spread over the months they belong to. Each month gets a checklist, and most of its tasks check themselves — bank reconciled, revenue recognised, receivables agreeing with the ledger. Large movements against last month are explained on the Flux tab, and closing the month locks the books to its last day.",
      ),
      note(
        "Revenue & Close is for workspaces in India and needs Accounting. Its months follow India's calendar, and it applies Ind AS 115 the way this guide describes — it isn't advice on how your contracts should be treated.",
      ),
    ],
    access: [
      p("Revenue & Close is for the finance team. Its pages open with two pairs of permissions:"),
      ul(
        runs(
          { b: "Revenue" },
          " and ",
          { b: "Revenue Waterfall" },
          " — reading them needs ",
          { b: "See revenue schedules and deferred revenue" },
          " (Accounts and Management by default). Anything that moves money between months — recognising, approving, editing or cancelling a schedule, opening deferred revenue — needs ",
          { b: "Manage revenue recognition" },
          ", which no role has by default.",
        ),
        runs(
          { b: "Prepaids & Accruals" },
          " and ",
          { b: "Month-end Close" },
          " — working them needs ",
          { b: "Work the month-end close" },
          " (the Accounts role by default). Changing the checklist and the settings, making or stopping a prepaid or accrual, and closing or reopening a month need ",
          { b: "Run the month-end close" },
          ", which no role has by default.",
        ),
      ),
      p(
        "Two people are involved in anything done by hand. A schedule made or changed by hand recognises nothing until somebody else with Manage revenue recognition approves it — only the super admin may approve their own, and the audit log records that. Closing a month also needs Lock periods and close the year, because it moves the period lock.",
      ),
    ],
    permissions: [
      perm("section.revenueClose", "Shows Revenue & Close's pages in the Accounting menu. Every role has it until an admin unticks it for one; each page still needs a permission below."),
      perm(
        "revenue.viewReports",
        "Opens Revenue (its Schedules, Review and Roll-forward tabs), the Revenue Waterfall and each schedule. Read-only: nothing here moves money. The Accounts and Management roles have it by default.",
      ),
      perm(
        "revenue.manage",
        "Adds Recognise through…, the Open deferred revenue tab, and Approve, Edit and Cancel schedule on a schedule. It opens the revenue pages too. No role has it by default.",
      ),
      perm(
        "close.work",
        "Opens Prepaids & Accruals and Month-end Close, and lets you tick tasks, mark them not applicable, set owners, add notes and files, explain flux, and post the prepaid and accrual months that have ended. The Accounts role has it by default.",
      ),
      perm(
        "close.manage",
        "Opens the same pages, and lets you make, change and stop prepaids and accruals, change Settings › Revenue & Close and Settings › Month-end checklist, and close or reopen a month (with Lock periods and close the year). It doesn't include working the checklist. No role has it by default.",
      ),
      perm("books.close", "Needed as well as Run the month-end close to close or reopen a month, because closing moves the books' period lock. No role has it by default."),
      perm("data.exportFinance", "Shows Export CSV on the Revenue Waterfall. No role has it by default."),
    ],
    setup: [
      p("An admin, or somebody who may run the close, does this once:"),
      ol(
        runs(
          "Check ",
          { b: "Settings › Revenue & Close" },
          ". Automatic posting is on to start with, new revenue schedules spread by day, and a movement is flagged at 20% and ₹25,000 together. Change them if they don't suit you.",
        ),
        runs("Look over ", { b: "Settings › Month-end checklist" }, ". It starts with a standard set of tasks; give them owners, and add, reorder or switch off tasks to match how you close."),
        runs(
          "Bring in invoices issued before Revenue & Close. On ",
          { b: "Accounting › Revenue" },
          ", the ",
          { b: "Open deferred revenue" },
          " tab walks you through it once (see the task below). A second person then approves the schedules it makes.",
        ),
        runs("Grant the permissions above to the right roles in ", { b: "Settings › Roles & Permissions" }, "."),
      ),
      p(runs("From then on, invoices whose lines carry a ", { b: "Service period" }, " make their own schedules as they are issued, and those start active without approval.")),
    ],
    tasks: [
      task(
        "See what's deferred and what's been recognised",
        ol(
          runs("Open ", { b: "Accounting › Revenue" }, ". The ", { b: "Schedules" }, " tab lists every schedule."),
          runs("Narrow it with the search box, ", { b: "Status" }, ", ", { b: "Customer" }, ", ", { b: "Item" }, ", ", { b: "From" }, " and ", { b: "To" }, ", or select ", { b: "Pending approval" }, "."),
          runs("Open a schedule to see what is ", { b: "Recognised" }, ", what is ", { b: "Remaining" }, ", what credit notes took off (", { b: "Credited" }, "), and each month marked ", { b: "Posted" }, " or ", { b: "Planned" }, "."),
          runs("The ", { b: "Roll-forward" }, " tab shows how Deferred Revenue moved in a month, beside the ledger's balance at the month end."),
          runs(
            "For what is still to come, open ",
            { b: "Accounting › Revenue Waterfall" },
            ": the revenue left to recognise ",
            { b: "By customer" },
            " or ",
            { b: "By item" },
            ", over ",
            { b: "12 months" },
            " or ",
            { b: "24 months" },
            ".",
          ),
        ),
        p("For anybody who may read revenue, a customer's page also has a Revenue card: invoiced, recognised, deferred, the next twelve months and this month's recurring revenue, with a link to that customer's schedules."),
      ),
      task(
        "Recognise revenue for a month",
        ol(
          runs("On ", { b: "Accounting › Revenue" }, ", find the ", { b: "Recognise revenue" }, " card."),
          runs("Pick the month in ", { b: "Recognise through" }, " — only months that have ended are offered."),
          runs("Select ", { b: "Recognise through" }, " with the month."),
        ),
        p(
          runs(
            "Every month that has come due moves from Deferred Revenue to Sales, one journal entry per month. A month whose books are locked is caught up in the first open month, and running it twice posts nothing twice. Anything it couldn't post is listed under ",
            { b: "Left for later" },
            " with the reason. With automatic posting on, this also happens on its own each night.",
          ),
        ),
      ),
      task(
        "Approve a schedule made or changed by hand",
        ol(
          runs("Open the ", { b: "Review" }, " tab on ", { b: "Accounting › Revenue" }, ". Its count shows how many are waiting."),
          "Open a schedule and check its period, amount and note.",
          runs("Select ", { b: "Approve" }, "."),
        ),
        p("You can't approve a schedule you made or last changed — somebody else has to. Schedules made from an invoice's own service period never come here."),
      ),
      task(
        "Change or cancel a schedule",
        ol(
          runs("Open the schedule and select ", { b: "Edit" }, "."),
          runs("Change ", { b: "Service from" }, ", ", { b: "Service to" }, ", the ", { b: "Amount (₹)" }, ", ", { b: "Spread evenly by month" }, " or the ", { b: "Note" }, ", and select ", { b: "Save" }, "."),
          runs("If the change moves money now, you see the figure first — select ", { b: "Post and save" }, " to go ahead."),
        ),
        p(
          runs(
            "Months already recognised never change; what is left is spread afresh over the months still to come. Changing the period, the amount or the spreading sends the schedule back for approval by somebody else. To stop a schedule, select ",
            { b: "Cancel schedule" },
            ", say ",
            { b: "Why" },
            " and ",
            { b: "Continue" },
            ": whatever it still holds is recognised at once. To take revenue back from a customer, raise a credit note instead.",
          ),
        ),
      ),
      task(
        "Open deferred revenue for invoices issued earlier",
        ol(
          runs("On ", { b: "Accounting › Revenue" }, ", open the ", { b: "Open deferred revenue" }, " tab."),
          runs("Choose the month end to open it at — only month ends that have passed, in periods still open — and select ", { b: "List the invoices" }, "."),
          "From the invoices issued in the 24 months up to that date, tick the service and subscription lines that were really for a period, and set the period each one covered.",
          runs("Select ", { b: "Preview" }, " to see what is still unearned at that date, then select ", { b: "Post" }, " with the amount."),
        ),
        p("It posts one entry moving the unearned part from Sales to Deferred Revenue, and a schedule per line that recognises the rest from the following month. Those schedules were made by hand, so they wait on the Review tab until somebody else approves them."),
      ),
      task(
        "Spread a prepaid cost or accrue a cost",
        ol(
          runs("Open ", { b: "Accounting › Prepaids & Accruals" }, " and select ", { b: "New schedule" }, "."),
          runs(
            "Choose ",
            { b: "Prepaid — paid ahead, expensed over the months" },
            " or ",
            { b: "Accrual — incurred before its bill arrives" },
            ", and give it a ",
            { b: "Name" },
            ". A prepaid can start ",
            { b: "From a vendor bill" },
            ".",
          ),
          runs(
            "Pick the ",
            { b: "Expense account" },
            ", where it is ",
            { b: "Held in" },
            " or ",
            { b: "Owed in" },
            " (Prepaid Expenses or Accrued Expenses unless you choose another), the ",
            { b: "Amount (₹)" },
            ", the ",
            { b: "First month" },
            " and how many ",
            { b: "Months" },
            ". Branch, department, vendor and note are optional.",
          ),
          runs("Check the months it will post, then select ", { b: "Make the prepaid" }, " or ", { b: "Make the accrual" }, "."),
          runs("Each month, under ", { b: "Post the months that have ended" }, ", pick ", { b: "Through" }, " and select ", { b: "Post through" }, " with the month. Safe to press twice."),
        ),
        p(
          runs(
            "A prepaid moves the whole amount out of the expense when it's made, then expenses a share each month. An accrual books its share at each month end and reverses it on the 1st, so the real bill books normally when it comes. ",
            { b: "Change" },
            " and ",
            { b: "Stop…" },
            " are on a running schedule; stopping removes the months not yet posted and can't be undone.",
          ),
        ),
      ),
      task(
        "Work the month-end checklist",
        ol(
          runs("Open ", { b: "Accounting › Month-end Close" }, ". It opens on the last month that has ended; pick another month at the top right."),
          runs("On the ", { b: "Checklist" }, " tab, open a task. An automatic check says what it found and when it last looked; the checks run again each time you open the month."),
          runs(
            "When a task is done, select ",
            { b: "Mark done" },
            ". If it doesn't apply this month, select ",
            { b: "Not applicable…" },
            ", say why and select ",
            { b: "Mark not applicable" },
            ". ",
            { b: "Back to to-do" },
            " undoes either.",
          ),
          runs(
            "Give the task an ",
            { b: "Owner" },
            " — they're told when it's theirs, two days before it's due and when it's overdue. Use ",
            { b: "Add a note" },
            " and ",
            { b: "Attach a file" },
            " (PDF, Word or an image, up to 4 MB) for the evidence.",
          ),
        ),
      ),
      task(
        "Explain the large movements and close the month",
        ol(
          runs("Open the ", { b: "Flux" }, " tab. ", { b: "Show" }, " lists the accounts ", { b: "Flagged and explained" }, ", or ", { b: "Every account with figures" }, "."),
          runs("For each flagged account, write why it moved and select ", { b: "Save explanation" }, "."),
          runs("When everything is done, select ", { b: "Close" }, " with the month's name, read what it will do, and select ", { b: "Lock the books and close" }, " with the month."),
        ),
        p(
          runs(
            "A month can't be closed before it has ended, or while an earlier month is still open. With tasks still open you can use ",
            { b: "Close with open tasks…" },
            " and write the reason, which is kept on the month and in the audit log. To reopen a closed month, select ",
            { b: "Reopen" },
            " with its name and answer ",
            { b: "Why reopen it?" },
            ": the lock moves back to the previous month's end, and any later closed months reopen too.",
          ),
        ),
      ),
    ],
    settings: [
      setting(
        "Post recognition and schedules automatically",
        "Settings › Revenue & Close",
        p(
          "On to start with. Each night, once a month has ended, its revenue recognition and its prepaid and accrual months are posted by the workspace's Automation account — a hidden account that can't sign in and isn't a seat. Its entries show “Posted automatically” in the journal. Off: nothing posts until somebody uses Recognise through… on Revenue or Post through… on Prepaids & Accruals; the checklist still runs and says what is left.",
        ),
      ),
      setting(
        "Spreading revenue",
        "Settings › Revenue & Close",
        p(
          runs(
            "How a new revenue schedule spreads its amount: ",
            { b: "By day (exact)" },
            " — each month earns its share of the days, the starting choice — or ",
            { b: "Evenly by month" },
            " — the same amount every month, the last taking the rounding. Existing schedules keep theirs; one schedule can be changed with ",
            { b: "Spread evenly by month" },
            " when you edit it.",
          ),
        ),
      ),
      setting(
        "Flux thresholds",
        "Settings › Revenue & Close",
        p(
          runs(
            "An account is flagged on the Flux tab when its change against last month is at least the ",
            { b: "Percentage change" },
            " and at least the ",
            { b: "Amount (₹)" },
            " — both, so a small account doubling isn't flagged, and neither is a small percentage on a large one. Every flagged account needs an explanation before the checklist's changes-explained task passes. Select ",
            { b: "Save settings" },
            " to keep any change.",
          ),
        ),
      ),
      setting(
        "Month-end checklist",
        "Settings › Month-end checklist",
        p(
          runs(
            "The tasks every month's checklist is copied from, in order, when the month is first opened. ",
            { b: "Add a task" },
            " asks for the ",
            { b: "Task" },
            ", ",
            { b: "What done looks like (optional)" },
            ", an ",
            { b: "Automatic check" },
            " (or ",
            { b: "None — ticked by hand" },
            "), an ",
            { b: "Owner (optional)" },
            " and ",
            { b: "Due on working day" },
            " of the next month. Move tasks up and down, ",
            { b: "Edit" },
            ", ",
            { b: "Deactivate" },
            " or ",
            { b: "Reactivate" },
            " them; a task no month has used yet can be deleted. Changes apply to months opened from then on.",
          ),
        ),
      ),
    ],
    faq: [
      qa(
        "I can't see Revenue & Close in the menu.",
        p(
          "Its pages sit in the Accounting menu: Revenue, Revenue Waterfall, Prepaids & Accruals and Month-end Close. If they aren't there, the module may be switched off in Settings › Modules (it needs Accounting, and is only offered in India), your role may have its section hidden in Settings › Roles & Permissions, or you may not hold any of the permissions above. Ask an admin.",
        ),
      ),
      qa(
        "I issued an invoice but no revenue schedule appeared.",
        p(
          runs(
            "A schedule is only made for a line with a ",
            { b: "Service period" },
            " that runs past its month, or for a project stage invoiced before its delivery. Everything else is recognised when it's invoiced, as before.",
          ),
        ),
      ),
      qa("Why is this schedule recognising nothing?", p("It's waiting for approval. Schedules made or changed by hand recognise nothing until somebody other than their maker approves them on the Review tab.")),
      qa("Why can't I approve this schedule?", p("You made it or changed it last, so somebody else with Manage revenue recognition has to. Only the super admin may approve their own.")),
      qa(
        "What happens to revenue for a month whose books are locked?",
        p("It's caught up in the first open month, and the schedule's month is marked as posted there. Nothing is posted into a locked period."),
      ),
      qa(
        "Why can't I close the month?",
        p(
          "The page says why under the button: the month hasn't ended, an earlier month is still open, or tasks are still open. Finish them, mark them not applicable, or close with a written reason. Closing also needs both Run the month-end close and Lock periods and close the year — the screen calls the second one “Close the books”.",
        ),
      ),
      qa(
        "How does the month-end close relate to Close the Books?",
        p(
          "The two share one lock. Closing a month here moves the books' lock to its last day. Moving that lock back on Accounting › Close the Books, or reopening a financial year there, reopens the months it no longer covers, and they need closing again.",
        ),
      ),
    ],
    related: ["accounting", "sales_documents", "projects", "receivables"],
  },
};

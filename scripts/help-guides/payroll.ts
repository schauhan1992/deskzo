import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Payroll — written from src/app/(dashboard)/people/payroll (the runs and a month's register), the
 * Salary and Income tax cards and the settlement page on a person's record (src/app/(dashboard)/
 * people/[id]), src/components/hr (payroll-runs, payroll-register, salary-card, tax-declaration-card,
 * my-payslips, settlement-view), src/actions/payroll.ts and settlement.ts, src/lib/hr (payroll,
 * payroll-month, loss-of-pay, tds) and src/components/accounting/unposted-banner.tsx.
 */
export const guide: SeedGuide = {
  slug: "help/payroll",
  title: "Payroll",
  seo: {
    title: "Payroll: salary structures, monthly runs and payslips",
    description: "How to set salary structures, calculate and lock the monthly payroll with PF, ESI, professional tax and TDS, issue payslips and settle a leaver in {siteName}.",
    keywords: ["payroll software", "salary structure", "payslips"],
  },
  guide: {
    module: "payroll",
    heading: "Payroll",
    summary: "Salary structures, the monthly payroll run and payslips, with PF, ESI, professional tax and TDS on salary worked out for you, loss of pay taken from attendance and leave, and a leaver's full & final settlement. For workspaces in India.",
    purpose: [
      p("Payroll turns each person's salary structure and their month's attendance into payslips. You calculate a month, check it, adjust what needs adjusting, lock it and mark it paid. Everyone sees their own payslips once the month is locked."),
      p("PF, ESI and professional tax are worked out from each salary structure and the rules built into the app. Income tax (TDS) is worked out from the tax year so far and the person's declaration — or you type the figure yourself. Loss of pay is the days recorded as Absent, plus days of unpaid leave; a day nobody recorded is never counted against anyone."),
      p("When somebody leaves, Payroll also prepares their full & final settlement: the last salary, leave encashment and gratuity, less notice shortfall and any recoveries."),
      note(runs("Payroll is for workspaces in India only. It needs People (HR), which holds the employee records, attendance and leave it works from — see ", ["People (HR)", "/help/people-hr"], ".")),
    ],
    access: [
      p(runs("Everyone can open ", { b: "People › Payroll" }, " to see their own payslips, from the month payroll locks it. ", { b: "My HR" }, " lists them too. Nobody else's are shown, and a month still being worked on is never shown to the people it pays.")),
      p("Everything else — salaries, the monthly runs, adjustments, tax declarations and settlements — needs the permission to run payroll. It shows what everybody earns, so grant it to as few people as the work allows. Managing somebody never gives you their pay."),
      p("On your own employee record you can see your current salary, your income tax declaration and, once one is prepared, your full & final settlement. You can't change them."),
    ],
    permissions: [
      perm("section.payroll", "Shows Payroll in the menu and lets people open it — for most people, to see their own payslips. Every role has it until an admin unticks it for one."),
      perm(
        "payroll.manage",
        "See and set everyone's salary structure and income tax declaration; calculate, adjust, lock and mark paid each month's payroll; and prepare, approve and pay full & final settlements. No role has it by default apart from admins; the built-in HR head role starts with it. It is never passed on to somebody's manager.",
      ),
    ],
    setup: [
      p("Someone allowed to run payroll does this once, after HR has set people up in People (HR):"),
      ol(
        runs("Check each person's employee record is complete, the joining date above all: a joining or leaving date inside a month pays them for the days they were employed. Payslips show the PAN, UAN and bank account from the record."),
        runs("Make sure each person has a work state for professional tax: the branch in ", { b: "Works at" }, " in ", { b: "Settings › Users" }, ", or the state in the address on their record."),
        runs("Open each person in ", { b: "People › People" }, " and select ", { b: "Set salary" }, " on the ", { b: "Salary" }, " card. Anyone without a salary structure is skipped when you calculate a month."),
        runs("For anyone on the old tax regime, or who was paid elsewhere earlier in the tax year, record their declaration with ", { b: "Declaration" }, " on the ", { b: "Income tax" }, " card."),
      ),
      p(runs("If your company uses Accounting, locking a month and marking it paid post to the books by themselves — see ", ["Accounting", "/help/accounting"], ".")),
    ],
    tasks: [
      task(
        "Set or revise someone's salary",
        ol(
          runs("Open the person in ", { b: "People › People" }, " and, on the ", { b: "Salary" }, " card, select ", { b: "Set salary" }, " (or ", { b: "Revise" }, ")."),
          runs("Type the ", { b: "Annual CTC" }, ". It's split as you type, by the rules in ", { b: "Settings › Salary structure" }, ", with your own components in and the special allowance taking up the rest, so the structure costs exactly the CTC."),
          runs("To revise, choose ", { b: "Revise by" }, " — ", { b: "A percentage" }, ", ", { b: "An amount a year (₹)" }, " or ", { b: "A new CTC (₹)" }, " — and type it. ", { b: "The breakup" }, " keeps theirs, scaled up, or splits it again by the company's rules."),
          runs("Change any part. With ", { b: "Keep to the CTC" }, " ticked, the special allowance takes up the difference. Add one of the company's own components, or another typed there, from ", { b: "+ Add a component…" }, "."),
          runs("Set ", { b: "Effective from" }, ", tick whether ", { b: "Provident fund" }, ", ", { b: "ESI" }, " and ", { b: "Professional tax" }, " apply, check the monthly gross and annual cost to company, and select ", { b: "Save structure" }, "."),
        ),
        p(runs("A revision keeps the earlier structures as history, and the card shows how it was given (+10%, +₹60,000 a year). A structure can't start on or before a month that is already locked. To correct the structure someone is on, select ", { b: "Edit" }, " — offered until a locked month has paid from it.")),
      ),
      task(
        "Record an income tax declaration",
        ol(
          runs("On the person's record, pick the tax year on the ", { b: "Income tax" }, " card and select ", { b: "Declaration" }, "."),
          runs("Choose ", { b: "New regime" }, " or ", { b: "Old regime" }, ". For the old regime, enter what they have declared, with evidence."),
          "Enter any pay and tax from earlier in the tax year with another employer or your own earlier payroll, and any other income they've asked to be taxed through salary.",
          runs("Add a ", { b: "Note" }, " of what you checked and select ", { b: "Save" }, "."),
        ),
        p("Each month's TDS is then worked out from this, the year's payslips so far and the months still to come."),
      ),
      task(
        "Calculate a month",
        ol(
          runs("Open ", { b: "People › Payroll" }, ". Under ", { b: "Run a month" }, ", choose the month and year."),
          runs("Select ", { b: "Calculate" }, "."),
          runs("Read the result: how many payslips were calculated, and anyone ", { b: "Skipped" }, " with the reason."),
        ),
        p("It reads each person's salary structure and their unpaid days from attendance. If your company uses Incentives, approved incentives waiting to be paid go onto the same payslip. You can calculate again as often as you like while the month is a draft — attendance corrections made in between are picked up."),
      ),
      task(
        "Check and adjust the payslips",
        ol(
          runs("Open the month from ", { b: "Runs" }, ". The top shows ", { b: "Gross" }, ", ", { b: "Deductions" }, ", ", { b: "Net to pay" }, " and ", { b: "Cost to company" }, " for the whole month."),
          runs("Use ", { b: "Show" }, " to list only ", { b: "Has loss of pay" }, " or ", { b: "Has a warning" }, ", and hover the ⚠ on a row to read the warning."),
          runs("To change a payslip, select ", { b: "Adjust" }, ". Change ", { b: "Income tax (TDS)" }, ", or enter an ", { b: "Other deduction" }, " and ", { b: "What the other deduction is for" }, ", and select ", { b: "Save" }, "."),
        ),
        p(runs("A typed income tax figure is kept when you calculate the month again. ", { b: "Let {siteName} work it out" }, " goes back to the worked-out figure. Select a worked-out tax figure in the table to see how it was reached.")),
      ),
      task(
        "Lock the month and mark it paid",
        ol(
          runs("When the figures are right, select ", { b: "Lock the month" }, ". Payslips become visible to the people they pay."),
          runs("If you find a mistake before paying, select ", { b: "Unlock" }, ", correct it and calculate again."),
          runs("When the salaries have left the bank, select ", { b: "Mark paid" }, "."),
        ),
        p("A month that has been marked paid can't go back to draft."),
      ),
      task(
        "See and download your payslips",
        ol(
          runs("Open ", { b: "People › Payroll" }, " (or ", { b: "My HR" }, ")."),
          runs("Under ", { b: "Your payslips" }, ", select ", { b: "Download" }, " on the month you want."),
        ),
      ),
      task(
        "Prepare a full & final settlement",
        ol(
          runs("Record the person's exit in People (HR) first. Then open their record and select ", { b: "Full & final settlement →" }, "."),
          runs("Select ", { b: "Prepare settlement" }, ". It needs a last working day, a joining date and a salary structure."),
          runs("Check what is ", { b: "Payable" }, " and ", { b: "Recoverable" }, ". To change the figures somebody decides — bonus, other earnings, advance or asset recovery, other deductions and the statutory deductions — select ", { b: "Adjust" }, "."),
          runs("Select ", { b: "Recalculate" }, " if anything on their record has changed, then ", { b: "Approve" }, "."),
          runs("When it has been paid, select ", { b: "Mark paid" }, ". ", { b: "Reopen" }, " takes an approved settlement back to draft; a paid one can't go back."),
        ),
        p("Gratuity, leave encashment and notice recovery come from the record and are recalculated, not typed. The last month's salary is paid in the settlement, so that month's payroll leaves them out."),
      ),
    ],
    settings: [
      setting(
        "Salary",
        "On each person's record in People › People",
        p("The person's salary structure: the components, the date it takes effect, and whether provident fund, ESI and professional tax apply. Earlier structures are kept under History. Payroll uses the structure in force for each month."),
      ),
      setting(
        "Salary structure",
        "Settings › Salary structure",
        p(runs("How a CTC is split: ", { b: "Basic (% of the CTC)" }, ", ", { b: "HRA (% of basic)" }, ", and fixed ", { b: "Conveyance" }, " and ", { b: "Medical" }, " a month. The example underneath shows a ₹6,00,000 CTC split by what you've typed.")),
        p(runs("Under ", { b: "Your own components" }, ", add earnings besides the built-in ones — a food or shift allowance — at ", { b: "₹ a month" }, " or ", { b: "% of basic" }, ". They're offered on every salary, count towards gross, ESI and professional tax, and show on the payslip by name. Untick ", { b: "Offered" }, " or remove one to stop offering it; salaries that have it keep it.")),
      ),
      setting(
        "Provident fund, ESI and Professional tax",
        "Salary card › Set salary or Revise",
        p("Ticked or unticked per structure. Their amounts are worked out from the rules and can't be edited on a payslip — change the structure and calculate again instead. Professional tax follows the state of the branch the person works at, or the state on their record; with no state, nothing is deducted and the payslip says so."),
      ),
      setting(
        "Income tax",
        "On each person's record in People › People",
        p(runs("The person's regime and declaration for this tax year and last year. ", { b: "Declaration" }, " changes it. If the app doesn't work out TDS for a tax year, type the figure on each payslip with ", { b: "Adjust" }, ".")),
      ),
      setting(
        "Works at",
        "Settings › Users",
        p("The branch somebody works at. Its state decides their professional tax."),
      ),
    ],
    faq: [
      qa(
        "I can't see Payroll in the menu.",
        p("Either the module is switched off for your company in Settings › Modules, or your role has had the section hidden in Settings › Roles & Permissions. Payroll is only offered to workspaces in India."),
      ),
      qa(
        "Someone is missing from this month's payroll.",
        p(runs("The result of ", { b: "Calculate" }, " lists everyone skipped and why: no salary structure, a joining date after the month, or a month whose salary is paid in their full & final settlement.")),
      ),
      qa(
        "Why is someone's pay lower this month?",
        ul(
          "Loss of pay: days recorded as Absent, and days of unpaid leave. A day nobody recorded doesn't count.",
          "They joined or left during the month, so they are paid for the days they were employed.",
          "A typed income tax figure or another deduction on their payslip.",
        ),
      ),
      qa(
        "Can I change PF, ESI or professional tax on a payslip?",
        p("No. They come from the salary structure. Change the structure, then calculate the month again while it is still a draft."),
      ),
      qa(
        "I typed an income tax figure. Will calculating again overwrite it?",
        p("No. Typed income tax and other deductions are carried across when the month is recalculated. Worked-out TDS is worked out again."),
      ),
      qa(
        "Why can't I calculate or adjust a month?",
        p("It is locked or paid. Unlock a locked month to work on it again; a paid month is final."),
      ),
      qa(
        "An employee can't see their payslip.",
        p("Payslips appear only once the month is locked. Until then the figures are still being worked on, and only payroll can see them."),
      ),
      qa(
        "A locked month didn't reach the books.",
        p(runs("If Accounting couldn't take the entry, locking says so. ", { b: "Accounts › Overview" }, " then lists the run, and ", { b: "Post these now" }, " posts it again.")),
      ),
    ],
    related: ["hr", "accounting", "incentives"],
  },
};

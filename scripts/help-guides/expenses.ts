import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Expenses — written from src/app/(dashboard)/expenses (the list, a claim, new and edit),
 * src/components/expenses (the form, the claim's buttons, the list's bulk bar), src/actions/expense.ts
 * (who a claim goes to, who may see, change, decide and reimburse it, and the ledger postings),
 * src/lib/expenses.ts (categories, statuses, receipts), the expenses rule in src/lib/authz/access.ts and
 * the expenses.* entries in src/lib/permissions.ts.
 */
export const guide: SeedGuide = {
  slug: "help/expenses",
  title: "Expenses",
  seo: {
    title: "Expenses: claims, approval and reimbursement",
    description: "How to claim an expense in {siteName}, attach the receipt, send it for approval and record its reimbursement — travel against a field visit included.",
    keywords: ["expense claims", "expense approval", "reimbursement"],
  },
  guide: {
    module: "expenses",
    heading: "Expenses",
    summary:
      "Every company expense in one place — the official expenses each person claims, travel against a field visit, and everything else the business spends — approved by HR (or the reporting manager, as the company chooses), then paid back by Accounts from Accounting › Expense claims.",
    purpose: [
      p(
        "Expenses is where people claim what they've spent for the business: a cab to a client, a hotel, fuel, a software subscription, office supplies. Each claim has a category, an amount, the day it was spent, how it was paid, what it was for and, ideally, a photo or PDF of the receipt. It can be tied to a customer, or to a field visit, or left as general business spend.",
      ),
      p(
        runs(
          "A claim moves through ",
          { b: "Draft" },
          ", ",
          { b: "Awaiting approval" },
          ", ",
          { b: "Approved" },
          " or ",
          { b: "Rejected" },
          ", and finally ",
          { b: "Reimbursed" },
          ". Submitting it sends it to HR — or to your reporting manager, or to the manager and then HR, as your company has chosen. Once approved it shows in ",
          { b: "Accounting › Expense claims" },
          ", where Accounts pays it back and marks it reimbursed. The claimant is notified when it's decided and when it's paid.",
        ),
      ),
      note(
        runs(
          "With ",
          ["Accounting", "/help/accounting"],
          " switched on, approving a claim posts its cost to the ledger, and marking it reimbursed posts the payment. The tax you enter under ",
          { b: "Of which tax" },
          " counts as input credit on the GST Returns page.",
        ),
      ),
    ],
    access: [
      p("Everybody can claim their own expenses. Beyond that, plain words:"),
      ul(
        runs(
          { b: "Seeing claims." },
          " You see your own claims and those of everybody who reports to you, at any depth. ",
          { b: "View all company expenses" },
          " opens everyone's. An admin can set a different reach for a role in Settings › Roles & Permissions.",
        ),
        runs({ b: "Changing a claim." }, " Only the person claiming can edit, submit or delete it, and only while it's a draft or has come back rejected."),
        runs(
          { b: "Deciding a claim." },
          " Who decides is set in ",
          { b: "Settings › People › Expense approvals" },
          ". With HR, anybody who holds ",
          { b: "Approve expense claims (HR)" },
          " decides it, and nobody else. With the reporting manager, the claimant's manager does — or, for somebody with none, a holder of ",
          { b: "Approve or reject expense claims" },
          ", who can also decide any claim waiting on a manager. With the manager and then HR, the manager approves first and HR after. Nobody can approve their own.",
        ),
        runs({ b: "Paying it out." }, " Marking a claim reimbursed needs ", { b: "Mark expenses reimbursed" }, "."),
      ),
    ],
    permissions: [
      perm(
        "hr.approveExpenses",
        "Approve or reject the claims that come to HR — every claim when HR approves them, or each claim after the manager has. Never your own claim. The HR roles and Management have it by default.",
      ),
      perm("section.expenses", "Shows Expenses in the menu and lets people open it to claim and see their own expenses. Every role has it until an admin unticks it for one."),
      perm(
        "expenses.approve",
        "Lets you approve or reject any submitted claim, not only the ones sent to you — for covering an absent manager. Claims from people with no manager are sent to a holder. Never your own claim. Management and Accounts have it by default.",
      ),
      perm(
        "expenses.reimburse",
        "Opens Accounting › Expense claims and shows Mark reimbursed on approved, reimbursable claims, one at a time or in bulk. With Accounting on, it also lets you post approved claims the ledger missed. Accounts and Management have it by default.",
      ),
      perm("expenses.viewAll", "See every claim in the company, not just your own and your team's — for company-wide spend reporting. Management and Accounts have it by default."),
    ],
    setup: [
      p("Claims work as soon as the module is on. What decides where they go is set up once:"),
      ul(
        runs(
          "Choose who approves claims in ",
          { b: "Settings › People › Expense approvals" },
          ": HR (to begin with), the reporting manager, or the manager and then HR. A claim keeps the choice it was submitted under.",
        ),
        runs("Make sure somebody in HR holds ", { b: "Approve expense claims (HR)" }, " — the HR roles do to begin with."),
        runs(
          "If managers approve, give each person a reporting manager in ",
          { b: "Settings › Users" },
          ", and make sure somebody holds ",
          { b: "Approve or reject expense claims" },
          ", so a claim from someone with no manager still reaches a person.",
        ),
        runs("Give whoever pays claims out ", { b: "Mark expenses reimbursed" }, ". Permissions are in ", { b: "Settings › Roles & Permissions" }, "."),
      ),
    ],
    tasks: [
      task(
        "Claim an expense",
        ol(
          runs("Open ", { b: "People › Expenses" }, " and select ", { b: "New expense" }, " (or use ", { b: "Create" }, " › ", { b: "New expense" }, " in the header)."),
          runs(
            "Under ",
            { b: "What was spent" },
            ", choose the ",
            { b: "Category" },
            ", type the ",
            { b: "Amount" },
            " and, if there was tax you can claim credit for, ",
            { b: "Of which tax" },
            ". Set ",
            { b: "Spent on" },
            " and ",
            { b: "Paid by" },
            ".",
          ),
          runs("Leave ", { b: "Reimburse me for this" }, " ticked if it came out of your pocket; untick it for something the company paid, such as a company card."),
          runs("Write ", { b: "What it was for" }, "."),
          runs("Under ", { b: "What it was against" }, ", pick the ", { b: "Company" }, " it was for, or leave it blank for general business spend."),
          runs("Select ", { b: "Attach" }, " to add the ", { b: "Receipt" }, ": a PNG, JPEG, WebP or PDF, up to 512KB."),
          runs("Select ", { b: "Submit for approval" }, " to send it for approval, or ", { b: "Save as draft" }, " to submit it later."),
        ),
      ),
      task(
        "Claim travel against a field visit",
        ol(
          runs("Open the visit and select ", { b: "Add expense" }, "."),
          "The form opens already tied to the visit, with Travel chosen. The company comes from the visit, so there's no company to pick.",
          "Fill in the rest as for any claim and submit it.",
        ),
        p(runs("The claim shows on the visit, and on the claim under ", { b: "Against" }, ". See ", ["Field Visits", "/help/field-visits"], ".")),
      ),
      task(
        "Submit, change or delete your own claim",
        ol(
          "Open the claim from the list.",
          runs("While it's a draft, select ", { b: "Submit for approval" }, ", ", { b: "Edit" }, " or ", { b: "Delete" }, "."),
          runs("If it comes back rejected, read the reason, select ", { b: "Edit" }, " to fix it, then ", { b: "Resubmit" }, "."),
        ),
        p("Once submitted, a claim can't be changed until it's decided — the claim says who it's waiting on. A submitted, approved or reimbursed claim is a record and can't be deleted."),
      ),
      task(
        "Approve or reject claims",
        ol(
          runs("Open ", { b: "People › Expenses" }, " and select ", { b: "To approve" }, " — it shows how many claims are waiting on you."),
          runs("Open a claim and check it, and its receipt. Select ", { b: "Approve" }, ", or ", { b: "Reject" }, "."),
          runs("To reject, write the ", { b: "Reason" }, " — the claimant sees it and can fix and resubmit — and select ", { b: "Reject" }, "."),
        ),
        p(
          runs(
            "To approve several at once, tick them in the list and select ",
            { b: "Approve" },
            " with the number. When the manager approves first, the manager's button says ",
            { b: "Approve and send to HR" },
            ": the claim goes on to HR, and reaches the books and Accounts once HR approves it.",
          ),
        ),
      ),
      task(
        "Pay claims back (Accounts)",
        ol(
          runs("Open ", { b: "Accounting › Expense claims" }, ". ", { b: "To pay" }, " lists every approved claim owed to somebody, with who approved it and its ledger entry."),
          "Tick the claims you've paid. The bar shows how much of the selection is to pay.",
          runs("Type the ", { b: "Payment reference" }, " (a UTR or cheque number), pick the day it was ", { b: "Paid on" }, ", and select ", { b: "Mark paid" }, "."),
          runs("They move to ", { b: "Paid" }, ". ", { b: "Company paid" }, " lists approved spend nobody is owed, such as a company card's."),
        ),
        p(
          runs(
            "For one claim, open it, select ",
            { b: "Mark reimbursed" },
            ", type the ",
            { b: "Payment reference" },
            " and select ",
            { b: "Mark paid" },
            ". Only approved claims that are reimbursable are marked; anything else in the selection is skipped. Each claimant is notified.",
          ),
        ),
      ),
      task(
        "Find and total expenses",
        p(
          runs(
            "Search by description, company or claimant, and narrow by ",
            { b: "Status" },
            ", ",
            { b: "Category" },
            ", ",
            { b: "Claimant" },
            ", ",
            { b: "Reimbursable" },
            " (reimbursable or company paid) and ",
            { b: "Spent on" },
            ". The figures at the top — ",
            { b: "Total" },
            ", ",
            { b: "Awaiting approval" },
            ", ",
            { b: "Payable now" },
            " and ",
            { b: "Reimbursed" },
            " — and ",
            { b: "Where it goes" },
            ", the spend by category, follow the filters.",
          ),
        ),
      ),
    ],
    settings: [
      setting(
        "Reimburse me for this",
        "In each claim",
        p("Ticked, the claim is money owed back to you: once approved it counts in Payable now and can be marked reimbursed. Unticked, the company paid — the claim still goes for approval, but there's nothing to pay back, and it shows “Not reimbursable”."),
      ),
      setting("Paid by", "In each claim", p("Cash, Personal card, Company card, UPI or Bank transfer — how the money was spent.")),
      setting(
        "Expense claims are approved by",
        "Settings › People › Expense approvals",
        p("HR (to begin with), the reporting manager, or the reporting manager and then HR. Somebody with no manager goes straight to HR under the last. A claim keeps the choice it was submitted under, so changing it doesn't move claims already waiting."),
      ),
      setting(
        "Reporting manager",
        "Settings › Users",
        p("When managers approve, decides who a person's claims are sent to. The approver is fixed when the claim is submitted, so changing someone's manager later doesn't move a claim that's already waiting."),
      ),
      setting(
        "Whose claims a role can see",
        "Settings › Roles & Permissions",
        p("View all company expenses opens every claim; without it a role sees its own and its team's. An admin can also set the role's reach for expense claims there."),
      ),
    ],
    faq: [
      qa(
        "I can't see Expenses in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
      qa(
        "My claim says there's nobody to route it to.",
        p("You have no reporting manager set, and nobody else can approve claims. Ask an admin to set your manager in Settings › Users, or to give someone the permission to approve or reject expense claims — they can then pick it up."),
      ),
      qa("Why can't I edit my claim?", p("It's been submitted and is waiting for a decision. If it's rejected you can edit it and resubmit; once approved it's a record.")),
      qa(
        "Why can't I approve this claim?",
        p("It's your own — nobody approves their own claim — or it's with HR and you don't hold Approve expense claims (HR), or it was sent to another manager and you don't hold the permission to approve or reject any claim."),
      ),
      qa(
        "The receipt won't attach.",
        p("It has to be a PNG, JPEG, WebP or PDF of 512KB or less. Take a smaller photo or save the PDF at a lower quality."),
      ),
      qa(
        "It said the claim was approved but didn't reach the ledger.",
        p("The approval stands — the claimant isn't kept waiting. The claim is listed on the Accounting overview and on Accounting › Expense claims as something the ledger never received, and somebody who may mark expenses reimbursed can post it from there with Post these now."),
      ),
      qa("Can I see a colleague's claims?", p("Only if they report to you, you hold the permission to view all company expenses, or an admin has given your role a wider reach.")),
    ],
    related: ["visits", "accounting"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Accounting — written from src/app/(dashboard)/accounting (the overview, journal, chart of accounts,
 * statements, an account's ledger, banking, fixed assets, GST returns, TDS and close the books),
 * src/components/accounting (the journal dialog, chart, banking, assets and books managers),
 * src/actions/ledger.ts, ledger-reports.ts, bank.ts, asset.ts, tax-reports.ts and books.ts (what each
 * refuses), src/lib/ledger (the lock, the year-end, the default chart) and the ledger.*, books.close
 * and payments.manage entries in src/lib/permissions.ts.
 */
export const guide: SeedGuide = {
  slug: "help/accounting",
  title: "Accounting",
  seo: {
    title: "Accounting: the ledger, statements, GST and the period lock",
    description: "How the ledger in {siteName} fills itself from invoices, bills and payments, and how to read the statements, write a journal and reconcile the bank.",
    keywords: ["accounting", "general ledger", "bank reconciliation"],
  },
  guide: {
    module: "accounting",
    heading: "Accounting",
    summary:
      "The company's books: a double-entry ledger that fills itself as invoices, bills, payments, expense claims and payroll are recorded, the statements built from it, and the tools that keep it right — bank reconciliation, fixed assets, GST, TDS and a period lock.",
    purpose: [
      p(
        "Accounting is the general ledger. You rarely type an entry by hand: issuing an invoice, a credit note or a vendor bill posts it to the ledger in the same step, and so does recording a payment. Approving an expense claim and locking a month's payroll post their cost too — the cost is booked when it is incurred, not when the money moves.",
      ),
      p(
        runs(
          "Nothing in the ledger is edited or deleted. A cancelled document is reversed, and the original entry stays in the ",
          { b: "Journal" },
          " beside its reversal. A mistake you correct by hand is corrected the same way, with a dated reversal everyone can see.",
        ),
      ),
      p(
        runs(
          "From the ledger come the statements — ",
          { b: "Trial Balance" },
          ", ",
          { b: "Profit & Loss" },
          ", ",
          { b: "Balance Sheet" },
          " and ",
          { b: "Cash Flow" },
          " — and the tools that keep the books defensible: ",
          { b: "Banking" },
          " to agree the books with the bank statement, ",
          { b: "Fixed Assets" },
          " for the asset register and monthly depreciation, ",
          { b: "GST Returns" },
          " and ",
          { b: "TDS" },
          ", and ",
          { b: "Close the Books" },
          " to lock a period and close the financial year.",
        ),
      ),
      note(
        runs(
          "Accounting is for workspaces in India: GST, TDS and the April-to-March financial year are built in. Revenue recognised over time and the month-end close are a separate module on top of it — see ",
          ["Revenue & Close", "/help/revenue-and-close"],
          ".",
        ),
      ),
    ],
    access: [
      p("Accounting holds every figure the company has, so having the module switched on isn't enough — each page asks for a permission of its own:"),
      ul(
        runs(
          "Reading the books — ",
          { b: "Overview" },
          ", ",
          { b: "Journal" },
          ", the statements and any account's ledger — needs ",
          { b: "See the books" },
          ". The Accounts and Management roles have it by default.",
        ),
        runs(
          { b: "Banking" },
          ", ",
          { b: "Fixed Assets" },
          ", ",
          { b: "GST Returns" },
          " and ",
          { b: "TDS" },
          " need ",
          { b: "Manage finance records" },
          " — also held by Accounts and Management by default.",
        ),
        "Writing or reversing a journal entry, changing the chart of accounts, and locking periods or closing a year each need their own permission. No role has these by default, so until an admin grants them only admins can do them.",
      ),
      p("A page you don't have the permission for isn't shown in your menu, and its address shows “page not found”."),
    ],
    permissions: [
      perm("section.accounting", "Shows Accounting in the menu and lets people open its pages. Every role has it until an admin unticks it for one — each page then still needs its own permission below."),
      perm(
        "ledger.viewReports",
        "Opens Overview, Vouchers, Journal, Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, the Day Book, Registers, the cash and bank books and each account's ledger, and lets you read the Chart of Accounts and Close the Books. The Accounts and Management roles have it by default.",
      ),
      perm("ledger.post", "Shows New journal entry on the Journal and Reverse on its entries, and posts and reverses vouchers. No role has it by default."),
      perm("vouchers.create", "Lets you write payment, receipt, contra and journal vouchers as drafts, change your drafts, and send them for approval. The Accounts and Management roles have it by default."),
      perm("vouchers.approve", "Lets you approve somebody else's voucher, or send it back, where Accounts settings ask for approval. Never your own. Management has it by default."),
      perm(
        "ledger.manageAccounts",
        "Lets you add, edit, archive and delete accounts on the Chart of Accounts (and opens that page on its own). No role has it by default — an account's type decides which statement it lands in, so this reshapes every report.",
      ),
      perm(
        "payments.manage",
        "Opens Banking, Fixed Assets, GST Returns and TDS and everything done on them: bank accounts, statement imports, reconciliation, clearing cheques, the asset register and depreciation. The Accounts and Management roles have it by default.",
      ),
      perm(
        "books.close",
        "Lets you set and remove the period lock and close or reopen a financial year on Close the Books. Deliberately separate from writing entries. No role has it by default.",
      ),
      perm(
        "expenses.reimburse",
        "Opens Expense claims — the approved expense claims to pay back, the ones paid and company-paid spend — and lets you mark them paid, which posts the payment. The Accounts and Management roles have it by default.",
      ),
      perm("expenses.viewAll", "Opens Expense claims to read, without marking anything paid — as it opens every claim under Expenses. The Accounts and Management roles have it by default."),
    ],
    setup: [
      p("There's little to set up. The default chart of accounts is created the first time anything posts to the ledger, so invoices and payments reach the books from the first day. What's worth doing once:"),
      ul(
        runs(
          { b: "Company details." },
          " An admin enters the legal name, PAN and head-office GSTIN in ",
          { b: "Settings › Profile" },
          ", and any other GSTINs against their offices in ",
          { b: "Settings › Branches" },
          ". GST returns are prepared per GSTIN.",
        ),
        runs(
          { b: "Bank accounts." },
          " Somebody with Manage finance records adds each real bank account on ",
          { b: "Accounts › Banking" },
          ", so each one gets its own ledger account and reconciles against its own statement.",
        ),
        runs(
          { b: "Opening balances." },
          " Somebody who may write journal entries posts them on ",
          { b: "Accounts › Journal" },
          " with the entry's ",
          { b: "Kind" },
          " set to ",
          { b: "Opening balance" },
          ".",
        ),
        runs({ b: "Fixed assets." }, " Add the laptops and equipment the company owns on ", { b: "Accounts › Fixed Assets" }, ", so depreciation reaches the P&L every month."),
        runs({ b: "Access." }, " An admin grants the permissions above, role by role, in ", { b: "Settings › Roles & Permissions" }, "."),
      ),
    ],
    tasks: [
      task(
        "Read the statements",
        ol(
          runs("Open ", { b: "Accounts › Overview" }, " for this financial year's income, expenses, profit and total assets, and a line saying whether debits equal credits."),
          runs("Open ", { b: "Trial Balance" }, ", ", { b: "Profit & Loss" }, ", ", { b: "Balance Sheet" }, " or ", { b: "Cash Flow" }, " from the menu."),
          runs("Change the dates at the top right: ", { b: "As at" }, " on the trial balance and balance sheet, ", { b: "From" }, " and ", { b: "To" }, " on the P&L and cash flow. The P&L opens on the current financial year."),
          runs("With more than one branch, choose a ", { b: "Branch" }, " on the P&L to see that branch's figures. The balance sheet is always for the whole company."),
          "Select an account's name to open its ledger: the opening balance, every entry against it with its party, and the running balance.",
        ),
        p(runs("On the Overview you can drag the cards by their handle into the order you like; the order is kept for you.")),
      ),
      task(
        "Write a journal entry",
        ol(
          runs("Open ", { b: "Accounts › Journal" }, " and select ", { b: "New journal entry" }, "."),
          runs("Set the ", { b: "Date" }, " and write a ", { b: "Narration" }, " — every entry needs one."),
          runs("Choose the ", { b: "Kind" }, ": ", { b: "Manual entry" }, " or ", { b: "Opening balance" }, "."),
          runs("On each line pick the ", { b: "Account" }, " and type a ", { b: "Debit" }, " or a ", { b: "Credit" }, " — one or the other, not both. ", { b: "Add line" }, " gives you more lines."),
          runs("If the company has more than one branch or GSTIN, ", { b: "Branch" }, " and ", { b: "GSTIN" }, " columns appear. A line on a GST account must say which GSTIN it belongs to."),
          runs("Watch the total: when it says ", { b: "Balanced." }, ", select ", { b: "Post entry" }, "."),
        ),
        note("You can't post to a group (post to an account under it), to an archived account, or into a period the books are locked for.", "warning"),
      ),
      task(
        "Write a payment, receipt, contra or journal voucher",
        ol(
          runs("Open ", { b: "Accounts › Vouchers" }, " and select ", { b: "New voucher" }, "."),
          runs("Choose the kind: ", { b: "Payment" }, " (money out of a bank or cash account), ", { b: "Receipt" }, " (money in), ", { b: "Contra" }, " (between your own bank and cash accounts) or ", { b: "Journal" }, " (anything else, with no bank or cash line)."),
          "Set the date, a narration and, if you like, a reference. Add the lines: an account and a debit or a credit on each. A receivable or payable line names the customer or vendor.",
          runs("When the totals balance, save it. A draft changes nothing in the books."),
          runs("Select ", { b: "Post" }, " — or, where vouchers need approval, ", { b: "Submit for approval" }, " and somebody else approves it first. Posting writes one journal entry, numbered in the voucher's own series (PMT/2026-27/0001)."),
        ),
        note("A posted voucher isn't edited or deleted. Reverse it: the reversal is a dated, opposite entry, and both stay on record.", "warning"),
      ),
      task(
        "Read the day book, cash and bank books, and registers",
        ul(
          runs({ b: "Accounts › Day Book" }, " — every entry posted in a date range, whatever wrote it, with its lines."),
          runs({ b: "Accounts › Cash & bank books" }, " — one cash or bank account's receipts and payments, with its opening and running balance."),
          runs({ b: "Accounts › Registers" }, " — the sales and purchase registers with their GST, the journal register, expenses by account and month, a GST summary of output against input tax, and who did what to each voucher."),
        ),
        p("Each opens the entries and documents behind it, and can be exported as CSV by somebody allowed to export finance data."),
      ),
      task(
        "Correct an entry with a reversal",
        ol(
          runs("Find the entry in ", { b: "Accounts › Journal" }, ". Search by entry number or narration, or narrow by ", { b: "Source" }, ", ", { b: "From" }, " and ", { b: "To" }, "."),
          runs("Select ", { b: "Reverse" }, " on the entry."),
          "Say why it's being reversed — the reason is shown on the reversing entry.",
        ),
        p(
          runs(
            "The reversal is posted with today's date and the narration “Reversal of” the original's number, and the original is marked ",
            { b: "Reversed by" },
            " it. An entry can be reversed once, and a reversal can't itself be reversed. If the mistake was right, post a fresh entry.",
          ),
        ),
        note("To undo an invoice or a bill, cancel the document rather than reversing its entry here: cancelling reverses the posting for you and keeps the document and its GST in step."),
      ),
      task(
        "Reconcile a bank account",
        ol(
          runs("Open ", { b: "Accounts › Banking" }, " and select the bank account (the default one is selected for you)."),
          runs(
            "Select ",
            { b: "Import a statement" },
            " and choose the bank's CSV file. It needs a header row with a date column and either an amount column or separate withdrawal and deposit columns. Rows you've already imported are skipped, so overlapping downloads are fine.",
          ),
          runs("Type the ", { b: "Closing balance on the statement" }, " and select ", { b: "Compare" }, "."),
          runs(
            "Read the four figures: ",
            { b: "Books say" },
            ", ",
            { b: "Bank says" },
            ", ",
            { b: "Adjusted for what's in flight" },
            " and ",
            { b: "Difference" },
            ".",
          ),
          runs(
            "Work through the suggested matches — ",
            { b: "Match" },
            " one at a time, or ",
            { b: "Accept all" },
            ". A pair is only suggested where exactly one entry fits; select a matched row's tick to undo it.",
          ),
          "Look at what is left unmatched on the statement — usually bank charges, interest or a receipt nobody has recorded yet — and record it.",
          runs("Select ", { b: "Sign this off" }, ". The date, both balances and the difference are recorded, even when the difference isn't nil."),
        ),
        p(
          runs(
            "Cheques sit in ",
            { b: "Cheques that haven't cleared" },
            " until the bank clears them. Pick the date each one cleared and select ",
            { b: "Cleared" },
            " — this moves the money into the bank account, and is often what explains a difference.",
          ),
        ),
      ),
      task(
        "Add a fixed asset and charge depreciation",
        ol(
          runs("Open ", { b: "Accounts › Fixed Assets" }, " and select ", { b: "Add an asset" }, "."),
          runs(
            "Fill in the ",
            { b: "Tag" },
            " (what's stuck on the thing itself), ",
            { b: "What it is" },
            ", ",
            { b: "Bought on" },
            " and ",
            { b: "Cost" },
            ". Choose the ",
            { b: "Method" },
            ": ",
            { b: "Straight line" },
            " needs a ",
            { b: "Useful life (years)" },
            "; ",
            { b: "Written down value" },
            " needs a ",
            { b: "Rate (% a year)" },
            ".",
          ),
          runs("Optionally add a ", { b: "Salvage value" }, " (depreciation stops there), the account it ", { b: "Sits in" }, ", a ", { b: "Cost centre" }, " and who it's ", { b: "Held by" }, ". Select ", { b: "Add" }, "."),
          runs("Each month, pick the ", { b: "Month" }, " and ", { b: "Year" }, " at the top (last month is chosen for you), check the preview and select ", { b: "Charge" }, " with the amount."),
        ),
        p(
          runs(
            "A month can only be charged once it's over, and running it twice charges nothing twice. To sell or scrap an asset, select ",
            { b: "Dispose" },
            " on its row, enter ",
            { b: "Disposed on" },
            " and what it was ",
            { b: "Sold for" },
            " (zero if scrapped), and select ",
            { b: "Dispose" },
            ". The gain or loss is worked out from its book value.",
          ),
        ),
      ),
      task(
        "Prepare the GST returns",
        ol(
          runs("Open ", { b: "Accounts › GST Returns" }, ". It opens on last month, the one being filed."),
          runs("Change the ", { b: "Month" }, " and ", { b: "Year" }, " if you need to. With more than one registration, choose the ", { b: "GST registration" }, " — a return is per GSTIN."),
          "Read the warnings at the top first. Red means the return shows more output tax than the ledger can support — find out why before filing. Amber means the ledger holds output tax the documents don't show, or lists the things the GST portal will reject.",
          runs("Under ", { b: "GSTR-3B — what's payable" }, ", check the output tax, the credit from vendor bills and expense claims, and what's payable in cash or carried forward under each head."),
          runs("Under ", { b: "GSTR-1 — what was supplied" }, ", B2B supplies are listed invoice by invoice and B2C as totals, with the HSN summary (Table 12) beneath."),
        ),
        p("The page prepares and checks the figures; the return itself is filed on the GST portal."),
      ),
      task(
        "Check the month's TDS",
        ol(
          runs("Open ", { b: "Accounts › TDS" }, " and pick the month."),
          runs(
            "Read ",
            { b: "We deducted, and owe" },
            " (payable to the government), ",
            { b: "Customers withheld from us" },
            " (to claim against the year's tax) and ",
            { b: "Due on" },
            " — the 7th of the following month.",
          ),
          runs("Check the ", { b: "Deducted from vendors" }, " and ", { b: "Withheld by customers" }, " tables. A party with no PAN shows ", { b: "missing" }, "; fix the things listed before filing."),
        ),
        p("The figures come from the TDS recorded on issued invoices and vendor bills dated in the month. Drafts and cancelled documents are left out."),
      ),
      task(
        "Lock a period and close the financial year",
        ol(
          runs("Open ", { b: "Accounts › Close the Books" }, "."),
          runs("Under ", { b: "Period lock" }, ", pick a date in ", { b: "Lock everything up to and including" }, ", say ", { b: "Why" }, " and select ", { b: "Lock" }, ". You can only lock a period that has finished."),
          runs("When a financial year is over, it appears beside ", { b: "Ready to close:" }, " under ", { b: "Financial years" }, ". Select it, read what will happen, and select ", { b: "Close" }, " with the year."),
        ),
        p(
          runs(
            "Closing a year posts one entry that brings every income and expense account back to nil and moves the difference to Retained Earnings, and locks the books to 31 March. To undo it, select ",
            { b: "Reopen" },
            " beside the year, type the year to confirm and select ",
            { b: "Reopen the year" },
            ": the closing entry is reversed, not deleted, and the lock rolls back to the start of the year. A later closed year has to be reopened first.",
          ),
        ),
      ),
      task(
        "Pay back approved expense claims",
        ol(
          runs("Open ", { b: "Accounts › Expense claims" }, ". ", { b: "To pay" }, " lists every approved claim owed to somebody — who claimed it, who approved it, and the ledger entry its approval posted."),
          runs("Tick the claims you've paid, type the ", { b: "Payment reference" }, ", pick the day it was ", { b: "Paid on" }, " and select ", { b: "Mark paid" }, "."),
          runs("They move to ", { b: "Paid" }, ", and the payment is posted. The claimants are told."),
        ),
        p(runs("A claim reaches this page once it's approved — by HR, or the manager, as the company has chosen. See ", ["Expenses", "/help/expenses"], ".")),
      ),
    ],
    settings: [
      setting(
        "Chart of accounts",
        "Settings › Chart of accounts (opens Accounts › Chart of Accounts)",
        p(
          runs(
            "The ledger accounts every posting lands in. Groups organise the statements; postings go to the accounts under them. ",
            { b: "New account" },
            " asks for a ",
            { b: "Code" },
            ", a ",
            { b: "Name" },
            ", a ",
            { b: "Type" },
            " (Asset, Liability, Equity, Income or Expense), where it ",
            { b: "Sits under" },
            " and ",
            { b: "Notes" },
            "; tick ",
            { b: "This is a group" },
            " for a heading that takes no postings.",
          ),
        ),
        ul(
          "An account's type can't change once it has entries.",
          "Accounts the automatic postings use can't be archived or deleted.",
          runs("An account with entries can't be deleted — tick ", { b: "Archived" }, " instead, and it takes no new entries."),
          "A group can't be deleted while accounts sit under it, nor an account a prepaid or accrual schedule uses.",
        ),
      ),
      setting(
        "Close the books",
        "Settings › Close the books (opens Accounts › Close the Books)",
        p("The period lock and the year-end close described in the task above. Nothing dated on or before the lock date can be posted, reversed or corrected — post the correction in an open period instead. Removing the lock makes everything postable again."),
      ),
      setting(
        "Bank accounts",
        "Accounts › Banking",
        p(
          runs(
            { b: "Add an account" },
            " asks for a ",
            { b: "Name" },
            ", ",
            { b: "Bank" },
            ", ",
            { b: "Branch" },
            ", ",
            { b: "Account number" },
            " and ",
            { b: "IFSC" },
            ". Until the first one exists every payment posts to a single bank account in the chart; the first you add takes that account over, so nothing already posted moves. Select an account to see ",
            { b: "Make … the default" },
            " and ",
            { b: "Stop using …" },
            " — use the second for an account the company has closed; it stays on past transactions and comes off the lists for new ones. The default account can't be stopped: make another one the default first.",
          ),
        ),
      ),
      setting(
        "GSTINs and the legal name",
        "Settings › Profile and Settings › Branches",
        p("The head office's GSTIN, PAN and legal name are on the profile; other registrations are against their branches. The statements show the legal name at the top, and GST Returns lets you pick between the GSTINs when there is more than one."),
      ),
    ],
    faq: [
      qa(
        "I can't see Accounting in the menu.",
        p(
          "The module may be switched off for your company in Settings › Modules (it's only offered to workspaces in India), or your role may have the Accounting section hidden in Settings › Roles & Permissions. Each link also needs its own permission: See the books for the statements, Manage finance records for Banking, Fixed Assets, GST Returns and TDS. Ask an admin.",
        ),
      ),
      qa("Why is there no New journal entry button?", p("Writing and reversing entries needs the permission to write and reverse journal entries, which no role has by default. Ask an admin to grant it.")),
      qa(
        "Why won't my journal entry post?",
        p(
          "The message says which rule it broke: the debits and credits must match, every entry needs a narration and at least two lines, a line can't carry both a debit and a credit, groups and archived accounts take no postings, and a line on a GST account needs its GSTIN when there's more than one. If it says the books are closed to a date, post the entry in an open period.",
        ),
      ),
      qa("Can I edit or delete an entry that's already posted?", p("No. The ledger is never rewritten — reverse the entry and post the correct one. Both stay visible in the Journal.")),
      qa(
        "The Overview says there are things the ledger never received.",
        p(
          runs(
            "Approving an expense claim or locking a payroll run posts it to the ledger, but if the posting fails the approval still stands. Those are listed on the Overview until they're posted. Select ",
            { b: "Post these now" },
            "; posting claims needs the permission to mark expenses reimbursed.",
          ),
        ),
      ),
      qa(
        "The books and the bank statement don't agree.",
        p(
          "Clear the cheques the bank has cleared, import the latest statement and match the rows. What is still unmatched on the statement is usually bank charges or interest nobody has recorded. You can sign a reconciliation off with a difference — it's recorded as it is.",
        ),
      ),
      qa("GST Returns says there's no GST registration.", p("Add the head office's GSTIN in Settings › Profile, or a branch's in Settings › Branches. The returns are prepared against it.")),
      qa("Why can't I lock this month?", p("A period can only be locked once it has finished. Lock to the end of the last month you've reported or filed.")),
    ],
    related: ["sales_documents", "payments", "revenue_close", "expenses"],
  },
};

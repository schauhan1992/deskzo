import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Receivables — written from src/app/(dashboard)/receivables (the aged list and Customer credit),
 * src/app/(dashboard)/collections/page.tsx (My collections), src/components/documents/invoice-settlement.tsx
 * (Payments & credits on an invoice, Applied to invoices on a credit note), src/components/collections
 * (Log follow-up, Payment follow-ups), src/components/companies/company-statement.tsx (the Statement tab),
 * src/components/credit (the Credit tab and the credit limit), src/actions/receivable.ts,
 * src/actions/collections.ts, src/lib/collections (who may log follow-ups, whose dues), src/actions/credit.ts
 * and src/lib/receivables.ts (the ageing buckets).
 */
export const guide: SeedGuide = {
  slug: "help/receivables",
  title: "Receivables",
  seo: {
    title: "Receivables: what customers owe, aged and chased",
    description: "How {siteName} ages unpaid invoices, settles them with payments and credit notes, rates each customer's credit and keeps a log of every payment follow-up.",
    keywords: ["accounts receivable", "ageing report", "payment follow-up"],
  },
  guide: {
    module: "receivables",
    heading: "Receivables",
    summary:
      "What customers owe you, aged from each invoice's due date — invoices settled by payments and credit notes, a statement of account per customer, a credit rating for each, and a list of dues to chase with every promise to pay.",
    purpose: [
      p(
        runs(
          "Receivables answers who owes you what, and for how long. Every issued tax invoice that isn't settled is aged from its due date — or from its issue date, when it has none — into ",
          { b: "Not yet due" },
          ", ",
          { b: "1–30 days" },
          ", ",
          { b: "31–60 days" },
          ", ",
          { b: "61–90 days" },
          " and ",
          { b: "90+ days" },
          ", one row per customer.",
        ),
      ),
      p(
        runs(
          "An invoice is settled on the invoice itself, by payments recorded against it and credit notes applied to it. Each customer's ",
          { b: "Statement" },
          " tab puts their invoices, payments and credit notes in date order with a running balance.",
        ),
      ),
      p(
        runs(
          { b: "Customer credit" },
          " rates every customer you have billed on how they have actually paid — ",
          { b: "Reliable" },
          ", ",
          { b: "Fair" },
          ", ",
          { b: "Risky" },
          " or ",
          { b: "New" },
          " — and the rating decides the longest payment terms and the credit limit anybody can give without overriding it.",
        ),
      ),
      p(
        runs(
          { b: "My collections" },
          " is a salesperson's list of what their clients owe, where each follow-up is logged: what the client said, and the date they promised to pay by. A promise that passes unpaid is flagged to whoever logged it, their manager and accounts.",
        ),
      ),
    ],
    access: [
      p(
        "Anybody whose role can view payments sees Receivables, Customer credit, and the Statement and Credit tabs on a customer's page. Which customers they see follows the record scope set for their role in Settings › Roles & Permissions.",
      ),
      ul(
        runs({ b: "Record payments" }, " — record a payment on an invoice and apply a credit note to an invoice."),
        runs({ b: "Delete payments" }, " — remove a credit note from an invoice it was applied to."),
        runs({ b: "Override credit terms & limits" }, " — set a customer's credit limit by hand, or give longer terms than their rating suggests."),
        runs(
          { b: "Follow up payments on their accounts" },
          " — My collections, and logging follow-ups. Nobody has it until an admin grants it. Accounts staff who record payments can log follow-ups without it.",
        ),
      ),
    ],
    permissions: [
      perm(
        "payments.view",
        "Shows Receivables, Customer credit, an invoice's Payments & credits panel, and the Statement and Credit tabs on a customer's page — and Payments and Payables too. Sales, Support, Accounts, Purchase and Management have it by default.",
      ),
      perm("section.receivables", "Shows Receivables under Payments in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "collections.followUp",
        "Shows Payments › My collections: what is owed on the accounts someone manages (their team's too, for a manager) and on orders they punched on anybody's account, and logging each follow-up. Needs View payments as well. No role has it by default.",
      ),
      perm(
        "payments.record",
        "Record a payment against a tax invoice, apply a credit note to an invoice, and log payment follow-ups. Accounts and Management have it by default.",
      ),
      perm("payments.delete", "Remove a credit note's application from an invoice, so the invoice owes that amount again. Accounts and Management have it by default."),
      perm(
        "credit.override",
        "Set or change a customer's credit limit, give longer payment terms than their rating supports, and approve an order that goes over the limit — each time with a reason, kept against the customer. Management and Accounts have it by default.",
      ),
    ],
    setup: [
      p(
        runs(
          "Receivables works on the tax invoices raised in ",
          ["Sales Documents", "/help/sales-documents"],
          " and the payments recorded in ",
          ["Payments", "/help/payments"],
          ". There is nothing else to switch on.",
        ),
      ),
      ul(
        runs("Give invoices a ", { b: "Due date" }, ". An invoice without one is aged from the day it was issued."),
        runs("Set each customer's ", { b: "Payment terms" }, " on their record. The Credit tab compares them with the terms their rating suggests."),
        runs(
          "To let salespeople chase their own accounts, an admin ticks ",
          { b: "Follow up payments on their accounts" },
          " for their role in ",
          { b: "Settings › Roles & Permissions" },
          ", or for one person in ",
          { b: "Settings › Users" },
          ".",
        ),
      ),
    ],
    tasks: [
      task(
        "Record a payment against an invoice",
        ol(
          "Open the issued tax invoice.",
          runs("In its ", { b: "Payments & credits" }, " panel, select ", { b: "Record payment" }, ". The ", { b: "Amount" }, " starts at the balance due."),
          runs(
            "Fill in ",
            { b: "Received on" },
            ", the ",
            { b: "Method" },
            " and a ",
            { b: "Reference" },
            " (UTR or cheque number) and, if you like, ",
            { b: "Notes" },
            ". On an invoice in another currency, enter the ",
            { b: "Amount received" },
            " in that currency and the ",
            { b: "Rate on the day" },
            ".",
          ),
          runs("Select ", { b: "Record payment" }, "."),
        ),
        p("The invoice becomes Partially paid, or Paid once nothing is left. A payment can't be more than the balance — record any excess as a separate payment, so it stays unapplied on the customer's account."),
      ),
      task(
        "Apply a credit note to an invoice",
        ol(
          runs("Open the open invoice and select ", { b: "Apply credit note" }, " — it appears when the customer has an issued credit note with something left on it."),
          runs("Choose the ", { b: "Credit note" }, " and the ", { b: "Amount to apply" }, ", then select ", { b: "Apply" }, "."),
        ),
        p(
          runs(
            "Or start from the credit note: its ",
            { b: "Applied to invoices" },
            " card shows what is still unapplied, and ",
            { b: "Apply to an invoice" },
            " does the same. The credit note and the invoice must be for the same customer and in the same currency. ",
            { b: "Remove" },
            " on the invoice's list takes an application off again.",
          ),
        ),
      ),
      task(
        "See who owes what",
        ol(
          runs("Open ", { b: "Payments › Receivables" }, ". The cards show the ", { b: "Total outstanding" }, ", what is ", { b: "Overdue" }, ", ", { b: "Not yet due" }, " and ", { b: "90+ days" }, "."),
          runs("Type in ", { b: "Search customer name…" }, ", or pick ", { b: "Broken promises" }, " or ", { b: "Promised this week" }, "."),
          runs("Select a customer to open their ", { b: "Statement" }, " tab: what they were invoiced, received and credited, the ageing, their open invoices and the running statement of account."),
        ),
        p("Each row also shows the last follow-up anybody logged for that customer, and the promise to pay that matters most."),
      ),
      task(
        "Log a follow-up and a promise to pay",
        ol(
          runs(
            "Select ",
            { b: "Log follow-up" },
            " on the invoice's ",
            { b: "Payment follow-ups" },
            " card or in My collections — or ",
            { b: "Follow up" },
            " beside an open invoice on the customer's Statement tab.",
          ),
          runs("Choose ", { b: "How you reached them" }, " (Call, WhatsApp, Email, Visit, Meeting or Other) and write ", { b: "What the client said" }, "."),
          runs("If they promised to pay, fill in ", { b: "Will pay by" }, " and the ", { b: "Amount" }, " under ", { b: "A promise to pay (optional)" }, "."),
          runs("Pick a ", { b: "Next follow-up (optional)" }, " date to get a task for that day, or a reminder that morning."),
          runs("Select ", { b: "Save follow-up" }, "."),
        ),
        p("A new promise on the same invoice or order replaces the one still open. Sales and accounts share one history, so everybody sees what the customer has already been told."),
      ),
      task(
        "Work through My collections",
        ol(
          runs("Open ", { b: "Payments › My collections" }, "."),
          runs(
            "Pick a filter: ",
            { b: "All" },
            ", ",
            { b: "Overdue" },
            ", ",
            { b: "Promise broken" },
            ", ",
            { b: "Promised this week" },
            " or ",
            { b: "No follow-up in 14 days" },
            ". Sort by ",
            { b: "Most overdue" },
            " or ",
            { b: "Largest amount" },
            ".",
          ),
          runs("For each invoice or order, read the last follow-up and the promise, and select ", { b: "Log follow-up" }, " when you have spoken to the client."),
        ),
        p("It lists the accounts you manage (and your team's), and orders you punched on anybody's account; somebody whose record scope reaches every account sees what every client owes. Orders nobody has invoiced yet are included."),
      ),
      task(
        "Check a customer's credit and set a limit",
        ol(
          runs("Open ", { b: "Payments › Customer credit" }, ". Customers are listed riskiest first; filter by rating or search."),
          runs("Select a customer to open their ", { b: "Credit" }, " tab: the suggested and standing terms, the credit limit, and ", { b: "What the rating is based on" }, ", bill by bill."),
          runs(
            "With the permission to override credit, use ",
            { b: "Set the limit by hand" },
            ": enter the ",
            { b: "Limit (₹)" },
            " and say ",
            { b: "Why" },
            ", then select ",
            { b: "Save limit" },
            ". ",
            { b: "Use the suggested limit instead" },
            " goes back to the rating's figure.",
          ),
        ),
        note("Every time somebody gives more credit than suggested, it is listed under Credit decisions on the customer's Credit tab, with the reason."),
      ),
    ],
    settings: [
      setting(
        "Payment terms",
        "On each customer's record",
        p("The customer's standing terms — Due on receipt, Advance, Net 15, Net 30, Net 45 or Net 60. Customer credit shows when they are longer than the rating suggests."),
      ),
      setting(
        "Due date",
        "On each tax invoice",
        p("The day the invoice falls due, which ageing counts from. Left blank, the invoice ages from its issue date, so old debt is never hidden as not yet due."),
      ),
      setting(
        "Follow up payments on their accounts",
        "Settings › Roles & Permissions",
        p("Off for every role until an admin ticks it — per role here, or for one person in Settings › Users. It shows a salesperson money on orders they punched on somebody else's account, which viewing payments alone does not."),
      ),
    ],
    faq: [
      qa(
        "I can't see Receivables, Customer credit or My collections in the menu.",
        p(
          "Either the module is switched off for your company, its section has been hidden for your role, or you don't hold the permission to view payments. My collections also needs the permission to follow up payments on your accounts. Ask an admin: the switch is in Settings › Modules, and the section and permissions are in Settings › Roles & Permissions.",
        ),
      ),
      qa(
        "An invoice I raised isn't on Receivables.",
        p("Only issued tax invoices with something still owed are listed. A draft, a cancelled invoice and one settled in full are not. You also only see the customers your record scope reaches."),
      ),
      qa(
        "Why is there no Record payment button on the invoice?",
        p("Recording payments needs its own permission. The button is also hidden on an invoice that is settled in full, and there is no panel on a draft or a cancelled invoice."),
      ),
      qa(
        "It says only part of the amount is outstanding.",
        p("A payment against an invoice can't be more than its balance. Record the invoice's balance here, and the rest as a separate payment in Payments, where it stays unallocated."),
      ),
      qa(
        "Why can't I apply this credit note?",
        p("It must be issued, for the same customer as the invoice, in the same currency, with something left unapplied — and the invoice must still be open. If it is already applied to that invoice, remove it first to change the amount."),
      ),
      qa(
        "Who is told when a promise to pay is broken?",
        p("The person who logged the promise and their reporting manager are each told about it, and everybody who can record payments gets one summary of the day's broken promises. The Receivables list and My collections both have a filter for them."),
      ),
    ],
    related: ["sales_documents", "payments", "companies", "accounting"],
  },
};

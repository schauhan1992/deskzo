import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Payments — written from src/app/(dashboard)/payments/page.tsx, src/components/payments (Record
 * payment, the order's Payments dialog, Payments received, Allocate, Delete), src/actions/payment.ts
 * (what recording, allocating, un-applying and deleting allow and refuse, and that a payment is posted
 * to the ledger and a deletion reversed) and the Payments tab on a customer's page
 * (src/components/companies/company-detail.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/payments",
  title: "Payments",
  seo: {
    title: "Payments: record money received against orders",
    description: "How to record payments customers make against their orders in {siteName}, hold a lump sum to allocate later, and see what is still outstanding.",
    keywords: ["record payments", "payments received", "outstanding balance"],
  },
  guide: {
    module: "payments",
    heading: "Payments",
    summary:
      "Record the money customers pay against their orders — or as a lump sum to set against an order later — and see what is still outstanding on every order.",
    purpose: [
      p(
        runs(
          "Payments is the record of money coming in. Every order is listed with its total, what has been paid against it and the balance, and a status: ",
          { b: "Unpaid" },
          ", ",
          { b: "Partially paid" },
          " or ",
          { b: "Paid" },
          ". The heading adds it up: how many orders, how much is outstanding, and how much has been received but not yet allocated.",
        ),
      ),
      p(
        runs(
          "A payment is either applied to one order as you record it, or recorded as a lump sum that stays unallocated until you allocate it. Every payment is listed under ",
          { b: "Payments received" },
          ", with who recorded it and how much of it is still unallocated. Recording a payment posts it to the books; deleting one reverses that posting.",
        ),
      ),
      note(
        runs(
          "A payment against a tax invoice is recorded on the invoice itself, in its Payments & credits panel — see ",
          ["Receivables", "/help/receivables"],
          ".",
        ),
      ),
    ],
    access: [
      p("Anybody whose role can view payments sees the Payments screen and the Payments tab on a customer's page. Which customers' money they see follows the record scope set for their role in Settings › Roles & Permissions."),
      ul(
        runs({ b: "Record payments" }, " — the ", { b: "+ Record payment" }, " button, recording against an order, and allocating a lump sum."),
        runs({ b: "Delete payments" }, " — deleting a payment, and un-applying one from an order."),
      ),
      p("Without either, the Payments button on an order's row is hidden too: the list is for reading."),
    ],
    permissions: [
      perm(
        "payments.view",
        "Shows Payments, each order's paid and outstanding figures, and the Payments tab on a customer's page — and Receivables and Payables as well. Sales, Support, Accounts, Purchase and Management have it by default.",
      ),
      perm("section.payments", "Shows Payments in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "payments.record",
        "Record a payment received, against an order or as a lump sum, and allocate a lump sum to an order. Accounts and Management have it by default.",
      ),
      perm(
        "payments.delete",
        "Delete a payment — its allocations go with it — and un-apply a payment from an order. Accounts and Management have it by default.",
      ),
    ],
    setup: [
      p(
        runs(
          "There is nothing to set up in Payments itself: it works on the orders punched in ",
          ["Orders", "/help/orders"],
          ". Each order's total includes its GST.",
        ),
      ),
      p(
        runs(
          "An admin decides who may record and delete payments by ticking ",
          { b: "Record payments" },
          " and ",
          { b: "Delete payments" },
          " for their roles in ",
          { b: "Settings › Roles & Permissions" },
          ".",
        ),
      ),
    ],
    tasks: [
      task(
        "Record a payment against an order",
        ol(
          runs("Open ", { b: "Accounts › Payments" }, " and select ", { b: "+ Record payment" }, "."),
          runs("Search for the company and select it. Its orders are listed with the balance due on each."),
          "Select the order the payment is for.",
          runs(
            "Fill in the ",
            { b: "Amount" },
            ", ",
            { b: "Date received" },
            " and ",
            { b: "Method" },
            " (Bank transfer, UPI, Cheque, Cash, Card or Other), and if you like a ",
            { b: "Reference" },
            " (UTR, cheque number or transaction id) and ",
            { b: "Notes" },
            ".",
          ),
          runs("Select ", { b: "Record payment" }, "."),
        ),
        p(
          runs(
            "You can also select ",
            { b: "Payments" },
            " on the order's row: it shows what has been applied to that order so far, with ",
            { b: "Record a new payment for this order" },
            " below. On a customer's page, the Payments tab has the same button for that customer.",
          ),
        ),
      ),
      task(
        "Record a lump sum and allocate it later",
        ol(
          runs("Select ", { b: "+ Record payment" }, " and pick the company."),
          runs("Instead of an order, choose ", { b: "Record as a lump sum — don't apply to an order yet" }, "."),
          runs("Fill in the amount and the rest, and select ", { b: "Record payment" }, "."),
          runs("Later, find it under ", { b: "Payments received" }, " — its ", { b: "Unallocated" }, " amount is shown — and select ", { b: "Allocate" }, "."),
          runs("Choose the ", { b: "Order" }, ", enter the ", { b: "Amount to allocate" }, ", and select ", { b: "Allocate" }, "."),
        ),
        p("You can allocate part of a payment and the rest later. An allocation can't be more than what is left unallocated on the payment, nor more than the order's balance."),
      ),
      task(
        "See what is outstanding",
        ol(
          runs("Open ", { b: "Accounts › Payments" }, "."),
          runs("Type in ", { b: "Search company name…" }, " to see one customer's orders."),
          runs("Use the ", { b: "Status" }, " filter to show only ", { b: "Unpaid" }, ", ", { b: "Partially paid" }, " or ", { b: "Paid" }, " orders."),
        ),
        p(runs("The search and the filter narrow the orders. Below them, ", { b: "Payments received" }, " lists every payment received, latest first, with how much of each is allocated and unallocated.")),
      ),
      task(
        "Correct a payment",
        ol(
          runs("If it was applied to the wrong order, select ", { b: "Payments" }, " on that order's row and select ", { b: "Un-apply" }, " beside it. The money becomes unallocated again."),
          runs("Then select ", { b: "Allocate" }, " on the payment under ", { b: "Payments received" }, " and choose the right order."),
          runs(
            "If the payment shouldn't exist at all, select ",
            { b: "Delete" },
            " beside it under ",
            { b: "Payments received" },
            " (or tick several and select ",
            { b: "Delete" },
            " in the bar that appears) and confirm.",
          ),
        ),
        note("Deleting a payment can't be undone. Its allocations go with it, so the orders it paid for become outstanding again, and its posting in the books is reversed.", "warning"),
      ),
    ],
    settings: [
      setting(
        "Record payments and Delete payments",
        "Settings › Roles & Permissions",
        p("Who may record, allocate, un-apply and delete payments, role by role. Viewing payments is a separate permission, which most roles hold."),
      ),
      setting(
        "Payments",
        "Settings › Modules",
        p("Whether the Payments screen exists in your workspace at all. Switching it off hides it everywhere, including the Payments tab on customers' pages."),
      ),
    ],
    faq: [
      qa(
        "I can't see Payments in the menu.",
        p(
          "Either the module is switched off for your company, its section has been hidden for your role, or you don't hold the permission to view payments. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions.",
        ),
      ),
      qa("Why is there no Record payment button?", p("Recording payments needs its own permission, which Accounts and Management hold by default. Without it you can see payments but not add one.")),
      qa(
        "It says the order is cancelled — record the payment on account instead.",
        p("New money can't be applied to a cancelled order. Record it as a lump sum and allocate it to another order, or leave it on the customer's account."),
      ),
      qa(
        "I applied a payment to the wrong order.",
        p("Un-apply it from that order (Payments on the order's row, then Un-apply), then allocate it to the right one from Payments received. Un-applying needs the permission to delete payments."),
      ),
      qa(
        "Where do I record a payment against a tax invoice?",
        p(
          runs("On the invoice: open it and select ", { b: "Record payment" }, " in its Payments & credits panel. See ", ["Receivables", "/help/receivables"], "."),
        ),
      ),
      qa(
        "Why don't payments to vendors show here?",
        p(
          runs("Payments lists money received only. Money paid out to vendors is recorded against their bills — see ", ["Payables", "/help/payables"], "."),
        ),
      ),
    ],
    related: ["orders", "receivables", "companies", "accounting"],
  },
};

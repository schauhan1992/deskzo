import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Payables — written from src/app/(dashboard)/payables/page.tsx (the aged list),
 * src/components/documents/bill-settlement.tsx (Paid to vendor on a bill), src/actions/payable.ts
 * (paying a bill, what Payables lists), src/app/(dashboard)/purchase/vendor-credits (the list, Record
 * a credit, a credit's page), src/components/rebates (the credit form and its actions) and
 * src/actions/vendor-credit.ts (who may see and record vendor credits, and what each refuses).
 */
export const guide: SeedGuide = {
  slug: "help/payables",
  title: "Payables",
  seo: {
    title: "Payables: what you owe vendors, aged and paid",
    description: "How {siteName} ages the bills you owe vendors, records the payments that settle them, and books credit notes and rebate payouts from distributors and OEMs.",
    keywords: ["accounts payable", "vendor payments", "vendor credits"],
  },
  guide: {
    module: "payables",
    heading: "Payables",
    summary:
      "What you owe vendors, aged from each bill's due date — bills settled by payments recorded against them, and credit notes and rebate payouts from distributors and OEMs recorded as vendor credits.",
    purpose: [
      p(
        runs(
          "Payables is the mirror of Receivables: one row per vendor you still owe, with their bills bucketed by how far past due they are — ",
          { b: "Not yet due" },
          ", ",
          { b: "1–30 days" },
          ", ",
          { b: "31–60 days" },
          ", ",
          { b: "61–90 days" },
          " and ",
          { b: "90+ days" },
          ". It is the list a payment run is planned from.",
        ),
      ),
      p(
        runs(
          "The bills come from ",
          ["Purchase Documents", "/help/purchase-documents"],
          ". A bill is settled by recording a payment against it on the bill's own page, and each payment out is posted to the books. A bill is aged from its due date, or from its date when it has none.",
        ),
      ),
      p(
        runs(
          { b: "Vendor credits" },
          " are what distributors and OEMs give back: a credit note that reduces what you owe them, or a rebate paid into your bank. Each is posted to the books as it is recorded, and set against the backend rebates expected on your orders and — a credit note — against the vendor's open bills.",
        ),
      ),
    ],
    access: [
      p("Anybody whose role can view payments sees Payables and the Paid to vendor panel on a bill. Which vendors they see follows the record scope set for their role in Settings › Roles & Permissions."),
      ul(
        runs({ b: "Record payments" }, " — record a payment against a bill."),
        runs({ b: "See backend rebates" }, " — open Payments › Vendor credits and each credit's page."),
        runs({ b: "Manage rebate programmes and vendor credits" }, " — record a credit, set it against rebates or bills, take a settlement off, and cancel a credit."),
      ),
    ],
    permissions: [
      perm(
        "payments.view",
        "Shows Payables and the Paid to vendor panel on a vendor bill — and Payments and Receivables too. Sales, Support, Accounts, Purchase and Management have it by default.",
      ),
      perm("section.payables", "Shows Payables under Payments in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "rebates.view",
        "Shows Payments › Vendor credits and each credit's page, along with the backend rebates on orders. Management, Accounts and Purchase have it by default.",
      ),
      perm("payments.record", "Record a payment against a vendor bill. Accounts and Management have it by default."),
      perm(
        "rebates.manage",
        "Record a vendor credit (it posts to the books straight away), set it against orders' rebates and bills, take a settlement off, and cancel a credit. Management and Accounts have it by default.",
      ),
    ],
    setup: [
      p(
        runs(
          "There is nothing to set up in Payables itself. Record your vendors' bills in Purchase Documents with a ",
          { b: "Due date" },
          ", and they appear here as soon as they are issued.",
        ),
      ),
      p(
        runs(
          "Vendor credits settle the backend rebates expected on orders. The standing rebates that are suggested on each order are set up in ",
          { b: "Settings › Rebate programmes" },
          " — see ",
          ["Orders", "/help/orders"],
          ".",
        ),
      ),
    ],
    tasks: [
      task(
        "See what you owe",
        ol(
          runs("Open ", { b: "Payments › Payables" }, ". The cards show the ", { b: "Total owed" }, ", what is ", { b: "Overdue" }, ", ", { b: "Not yet due" }, " and ", { b: "Over 90 days" }, "."),
          runs("Type in ", { b: "Search vendor name…" }, " to find one vendor."),
          "Select a vendor to open their page, and their bills from its Documents tab.",
        ),
      ),
      task(
        "Pay a vendor bill",
        ol(
          runs("Open the issued bill under ", { b: "Purchase › Vendor Bills" }, "."),
          runs("In its ", { b: "Paid to vendor" }, " panel — ", { b: "Billed" }, ", ", { b: "Paid" }, ", ", { b: "Credited" }, " and ", { b: "Balance" }, " — select ", { b: "Record a payment" }, "."),
          runs(
            "Fill in the ",
            { b: "Amount" },
            ", ",
            { b: "Paid on" },
            ", ",
            { b: "Method" },
            " and ",
            { b: "Reference" },
            ". On a bill in another currency, enter the ",
            { b: "Amount paid" },
            " in that currency and the ",
            { b: "Rate on the day" },
            ".",
          ),
          runs("Select ", { b: "Record payment" }, "."),
        ),
        p("The bill becomes Partially paid, or Paid once nothing is left — and then drops off Payables. A payment can't be more than what is outstanding on the bill."),
        note(
          "Marking a bill Paid from its More menu also takes it off Payables, but records no payment and posts nothing to the books. Use Record a payment for money that has actually gone out.",
          "warning",
        ),
      ),
      task(
        "Record a credit note or a rebate payout",
        ol(
          runs("Open ", { b: "Payments › Vendor credits" }, " and select ", { b: "Record a credit" }, "."),
          runs("Under ", { b: "From" }, ", pick the distributor or OEM."),
          runs(
            "Under ",
            { b: "It came as" },
            ", choose ",
            { b: "A credit note — what we owe them goes down" },
            " or ",
            { b: "Money paid into our bank" },
            "; under ",
            { b: "For" },
            ", choose ",
            { b: "A backend rebate" },
            ", ",
            { b: "A bill above the deal price" },
            " or ",
            { b: "Something else" },
            ".",
          ),
          runs(
            "Fill in the ",
            { b: "Date" },
            " (not in the future), ",
            { b: "Their credit note number" },
            " or ",
            { b: "The payment's reference" },
            ", the bank it went ",
            { b: "Into" },
            " for a payout, and the amounts: ",
            { b: "Before GST" },
            ", ",
            { b: "CGST" },
            ", ",
            { b: "SGST" },
            " and ",
            { b: "IGST" },
            ".",
          ),
          runs(
            "Under ",
            { b: "Set against orders' rebates" },
            " — and, for a credit note, against the vendor's bills — enter how much goes where, or select ",
            { b: "Fill oldest first" },
            ".",
          ),
          runs("Select ", { b: "Record and post" }, "."),
        ),
        p("A credit note set against a bill reduces what that bill still owes. Whatever isn't set against anything waits on the vendor's account."),
      ),
      task(
        "Settle more of a credit, or cancel one",
        ol(
          runs("Open the credit from ", { b: "Payments › Vendor credits" }, "."),
          runs("Use ", { b: "Set more against rebates or bills" }, " to place what is left, or ", { b: "Take off" }, " beside a rebate or bill it was set against."),
          runs(
            "If it was recorded in error, select ",
            { b: "Cancel this credit" },
            ", say ",
            { b: "Why" },
            " and select ",
            { b: "Cancel it" },
            ". Its posting is reversed that day, the rebates it was set against are due again, and the bills owe again.",
          ),
        ),
      ),
    ],
    settings: [
      setting(
        "Due date",
        "On each vendor bill",
        p("The day the bill falls due, which Payables ages from. Left blank, the bill ages from its date."),
      ),
      setting(
        "Rebate programmes",
        "Settings › Rebate programmes",
        p("The standing rebates OEMs and distributors pay, suggested on each order. Vendor credits are what settles those rebates when the money or the credit note arrives. Anyone who can see backend rebates can read the screen; only those who manage them can change it."),
      ),
    ],
    faq: [
      qa(
        "I can't see Payables or Vendor credits in the menu.",
        p(
          "Either the module is switched off for your company, its section has been hidden for your role, or you don't hold the permission to view payments. Vendor credits also needs the permission to see backend rebates. Ask an admin: the switch is in Settings › Modules, and the section and permissions are in Settings › Roles & Permissions.",
        ),
      ),
      qa(
        "A bill I've paid still shows on Payables.",
        p("Payables lists every issued bill that isn't paid in full or cancelled. Open the bill and check its Paid to vendor panel: the payment has to be recorded against the bill with Record a payment, and a part payment leaves the rest outstanding."),
      ),
      qa(
        "Why is there no Record a payment button on the bill?",
        p("Recording payments needs its own permission. The button is also hidden on a bill that is settled in full, and there is no panel on a draft or a cancelled bill."),
      ),
      qa(
        "It says only part of the amount is outstanding on this bill.",
        p("A payment against a bill can't be more than its balance. Record the bill's balance, and anything extra as a separate payment."),
      ),
      qa(
        "Record a credit says it is for whoever manages rebates.",
        p("Recording, settling and cancelling vendor credits needs the permission to manage rebate programmes and vendor credits. Seeing them needs the permission to see backend rebates."),
      ),
      qa(
        "I recorded a vendor credit by mistake.",
        p("Open it and select Cancel this credit, with a reason. Its posting is reversed, and whatever it was set against owes again. A cancelled credit stays in the list, struck through."),
      ),
    ],
    related: ["purchase_documents", "vendors", "orders", "accounting"],
  },
};

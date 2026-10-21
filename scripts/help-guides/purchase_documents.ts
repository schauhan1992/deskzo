import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Purchase Documents — written from src/app/(dashboard)/purchase (Purchase Orders, Vendor Bills and
 * Reconciliation), the shared document pages and components in src/app/(dashboard)/documents and
 * src/components/documents, src/actions/trade-document.ts (issue, convert, status, delete),
 * src/lib/documents/write-permission.ts (which permission each type's writes ask),
 * src/actions/order-vendor-po.ts and src/lib/orders/vendor-po.ts (a PO from an order),
 * src/components/reconcile and src/actions/reconcile.ts (statements), src/lib/reconcile/match.ts
 * (what each line is found to be), and the settings screens for numbering, approvals and document
 * emails.
 */
export const guide: SeedGuide = {
  slug: "help/purchase-documents",
  title: "Purchase Documents",
  seo: {
    title: "Purchase documents: purchase orders and vendor bills",
    description: "How to raise purchase orders to vendors in {siteName}, record the bills they send back against them, and reconcile a distributor's monthly statement.",
    keywords: ["purchase orders", "vendor bills", "vendor reconciliation"],
  },
  guide: {
    module: "purchase_documents",
    heading: "Purchase Documents",
    summary:
      "Purchase orders you raise on vendors and the bills they send back against them — drafted, issued and kept linked — plus a check of a distributor's monthly statement against what you actually sold.",
    purpose: [
      p(
        runs(
          "Purchase Documents is the buying side of your paperwork. A ",
          { b: "Purchase order" },
          " is what you send a vendor or distributor; a ",
          { b: "Vendor bill" },
          " is the invoice they send you back. When the vendor's invoice arrives, you convert the purchase order into a bill, so the two stay linked.",
        ),
      ),
      p(
        "Both work like sales documents: they start as drafts you can change freely, and issuing makes them final. A purchase order posts nothing to the books. A vendor bill is posted when it is issued, and from then on it is part of what you owe the vendor.",
      ),
      p(
        runs(
          { b: "Reconciliation" },
          " compares a distributor's statement with your orders: seat counts that drifted, prices that differ from what your order records, subscriptions still being charged for that no live order covers, and orders live on your side that never reached the vendor.",
        ),
      ),
      note(
        runs(
          "A purchase order can also be raised in one click from an order: ",
          { b: "Create vendor PO" },
          " in the order's ",
          { b: "Purchasing" },
          " box — see ",
          ["Orders", "/help/orders"],
          ". To pay a bill, see ",
          ["Payables", "/help/payables"],
          ".",
        ),
      ),
    ],
    access: [
      p(
        "Anybody whose role can view quotes and invoices sees the Purchase Orders and Vendor Bills lists, and the Documents tab on a vendor's page. Which documents they see follows the record scope set for their role in Settings › Roles & Permissions.",
      ),
      p("Writing them is split between purchase and accounts:"),
      ul(
        runs({ b: "Raise purchase orders" }, " — create, edit, issue and cancel purchase orders, and delete a draft one."),
        runs(
          { b: "Raise and issue sales documents" },
          " — record a vendor bill, and convert a purchase order into one. A bill posts to the books, so it stays with this permission rather than with purchase orders.",
        ),
        runs({ b: "Delete or cancel a sales document" }, " — cancel a vendor bill, mark it paid by hand, or delete a draft one."),
        runs({ b: "Reconcile vendor statements" }, " — Accounts › Reconciliation."),
      ),
    ],
    permissions: [
      perm(
        "documents.view",
        "Shows the Purchase Orders and Vendor Bills lists, each document's page, and the Documents tab on a vendor's page. Sales, Support, Accounts, Purchase and Management have it by default.",
      ),
      perm(
        "section.purchaseDocuments",
        "Shows Purchase Documents under Purchase in the menu and lets people open its pages. Every role has it until an admin unticks it for one.",
      ),
      perm(
        "purchase.reconcile",
        "Shows Accounts › Reconciliation: adding a vendor's statement, comparing it with your orders, and clearing each exception once it has been dealt with. Purchase, Accounts and Management have it by default.",
      ),
      perm(
        "purchase.raiseOrders",
        "Create, edit, issue and cancel purchase orders — from the Purchase Orders list, a vendor's page, or Create vendor PO on an order. Purchase, Accounts and Management have it by default.",
      ),
      perm(
        "documents.issue",
        "Record a vendor bill — create, edit and issue it — and convert a purchase order into a bill. Sales, Accounts and Management have it by default.",
      ),
      perm(
        "documents.void",
        "Mark a vendor bill Paid or Cancelled by hand, and delete a draft bill. Accounts and Management have it by default.",
      ),
      perm("settings.manage", "Change organisation settings — needed to change Document numbering and Document approvals. Only admins have it by default."),
    ],
    setup: [
      p(
        runs(
          "The vendors you buy from need to be on file: a purchase document can be raised for a company recorded as a vendor, OEM, distributor or partner — see ",
          ["Vendors", "/help/vendors"],
          ". Lines are picked from your catalogue, as on a sales document.",
        ),
      ),
      p("An admin can then, once:"),
      ul(
        runs({ b: "Settings › Document numbering" }, " — the prefix and running number for purchase orders and vendor bills."),
        runs({ b: "Settings › Branches" }, " — with more than one branch, each document has a Buying branch, whose GSTIN it carries."),
        runs({ b: "Settings › Document approvals" }, " — if purchase orders or bills must be signed off before they are issued."),
      ),
      p("Reconciliation needs nothing set up: the columns of a vendor's file are worked out for you, and remembered."),
    ],
    tasks: [
      task(
        "Raise a purchase order",
        ol(
          runs("Open ", { b: "Accounts › Purchase Orders" }, " and select ", { b: "New purchase order" }, "."),
          runs("Under ", { b: "Vendor name" }, ", type to search and pick the vendor. Choose a ", { b: "Location on file" }, " to fill in their address and GST details, and check the ", { b: "Place of supply" }, "."),
          runs("Under ", { b: "Document details" }, ", set the ", { b: "Date" }, " and ", { b: "Due date" }, ", and the ", { b: "Buying branch" }, " if you have several."),
          runs("Fill in the ", { b: "Item table" }, " — item, ", { b: "Quantity" }, ", ", { b: "Rate" }, ", ", { b: "Discount" }, " and ", { b: "Tax" }, " on each line."),
          runs("Select ", { b: "Save purchase order" }, ", check it with ", { b: "Preview PDF" }, ", then select ", { b: "Issue" }, "."),
        ),
        p(
          runs(
            "A purchase order raised from an order — ",
            { b: "Create vendor PO" },
            " in its Purchasing box — starts as a draft for the vendor and price saved on the order, delivered to your own address. Issuing it puts its number in the order's ",
            { b: "Our PO to vendor" },
            "; cancelling it takes the number out again.",
          ),
        ),
      ),
      task(
        "Record the vendor's bill",
        ol(
          runs("Open the issued purchase order and select ", { b: "Convert to vendor bill" }, ". A draft bill is made with the purchase order's vendor, branch and lines, dated today."),
          runs("Open the bill from ", { b: "Related documents" }, ", select ", { b: "Edit" }, ", and check the lines, the amounts and the ", { b: "Due date" }, " against the vendor's invoice."),
          runs("Select ", { b: "Save changes" }, ", then ", { b: "Issue" }, "."),
        ),
        p(
          runs(
            "For a bill with no purchase order behind it, select ",
            { b: "New vendor bill" },
            " on ",
            { b: "Accounts › Vendor Bills" },
            " and fill it in the same way. An issued bill is posted to the books and shows on Payables until it is paid.",
          ),
        ),
      ),
      task(
        "Pay a bill",
        ol(
          runs("Open the issued bill under ", { b: "Accounts › Vendor Bills" }, "."),
          runs("In its ", { b: "Paid to vendor" }, " panel, select ", { b: "Record a payment" }, "."),
          runs("Fill in the ", { b: "Amount" }, ", ", { b: "Paid on" }, ", ", { b: "Method" }, " and ", { b: "Reference" }, ", then select ", { b: "Record payment" }, "."),
        ),
        p(runs("The bill becomes Partially paid or Paid as payments are recorded. See ", ["Payables", "/help/payables"], ".")),
        note(
          runs(
            { b: "More › Paid" },
            " only changes the bill's status: it takes the bill off Payables but records no payment and posts nothing. Use Record a payment for money that has actually gone out.",
          ),
          "warning",
        ),
      ),
      task(
        "Confirm or cancel a purchase order",
        ol(
          runs("Open the issued purchase order and select ", { b: "More" }, "."),
          runs("Choose ", { b: "Accepted" }, " when the vendor confirms it, or ", { b: "Cancelled" }, " if it won't go ahead."),
          runs("When cancelling, say why under ", { b: "Reason for cancelling" }, ". The reason is kept on the document, with who cancelled it and when."),
        ),
        p(runs("A draft is removed with ", { b: "More › Delete draft" }, ". A vendor bill is cancelled the same way, with the permission to delete or cancel documents.")),
      ),
      task(
        "Reconcile a distributor's statement",
        ol(
          runs("Open ", { b: "Accounts › Reconciliation" }, " and select ", { b: "Add a statement" }, "."),
          runs("Choose the ", { b: "Vendor" }, ", give it a ", { b: "Name" }, ", and set ", { b: "Period from" }, " and ", { b: "Period to" }, "."),
          runs(
            "Under ",
            { b: "These lines are billed" },
            ", choose ",
            { b: "Monthly" },
            ", ",
            { b: "Annually" },
            " or ",
            { b: "One-off" },
            ". Your orders record the cost of a full term, so a wrong choice makes every price look wrong.",
          ),
          runs(
            "Tick ",
            { b: "This is everything they billed for the period" },
            " for a full statement — your live orders missing from it are then reported. Leave it unticked for a spot check.",
          ),
          runs(
            { b: "Upload a file" },
            " (Excel, CSV, or a PDF from the vendor's portal), or ",
            { b: "Type or paste" },
            " the lines and select ",
            { b: "Check these against our orders" },
            ".",
          ),
          runs("Select ", { b: "Import and reconcile" }, " (or ", { b: "Save and reconcile" }, ")."),
        ),
        p(
          runs(
            "Each line is then ",
            { b: "Matched" },
            " or an exception: ",
            { b: "Seat mismatch" },
            ", ",
            { b: "Price mismatch" },
            ", ",
            { b: "Billed, not sold" },
            ", ",
            { b: "Unknown SKU" },
            ", ",
            { b: "Unknown customer" },
            ", ",
            { b: "Ambiguous" },
            " or ",
            { b: "Sold, not billed" },
            ". When you have dealt with one, select ",
            { b: "Clear this" },
            ", write what was done and select ",
            { b: "Clear" },
            ". ",
            { b: "Reopen" },
            " puts it back on the list.",
          ),
        ),
      ),
    ],
    settings: [
      setting(
        "Document numbering",
        "Settings › Document numbering",
        p(
          runs(
            "The ",
            { b: "Purchase order" },
            " and ",
            { b: "Vendor bill" },
            " rows set each one's ",
            { b: "Mode" },
            " (",
            { b: "Auto" },
            " or ",
            { b: "Manual" },
            "), ",
            { b: "Prefix" },
            ", ",
            { b: "Next" },
            " number and ",
            { b: "Digits" },
            ". A number already issued never changes. The gear beside the number on a document opens the same preferences.",
          ),
        ),
      ),
      setting(
        "Document approvals",
        "Settings › Document approvals",
        p(
          runs(
            "Tick ",
            { b: "Require approval" },
            " on the Purchase order or Vendor bill card to stop either being issued until it is approved — every one, or only above a value or a line discount. Choose the approvers by role, by name, or ",
            { b: "The submitter's manager can approve" },
            ". Nobody approves what they submitted, and editing an approved document sends it back.",
          ),
        ),
      ),
      setting(
        "Document emails",
        "Settings › Document emails",
        p(
          "The wording and sender of emailed documents. Only proposals, proforma invoices, tax invoices and credit notes are emailed from the app — purchase orders and vendor bills have no Mail button, so this screen changes nothing for them.",
        ),
      ),
    ],
    faq: [
      qa(
        "I can't see Purchase Documents, or Reconciliation, in the menu.",
        p(
          "Either the module is switched off for your company, its section has been hidden for your role, or you don't hold the permission to view quotes and invoices. Reconciliation also needs the permission to reconcile vendor statements. Ask an admin: the switch is in Settings › Modules, and the section and permissions are in Settings › Roles & Permissions.",
        ),
      ),
      qa(
        "I can raise purchase orders, so why can't I record the vendor's bill?",
        p("A vendor bill posts to the books, so recording one — or converting a purchase order into one — needs the permission to raise and issue sales documents, not the purchase order one."),
      ),
      qa(
        "Can I email a purchase order to the vendor?",
        p("Not from the app — the Mail button is only on proposals, proforma invoices, tax invoices and credit notes. Select Print / PDF on the purchase order and send the PDF yourself."),
      ),
      qa(
        "I marked a bill Paid, but no payment shows anywhere.",
        p("Marking a bill Paid by hand only changes its status. To record money going out — so it is posted to the books — open the bill and use Record a payment in its Paid to vendor panel."),
      ),
      qa(
        "Why can't I edit an issued purchase order?",
        p("Only a draft can be edited. Cancel the issued one with a reason and raise a new one."),
      ),
      qa(
        "My vendor's PDF statement won't import.",
        p("A scanned PDF or a photo can't be read. Ask the vendor for Excel or CSV, or choose Type or paste and enter the lines yourself."),
      ),
      qa(
        "What do Unknown SKU and Unknown customer mean?",
        p("Unknown SKU: the line's product isn't in your catalogue — add the item, or fix the column mapping. Unknown customer: the name on the statement matches no company in your records."),
      ),
    ],
    related: ["vendors", "payables", "orders", "items"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Sales Documents — written from src/app/(dashboard)/sales (the five document lists and E-Way Bills),
 * src/app/(dashboard)/documents (new, edit and the shared detail page), src/components/documents
 * (the list, form, detail, actions bar, approval bar, email dialog, number preferences),
 * src/components/logistics/eway-panel.tsx, src/actions/trade-document.ts (what issuing, converting,
 * cancelling and deleting allow and refuse), src/actions/eway.ts, src/actions/document-approval.ts,
 * src/lib/trade-documents.ts, src/lib/documents/write-permission.ts, src/lib/document-next-step.ts and
 * the settings screens under src/app/(dashboard)/settings (numbering, approvals, document-emails,
 * einvoicing, eway, organisation).
 */
export const guide: SeedGuide = {
  slug: "help/sales-documents",
  title: "Sales Documents",
  seo: {
    title: "Sales documents: proposals, invoices and credit notes",
    description: "How to raise proposals, proforma and tax invoices, credit notes and delivery challans in {siteName}, issue and email them, and file e-invoices and e-way bills.",
    keywords: ["sales documents", "tax invoice", "proposal"],
  },
  guide: {
    module: "sales_documents",
    heading: "Sales Documents",
    summary:
      "Proposals, proforma invoices, tax invoices, credit notes and delivery challans — drafted, issued, printed and emailed, with GST worked out on every line, and India's e-invoice (IRN) and e-way bill filed with the government portal.",
    purpose: [
      p(
        runs(
          "Sales Documents is where you write what goes to a customer: a ",
          { b: "Proposal" },
          " (a quote), a ",
          { b: "Proforma invoice" },
          " (a request for payment before supply — not a tax invoice), a ",
          { b: "Tax invoice" },
          ", a ",
          { b: "Credit note" },
          " (a reduction against an invoice already issued) and a ",
          { b: "Delivery challan" },
          " (what travels with goods that are moving but not being sold). Each has its own list under ",
          { b: "Accounts › Sales" },
          ".",
        ),
      ),
      p(
        "Every document starts as a draft. A draft can be changed as often as you like, and nothing has gone to the customer. Issuing it makes it final: it can't be edited any more, and a tax invoice or a credit note is posted to the books as it is issued. To correct an issued invoice, you raise a credit note against it.",
      ),
      p(
        runs(
          "Documents follow the deal. A proposal converts to a proforma invoice or straight to a tax invoice, a proforma to a tax invoice, and a tax invoice to a credit note. Each conversion makes a new draft with the same customer and lines, and the ",
          { b: "Related documents" },
          " card on both shows how they are linked. A proposal can also be started from a lead, and a tax invoice from one or more orders — see ",
          ["Orders", "/help/orders"],
          ".",
        ),
      ),
      note(
        "Place of supply, GSTIN, the CGST, SGST and IGST split and HSN/SAC codes are India's GST. Generating an IRN (e-invoice) and the E-Way Bills list are only available to a workspace set up for India.",
      ),
    ],
    access: [
      p(
        "Anybody whose role can view quotes and invoices sees the document lists and the Documents tab on a customer's page. Which documents they see follows the record scope set for their role in Settings › Roles & Permissions — for example only their own customers' documents, their branch's, or all of them.",
      ),
      p("What they can do with a document is decided by separate permissions, and only the buttons someone may press are shown to them:"),
      ul(
        runs({ b: "Raise and issue sales documents" }, " — the New buttons, Edit, Issue, the Convert to… buttons and Generate IRN."),
        runs({ b: "Delete or cancel a sales document" }, " — the More menu: marking a status (including Accepted or Rejected on a proposal), cancelling, deleting a draft and cancelling an e-invoice."),
        runs({ b: "Email sales documents to customers" }, " — the Mail button on an issued document."),
        runs({ b: "Process orders (purchasing)" }, " — the E-Way Bills list and the e-way bill panel on a document."),
      ),
      p(
        "If a document type needs approval (Settings › Document approvals), only the approvers chosen there can approve it, and nobody can approve a document they submitted themselves.",
      ),
    ],
    permissions: [
      perm(
        "documents.view",
        "Shows the Proposals, Proforma Invoices, Tax Invoices, Credit Notes and Delivery Challans lists, each document's page, and the Documents tab on a customer's page. Sales, Support, Accounts, Purchase and Management have it by default.",
      ),
      perm(
        "section.salesDocuments",
        "Shows Sales Documents under Finance › Accounts in the menu and lets people open its pages. Every role has it until an admin unticks it for one.",
      ),
      perm(
        "documents.issue",
        "Create, edit and issue proposals, proforma invoices, tax invoices and credit notes, convert one document into the next, and generate an invoice's IRN. Without it the New buttons, Edit and Issue are hidden. Sales, Accounts and Management have it by default.",
      ),
      perm(
        "documents.void",
        "Mark an issued document Accepted, Rejected, Expired or Cancelled, delete a draft, and cancel an e-invoice with the portal. Accounts and Management have it by default.",
      ),
      perm(
        "documents.send",
        "Email an issued proposal, proforma invoice, tax invoice or credit note to the customer's contacts, with the document attached as a PDF. Sales, Accounts and Management have it by default.",
      ),
      perm(
        "orders.process",
        "Needed for the E-Way Bills list and for raising, recording, changing or cancelling an e-way bill on a tax invoice, credit note or delivery challan. Purchase and Management have it by default.",
      ),
      perm(
        "settings.manage",
        "Change organisation settings — needed to change Document numbering, Document approvals, Document emails, e-Invoicing and e-Way bills. Only admins have it by default.",
      ),
    ],
    setup: [
      p("Before the first tax invoice goes out, an admin fills in, once:"),
      ul(
        runs(
          { b: "Settings › Profile" },
          " — the legal name, head-office GSTIN and bank accounts that print on every document, and under ",
          { b: "Invoice defaults" },
          ": the ",
          { b: "Default terms & conditions" },
          " (pre-filled on every new document), the ",
          { b: "Footer note" },
          ", whether totals round to the nearest rupee, and the ",
          { b: "Signature / stamp" },
          ".",
        ),
        runs(
          { b: "Settings › Branches" },
          " — each office's GSTIN and state, if you bill from more than one. A branch with no GSTIN or state is taxed as inter-state (IGST), and the form warns you.",
        ),
        runs({ b: "Settings › Letterhead" }, " — the logo and signature block at the top and bottom of a printed document."),
        runs({ b: "Settings › Document numbering" }, " — the prefix and running number each kind of document is issued with."),
        runs("The items you sell, so lines can be picked from the catalogue — see ", ["Items & Inventory", "/help/items-and-inventory"], "."),
      ),
      p(
        runs(
          "If you want them: ",
          { b: "Settings › Document approvals" },
          " (sign-off before a document can be issued), ",
          { b: "Settings › Document emails" },
          " (the wording of an emailed document, and where it goes out from), and — in India — ",
          { b: "Settings › e-Invoicing" },
          " and ",
          { b: "Settings › e-Way bills" },
          ".",
        ),
      ),
    ],
    tasks: [
      task(
        "Write a proposal",
        ol(
          runs(
            "Open ",
            { b: "Accounts › Proposals" },
            " and select ",
            { b: "New proposal" },
            ". (On a lead, ",
            { b: "Create proposal" },
            " starts it from the lead's required products instead.)",
          ),
          runs("Under ", { b: "Customer name" }, ", type to search and pick the customer. Choose a ", { b: "Location on file" }, " to fill in the billing address and GST details."),
          runs("Check the ", { b: "Place of supply" }, ". It decides whether the tax is CGST + SGST (intra-state) or IGST (inter-state)."),
          runs(
            "Under ",
            { b: "Document details" },
            ", set the ",
            { b: "Date" },
            ", the ",
            { b: "Expiry date" },
            " and, if the customer gave you one, the ",
            { b: "Reference # / their PO" },
            ". The ",
            { b: "Salesperson" },
            " starts as you; ",
            { b: "Account owner" },
            " leaves it to whoever owns the account.",
          ),
          runs(
            "In the ",
            { b: "Item table" },
            ", pick an item on each line and adjust the ",
            { b: "Quantity" },
            ", ",
            { b: "Rate" },
            ", ",
            { b: "Discount" },
            " and ",
            { b: "Tax" },
            ". ",
            { b: "Add new row" },
            " adds another line.",
          ),
          runs("Fill in ", { b: "Customer notes" }, " and ", { b: "Terms & conditions" }, ", check the ", { b: "Summary" }, ", and select ", { b: "Save proposal" }, "."),
        ),
        p(runs("It is saved as a draft. ", { b: "Preview PDF" }, " shows exactly what the customer will receive.")),
      ),
      task(
        "Issue a document",
        ol(
          "Open the draft and read the What's next? line above its buttons.",
          runs("Select ", { b: "Preview PDF" }, " to check the address, the lines and the tax."),
          runs("If it needs approval, select ", { b: "Submit for approval" }, " and wait for an approver to ", { b: "Approve" }, " it."),
          runs(
            "Select ",
            { b: "Issue" },
            ". On a tax invoice or credit note, with e-invoicing switched on, the button reads ",
            { b: "Issue & generate IRN" },
            " and reports it to the portal in the same step.",
          ),
        ),
        p(
          "A document needs at least one line before it can be issued. A draft on an inactive branch can't be issued — move it to an active branch first. And once your company has a GST registration, a tax invoice, credit note or delivery challan can't be issued from a branch without an active one.",
        ),
      ),
      task(
        "Turn a proposal into an invoice",
        ol(
          runs("Open the issued proposal. When the customer agrees, you can mark it with ", { b: "More › Accepted" }, "."),
          runs("Select ", { b: "Convert to proforma invoice" }, " if they are paying in advance, or ", { b: "Convert to tax invoice" }, "."),
          runs("A new draft is made with the same customer, branch, lines and totals, dated today. Open it from ", { b: "Related documents" }, "."),
          "Check it, then issue it.",
        ),
        p("A cancelled or rejected document can't be converted."),
      ),
      task(
        "Correct an issued invoice with a credit note",
        ol(
          runs(
            "Open the tax invoice and select ",
            { b: "Convert to credit note" },
            " — or select ",
            { b: "New credit note" },
            " on ",
            { b: "Accounts › Credit Notes" },
            " and choose the invoice under ",
            { b: "Against invoice" },
            ".",
          ),
          "Change the lines to what is being reduced — a return, a discount, a correction.",
          runs("Save it and select ", { b: "Issue" }, "."),
        ),
        p(
          runs(
            "The credit note goes out from the invoice's own branch. To take it off what the customer owes, apply it to the invoice — see ",
            ["Receivables", "/help/receivables"],
            ".",
          ),
        ),
      ),
      task(
        "Email a document to the customer",
        ol(
          runs("Open an issued proposal, proforma invoice, tax invoice or credit note and select ", { b: "Mail" }, "."),
          runs("Under ", { b: "To" }, ", tick the contacts it goes to. Contacts marked ", { b: "Receives invoices" }, " are labelled. A contact who can't be sent this can't be ticked, and the reason is shown under their name."),
          runs("Check the ", { b: "Subject" }, " and ", { b: "Message" }, ". They are filled in from your company's template; ", { b: "Back to the template" }, " undoes your changes."),
          runs("Select ", { b: "Send to" }, " — the button counts the people. The PDF attached is the same one ", { b: "Print / PDF" }, " makes."),
        ),
        p(
          "The top of the dialog says where it is sent from: your own connected mailbox, your company's mail server, or {siteName}'s mail service on your company's behalf, which has a daily limit. Each document keeps a history of the emails sent with it.",
        ),
      ),
      task(
        "Cancel a document or delete a draft",
        ol(
          runs("Open the issued document, select ", { b: "More" }, " and choose ", { b: "Cancelled" }, "."),
          runs("Say why under ", { b: "Reason for cancelling" }, " — it is kept on the document with who cancelled it and when — and confirm."),
        ),
        p(
          runs(
            "A tax invoice with an active IRN can't be cancelled until its e-invoice is: select ",
            { b: "More › Cancel e-invoice" },
            ", choose a ",
            { b: "Reason" },
            " and type a ",
            { b: "Remark" },
            ". The portal only allows this within 24 hours of the IRN; after that, raise a credit note instead. Cancelling an invoice or credit note reverses its posting in the books.",
          ),
        ),
        p(runs("A draft is deleted with ", { b: "More › Delete draft" }, ". A draft that other documents were made from can't be deleted.")),
      ),
      task(
        "Raise an e-way bill (India)",
        ol(
          runs("Open the issued tax invoice, credit note or delivery challan. Its ", { b: "E-way bill" }, " panel says whether a bill is needed."),
          runs(
            "Select ",
            { b: "Transport details" },
            " and fill in the ",
            { b: "Value of the goods" },
            ", ",
            { b: "Distance" },
            ", ",
            { b: "Transporter" },
            ", ",
            { b: "LR / consignment note" },
            ", ",
            { b: "Mode" },
            ", ",
            { b: "Vehicle" },
            " and ",
            { b: "Vehicle number" },
            ", then ",
            { b: "Save" },
            ".",
          ),
          runs("Select ", { b: "Raise the e-way bill" }, "."),
        ),
        p(
          runs(
            { b: "Accounts › E-Way Bills" },
            " lists every document that carries goods. It opens on ",
            { b: "Needs a bill" },
            "; the other tabs are ",
            { b: "Live" },
            ", ",
            { b: "Expired" },
            ", ",
            { b: "Cancelled" },
            " and ",
            { b: "All" },
            ". A bill raised on the portal itself is recorded with ",
            { b: "Record one from the portal" },
            ". On a live bill, ",
            { b: "Add the vehicle" },
            " or ",
            { b: "Change the vehicle" },
            ", and ",
            { b: "Cancel the bill" },
            " within 24 hours of raising it.",
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
            "One row per document type: ",
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
            ", with a ",
            { b: "Preview" },
            ". In a prefix, {FY} becomes the financial year and {FY2} its short form; {GST} and {BR} print the GST registration's and the branch's code. Tax invoices, credit notes and delivery challans must fit GST's 16 characters.",
          ),
        ),
        p(
          "With more than one branch or GST registration, each type can count One for the company, One per GST registration or One per branch. A number already issued never changes, so a change affects only what comes next. The gear beside the number on a document opens the same preferences.",
        ),
      ),
      setting(
        "Document approvals",
        "Settings › Document approvals",
        p(
          runs(
            "Everything is off until you tick ",
            { b: "Require approval" },
            " for a type. You can limit it to documents ",
            { b: "Only when worth more than (₹)" },
            " an amount (the total including GST) ",
            { b: "Or when any line is discounted more than (%)" },
            " a percentage; leave both blank and every one needs approving.",
          ),
        ),
        p(
          runs(
            "Choose who approves: ",
            { b: "Anyone holding these roles" },
            ", ",
            { b: "And these people by name" },
            ", and ",
            { b: "The submitter's manager can approve" },
            ". A document of that type can still be drafted and edited freely — it just can't be issued until it is approved. Nobody approves what they submitted, and editing an approved document sends it back for approval.",
          ),
        ),
      ),
      setting(
        "Document emails",
        "Settings › Document emails",
        p(
          runs(
            { b: "Send documents from" },
            ": ",
            { b: "Each person's own mailbox" },
            ", ",
            { b: "The company's mail server" },
            ", or ",
            { b: "Their own mailbox if connected, otherwise the company's" },
            ". When what you choose isn't set up for your company, documents go out through {siteName}'s mail service in the sender's name, within a daily limit. A person whose own mailbox can be connected but isn't is asked to connect it first.",
          ),
        ),
        p(
          runs(
            "Below, a tab per type — proposal, proforma invoice, tax invoice, credit note — with the ",
            { b: "Subject" },
            " and ",
            { b: "Message" },
            " the Mail button fills in, a ",
            { b: "Preview" },
            " and the ",
            { b: "Fields you can use" },
            ". ",
            { b: "Back to the built-in wording" },
            " undoes your changes.",
          ),
        ),
      ),
      setting(
        "e-Invoicing (India)",
        "Settings › e-Invoicing",
        p(
          runs(
            { b: "Generate e-invoices automatically when an invoice is issued" },
            " switches IRN generation on for tax invoices and credit notes. ",
            { b: "Minimum invoice value" },
            ": invoices below it skip IRN generation.",
          ),
        ),
        p(
          runs(
            "Each GST registration has its own connection: the ",
            { b: "Provider" },
            " (",
            { b: "Mock (no portal — for testing)" },
            ", ",
            { b: "NIC sandbox" },
            " or ",
            { b: "NIC production" },
            ") and, for NIC, the ",
            { b: "Portal username" },
            ", ",
            { b: "Portal password" },
            ", ",
            { b: "Client ID" },
            " and ",
            { b: "Client secret" },
            ". E-way bills use the same login.",
          ),
        ),
      ),
      setting(
        "e-Way bills (India)",
        "Settings › e-Way bills",
        p(
          runs(
            { b: "Enable" },
            " or ",
            { b: "Disable" },
            " e-way bills. They sign in with each GSTIN's e-invoicing login, so nothing can be filed while e-invoicing is off. ",
            { b: "Threshold within the state" },
            " sets a GSTIN's own limit for movements inside its state; left blank, the central ₹50,000 applies, and ",
            { b: "Use the central threshold" },
            " puts it back. Transporters are kept under ",
            { b: "Manage" },
            ".",
          ),
        ),
      ),
      setting(
        "Invoice defaults",
        "Settings › Profile",
        p(
          runs(
            { b: "Default terms & conditions" },
            " are pre-filled on every new document and can be changed on each one. The ",
            { b: "Footer note" },
            " prints at the bottom of every document. ",
            { b: "Round document totals to the nearest rupee" },
            " adds a round-off line; turn it off to bill to the paisa. ",
            { b: "Signature / stamp" },
            " is the image printed on documents.",
          ),
        ),
      ),
    ],
    faq: [
      qa(
        "I can't see Sales Documents, or one of its lists, in the menu.",
        p(
          "Either the module is switched off for your company, its section has been hidden for your role, or you don't hold the permission to view quotes and invoices. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions. E-Way Bills is only shown to a workspace set up for India.",
        ),
      ),
      qa("Why is there no New button on the list?", p("Raising documents needs the permission to raise and issue sales documents. Without it you can read documents but not create one.")),
      qa(
        "Why can't I edit an issued invoice?",
        p("Only a draft can be edited. Once a document is issued its number is committed and, for an invoice, it may have gone to the portal. Raise a credit note against it, or cancel it and raise a new one."),
      ),
      qa(
        "Why can't I mark my proposal accepted?",
        p("Marking a status — Accepted, Rejected, Expired or Cancelled — needs the permission to delete or cancel a sales document. Without it the More menu doesn't appear. You can still convert the proposal into a proforma or tax invoice."),
      ),
      qa(
        "Issuing says the document needs approving first.",
        p("Its type is switched on in Settings › Document approvals, and this one is over the value or discount limit set there. Select Submit for approval; once an approver approves it, Issue works. If it was rejected, the reason is shown — make the changes and select Submit again."),
      ),
      qa(
        "The portal rejected my invoice. What now?",
        p(
          "The invoice stays issued without an IRN, and the portal's reason is shown in a red box on it. Put right what the reason names — often the connection in Settings › e-Invoicing — then select Retry IRN. If the fault is on the invoice itself, it can't be edited: cancel it and raise a corrected one.",
        ),
      ),
      qa(
        "E-Way Bills says I don't have access to despatch and its paperwork.",
        p("E-way bills need the permission to process orders (purchasing). Ask an admin to grant it in Settings › Roles & Permissions."),
      ),
      qa(
        "How do I raise a delivery challan?",
        p(
          runs(
            "A challan is raised from a consignment, which already knows what is moving and where to: open it under IT Assets › Consignments and select ",
            { b: "Raise the challan" },
            ". It then appears under Accounts › Delivery Challans. A challan carries no tax and never reaches the books. See ",
            ["IT Assets", "/help/it-assets"],
            ".",
          ),
        ),
      ),
    ],
    related: ["orders", "receivables", "items", "companies"],
  },
};

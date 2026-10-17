import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Orders — written from src/app/(dashboard)/orders (the list and its views, the punch form, an order's
 * page, Purchase savings, Backend rebates), src/components/orders (the punch sections, the Actions panel,
 * hand-off, price review, progress, invoicing, rebates), src/actions/order.ts (who may punch, approve,
 * process, fulfil and cancel, and what each refuses), src/actions/order-progress.ts, order-vendor-po.ts,
 * order-billing.ts and rebate.ts, and Settings › Pipeline and Settings › Rebate programmes.
 */
export const guide: SeedGuide = {
  slug: "help/orders",
  title: "Orders",
  seo: {
    title: "Orders: punch, approve, purchase and fulfil customer orders",
    description: "How an order moves through {siteName}: sales punches it, accounts approves its terms, purchase sets the vendor and price, and it's marked fulfilled.",
    keywords: ["order punching", "order approval", "purchase margin"],
  },
  guide: {
    module: "orders",
    heading: "Orders",
    summary: "Order punching from sale to delivery: sales punches the order, accounts approves its payment terms, purchase buys it from a vendor and marks it fulfilled — with the margin, deal registration and backend rebates tracked on the way.",
    purpose: [
      p("An order is one product sold to one customer: the product, quantity and price, the site it goes to, the payment terms, and — for a subscription — its start and expiry dates. Each order has a number starting ORD-."),
      p("Every order passes through the same hands, in this order:"),
      ol(
        runs("Sales punches it. It waits as ", { b: "Pending Approval" }, "."),
        runs("Accounts reviews its payment terms and the customer's credit, and approves or rejects it. Approved, it is ", { b: "Approved" }, "."),
        runs("Once it's approved and sales has sent it to purchase, purchase chooses the vendor and enters the purchase price and our PO. It is then ", { b: "Processing" }, "."),
        runs("When it's delivered, purchase marks it ", { b: "Fulfilled" }, ", and it becomes a live product on the customer's Products & Subscriptions tab."),
      ),
      p("On the way, the order works out its margin: the sale price against the distributor price sales was quoted, the deal registration price, and what purchase actually paid. An order that would sell below cost needs a manager's go-ahead before it's bought."),
      p(runs("Beside the list are two reports: ", { b: "Purchase savings" }, " (what purchase bought below the distributor price sales had) and ", { b: "Backend rebates" }, " (what distributors and OEMs are to pay back on the orders booked).")),
      note(runs("A subscription order also comes up in Renewals before it expires — see ", ["Renewals", "/help/renewals"], ".")),
    ],
    access: [
      p("Anybody who can open Orders can punch an order. Which orders you see follows the customers you can see: with See every account, not just your own, that's every customer's orders; without it, the orders on your own accounts and, if you manage people, your reports' accounts."),
      p("Each step belongs to someone:"),
      ul(
        "Approving or rejecting — people allowed to approve or reject orders, never on an order they punched themselves.",
        "Purchasing — people allowed to process orders: they set the vendor, the price and our PO, raise the vendor PO and mark the order fulfilled.",
        "Deciding when an order goes to purchase, setting its distributor price, and accepting or sending back a higher price — the salesperson who punched it, or anyone who approves orders. Purchase can also change the deal registration.",
        "Cancelling — the salesperson who punched it, an approver, or purchase.",
      ),
      p(runs("An admin can change how far a role reaches over orders in ", { b: "Settings › Roles & Permissions" }, ". Admins have every permission by default.")),
    ],
    permissions: [
      perm("orders.view", "Opens Orders and Renewals at all, and a customer's Products & Subscriptions and Renewals tabs. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.orders", "Shows Orders in the Orders & Renewals menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("orders.approve", "Approve or reject a punched order after checking its payment terms, decide its hand-off and a higher purchase price, and see everyone's purchase savings. Never on an order you punched. Accounts and Management have it by default."),
      perm("orders.process", "Purchase's permission: set the vendor, purchase price and our PO on an approved order, mark it fulfilled, settle a vendor PO left to cancel, and see your own purchase savings. Purchase and Management have it by default."),
      perm("performance.view", "Opens Purchase savings with everybody's figures, for people who look at the team's performance. Management has it by default."),
      perm("rebates.view", "See an order's backend rebates and its net margin after them, enter a rebate when punching or later, open Backend rebates and read the rebate programmes. Management, Accounts and Purchase have it by default."),
      perm("rebates.manage", "Add and change rebate programmes, record the credit notes and payouts distributors and OEMs send, and write off a rebate that won't come. Management and Accounts have it by default."),
      perm("orders.approveLoss", "Approve an order that sells below cost — a negative call. Never on your own order. Management has it by default."),
      perm("credit.override", "Approve an order whose terms are longer than the customer's credit rating supports, or that goes over their credit limit, with a reason. Management and Accounts have it by default."),
      perm("purchase.raiseOrders", "With Process orders, lets purchase raise the vendor's purchase order from an order in one click. Purchase, Accounts and Management have it by default."),
      perm("documents.issue", "Raise tax invoices from orders, link an issued invoice to an order, and set up a subscription's recurring billing. Sales, Accounts and Management have it by default."),
      perm("pipeline.manage", "Add and change the order steps in Settings › Pipeline. Management has it by default."),
    ],
    setup: [
      p("Orders work as soon as the module is on, with items in the catalogue to sell and customers to sell to. Make sure the right people hold the right step: approving for accounts, processing for purchase."),
      p(runs("Optional, done once by a manager or admin: the steps an order goes through within each status in ", { b: "Settings › Pipeline" }, ", and the standing rebates OEMs and distributors pay in ", { b: "Settings › Rebate programmes" }, ".")),
      p(runs("Your company's own order fields are added in ", { b: "Settings › Custom fields" }, ", under Orders.")),
    ],
    tasks: [
      task(
        "Punch an order",
        ol(
          runs("Open ", { b: "Orders & Renewals › Orders" }, " and select ", { b: "Punch order" }, "."),
          runs("Under ", { b: "Customer" }, ", choose the customer and its ", { b: "Location" }, ". For a reseller you can also say which of their customers it's for. Add the ", { b: "Customer PO / invoice number" }, " if you have it."),
          runs("Under ", { b: "Product and price" }, ", choose the ", { b: "Product" }, ", the ", { b: "Quantity" }, " and the ", { b: "Sales price / unit" }, " — blank uses the list price. For a subscription, set the ", { b: "Start date" }, " and a ", { b: "Term" }, " or ", { b: "Expiry date" }, "."),
          runs("Check ", { b: "New or renewal?" }, " — marked Detected when it was worked out from the customer's orders."),
          runs("Under ", { b: "Terms and hand-off" }, ", choose the ", { b: "Payment terms" }, " (or leave the customer's default) and the ", { b: "Purchase hand-off" }, ": ", { b: "Send to purchase now" }, ", ", { b: "Hold (in-hand order)" }, " or ", { b: "Schedule on a date" }, "."),
          runs("If you like, open ", { b: "Cost and margin" }, " (the distributor's price and the deal registration), ", { b: "Backend rebate" }, ", ", { b: "Expenses and watchers" }, " and ", { b: "Notes" }, "."),
          runs("Check the ", { b: "Order summary" }, " and select ", { b: "Punch order" }, " — or ", { b: "Punch and add another" }, " to keep the customer and choose the next product."),
        ),
        p("The order waits for accounts. If you choose terms longer than the customer's credit record supports, you're asked why (kept on their credit record) — or, without the right to override credit, to choose shorter terms."),
      ),
      task(
        "Approve or reject an order",
        ol(
          runs("Open an order from the ", { b: "Pending Approval" }, " tab."),
          runs("Under ", { b: "Awaiting your review" }, ", check the ", { b: "Credit" }, " line: the terms on this order, the terms suggested, and what the customer owes."),
          runs("Add ", { b: "Notes (optional)" }, " and select ", { b: "Approve" }, ". If it lists reasons it needs a credit override, write why and select ", { b: "Approve with credit override" }, "."),
          runs("Or select ", { b: "Reject" }, ", give a reason if you like, and confirm with ", { b: "Reject" }, "."),
        ),
        p("The salesperson is told either way. Once an approved order is with purchase, purchase is told it's ready for them."),
        note("You can't approve an order you punched. An order that sells below cost also needs somebody allowed to approve orders sold below cost."),
      ),
      task(
        "Send a held order to purchase",
        p(runs("An order punched to hold or for a later date stays out of purchase's queue. The ", { b: "In hand" }, " view lists them. On the order, under ", { b: "Actions" }, ":")),
        ul(
          runs({ b: "Send to purchase now" }, " lets purchase start on it."),
          runs("Pick a day in ", { b: "Or schedule for" }, " and select ", { b: "Schedule" }, " to send it on that day."),
          runs("For a scheduled order, ", { b: "Hold instead" }, " takes it off its schedule."),
        ),
        p("A held or scheduled order counts toward targets once a payment comes in or it goes to purchase, whichever is first."),
      ),
      task(
        "Buy and fulfil an order",
        ol(
          runs("Open the ", { b: "Ready for purchase" }, " view, and an order in it."),
          runs("Under ", { b: "Purchasing" }, ", choose the ", { b: "Vendor" }, ", enter the ", { b: "Purchase price / unit" }, " and ", { b: "Our PO to vendor" }, ", and select ", { b: "Save purchasing details" }, ". The order is now Processing."),
          runs("Where purchase orders are available, select ", { b: "Create vendor PO" }, " to raise a draft purchase order to that vendor. Check it and issue it; its number then fills in Our PO to vendor."),
          runs("When it's been delivered, select ", { b: "Mark fulfilled" }, "."),
        ),
        p(runs("If you can only get it above the distributor price sales was quoted, give the reason and select ", { b: "Ask sales to accept" }, " — the order waits until they decide. Bought below that price, the difference times the quantity counts as your saving in Purchase savings.")),
      ),
      task(
        "Accept or send back a higher price",
        ol(
          runs("Open the ", { b: "Price to approve" }, " view, and the order."),
          runs("Under ", { b: "Purchase needs a higher price" }, ", read the price, the vendor and purchase's reason."),
          runs("Select ", { b: "Accept this price" }, ", or ", { b: "Send back" }, " with a note telling purchase what to do instead."),
        ),
        p("Only the salesperson who punched the order, or an approver, decides — and never the person who proposed the price."),
      ),
      task(
        "Approve an order sold below cost",
        p(runs("When the sale price is below the best cost known — the deal price, the distributor's quote or what purchase paid — the order shows ", { b: "Sold below cost — needs a manager's approval" }, ". Somebody allowed to approve orders sold below cost writes why the negative call is worth taking and selects ", { b: "Approve selling below cost" }, ".")),
        p("It's approved at that cost: buying it later for more needs approving again. Approvers are told when purchase tries to buy an order below cost."),
      ),
      task(
        "Cancel an order",
        ol(
          runs("Open the order and select ", { b: "Cancel order" }, "."),
          "Read what will happen, and give a reason — required once the order has gone to purchase.",
          runs("Select ", { b: "Cancel order" }, " to confirm, or ", { b: "Keep order" }, "."),
        ),
        p("Purchase is told if it was with them. Its purchase order is cancelled with it — unless the vendor has already billed it or it covers other orders too — and if a PO already went to the vendor, the order shows Vendor PO to cancel until purchase confirms what became of it. Anything paid against it moves on account for accounts to refund or apply elsewhere. A fulfilled order can't be cancelled — a return goes through a credit note."),
      ),
      task(
        "Invoice orders",
        p(runs("Where tax invoices are available and you're allowed to raise sales documents, an order's ", { b: "Invoicing" }, " card shows what's ", { b: "Ordered" }, ", ", { b: "Invoiced" }, " and ", { b: "To bill" }, ". Select ", { b: "Create tax invoice" }, " to bill what's left.")),
        p(runs("The ", { b: "To invoice" }, " view lists sold orders not yet billed in full, grouped by the customer's PO: ", { b: "One invoice for all" }, " of them, ", { b: "One per product" }, " as drafts, or ", { b: "Invoice" }, " beside a single order. See ", ["Sales Documents", "/help/sales-documents"], ".")),
      ),
    ],
    settings: [
      setting(
        "Pipeline",
        "Settings › Pipeline",
        p("Its Orders section holds your own steps within an order's statuses — Approved, Processing and Fulfilled — such as Material ordered, Installed, Handed over. The statuses themselves don't change."),
        p(runs("With steps set up, each order shows ", { b: "Progress" }, " on its page: choose a step under ", { b: "Move to" }, ", add a ", { b: "Note (optional)" }, " and select ", { b: "Move" }, ". Orders only move forward. The list gains a ", { b: "Step" }, " filter. Steps are changed by people allowed to manage the sales pipeline; a step no longer used can be retired.")),
      ),
      setting(
        "Rebate programmes",
        "Settings › Rebate programmes",
        p(runs("The backend rebates OEMs and distributors pay as a rule. ", { b: "Add a programme" }, ": its ", { b: "Name" }, ", the ", { b: "OEM (brand)" }, ", ", { b: "Through distributor" }, ", how it's ", { b: "Worked out as" }, " (a percentage of what you pay, of what you sell for, or a fixed amount), who it's ", { b: "Paid by" }, ", how it ", { b: "Comes as" }, " (a credit note or paid into the bank), and the dates it runs.")),
        p("A matching programme is suggested on an order as it's punched; the figure on the order is what counts. Rebates never count toward targets or incentives. Everyone who can see backend rebates can read this page; only people who manage rebate programmes can change it."),
      ),
      setting("Custom fields", "Settings › Custom fields › Orders", p("Your company's own order fields. They appear under More details on the punch form — never folded away, so a required one is always answered — and on the order's page.")),
      setting("Wording", "Settings › Wording", p("Your own word for an order, and your own names for its statuses, used in the menu, the tabs and the buttons.")),
      setting("Payment terms", "On the customer, or on each order", p("An order uses the customer's default terms unless you pick others when punching. Terms longer than the customer's credit rating supports need a reason, and approving them needs the right to override credit.")),
    ],
    faq: [
      qa(
        "Why can't I approve this order?",
        p("Either you punched it — somebody else has to approve it — or it needs more than approval: a credit override, or a manager's approval to sell below cost. The review box says which."),
      ),
      qa(
        "Purchase can't process an order.",
        p("It has to be approved by accounts first, and sales has to have sent it to purchase — a held order, or one scheduled for a later day, waits. A higher price waiting for sales also holds it."),
      ),
      qa("Why is Mark fulfilled greyed out?", p("Save the vendor and purchase price first. If a higher price is waiting for sales to accept, that has to be settled before the order can be fulfilled.")),
      qa(
        "Can I change an order after punching it?",
        p("On the order, the distributor price can be changed until purchase has processed it, and the deal registration and your company's own fields until it's fulfilled — by the salesperson, an approver or purchase. The quantity, site, PO number, dates and notes are edited from the customer's Products & Subscriptions tab, by people allowed to edit products & subscriptions."),
      ),
      qa("What happens to a rejected order?", p("It stays Rejected, and the salesperson sees the reason. To go ahead, punch the order again with the changes accounts asked for.")),
      qa("I can't see backend rebates on an order.", p("Rebates, and the net margin after them, show only to people allowed to see backend rebates. Without that, an order shows its deal registration and front margin only.")),
      qa("Why does Purchase savings show only my figures?", p("Purchase sees their own savings. Order approvers and people who can see team performance see everyone's.")),
      qa(
        "I don't see Orders in the menu.",
        p("Either the module is switched off for your company, your role has had the section hidden, or you don't hold View orders. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
    ],
    related: ["items", "renewals", "purchase_documents", "payments"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Renewals — written from src/app/(dashboard)/renewals (the list and its split view), src/components/
 * renewals (the table, the stage cell, the renew and proposal buttons), src/actions/renewal.ts (what the
 * list holds, renewal tasks), renewal-stage.ts, renewal-order.ts and renewal-proposal.ts (who may pin a
 * stage, punch the renewal and draft its proposal), src/lib/renewals.ts (statuses and stages),
 * src/actions/addon.ts (added seats), src/actions/recurring-billing.ts and src/lib/notify.ts (the
 * account manager's expiry reminder).
 */
export const guide: SeedGuide = {
  slug: "help/renewals",
  title: "Renewals",
  seo: {
    title: "Renewals: track subscription expiries and renew on time",
    description: "How to see every subscription coming up for renewal in {siteName}, raise renewal tasks, quote the next term and punch the renewal order.",
    keywords: ["subscription renewals", "expiry tracking", "renewal orders"],
  },
  guide: {
    module: "renewals",
    heading: "Renewals",
    summary: "Every subscription you've sold with an expiry date, soonest first — with how far each renewal has got, and quick ways to raise a task, quote the next term and punch the renewal order.",
    purpose: [
      p("Renewals lists the subscriptions your customers hold — orders for items managed as a subscription that have an expiry date — with the soonest expiry first. Each row shows the customer, the subscription and its seats, the PO / invoice number, the start and expiry dates, the account manager, a status and a stage."),
      p(runs("The ", { b: "Status" }, " is how long is left: ", { b: "Active" }, ", ", { b: "Expires in" }, " so many days (within 30 days), or ", { b: "Expired" }, ". The ", { b: "Stage" }, " is how far the renewal has got, worked out from what has happened:")),
      ul(
        runs({ b: "Not started" }, " — nothing yet."),
        runs({ b: "Task raised" }, " — an open renewal task names it."),
        runs({ b: "Contacted" }, " — a call has been logged against it."),
        runs({ b: "Quoted" }, " — a proposal, proforma or invoice quotes its next term."),
        runs({ b: "Renewed" }, " — the renewal order has been punched."),
      ),
      p(runs("Three stages leave no trace in the data, so they're set by hand: ", { b: "Negotiating" }, ", ", { b: "On hold" }, " and ", { b: "Lost" }, ".")),
      p("A renewal isn't a separate record: it's the order the subscription was punched on, so opening one shows that order. Seats added mid-term end with their subscription and are counted in its row rather than listed on their own."),
      note(runs("Only items managed as a subscription come up here — see ", ["Items & Inventory", "/help/items-and-inventory"], ". Goods and one-time services never renew.")),
    ],
    access: [
      p("Renewals uses the same permission as Orders: anybody who can view orders can open it, and sees the subscriptions on the customers they can see — every customer's with See every account, not just your own; otherwise their own accounts and their reports'."),
      p("Anybody who can open Renewals can raise renewal tasks. The rest of the row's actions have their own rules:"),
      ul(
        "Pinning a stage and punching the renewal order — people allowed to edit products & subscriptions, or to process orders.",
        "Drafting a renewal proposal — people allowed to raise and issue sales documents.",
        "Writing to the customer — people allowed to edit products & subscriptions, process orders, or send campaigns.",
        "Adding seats to a subscription — people allowed to process orders.",
      ),
    ],
    permissions: [
      perm("orders.view", "Opens Renewals (and Orders), and a customer's Products & Subscriptions and Renewals tabs. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.renewals", "Shows Renewals in the Orders & Renewals menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("products.edit", "Pin a renewal's stage, punch the renewal order and send the customer a renewal reminder — and change a subscription's quantity, dates and notes on the customer's Products & Subscriptions tab. Management and Sales have it by default."),
      perm("orders.process", "Does the same as editing products & subscriptions here, and also adds seats to a subscription mid-term. Purchase and Management have it by default."),
      perm("documents.issue", "Draft a renewal proposal for the next term, and set up a subscription's recurring billing. Sales, Accounts and Management have it by default."),
    ],
    setup: [
      p(runs("Nothing to set up on the list itself. For a subscription to appear, its item must be ticked ", { b: "Manage as a subscription" }, " and its order must have an expiry date — set by the ", { b: "Term" }, " or ", { b: "Expiry date" }, " when the order is punched.")),
      p("Each customer's account manager is the person the list names, and the one reminded as the expiry comes near — so make sure accounts have one."),
    ],
    tasks: [
      task(
        "See what's coming up",
        ol(
          runs("Open ", { b: "Orders & Renewals › Renewals" }, "."),
          runs("Choose a ", { b: "Window" }, ": ", { b: "Expired" }, ", or expiring in 30, 60 or 90 days. Search by company name."),
          runs("Use ", { b: "Columns" }, " to choose what the table shows, or switch to the split view to read each subscription's order beside the list."),
        ),
        p("The account manager also gets a notification when a subscription on their account comes within 30 days of its expiry."),
      ),
      task(
        "Raise renewal tasks",
        ol(
          "Tick the subscriptions to chase.",
          runs("In the bar, choose who to ", { b: "Assign to" }, " (or nobody) and, if you like, a due date — left blank, each task is due on its subscription's expiry date."),
          runs("Select ", { b: "Create renewal tasks" }, "."),
        ),
        p("Each task is called “Renew <product> — <customer>”. A subscription that already has an open renewal task is skipped, so running it again doesn't make duplicates. The stage moves to Task raised."),
      ),
      task(
        "Quote the next term",
        p(runs("Select the proposal icon on the row (", { b: "Draft a renewal proposal for" }, " the customer). A draft proposal for the next term is made from the subscription, its added seats and its full-term price; select ", { b: "Open it" }, " to check and send it. The stage moves to Quoted.")),
      ),
      task(
        "Punch the renewal order",
        ol(
          runs("Select the renew icon on the row (", { b: "Punch the renewal order" }, ")."),
          runs("In ", { b: "Renew this subscription" }, ", check the ", { b: "Quantity" }, " (seats added mid-term included), the ", { b: "Price each, full term" }, ", and when the ", { b: "New term starts" }, " and ends. Add ", { b: "Their PO" }, " and ", { b: "Notes" }, " if you have them."),
          runs("Select ", { b: "Punch renewal" }, "."),
        ),
        p(runs("It's raised as a normal order, pending approval, and goes through accounts and purchase like any other — see ", ["Orders", "/help/orders"], ". The old subscription stays as it was, and the row shows Renewed with the new order's number.")),
      ),
      task(
        "Set a stage by hand",
        ol(
          "Select the stage on the row.",
          "If you like, type why in the box — for example “lost on price”.",
          runs("Under ", { b: "Set the stage by hand" }, ", choose ", { b: "Negotiating" }, ", ", { b: "On hold" }, " or ", { b: "Lost" }, ". It's saved at once, with your note."),
        ),
        p(runs("A stage set by hand wins over the worked-out one, with one exception: once the renewal order is punched, the row shows Renewed. To hand it back, choose ", { b: "Clear — go back to what the record says" }, ".")),
      ),
      task(
        "Remind the customer",
        p(runs("Select the mail icon on the row (", { b: "Send a renewal reminder" }, "; once renewed, ", { b: "Confirm the renewal" }, "). Choose which contacts to write to, the ", { b: "Wording" }, ", and ", { b: "Add a line of your own" }, " if you like, then send it. Contacts who can't be written to are listed with the reason.")),
      ),
      task(
        "Add seats mid-term",
        p(runs("On the customer's ", { b: "Products & Subscriptions" }, " tab, select ", { b: "Add seats" }, " on the subscription. Enter ", { b: "How many extra" }, ", ", { b: "From" }, " when, the ", { b: "Full-year price a seat" }, " and ", { b: "What we pay for it" }, ", then add them. The seats are raised as their own order through the usual approval, end with the subscription, and come back with it at renewal.")),
      ),
    ],
    settings: [
      setting(
        "Recurring billing",
        "On a subscription's order",
        p(runs("How a subscription is invoiced: ", { b: "Off" }, " (by hand), ", { b: "Renew itself at the end of the term" }, " — on the first day of the next term the renewal order is punched for approval and its invoice raised as a draft — or ", { b: "Invoice the term in parts" }, ", ", { b: "Monthly" }, ", ", { b: "Quarterly" }, " or ", { b: "Yearly" }, ", each part raised as a draft on the day it begins.")),
        p("Nothing it raises is issued: the drafts wait for somebody to check and issue them. Setting it takes the permission to raise and issue sales documents."),
      ),
      setting("Wording", "Settings › Wording", p("Your own word for a renewal, used in the menu, headings and buttons.")),
      setting("A renewal is coming up", "Settings › Notification preferences", p("The notification an account manager gets when a subscription on their account enters its last 30 days. Each person can switch it off for themselves.")),
    ],
    faq: [
      qa(
        "A subscription I sold isn't in Renewals.",
        p("Check that its item is managed as a subscription and that the order has an expiry date. Seats added mid-term appear in their subscription's row, not on their own. And you only see the subscriptions on customers you can see."),
      ),
      qa("Why can't I set the stage to Quoted or Contacted?", p("Those stages are worked out from what has happened, so they can't be set by hand. Only Negotiating, On hold and Lost can.")),
      qa("I set the stage to Lost, but it shows Renewed.", p("Once the renewal order is punched, the row shows Renewed whatever was set by hand, and says the stage you set was overtaken.")),
      qa("It says the subscription is already renewed.", p("A renewal order has already been punched for it. If that one was wrong, cancel it first and punch the renewal again.")),
      qa("Are customers reminded automatically?", p("Not from this list: a reminder is sent by hand from the row. The account manager is reminded inside the app as the expiry comes near. For a subscription that renews itself, use Recurring billing on its order.")),
      qa(
        "I don't see Renewals in the menu.",
        p("Either the module is switched off for your company, your role has had the section hidden, or you don't hold View orders. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
    ],
    related: ["orders", "items", "sales_documents", "tasks"],
  },
};

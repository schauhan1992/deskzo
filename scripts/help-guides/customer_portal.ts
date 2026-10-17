import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Customer Portal — written from src/app/(dashboard)/customer-portal and customer-requests,
 * src/components/portal (a customer's Portal tab, the request inbox, the customer's own page),
 * src/app/(public)/portal/[token], src/actions/portal.ts and portal-public.ts (who may do what, and
 * what a link opens), src/lib/portal/access.ts (who gets in) and Settings › Customer portal
 * (src/components/settings/portal-settings-form.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/customer-portal",
  title: "Customer Portal",
  seo: {
    title: "Customer portal: a private page for each customer",
    description: "How to give customers a private page in {siteName} with their subscriptions, invoices and tickets, send them a sign-in link and work through what they ask for.",
    keywords: ["customer portal", "customer self-service", "portal link"],
  },
  guide: {
    module: "customer_portal",
    heading: "Customer Portal",
    summary: "A page of their own for your customers: what they have and when it ends, their invoices and their support tickets. They open it with a private link rather than a password, and can ask to renew, ask for more licences or ask a question.",
    purpose: [
      p("The customer portal is a page your customer opens to check their account without ringing anybody. They have no account here and no password: each person is given a private link, and opening it is signing in."),
      p(runs("What the page shows is one setting for every customer, in ", { b: "Settings › Customer portal" }, ". Who gets in is decided customer by customer.")),
      p(runs("When a customer asks for something from their page, it arrives in ", { b: "Support › Customer requests" }, " for somebody here to read. Nothing a customer does creates an order, a price or a commitment.")),
      note("Anyone holding a link can open that customer's page. Send each link only to the person it's for, and revoke it if it goes astray.", "warning"),
    ],
    access: [
      p("A customer's person can open the portal when all of these are true: the portal is switched on, their company is allowed a portal, they have been given a link, and the link hasn't expired or been revoked."),
      p("A reseller's end customers never get a portal, even when set to always on: their relationship belongs to the reseller. A vendor can't have one either."),
      p("On your side, everything about the portal needs the permission to manage it: the settings, Portal access, Customer requests and the Portal tab on a customer's page. Management has it by default."),
    ],
    permissions: [
      perm("portal.manage", "Opens Support › Portal access, Support › Customer requests, Settings › Customer portal and the Portal tab on a customer's page. Lets somebody switch the portal on, choose who may sign in and what customers see, create and revoke links, and work through requests. Management has it by default."),
      perm("section.customerPortal", "Shows Customer Portal in the menu and lets people open its pages. Every role has it until an admin unticks it for one; the menu links still need the permission to manage the portal."),
    ],
    setup: [
      p("Somebody with the permission to manage the portal sets it up once:"),
      ol(
        runs("Open ", { b: "Settings › Customer portal" }, "."),
        runs("Tick ", { b: "The customer portal is on" }, "."),
        runs("Under ", { b: "Who may sign in" }, ", choose ", { b: "Only customers I choose" }, " (the safe one to start with) or ", { b: "Every customer" }, "."),
        runs("If links should stop working after a while, fill in ", { b: "Links expire after" }, ". Add a ", { b: "Welcome note" }, " if you like."),
        runs("Tick what customers may see under ", { b: "What a customer can see" }, ", and what they may ask for under ", { b: "What a customer can ask for" }, "."),
        runs("Select ", { b: "Save settings" }, "."),
      ),
      p("Then give each customer access and send their people a link, as below."),
    ],
    tasks: [
      task(
        "Give a customer access and send a link",
        ol(
          runs("Open the customer's page and its ", { b: "Portal" }, " tab."),
          runs("If you chose ", { b: "Only customers I choose" }, ", set ", { b: "Access" }, " to ", { b: "Always on for this customer" }, "."),
          runs("Under ", { b: "Who is the link for?" }, ", choose the contact."),
          runs("Select ", { b: "Create a link" }, "."),
          runs("Select ", { b: "Copy link" }, " and email it to them yourself."),
        ),
        p("The app doesn't email the link for you. If a link can't be made, the card says why: the portal is switched off, the customer hasn't been given access, or they belong to a reseller. A link is for somebody still at the company, so a contact who has left can't be given one."),
      ),
      task(
        "Send a link again",
        p(runs("A link stays the same until it expires or is revoked. On the customer's ", { b: "Portal" }, " tab, select ", { b: "Copy link" }, " beside it and send it again.")),
      ),
      task(
        "Stop a link working",
        ol(
          runs("Open the customer's ", { b: "Portal" }, " tab."),
          runs("Select ", { b: "Revoke" }, " beside the link."),
        ),
        p(runs("It stops working at once and can't be brought back; create a new link if they need one. To shut a whole customer out, set ", { b: "Access" }, " to ", { b: "Never for this customer" }, ". When a contact is marked as having left, or moved to another company, their links stop working too.")),
      ),
      task(
        "See who has a link and who uses it",
        ol(
          runs("Open ", { b: "Support › Portal access" }, "."),
          runs("Read the totals: ", { b: "Customers with a working link" }, ", ", { b: "Have actually opened it" }, " and ", { b: "Who may have one" }, "."),
          runs("Search with ", { b: "Search customers…" }, ", or read down ", { b: "Customers with links" }, ": who holds a link, whether they're allowed in, when they last opened it and how often."),
        ),
        p("Customers you switched on but never sent a link are listed above the table, so nobody is left waiting for a link that never came."),
      ),
      task(
        "Work through customer requests",
        ol(
          runs("Open ", { b: "Support › Customer requests" }, ". ", { b: "Open" }, " shows what is new or in progress; ", { b: "Everything" }, " shows the rest too."),
          runs("Select ", { b: "I’ll take this" }, " to mark a request in progress."),
          "Do what they asked in the usual way, for example raise the quote or the renewal from the customer's page.",
          runs("Select ", { b: "Done" }, ", note what was done if you like, and select ", { b: "Mark done" }, ". Or select ", { b: "Decline" }, ", say why, and select ", { b: "Decline" }, " again."),
        ),
        p(runs("Your note is for your team; the customer doesn't see it, so tell them yourself. ", { b: "Reopen" }, " brings a closed request back.")),
      ),
      task(
        "Know what your customer sees",
        ul(
          runs({ b: "Your subscriptions and orders" }, ": what they bought, how many licences and how many days are left, with ", { b: "Renew this" }, " and ", { b: "Add licences" }, " when you allow those requests."),
          runs({ b: "Your invoices" }, ": number, date, due date, amount and whether it is paid. Drafts are never shown."),
          runs({ b: "Your support tickets" }, ": each ticket's number, title, when it was raised and its status. Never who is working on it, your comments or its deadline."),
          runs({ b: "Ask us something" }, ": a box to send you a question, when you allow it."),
        ),
        p("A section shows only when it is ticked in the settings and its module is in use in your workspace: Orders for subscriptions, Sales Documents for invoices, the Helpdesk for tickets. A customer can't raise a ticket from the portal; a question arrives as a request."),
      ),
    ],
    settings: [
      setting("The customer portal is on", "Settings › Customer portal", p("The master switch. Off, and no link works, whoever was granted what. It is the switch to reach for if anything ever looks wrong.")),
      setting(
        "Who may sign in",
        "Settings › Customer portal",
        ul(
          runs({ b: "Only customers I choose" }, " (the default): only customers whose Access is set to Always on for this customer."),
          runs({ b: "Every customer" }, ": anyone you have issued a link to can use it, without granting each customer separately. A customer set to Never for this customer stays off, and resellers' customers are still refused."),
        ),
      ),
      setting("Links expire after", "Settings › Customer portal", p("A number of days, or blank for never. A link is given its expiry when it is created, so changing this later doesn't change links already sent.")),
      setting("Welcome note", "Settings › Customer portal", p("A few words at the top of every customer's page, for example who to call with a question.")),
      setting(
        "What a customer can see",
        "Settings › Customer portal",
        p(runs("Applies to every customer, never one by one. ", { b: "Subscriptions and orders" }, ", ", { b: "Invoices" }, " and ", { b: "Support tickets" }, " are on by default and show as described above.")),
        note(runs({ b: "Payments received" }, ", ", { b: "Hardware and warranties" }, " and ", { b: "Their contacts as we hold them" }, " can be ticked too, but the customer's page doesn't show those sections at the moment: ticking them changes nothing a customer sees.")),
      ),
      setting(
        "What a customer can ask for",
        "Settings › Customer portal",
        ul(
          runs({ b: "Ask to renew" }, ": one click against a subscription."),
          runs({ b: "Ask for more licences" }, ": with a number."),
          runs({ b: "Ask a question" }, ": a free-text message."),
        ),
        p("All three are on by default, and each raises a request, never an order. Renewing and asking for licences need Subscriptions and orders to be shown."),
      ),
      setting(
        "Access",
        "A customer's page › Portal tab",
        p(runs({ b: "Follow the default" }, ", ", { b: "Always on for this customer" }, " or ", { b: "Never for this customer" }, ". With Only customers I choose, Follow the default means no access.")),
      ),
    ],
    faq: [
      qa(
        "I can't see Portal access or Customer requests in the menu.",
        p("Either the module is switched off for your company, the section is hidden for your role, or you don't have the permission to manage the customer portal. Ask an admin: the switch is in Settings › Modules, and the section and the permission are in Settings › Roles & Permissions."),
      ),
      qa(
        "My customer says the link says it is no longer valid.",
        p("Every refusal says the same, on purpose. The usual reasons: the portal is switched off, the link was revoked or has expired, the customer isn't allowed a portal (not chosen, or set to Never), the customer now belongs to a reseller, or the person has left the company. Check the customer's Portal tab and create a new link if they should have one."),
      ),
      qa("Can a customer sign in with an email and a password?", p("No. The link is the only way in. There is no account, no password and no sign-in form.")),
      qa("Can one customer see more than another?", p("No. What a customer can see is one setting for everybody. Only who gets in is decided per customer.")),
      qa(
        "Who is told when a customer asks for something?",
        p("The person assigned to the customer as their caller gets a notification in the app. If nobody is assigned, nobody is notified, so check Support › Customer requests regularly. Each person can switch the notification off in Settings › Notification preferences."),
      ),
      qa("Why is there no Portal tab on a company's page?", p("You need the permission to manage the customer portal, and the company has to be a customer or a reseller. Vendors don't have the tab.")),
    ],
    related: ["helpdesk", "orders", "sales_documents", "companies"],
  },
};

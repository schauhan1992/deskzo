import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Commission Parties — written from src/app/(dashboard)/commission-parties (the list and a new party),
 * the commission-party parts of src/components/companies/company-detail.tsx (linked companies,
 * commission earned, payee accounts), src/components/companies/company-commission.tsx (a customer's
 * Commission tab), src/components/companies/commission-party-accounts-manager.tsx and
 * src/actions/commission-party.ts.
 */
export const guide: SeedGuide = {
  slug: "help/commission-parties",
  title: "Commission Parties",
  seo: {
    title: "Commission Parties: agents, brokers and referral partners",
    description: "How to add the agents, brokers and referral partners you pay commission to, link them to the customers they bring, record their payee accounts and see what they've earned.",
    keywords: ["commission parties", "referral partners", "commission payouts"],
  },
  guide: {
    module: "commission_parties",
    heading: "Commission Parties",
    summary: "The agents, brokers and referral partners you pay commission to — onboarded like vendors but kept in their own list, linked to the customers they bring you, with the accounts they're paid into and what they've earned.",
    purpose: [
      p(
        "A commission party is somebody you pay for bringing you business: an agent, a broker, a referral partner. They are kept apart from your vendors, because you don't buy from them, and apart from your customers, because you don't sell to them.",
      ),
      p("For each one you can:"),
      ul(
        "move them through onboarding, as with a vendor;",
        "link them to the customer companies they refer business from;",
        "keep the accounts they want to be paid into — their own, a firm's or a family member's — with a default one;",
        "see the commission paid to them, order by order, and which customer each payment came from.",
      ),
      note(
        runs(
          "Commission itself is recorded as an expense on an order, when the order is punched — see ",
          ["Orders", "/help/orders"],
          ". This module is where the party and their accounts live, and where those payments are added up.",
        ),
      ),
    ],
    access: [
      p("Everybody with Commission Parties in their menu can open the list and add a party. Each person sees the commission parties they are account manager for, and their team's — or every one with See every account, not just your own. Whoever can open a party can change its status, its payee accounts and its links."),
      p("The commission earned, and the commission paid on a customer, list only the orders you are allowed to open."),
    ],
    permissions: [
      perm("section.commissionParties", "Shows Directory › Commission Parties in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("companies.viewAll", "See every commission party rather than only the ones you (or your team) manage. Held by default by Management, Accounts, Purchase, Support, Profiling and Calling — not by Sales."),
      perm("orders.view", "See the orders behind the commission — without it, Commission earned and a customer's commission payments leave those orders out. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("accounts.reassign", "Assign commission parties to anyone from the list's selection bar, including leaving them unassigned. Management has it by default."),
      perm("data.exportCrm", "Download commission parties as a file from Settings › Import & export. No role has it by default; admins do."),
    ],
    setup: [
      p("There is nothing to configure for the module. Each party is set up once:"),
      ol(
        runs("Add them (", { b: "Directory › Commission Parties" }, " › ", { b: "New commission party" }, ")."),
        runs("Add the accounts they are paid into under ", { b: "Related parties (payee accounts)" }, "."),
        runs("Link the customers they bring you under ", { b: "Linked companies" }, "."),
        runs("Change their status to ", { b: "Active" }, " when they're ready."),
      ),
    ],
    tasks: [
      task(
        "Add a commission party",
        ol(
          runs("Open ", { b: "Directory › Commission Parties" }, " and select ", { b: "New commission party" }, "."),
          "Fill in their name and details, their address, and the person you deal with.",
          runs("Select ", { b: "Save company" }, ". They start as ", { b: "Onboarding" }, "."),
        ),
      ),
      task(
        "Record the accounts they are paid into",
        ol(
          runs("Open the party. On its ", { b: "Details" }, " tab, under ", { b: "Related parties (payee accounts)" }, ", select ", { b: "+ Add related party" }, "."),
          runs("Fill in a ", { b: "Label" }, ", the ", { b: "Account holder name" }, ", ", { b: "PAN" }, ", ", { b: "UPI ID" }, ", ", { b: "Bank account number" }, ", ", { b: "IFSC" }, " and ", { b: "Bank name" }, " — whatever applies."),
          runs("Tick ", { b: "Default account for this commission party" }, " for the one used most, and select ", { b: "Save" }, "."),
        ),
        p("Add one entry per account. An account that a commission payment has already been recorded against can't be deleted."),
      ),
      task(
        "Link a commission party to the customers they refer",
        ol(
          runs("On the party's ", { b: "Details" }, " tab, under ", { b: "Linked companies" }, ", type to search customer companies."),
          runs("Pick the customer and select ", { b: "Link" }, ". ", { b: "Unlink" }, " removes it."),
        ),
        p(runs("You can do the same from the customer's side: its ", { b: "Commission" }, " tab lists the commission parties linked to it, with a search to add one. Only customer companies can be linked — not vendors or other commission parties.")),
      ),
      task(
        "See what a commission party has earned",
        p(
          runs(
            "On the party's ",
            { b: "Details" },
            " tab, ",
            { b: "Commission earned" },
            " lists every commission payment to them: the ",
            { b: "Customer" },
            ", the ",
            { b: "Order" },
            ", which account it went ",
            { b: "Into" },
            ", the ",
            { b: "Amount" },
            " and when it was ",
            { b: "Recorded" },
            ".",
          ),
        ),
      ),
      task(
        "See the commission paid on a customer",
        p(runs("Open the customer and its ", { b: "Commission" }, " tab. ", { b: "Commission paid on this account" }, " shows the total, a badge per commission party, and each payment with the order, who it was paid to, the account and any notes.")),
      ),
      task(
        "Change a party's onboarding status",
        ul(
          runs("For one party: use the status control at the top of its page — ", { b: "Onboarding" }, ", ", { b: "Active" }, " or ", { b: "Inactive" }, "."),
          runs("For several: tick them on the list, pick a status in ", { b: "Onboarding — no change" }, ", and select ", { b: "Apply" }, ". The same bar can assign them to a person (", { b: "Assign to…" }, ") and add tags."),
        ),
      ),
    ],
    settings: [
      setting("Onboarding status", "At the top of the party's page", p("Onboarding, Active or Inactive. The list's Status filter uses it, and its heading counts how many are still onboarding.")),
      setting(
        "Default account",
        "Related parties (payee accounts)",
        p("The payee account marked as this party's default. Ticking it on one account takes it off the others."),
      ),
      setting(
        "Reference code",
        "At the top of the party's page",
        p(runs("Your own code for the party, set with the ", { b: "Set vendor code" }, " button and shown as its Reference code on the Details tab. At most 30 characters, and no two companies can share one.")),
      ),
    ],
    faq: [
      qa("Why can't I delete one of their payee accounts?", p("A commission payment has already been recorded against it. Deleting it would erase how that commission was paid.")),
      qa("Why can't I link a commission party to this company?", p("Only customer companies can be linked. Vendors, resellers and other commission parties can't.")),
      qa(
        "Commission earned is empty, but we've paid them.",
        p("Commission shows here once it is recorded as an expense on an order. Orders you aren't allowed to open are left out, so a colleague may see more than you."),
      ),
      qa("Can I turn a vendor or customer into a commission party?", p("No. A company can't be moved between the client, reseller, vendor and commission party modules — create the commission party in this module instead.")),
      qa(
        "I can't see Commission Parties in the menu.",
        p("The Commission Parties module may be switched off for your company in Settings › Modules, or the Directory › Commission Parties section may be hidden from your role in Settings › Roles & Permissions."),
      ),
    ],
    related: ["orders", "vendors", "companies", "resellers"],
  },
};

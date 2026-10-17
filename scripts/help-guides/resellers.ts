import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Resellers — written from src/app/(dashboard)/resellers (the list, a new reseller, a new end
 * customer), src/components/resellers, the reseller parts of src/components/companies/company-detail.tsx
 * (onboarding, special pricing, end customers), src/actions/reseller.ts, src/lib/reseller.ts (the
 * do-not-contact rule), src/lib/reseller-onboarding.ts, src/lib/reseller-pricing.ts and
 * src/lib/orders/reseller-gate.ts (no order until Active).
 */
export const guide: SeedGuide = {
  slug: "help/resellers",
  title: "Resellers",
  seo: {
    title: "Resellers: channel partners, their onboarding and end customers",
    description: "How to add resellers, take them through onboarding to Active, agree tier discounts and special prices, and record the end customers they buy for without contacting them.",
    keywords: ["reseller management", "channel partner onboarding", "reseller pricing"],
  },
  guide: {
    module: "resellers",
    heading: "Resellers",
    summary:
      "Channel partners who buy from you for their own customers. Orders and payments sit with the reseller, each one is onboarded before it can be ordered for, and the customers they buy for are kept off limits to direct contact and marketing.",
    purpose: [
      p(
        "A reseller is a company that buys from you to sell on to its own customers. You invoice the reseller, not the customer at the end, so orders and payments are the reseller's. The customers they buy for — their end customers — are recorded under the reseller, so you know whose subscription is whose.",
      ),
      p("Three things set a reseller apart from an ordinary customer:"),
      ul(
        runs({ b: "Onboarding." }, " Every reseller starts as Onboarding, and no order can be raised for them until they are Active. They can only be made Active once their onboarding checklist is complete."),
        runs({ b: "Their own prices." }, " When an order is punched for a reseller, each product's price is filled in from a special price agreed for that product, else their tier's standard discount off the catalogue price, else the catalogue price — and the order form says which."),
        runs({ b: "Their customers are theirs." }, " An end customer is marked do-not-contact. It is kept out of the Companies and Customer lists and out of every marketing send, its page has no call button at the top, and its people's email and phone are hidden from anyone without View reseller-managed contact details."),
      ),
      note(runs("An order for a reseller is still billed to the reseller, but the product or subscription shows on the end customer's own ", { b: "Products & Subscriptions" }, " tab — their seats, their expiry. See ", ["Orders", "/help/orders"], ".")),
    ],
    access: [
      p("Everybody with Resellers in their menu can open the list and add resellers. Each person sees the resellers they are account manager for, and their team's — or every reseller with See every account, not just your own. Whoever can open a reseller can work on its onboarding, its prices and its end customers."),
      p("A reseller's end customers are reached only through the reseller: you see them on the reseller's page, and only if you can see that reseller."),
      p("Setting the reseller's PAN, and adding the bank accounts they are paid into, needs Manage finance records."),
    ],
    permissions: [
      perm("section.resellers", "Shows Directory › Resellers in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("companies.viewAll", "See every reseller rather than only the ones you (or your team) manage. Held by default by Management, Accounts, Purchase, Support, Profiling and Calling — not by Sales."),
      perm("payments.manage", "Set a reseller's PAN — one of the onboarding steps — and manage the bank accounts on its record. Accounts and Management have it by default."),
      perm("contacts.viewRestricted", "See the email and phone of a reseller's end customers, hidden from everyone else so nobody contacts them behind the reseller's back. Management and Support have it by default."),
      perm("credit.override", "Set or change a customer's credit limit from its Credit tab, with a reason that is kept on its credit record. For a reseller this is the same limit its onboarding shows. Management and Accounts have it by default."),
      perm("data.exportCrm", "Download resellers as a file from Settings › Import & export. No role has it by default; admins do."),
    ],
    setup: [
      p("Each reseller is set up once, by whoever looks after the partner:"),
      ol(
        runs("Add the reseller (", { b: "Directory › Resellers" }, " › ", { b: "New reseller" }, ")."),
        runs("Work through ", { b: "Reseller onboarding" }, " on its page until every step is ticked: ", { b: "Signed partner agreement" }, ", ", { b: "GSTIN & PAN on file" }, ", ", { b: "Credit limit & payment terms agreed" }, " and ", { b: "Partner tier & discount set" }, "."),
        runs("Change its status to ", { b: "Active" }, ". Only then can orders be punched for it."),
      ),
    ],
    tasks: [
      task(
        "Add a reseller",
        ol(
          runs("Open ", { b: "Directory › Resellers" }, " and select ", { b: "New reseller" }, "."),
          "Fill in the form as for any company: its name, details, primary location with its GST number (in India), and its first contact.",
          runs("Select ", { b: "Save company" }, ". The reseller starts as ", { b: "Onboarding" }, ", with you as its account manager."),
        ),
      ),
      task(
        "Onboard a reseller and make it Active",
        ol(
          runs("Open the reseller. On its ", { b: "Details" }, " tab, find ", { b: "Reseller onboarding" }, ". Each step not done yet says what it needs."),
          runs("Select ", { b: "Edit onboarding details" }, " and fill in ", { b: "Agreement signed on" }, ", ", { b: "Agreement reference" }, ", ", { b: "Approved by" }, ", ", { b: "Credit limit (₹)" }, ", ", { b: "Partner tier" }, " and ", { b: "Standard discount (%)" }, ". Select ", { b: "Save" }, "."),
          runs("For the GSTIN, put the GST number on the reseller's primary location (", { b: "Locations" }, " tab). For the PAN, someone with Manage finance records selects ", { b: "Set PAN" }, " at the top of the page."),
          runs("When every step is ticked, change the status beside the badge to ", { b: "Active" }, "."),
        ),
        p("If a step is still outstanding, activating is refused and the message lists what's missing."),
      ),
      task(
        "Agree a special price for one product",
        ol(
          runs("On the reseller's ", { b: "Details" }, " tab, find ", { b: "Special reseller pricing" }, " and select ", { b: "+ Add special price" }, "."),
          runs("Pick the ", { b: "Product" }, ", enter ", { b: "Their price (₹ per unit)" }, ", and add ", { b: "Notes" }, " such as how long it holds."),
          runs("Select ", { b: "Save price" }, "."),
        ),
        p(runs("A special price wins over the tier discount for that product. Select ", { b: "Remove" }, " to go back to the tier discount.")),
      ),
      task(
        "Record a reseller's end customer",
        ol(
          runs("On the reseller's ", { b: "Details" }, " tab, under ", { b: "End customers" }, ", select ", { b: "+ Add end customer" }, "."),
          "Fill in the customer as you would any company.",
          runs("Select ", { b: "Save company" }, "."),
        ),
        p("The new customer is created with the do-not-contact restriction already applied, and is listed under the reseller with the number of orders bought for them."),
      ),
      task(
        "Keep an eye on a reseller's credit",
        p(
          runs(
            "The onboarding card shows the reseller's ",
            { b: "Credit limit" },
            ", what is ",
            { b: "Outstanding" },
            " across its orders, what is still ",
            { b: "Available" },
            ", and its ",
            { b: "Tier" },
            ". When the balance goes over the limit, a warning says by how much — chase payment, or raise the limit.",
          ),
        ),
      ),
      task(
        "Change the status or tier of several resellers",
        ol(
          runs("On ", { b: "Directory › Resellers" }, ", tick the resellers."),
          runs("Pick a new status in ", { b: "Status — no change" }, " or a tier in ", { b: "Tier — no change" }, ", and select ", { b: "Apply" }, "."),
        ),
        p("Any reseller whose onboarding isn't complete is left as it was if you chose Active, and the message names them."),
      ),
    ],
    settings: [
      setting(
        "Onboarding status",
        "Reseller onboarding, on the reseller's page",
        p(runs({ b: "Onboarding" }, ", ", { b: "Active" }, ", ", { b: "Suspended" }, " or ", { b: "Inactive" }, ". Orders can be punched only while a reseller is Active; any other status blocks them.")),
      ),
      setting(
        "Partner tier and standard discount",
        "Edit onboarding details",
        p(runs("The tier — ", { b: "Silver" }, ", ", { b: "Gold" }, " or ", { b: "Platinum" }, " — and the percentage taken off the catalogue price for every product that has no special price.")),
      ),
      setting("Credit limit", "Edit onboarding details", p("The most the reseller may owe at once. The onboarding card measures what is outstanding on their orders against it.")),
      setting("Special reseller pricing", "On the reseller's Details tab", p("A price per unit for one product, agreed with this reseller. It is used instead of the tier discount when an order is punched for them.")),
    ],
    faq: [
      qa("Why can't I punch an order for this reseller?", p("Their onboarding status isn't Active. Finish the onboarding checklist on their page and change the status to Active.")),
      qa("Why can't I make a reseller Active?", p("A step of the onboarding checklist is still outstanding. The message lists which. The PAN step needs somebody with Manage finance records to set it.")),
      qa(
        "Where are a reseller's end customers? They aren't in the Customer list.",
        p("End customers are kept out of the Companies and Customer lists on purpose. Open the reseller — they are listed under End customers on its Details tab."),
      ),
      qa("Why can't I see an end customer's email or phone?", p("They belong to the reseller, and are contacted only through them. Their details are shown only to people who hold View reseller-managed contact details.")),
      qa("Can I turn an existing customer into a reseller?", p("No. A company can't be moved between the client, reseller, vendor and commission party modules — create the reseller in Resellers instead.")),
      qa(
        "I can't see Resellers in the menu.",
        p("The Resellers module may be switched off for your company in Settings › Modules, or the Directory › Resellers section may be hidden from your role in Settings › Roles & Permissions."),
      ),
    ],
    related: ["companies", "orders", "receivables", "commission_parties"],
  },
};

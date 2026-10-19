import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Vendors — written from src/app/(dashboard)/vendors (the list and the new-vendor page), the company
 * page as it shows a vendor (src/components/companies/company-detail.tsx, vendor-status-control.tsx,
 * vendor-code-button.tsx, the bank accounts manager), src/actions/company.ts (creating a vendor, its
 * onboarding status, its code and PAN), src/actions/company-bank.ts (who sees and changes bank details),
 * src/lib/authz/access.ts (which vendors somebody reaches) and Settings › Vendor codes.
 */
export const guide: SeedGuide = {
  slug: "help/vendors",
  title: "Vendors",
  seo: {
    title: "Vendors: your suppliers, OEMs, distributors and partners",
    description: "How to keep vendors in {siteName}: add a vendor, OEM, distributor or partner, track onboarding, give each a vendor code and record their bank accounts.",
    keywords: ["vendor management", "vendor onboarding", "vendor codes"],
  },
  guide: {
    module: "vendors",
    heading: "Vendors",
    summary: "Every company you buy from or work with — vendors, OEMs, distributors and partners — kept apart from your customers, each with an onboarding status, a vendor code, bank accounts and its purchase documents.",
    purpose: [
      p(runs("Vendors is the supply side of your directory: the companies you buy from or partner with, kept separate from the customers in Companies. Each one is a ", { b: "Vendor" }, ", ", { b: "OEM" }, ", ", { b: "Distributor" }, ", ", { b: "Partner" }, " or ", { b: "Other" }, ".")),
      p("A vendor is a company record of its own: its locations and GST numbers, its contacts, its payment terms (from us to them), its onboarding status and vendor code — and, where those modules are on, its purchase documents, calls, visits, tickets and tasks. It has no Products & Subscriptions, payments, leads or renewals, because you don't sell to it."),
      p("Vendors are who purchase chooses on an order, the distributors sales get prices from, and who purchase orders and vendor bills are raised on."),
      note(runs("Resellers and commission parties have modules of their own — see ", ["Resellers", "/help/resellers"], " and ", ["Commission Parties", "/help/commission-parties"], ".")),
    ],
    access: [
      p("Everybody who can open Vendors can add a vendor and work with the vendors they reach. With See every account, not just your own, that's every vendor; without it, the vendors you're account manager for and, if you manage people, your reports'. An admin can change a role's reach in Settings › Roles & Permissions."),
      p("A vendor's bank accounts and PAN are finance's. Only people allowed to manage finance records add or change them. People who record payments can read the full account numbers; everybody else sees them masked."),
    ],
    permissions: [
      perm("section.vendors", "Shows Vendors in the Directory menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("companies.viewAll", "Shows every vendor (and every customer), not only the ones you're account manager for. Management, Accounts, Purchase, Support, Profiling and Calling have it by default; Sales doesn't."),
      perm("payments.manage", "Add, change, retire and delete a vendor's bank accounts, choose the primary one, and change its PAN. Accounts and Management have it by default."),
      perm("payments.record", "See a vendor's full bank account numbers rather than masked ones. Accounts and Management have it by default."),
      perm("purchase.raiseOrders", "Raise a purchase order from a vendor's Documents tab. Purchase, Accounts and Management have it by default."),
      perm("settings.manage", "Change the prefix new vendor codes start with, and give older vendors a code, in Settings › Vendor codes. No role has it by default — admins do."),
    ],
    setup: [
      p(runs("An admin sets the prefix vendor codes start with in ", { b: "Settings › Vendor codes" }, ". Every vendor added afterwards is given the next code automatically.")),
      p(runs("Your company's own vendor fields are added in ", { b: "Settings › Custom fields" }, ", under Vendors — kept apart from the fields on customers.")),
    ],
    tasks: [
      task(
        "Add a vendor",
        ol(
          runs("Open ", { b: "Directory › Vendors" }, " and select ", { b: "New vendor" }, "."),
          runs("Enter the ", { b: "Company name" }, " and choose its ", { b: "Relationship" }, ": Vendor, OEM, Distributor, Partner or Other. Add its industry, website and ", { b: "Payment terms" }, " as you know them."),
          runs("Under ", { b: "Primary location" }, ", give the ", { b: "Location label" }, ", ", { b: "Address" }, ", ", { b: "GST number" }, " and ", { b: "GST treatment" }, "."),
          runs("If you can see contacts, add the people you deal with under ", { b: "Contacts" }, " with ", { b: "+ Add contact" }, "."),
          runs("Select ", { b: "Save company" }, "."),
        ),
        p("The name must be unique — if the company is already there, open it instead. A new vendor starts as Onboarding and is given the next vendor code."),
      ),
      task(
        "Track a vendor's onboarding",
        p(runs("Every vendor is ", { b: "Onboarding" }, ", ", { b: "Active" }, " or ", { b: "Inactive" }, ". Change it from the status menu at the top of the vendor's page — or tick several vendors on the list, choose a status in the bar and select ", { b: "Apply" }, ". The list says how many are still onboarding, and its ", { b: "Status" }, " filter shows each group.")),
      ),
      task(
        "Give a vendor its code",
        ol(
          runs("On the vendor's page, select ", { b: "Vendor code" }, " (or ", { b: "Set vendor code" }, " if it has none)."),
          runs("Type the code and select ", { b: "Save" }, "."),
        ),
        p("A code is up to 30 characters, saved in capitals, and can't be another vendor's. Leave it empty to remove it."),
      ),
      task(
        "Record a vendor's bank accounts",
        ol(
          runs("On the vendor's page, find ", { b: "Payout details" }, "."),
          runs("Select ", { b: "+ Add bank account" }, " and fill in the account."),
          runs("With more than one, use the star (", { b: "Make primary" }, ") on the one to use by default."),
        ),
        p("This needs the permission to manage finance records. The PAN is shown in the same card."),
      ),
      task(
        "Raise a purchase order to a vendor",
        p(runs("Open the vendor's ", { b: "Documents" }, " tab, which lists its purchase documents, and select ", { b: "New purchase order" }, ". See ", ["Purchase Documents", "/help/purchase-documents"], ".")),
      ),
      task(
        "Find and sort vendors",
        ul(
          runs("Search by company name, and filter by ", { b: "Type" }, ", ", { b: "Status" }, ", ", { b: "Source" }, ", ", { b: "Industry" }, ", ", { b: "Assigned to" }, " and ", { b: "Added on" }, " — and on your own vendor fields."),
          runs("Use ", { b: "Columns" }, " to choose what the table shows, or the split view to read a vendor beside the list."),
          "Tick vendors to reassign them, set their status or add tags in one go. Reassigning appears only for people allowed to change who a company belongs to.",
        ),
      ),
    ],
    settings: [
      setting(
        "Vendor codes",
        "Settings › Vendor codes",
        p(runs("The ", { b: "Prefix" }, " every new vendor's code starts with — 1 to 12 letters or digits, optionally with - / or _ — then the next number. The page shows the code the next vendor will get. Numbering carries on after the highest code already in use.")),
        p(runs("Vendors added before codes were automatic can be numbered in one go with ", { b: "Give them codes" }, ". Changing the prefix leaves existing codes as they are. Needs the permission to change organisation settings.")),
      ),
      setting("Custom fields", "Settings › Custom fields › Vendors", p("Your company's own fields on vendors, OEMs, distributors and partners — separate from the fields on customers.")),
      setting("Wording", "Settings › Wording", p("Your own word for a vendor — “Supplier”, say — used in the menu, headings and buttons.")),
      setting("Payment terms (from us to them)", "On each vendor", p("The terms you pay this vendor on, shown in the vendor's details.")),
    ],
    faq: [
      qa("I can't find a vendor a colleague added.", p("Without See every account, not just your own, you see only the vendors you're account manager for and your reports'. Ask an admin to widen your access, or the colleague to reassign it.")),
      qa("Why does a vendor's page have fewer tabs than a customer's?", p("You don't sell to a vendor, so the sales tabs — Products & Subscriptions, Payments, Leads, Renewals and the like — aren't shown. Its Documents tab holds purchase documents instead. A vendor that also buys from you has both sides' tabs.")),
      qa(
        "A customer of ours is also a vendor. Do I add them again?",
        p(runs("No — one company can have both roles. Open the customer and select ", { b: "Add as a vendor too" }, " under Roles on its Details tab, or the same from the name you type when adding a vendor. It gets a vendor code and starts Onboarding, appears in Vendors and the vendor pickers, and stays among your companies.")),
        p("Choose its Vendor manager there: purchasing reach it through them, as they reach their own vendors. Its Statement shows what you owe them beside what they owe you, and the net."),
      ),
      qa("The bank account number is masked.", p("Full numbers show only to people who manage finance records or record payments.")),
      qa("It says the code is already another vendor's.", p("Every vendor code is unique. Pick another, or correct the other vendor's code first.")),
      qa("Where do I see what we owe a vendor?", p(runs("In Payables, which ages each vendor's bills — see ", ["Payables", "/help/payables"], "."))),
      qa(
        "I don't see Vendors in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
    ],
    related: ["purchase_documents", "payables", "orders", "companies"],
  },
};

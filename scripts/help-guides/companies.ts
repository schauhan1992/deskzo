import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Companies & Contacts — written from src/app/(dashboard)/companies (the list, new, edit, the
 * duplicates list and the merge screen), src/app/(dashboard)/customers, src/app/(dashboard)/mail-log,
 * src/components/companies (the company page and its tabs, contacts, locations, the merge wizard),
 * src/actions/company.ts, src/actions/company-merge.ts, src/actions/company-location.ts,
 * src/actions/mail-log.ts and src/lib/authz/company-scope.ts (whose accounts somebody sees).
 */
export const guide: SeedGuide = {
  slug: "help/companies-and-contacts",
  title: "Companies & Contacts",
  seo: {
    title: "Companies & Contacts: your accounts and the people in them",
    description: "How to add companies and contacts, keep offices and GST details right, assign account managers, merge duplicates and see every email sent to a customer.",
    keywords: ["company records", "customer contacts", "merge duplicate companies"],
  },
  guide: {
    module: "companies",
    heading: "Companies & Contacts",
    summary:
      "Every organisation you sell to, in one place: companies you are still working on, customers who have bought, the people there, their offices and GST details, and one page per company with everything that happened with them.",
    purpose: [
      p(
        "Companies & Contacts is the address book the rest of the app hangs off. A company is an organisation you sell to. Its contacts are the people who work there, and its locations are its offices, each with its own address and GST registration. Leads, orders, invoices, payments, tickets and visits all belong to a company, and the company's page brings them together on one screen.",
      ),
      p(
        runs(
          "A company's page always has ",
          { b: "Details" },
          ", ",
          { b: "Locations" },
          " and, if you may see contacts, ",
          { b: "Contacts" },
          ". The other tabs — Leads, Products & Subscriptions, Documents, Payments, Tickets, Tasks and more — appear only for the modules your company uses and the records you may see.",
        ),
      ),
      p(
        runs(
          "The same records are shown in two lists. ",
          { b: "Sales › Companies" },
          " holds the companies that have never ordered — prospects, companies with a lead, and won deals still waiting for their first order. ",
          { b: "Sales › Customer" },
          " holds the companies that have actually bought from you: at least one order on file, active or expired. A company moves from the first list to the second by itself when its first order is placed.",
        ),
      ),
      p(runs("On the Companies list a company shows its stage. A new company starts as a ", { b: "Prospect" }, ". It becomes a ", { b: "Lead" }, " when somebody opens a lead for it, and shows ", { b: "Awaiting Order" }, " once one of its leads is won but no order has been placed yet.")),
      note(
        runs(
          "Vendors, resellers and commission parties are companies too, but each has its own module and list. See ",
          ["Vendors", "/help/vendors"],
          ", ",
          ["Resellers", "/help/resellers"],
          " and ",
          ["Commission Parties", "/help/commission-parties"],
          ".",
        ),
      ),
    ],
    access: [
      p("Companies & Contacts is in every workspace and can't be switched off. Everybody signed in can use it unless an admin hides it from their role, but each person sees only the accounts they are allowed to:"),
      ul(
        runs("With ", { b: "See every account, not just your own" }, ", you see every company."),
        "Without it, you see the companies you are account manager for, and the accounts of anyone who reports to you.",
        "A company with no account manager is seen only by people who see every account.",
      ),
      p("By default, everything under a company — its leads, orders, payments, tickets, contacts and documents — follows the same line. Whoever adds a company becomes its account manager, so a new company never disappears from the list of the person who added it. Anybody who can open a company can edit it."),
      p("The people at a company, with their phone numbers and emails, need View contacts. A reseller's end customer is marked do-not-contact: its email and phone are hidden from everyone who doesn't hold View reseller-managed contact details."),
      p(runs("An admin can change how far a role reaches — its record scope — in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    permissions: [
      perm("section.companies", "Shows Sales › Companies & Contacts in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("companies.viewAll", "See every account rather than only the ones you manage (and your team's). Held by default by Management, Accounts, Purchase, Support, Profiling and Calling — not by Sales."),
      perm("contacts.view", "See and work with the people at an account: the Contacts tab, their phone numbers and emails, and adding or editing them. Without it a company is created bare and someone else adds its people. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("contacts.viewRestricted", "See the email and phone of a reseller's end customer, which are hidden from everyone else. Management and Support have it by default."),
      perm("accounts.reassign", "Change the account manager or caller of any account you can see, including leaving one with nobody. Management has it by default."),
      perm("accounts.handOffOwn", "Pass an account you manage, or one you are the caller on, to a colleague. Always to a person — only someone who can reassign may leave it unassigned. Sales and Management have it by default."),
      perm("companies.merge", "Opens Duplicate companies and the merge screen, and lets you fold a duplicate into the company that stays. It can't be undone. Management has it by default."),
      perm("emails.view", "Opens the Mail log and a customer's Emails tab: every email the app sent a customer, with whether it arrived, for the accounts you can see. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("companies.manageCategories", "Create, rename, recolour and remove customer categories in Settings › Customer categories. Putting a customer in a category needs only access to that customer. Management has it by default."),
      perm("data.exportCrm", "Download companies, customers and contacts as a file from Settings › Import & export — only the accounts you can already see. No role has it by default; admins do."),
      perm("data.importCrm", "Bring companies and contacts in from a file in Settings › Import & export. No role has it by default; admins do."),
    ],
    setup: [
      p("There is nothing to switch on: the module is there from the first day. A few lists make the company form more useful, and an admin fills them in once:"),
      ul(
        runs({ b: "Settings › Lists" }, " — the industries a company can be in, and the contact designations offered for its people."),
        runs({ b: "Settings › Customer categories" }, " — how you group customers, with the icon, colour and handling note shown beside each one's name."),
        runs({ b: "Settings › Custom fields" }, " — your own fields on companies and contacts, if the built-in ones aren't enough."),
      ),
      p(runs("If you already have your customers in a spreadsheet, someone who may import customer data can bring them in from ", { b: "Settings › Import & export" }, " instead of typing them.")),
    ],
    tasks: [
      task(
        "Add a company",
        ol(
          runs("Open ", { b: "Sales › Companies" }, " and select ", { b: "New company" }, "."),
          runs("Type the ", { b: "Company name" }, ". As you type, companies with similar names are listed under the field — open one instead if it's the same company. A name already in use can't be saved twice."),
          runs("Fill in what you know: ", { b: "Industry" }, ", ", { b: "Company type" }, ", ", { b: "Number of employees" }, ", ", { b: "Website" }, ", ", { b: "Payment terms" }, ", ", { b: "Source" }, " and ", { b: "Tags" }, "."),
          runs("Under ", { b: "Primary location" }, ", give the office's address. In India also add its ", { b: "GST number" }, " and ", { b: "GST treatment" }, " — the state decides the tax on every document raised against that address."),
          runs("Under ", { b: "Contacts" }, ", add the first person and tick ", { b: "Primary contact" }, ". Select ", { b: "+ Add contact" }, " for more."),
          runs("Select ", { b: "Save company" }, ". The company's page opens, with you as its account manager."),
        ),
      ),
      task(
        "Find a company and work the list",
        ol(
          runs("Open ", { b: "Sales › Companies" }, " for companies that haven't ordered, or ", { b: "Sales › Customer" }, " for those that have."),
          runs("Search by name, or filter by ", { b: "Source" }, ", ", { b: "Industry" }, ", ", { b: "Category" }, ", ", { b: "Caller" }, " or ", { b: "Added on" }, ". On Companies, the chips ", { b: "Prospects" }, ", ", { b: "Leads" }, ", ", { b: "Awaiting Order" }, " and ", { b: "Disqualified" }, " narrow it by stage."),
          runs("Switch between ", { b: "Table" }, " and ", { b: "Split" }, " at the top. Split opens a company beside the list, so you can go down it one by one."),
          runs("Tick rows to change several at once: assign a caller (if you may change callers), or ", { b: "Add tags (comma separated)" }, ", then select ", { b: "Apply" }, ". Tags are added to the ones a company already has, never replaced."),
        ),
      ),
      task(
        "Keep a company's contacts up to date",
        ol(
          runs("Open the company and its ", { b: "Contacts" }, " tab."),
          runs("Select ", { b: "+ Add contact" }, ", fill in ", { b: "Name" }, ", ", { b: "Designation" }, ", ", { b: "Email" }, ", ", { b: "Phone" }, " and ", { b: "LinkedIn URL" }, ", and select ", { b: "Save contact" }, "."),
          runs("Tick ", { b: "Receives invoices & quotes" }, " for whoever should be sent documents, and ", { b: "Primary contact" }, " for the main person."),
          runs("To change someone, select the pencil (", { b: "Edit contact" }, ") on their row."),
          runs("To check the email addresses, select ", { b: "Check … addresses" }, " — it counts the ones not checked yet. Each address gets a verdict from its domain's mail records; the address itself is never changed."),
        ),
      ),
      task(
        "Record that a contact has left",
        ol(
          runs("On the company's ", { b: "Contacts" }, " tab, select the icon on their row labelled with their name and ", { i: "has left" }, " the company."),
          runs("If you know where they went, tick ", { b: "They've joined another company" }, ", pick the company and add their new designation, email and phone."),
          runs("Select ", { b: "They've left" }, " (or ", { b: "Record the move" }, ")."),
        ),
        p(
          runs(
            "They stay on the company with their history, folded under ",
            { b: "Left the company" },
            ". From then on they aren't the primary contact, aren't sent invoices or campaigns, aren't offered for meetings, calls or forms, and any customer-portal link of theirs stops working. If they come back, open that section and select the tick icon on their row.",
          ),
        ),
      ),
      task(
        "Add another office or GST registration",
        ol(
          runs("Open the company's ", { b: "Locations" }, " tab and select ", { b: "+ Add location" }, "."),
          runs("Give it a ", { b: "Label" }, " (for example, the city), the address, and in India its GST number and GST treatment."),
          runs("Tick ", { b: "Bill to this address" }, " and ", { b: "Ship to this address" }, " where they apply — documents default to the billing address."),
          runs("Select ", { b: "Add location" }, "."),
        ),
        p("A company always keeps at least one location, and a location with orders on it can't be deleted."),
      ),
      task(
        "Change the account manager or caller",
        ol(
          runs("Open the company. At the top, select ", { b: "Account manager" }, " (who looks after the account) or ", { b: "Caller" }, " (who works it for lead generation)."),
          runs("Pick the person and select ", { b: "Save" }, "."),
        ),
        p("You only see these choices if you may make them: anyone holding Reassign accounts and leads, or the current holder handing it on to a colleague. Every change is written to the activity log, and the person you give it to is notified."),
      ),
      task(
        "Merge a duplicate company",
        ol(
          runs("Open ", { b: "Sales › Duplicate companies" }, ". Pairs that look like one company entered twice are listed, marked ", { b: "Very likely" }, " or ", { b: "Possibly" }, ", with the reason — the same GSTIN or PAN, the same name, a shared email domain or phone."),
          runs("Select ", { b: "Review merge" }, " on a pair, or ", { b: "Not duplicates" }, " to stop it being offered again. You can also start from the company that should stay: select the merge icon at the top of its page (", { b: "Merge a duplicate into this company" }, ")."),
          runs("Check which company ", { b: "Stays" }, ", choose which details to keep, and untick anybody under ", { b: "People in both" }, " who is really two people."),
          runs("Type the duplicate's name to confirm and select ", { b: "Merge into" }, " the company that stays."),
        ),
        note("A merge moves everything under the duplicate — contacts, leads, orders, invoices, payments, tickets and the rest — and removes it. Its old links open the company it became. It can't be undone.", "warning"),
      ),
      task(
        "See what was emailed to a customer",
        ol(
          runs("Open ", { b: "Sales › Mail log" }, " for every customer, or a customer's ", { b: "Emails" }, " tab for one."),
          runs("Narrow it by status — ", { b: "Delivered" }, ", ", { b: "Opened" }, ", ", { b: "Bounced or failed" }, ", ", { b: "Held back" }, " and so on — by ", { b: "Notices" }, " or ", { b: "Marketing" }, ", by channel, or by the date it was ", { b: "Sent" }, "."),
          "Open a row to see who sent it, what happened to it, and the email as it was sent.",
        ),
      ),
    ],
    settings: [
      setting(
        "Customer categories",
        "Settings › Customer categories",
        p("The groups customers are put in, each with an icon, a colour and a note on how to treat them. A sub-category can borrow its category's icon and colour and add its own note. The chip shows beside the customer's name everywhere, and the note under the name on their page. Needs Manage customer categories."),
      ),
      setting(
        "Industries and contact designations",
        "Settings › Lists",
        p("The industries offered on a company, and the designations offered for its contacts. A designation typed on a contact that isn't in the list is added to it."),
      ),
      setting(
        "Custom fields",
        "Settings › Custom fields",
        p("Your own fields on companies and on contacts — where they appear, which are required and who sees them. Required ones must be filled in before a new company is saved. Needs Manage custom fields."),
      ),
      setting(
        "Import & export",
        "Settings › Import & export",
        p("Companies, customers and contacts to and from a spreadsheet. An export holds only the accounts the person can already see."),
      ),
      setting(
        "Columns and layout",
        "On each list",
        p(runs("Choose ", { b: "Table" }, " or ", { b: "Split" }, ", and which columns the table shows, including your own fields. Both are remembered for you alone.")),
      ),
    ],
    faq: [
      qa(
        "I added a company and now I can't find it, or I can't see a colleague's company.",
        p("If you don't see every account, you only see the companies you are account manager for (and your team's). Ask whoever can reassign accounts to make you its account manager, or ask an admin about your access."),
      ),
      qa(
        "It says a company with this name already exists, but I can't find it.",
        p("Company names are unique across the whole workspace — vendors, resellers and commission parties included. The one that exists belongs to somebody else's accounts. Ask an admin to give you access to it rather than creating a second one."),
      ),
      qa(
        "Why does a company we won say Awaiting Order?",
        p("A won deal only counts as a customer once an order is on file. Until then it stays on the Companies list as Awaiting Order. Once its first order is placed it moves to the Customer list."),
      ),
      qa(
        "Why can't I delete a contact?",
        p(runs("A contact linked to a lead can't be deleted. If they've moved on, mark them as left instead — they keep their history and stop being offered for anything new.")),
      ),
      qa(
        "How do I delete a company?",
        p("There is no button to delete a company. If it is a duplicate of another, merge it into the one that stays."),
      ),
      qa("Why are a customer's email and phone hidden?", p("They are a reseller's end customer. You go through the reseller rather than contacting them directly, so their details are hidden unless you hold View reseller-managed contact details.")),
      qa(
        "I can't see Companies, Duplicate companies or Mail log in the menu.",
        p(
          "Companies & Contacts can't be switched off, but an admin can hide the Sales › Companies & Contacts section from your role in Settings › Roles & Permissions. Duplicate companies needs Merge duplicate companies, and Mail log needs View emails sent to customers — without them the links aren't shown at all.",
        ),
      ),
    ],
    related: ["leads", "contacts_library", "orders", "workspace"],
  },
};

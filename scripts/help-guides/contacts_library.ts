import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Contacts Library — written from src/app/(dashboard)/contacts, src/components/contacts (the table and
 * its selection bar), src/actions/contact.ts (the list, its account scope and the bulk changes),
 * src/actions/email-verification.ts and src/lib/email-verification.ts (the email check), and
 * src/lib/contacts/left.ts (people who have left).
 */
export const guide: SeedGuide = {
  slug: "help/contacts-library",
  title: "Contacts Library",
  seo: {
    title: "Contacts Library: every contact at every company in one list",
    description: "How to search every contact across your customers, vendors and partners, filter by designation or relationship, check email addresses and tidy contacts in bulk.",
    keywords: ["contacts library", "contact list", "email verification"],
  },
  guide: {
    module: "contacts_library",
    heading: "Contacts Library",
    summary: "Every contact at every company you can see — clients, resellers, vendors, OEMs and partners — in one searchable list, with their email check and quick ways to reach them.",
    purpose: [
      p(
        "A contact always belongs to a company and is added on that company's page. The Contacts Library turns that round: it lists the people from every company together, so you can find somebody without knowing where they work, or pull out every purchase head in one industry.",
      ),
      p("From a row you can open the person's company, see whether their email address has been checked, and reach them — WhatsApp, LinkedIn, a meeting when you use Calendar, or a logged call when you use Calls."),
      note(runs("To add a contact, or to change one person's details, use the ", { b: "Contacts" }, " tab on their company's page — see ", ["Companies & Contacts", "/help/companies-and-contacts"], ".")),
    ],
    access: [
      p("You need View contacts to open the library. It shows the contacts at the companies you can see:"),
      ul(
        "With See every account, not just your own, that is every company's contacts.",
        "Without it, it is the contacts at the accounts you manage, and at your team's.",
      ),
      p("A reseller's end customer is marked do-not-contact. Their people are listed, but their email and phone are hidden unless you hold View reseller-managed contact details."),
      p("The changes on the selection bar — giving people a designation, checking emails, deleting — only work on contacts you are allowed to change. A contact linked to a lead is never deleted."),
    ],
    permissions: [
      perm("section.contactsLibrary", "Shows Directory › Contacts Library in the menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("contacts.view", "Opens the library and shows the people at an account, with their phone numbers and emails. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("contacts.viewRestricted", "Shows the email and phone of a reseller's end customer, which are hidden from everyone else. Management and Support have it by default."),
      perm("companies.viewAll", "Lists the contacts at every account rather than only the ones you (or your team) manage. Held by default by Management, Accounts, Purchase, Support, Profiling and Calling — not by Sales."),
      perm("data.exportCrm", "Download contacts as a file from Settings › Import & export — only the ones you can already see. No role has it by default; admins do."),
    ],
    setup: [
      p("There is nothing to set up: the library fills itself from the contacts added on each company."),
      p(
        runs(
          "For the ",
          { b: "Designation" },
          " filter to be useful, keep the list of contact designations tidy in ",
          { b: "Settings › Lists" },
          ". Your own contact fields, added in ",
          { b: "Settings › Custom fields" },
          ", can be filtered on here, and the ones set to show as a column in the list appear as columns.",
        ),
      ),
    ],
    tasks: [
      task(
        "Find a contact",
        ol(
          runs("Open ", { b: "Directory › Contacts" }, "."),
          runs("Type in ", { b: "Search name, email, phone, or company…" }, "."),
          runs("Narrow it with ", { b: "Relationship" }, " (client, reseller, vendor and so on), ", { b: "Designation" }, ", ", { b: "Industry" }, " or ", { b: "Primary only" }, "."),
          "Select the company's name on a row to open that company's Contacts tab.",
        ),
      ),
      task(
        "See people who have left",
        p(
          runs(
            "The library shows people still at their company unless you ask. Set ",
            { b: "Status" },
            " to ",
            { b: "Left the company" },
            " to see only those who have left, or ",
            { b: "Everybody" },
            " for both. A person who has left carries a ",
            { b: "Left" },
            " badge.",
          ),
        ),
      ),
      task(
        "Check email addresses before a mailing",
        ol(
          "Filter the list down to the people you plan to write to.",
          "Tick them, or tick the box at the top to select the whole page.",
          runs("Select ", { b: "Verify emails" }, "."),
        ),
        p(
          runs(
            "Each address is checked against its domain's mail records, and gets ",
            { b: "Verified" },
            ", ",
            { b: "Reaches someone" },
            " (a shared or personal inbox) or ",
            { b: "Bad address" },
            ". The address is never changed. Edit it later and the old result no longer counts — it shows as not checked until it is checked again.",
          ),
        ),
      ),
      task(
        "Give several people the same designation",
        ol(
          "Tick the contacts.",
          runs("Type or pick the designation in ", { b: "Designation to give them" }, "."),
          runs("Select ", { b: "Apply" }, "."),
        ),
      ),
      task(
        "Delete contacts in bulk",
        ol(
          "Tick the contacts.",
          runs("Select ", { b: "Delete" }, " and confirm."),
        ),
        p("Anyone linked to a lead is kept, and the message says how many were. Deleting can't be undone — for somebody who has moved on, mark them as left on their company's page instead, so their history stays."),
      ),
    ],
    settings: [
      setting(
        "Contact designations",
        "Settings › Lists",
        p("The designations offered for a contact, and in the Designation filter here. A designation typed on a contact that isn't in the list is added to it."),
      ),
      setting(
        "Contact custom fields",
        "Settings › Custom fields",
        p("Your own fields on contacts. You can filter this list on any of them you are allowed to see, and the ones set to show as a column in the list appear as columns here."),
      ),
      setting("Import & export", "Settings › Import & export", p("Contacts to and from a spreadsheet, for people who may export or import customer data. An export holds only the contacts the person can see.")),
    ],
    faq: [
      qa(
        "Why isn't somebody I know about in the list?",
        p("Either they have left their company — set Status to Everybody — or they work at a company you can't see. Without See every account you only see the contacts at the accounts you and your team manage."),
      ),
      qa("Why are some emails and phone numbers hidden?", p("Those people work for a reseller's end customer, who is contacted only through the reseller. Their details are shown only to people who hold View reseller-managed contact details.")),
      qa("Can I add a contact from here?", p("No. Contacts are added on their company's page, on its Contacts tab, so every contact always has a company.")),
      qa("Some contacts weren't deleted.", p("A contact linked to a lead can't be deleted. Mark them as left on their company's page instead.")),
      qa(
        "I can't see Contacts in the menu.",
        p(
          "You need View contacts, and the Contacts Library module must be on for your company in Settings › Modules. An admin can also hide the Directory › Contacts Library section from your role in Settings › Roles & Permissions.",
        ),
      ),
    ],
    related: ["companies", "workspace", "calls", "marketing"],
  },
};

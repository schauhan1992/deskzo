import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Domain Intel — written from src/app/(dashboard)/domains, src/components/domains (the list's rows and
 * the Domain & web card on a company), src/actions/domain.ts (who may be looked up, and the list),
 * src/lib/domain-intel/lookup.ts (what a lookup reads) and src/lib/domain-intel/opportunities.ts.
 */
export const guide: SeedGuide = {
  slug: "help/domain-intel",
  title: "Domain Intel",
  seo: {
    title: "Domain Intel: what a customer's domain says about them",
    description: "How to look up a customer's domain to see who runs their email, whether it can be spoofed, what their website runs on and who hosts it — and where that opens a conversation.",
    keywords: ["domain intelligence", "email security check", "website technology lookup"],
  },
  guide: {
    module: "domains",
    heading: "Domain Intel",
    summary:
      "What public DNS and a customer's own website say about them — who runs their email, whether their domain can be spoofed, what the site is built on, who hosts it and who it's registered with — and the sales conversations that opens.",
    purpose: [
      p("Domain Intel reads what any company publishes about itself and turns it into something a salesperson can use. From the website on a company's record it finds:"),
      ul(
        "who runs their email (for example Google Workspace, Microsoft 365, or self-hosted mail), and any mail security service in front of it;",
        "whether the domain has SPF, DMARC and DKIM — a domain with no DMARC can be impersonated;",
        "what the website is built on, who hosts it, who runs its DNS, and who it's registered with and when that runs out;",
        "the homepage's title and description, with a thumbnail of the page.",
      ),
      p(runs("Each finding comes with ", { b: "Where the conversation is" }, ": what it leaves open, such as a security conversation for a spoofable domain or a migration for self-hosted mail.")),
      note("A lookup only happens when somebody asks for one, never in the background. It reads public DNS, the company's homepage and the public domain registration record, and takes a few seconds. The page thumbnail comes from an outside screenshot service."),
    ],
    access: [
      p("Everybody with Domain Intel in their menu can open the list, look a company up and refresh a lookup."),
      p("Lookups are for the companies you sell to — customers and resellers. Vendors, OEMs, distributors, partners and commission parties are left out of the list, the counts and the company card."),
    ],
    permissions: [perm("section.domains", "Shows Prospecting › Domain Intel in the menu, opens its page, and shows the Domain & web card on a customer's page. Every role has it until an admin unticks it for one.")],
    setup: [
      p(
        runs(
          "There is nothing to configure. A lookup needs the company's ",
          { b: "Website" },
          " on its record — add it when you create the company, or later with ",
          { b: "Edit" },
          " on its page. Companies without one aren't listed.",
        ),
      ),
    ],
    tasks: [
      task(
        "Look up one company",
        ol(
          runs("Open the company's page. The ", { b: "Domain & web" }, " card is on its ", { b: "Details" }, " tab."),
          runs("Select ", { b: "Look up" }, " (or ", { b: "Refresh" }, " if it has been looked up before)."),
          runs("Read the findings — ", { b: "Email" }, ", ", { b: "Mail security" }, ", ", { b: "Website platform" }, ", ", { b: "Hosted on" }, ", ", { b: "DNS" }, ", ", { b: "Registrar" }, " — the SPF, DMARC and DKIM badges, and ", { b: "Where the conversation is" }, "."),
        ),
        p("The card shows when it was last checked. A lookup that failed says why, and the last good findings stay until the next one succeeds."),
      ),
      task(
        "Find the companies worth a conversation",
        ol(
          runs("Open ", { b: "Prospecting › Domain Intel" }, "."),
          runs("The cards at the top count ", { b: "Looked up" }, ", ", { b: "Spoofable" }, " (no DMARC), ", { b: "On Google Workspace" }, " and ", { b: "Self-hosted mail" }, "."),
          runs("Filter by ", { b: "Email" }, " provider or website ", { b: "Platform" }, ", or search by company or website."),
          runs("The ", { b: "Protection" }, " column shows ", { b: "No SPF" }, ", ", { b: "No DMARC" }, " or ", { b: "DMARC p=none" }, " where the domain is open, and ", { b: "Protected" }, " where it isn't."),
        ),
      ),
      task(
        "Look up the companies nobody has checked",
        ol(
          runs("On ", { b: "Prospecting › Domain Intel" }, ", select ", { b: "Not looked up yet" }, "."),
          runs("Select the refresh button on a row (", { b: "Look this domain up now" }, ")."),
        ),
      ),
      task(
        "Build a list from what domains say",
        p(
          runs(
            "In a Workspace list, the ",
            { b: "What their domain says" },
            " filters — ",
            { b: "Email provider" },
            ", ",
            { b: "Website platform" },
            ", ",
            { b: "Domain can be spoofed" },
            " and ",
            { b: "Domain not looked up yet" },
            " — use these findings. See ",
            ["Workspace", "/help/workspace"],
            ".",
          ),
        ),
      ),
    ],
    settings: [
      setting(
        "Website",
        "On each company's record",
        p("The address a lookup reads. If it doesn't look like a website address, the lookup says so — fix it on the company and look it up again."),
      ),
    ],
    faq: [
      qa("Why is there no Domain & web card on a company?", p("Either it is a vendor, partner or commission party — lookups are for customers and resellers — or Domain Intel isn't in your menu.")),
      qa("It says the company has no website on file.", p("Add the website to the company with Edit on its page, then select Look up.")),
      qa("Are the findings kept up to date by themselves?", p("No. A lookup is kept until somebody presses Refresh, and the date it was checked is shown beside it, so nobody mistakes an old answer for a current one.")),
      qa(
        "I can't see Domain Intel in the menu.",
        p("The Domain Intel module may be switched off for your company in Settings › Modules, or the Prospecting › Domain Intel section may be hidden from your role in Settings › Roles & Permissions."),
      ),
    ],
    related: ["companies", "workspace", "contacts_library"],
  },
};

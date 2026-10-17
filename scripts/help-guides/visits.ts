import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Field Visits — written from src/app/(dashboard)/visits (the list, Plan a visit, a visit's page, its edit
 * page), src/components/visits (the form, the check-in/complete/cancel controls), src/actions/visit.ts and
 * the visit rule in src/lib/authz/access.ts (whose visits somebody sees and changes), src/lib/visits.ts
 * (purposes and statuses) and the visit's Meetings card (src/components/calendar/record-meetings.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/field-visits",
  title: "Field Visits",
  seo: {
    title: "Field Visits: plan client visits, check in and write them up",
    description: "How to plan a client visit in {siteName}, check in on the day, write up the outcome and claim the travel against it.",
    keywords: ["field visits", "client visit log", "sales visit tracking"],
  },
  guide: {
    module: "visits",
    heading: "Field Visits",
    summary: "Client meetings and field visits: plan them with a purpose and agenda, check in when you arrive, write up the outcome, and claim the travel against the visit.",
    purpose: [
      p("Field Visits is the log of where your people went and what came of it. A visit is planned against a customer — with who you're meeting, the office, a purpose and an agenda — then checked into on the day and completed with a written outcome."),
      p("Expenses for the trip — travel, fuel, tolls, a client meal — are claimed against the visit, so the cost sits beside the result. A visit can be planned against an open lead too, and it shows on that lead's page."),
      note(runs("Expense claims themselves are covered in ", ["Expenses", "/help/expenses"], ".")),
    ],
    access: [
      p("Field visits are a record of somebody's day, so they aren't open to the whole company by default:"),
      ul(
        runs("You see your own visits and those of anybody who reports to you."),
        runs("With ", { b: "View all field visits" }, ", you see every visit in the company."),
        runs("Changing a visit — planning it, checking in, completing or cancelling it — is for the person visiting and the people they report to. Seeing every visit doesn't let you change them; on someone else's visit you'll see a line saying it isn't yours to change."),
      ),
      p(runs("An admin can set other levels for a role on the ", { b: "Record Access" }, " tab of that role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    permissions: [
      perm("section.visits", "Shows Field Visits in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("visits.view", "Lets somebody see visits at all — the Field Visits pages and a customer's or lead's visits. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("visits.viewAll", "Shows every visit logged across the company, rather than just your own and your team's. It doesn't let you change them. Management has it by default."),
    ],
    setup: [
      p(runs("Nothing needs setting up beyond switching the module on in ", { b: "Settings › Modules" }, ". For managers to see and plan their team's visits, each person needs a reporting manager, set in ", { b: "Settings › Users" }, ".")),
      p("The Office picker on a visit lists the addresses already saved on the customer, so it helps to keep customers' locations up to date."),
    ],
    tasks: [
      task(
        "Plan a visit",
        ol(
          runs("Open ", { b: "Field & Expenses › Field Visits" }, " and select ", { b: "Plan visit" }, " — or use ", { b: "Plan visit" }, " on a customer's or lead's page, which fills the customer in for you."),
          runs("Choose the ", { b: "Company" }, ", then who you're ", { b: "Meeting with" }, " and the ", { b: "Office" }, ". The ", { b: "Address" }, " follows the office until you type over it."),
          runs("Pick the ", { b: "Purpose" }, " and the ", { b: "Date & time" }, ". A manager can choose another ", { b: "Rep" }, " from their team."),
          runs("If it's for a deal, choose it under ", { b: "Against lead" }, "."),
          runs("Add the planned ", { b: "Distance (km)" }, " and an ", { b: "Agenda" }, ", then select ", { b: "Plan visit" }, "."),
        ),
        p("If you plan a visit for somebody else, they get a notification."),
      ),
      task(
        "Check in when you arrive",
        p(runs("Open the visit and select ", { b: "Check in" }, ". It stamps the time you arrived, so the visit can show how long you were on site.")),
      ),
      task(
        "Write up the visit",
        ol(
          runs("Open the visit and select ", { b: "Complete visit" }, "."),
          runs("Write the ", { b: "Outcome" }, " — what was discussed, what was agreed, what happens next."),
          runs("Correct the ", { b: "Distance travelled (km)" }, " if it differs from the plan."),
          runs("Select ", { b: "Complete" }, ". The time you left is stamped then."),
        ),
      ),
      task(
        "Claim the travel",
        p(runs("On the visit's page, select ", { b: "Add expense" }, ". The claim is made against this visit and listed under ", { b: "Expenses claimed" }, ", with its status.")),
      ),
      task(
        "Cancel a visit, or record a no-show",
        ol(
          runs("Open the visit and select ", { b: "Cancel / no show" }, "."),
          runs("Choose ", { b: "Cancelled" }, " or ", { b: "They didn't show" }, ", and say ", { b: "Why" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p(runs("A planned visit that was never needed can be removed with ", { b: "Delete" }, " instead.")),
      ),
      task(
        "Put a visit in your calendar",
        p(runs("Where Calendar is on, the person making a planned visit sees ", { b: "Add to my calendar" }, " in the visit's ", { b: "Meetings" }, " card. Moving or cancelling the visit later moves or cancels the calendar entry too — see ", ["Calendar", "/help/calendar"], ".")),
      ),
      task(
        "Find visits",
        p(runs("On ", { b: "Field & Expenses › Field Visits" }, ", search by company, agenda or outcome, and filter by ", { b: "Status" }, ", ", { b: "Purpose" }, ", ", { b: "Rep" }, " and the ", { b: "Scheduled" }, " dates. The count at the top says how many visits are still open.")),
      ),
    ],
    settings: [
      setting(
        "Purpose",
        "In each visit",
        p("Intro meeting, Requirement gathering, Product demo, Proposal discussion, Negotiation, Order collection, Payment follow-up, Support escalation, Relationship building, Delivery / installation or Other. You can filter the list by it."),
      ),
      setting(
        "The word \"visit\"",
        "Settings › Wording",
        p("If your company calls them something else, an admin can rename the word, and the menu and the visit pages use yours."),
      ),
      setting(
        "Whose visits a role reaches",
        "Settings › Roles & Permissions, the Record Access tab",
        p("By default people see their own and their team's visits, everyone's with View all field visits, and change only their own and their team's. An admin can set a different level for a role here."),
      ),
    ],
    faq: [
      qa(
        "I forgot to check in. Can I still complete the visit?",
        p("Yes. Complete visit works from a planned visit too, and stamps the time you left — but without a check-in, the visit can't show how long you were on site."),
      ),
      qa(
        "Why can't I delete a visit?",
        p("Only a planned visit can be deleted. A completed visit is a record — cancel it instead. A visit with expenses claimed against it can't be deleted until those claims are removed."),
      ),
      qa(
        "I can see a colleague's visit but can't change it.",
        p("Seeing everybody's visits doesn't let you change them. Only the person visiting, and the people they report to, can plan, check in, complete or cancel a visit."),
      ),
      qa(
        "Why isn't a lead listed under Against lead?",
        p("Only open leads at the chosen company that you can see are offered — won, lost and disqualified leads aren't. Choose the company first: the list fills in from it."),
      ),
      qa(
        "I don't see Field Visits in the menu.",
        p("Either the module is switched off for your company (Settings › Modules), your role has had the section hidden, or your role doesn't have the permission to view visits (both in Settings › Roles & Permissions). Ask an admin."),
      ),
    ],
    related: ["expenses", "calendar", "companies", "targets"],
  },
};

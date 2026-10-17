import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Visitor Management — written from src/app/(dashboard)/visitors (the book, expected visitors,
 * reception tablets, visitor companies), src/app/(public)/kiosk (the tablet), src/components/visitors,
 * src/actions/visitor.ts (who may read the book, set up tablets and invite) and
 * src/actions/visitor-public.ts (what a visitor must give, and who is told they've arrived).
 */
export const guide: SeedGuide = {
  slug: "help/visitor-management",
  title: "Visitor Management",
  seo: {
    title: "Visitor Management: reception sign-in and the visitor book",
    description: "How to set up a reception tablet, invite visitors with a code, tell hosts when their visitor arrives and keep the book of who is in the building in {siteName}.",
    keywords: ["visitor management", "reception sign-in", "visitor book"],
  },
  guide: {
    module: "visitors",
    heading: "Visitor Management",
    summary: "A sign-in tablet for reception, invitations with a code for visitors you're expecting, a notification to the host the moment their visitor arrives, and the book of who is in the building.",
    purpose: [
      p("Visitors sign themselves in on a tablet at reception. They say why they've come, choose the team and the person they're seeing, enter their name, phone number, company and email, take a photo, and add anyone who came with them. The person they came to see is notified straight away — or everyone in the team, if they didn't pick a person."),
      p("If you're expecting somebody, invite them in advance. They get a code to type at reception, so there is no form to fill in on the day."),
      p(runs("The ", { b: "Visitors" }, " page is the book: everybody who signed in over the last week, who is still in the building, and signing them out.")),
    ],
    access: [
      ul(
        runs({ b: "Everyone" }, " can invite a visitor from ", { b: "Expected visitors" }, " — for themselves, or for a colleague, who is told. You see the invitations you made and the ones for you."),
        runs({ b: "Reception, security and HR" }, " — people allowed to see the visitor book — also see ", { b: "Visitors" }, ": who has signed in, who is still in the building, signing them out, and every invitation in the company."),
        runs({ b: "Whoever sets up the tablets" }, " creates the reception tablet links and keeps the list of companies the tablet suggests."),
      ),
      p("A visitor at the tablet doesn't sign in to anything. The tablet's link is all it takes, and it lists every employee by name and department to whoever opens it — so treat the link like a password."),
    ],
    permissions: [
      perm("section.visitors", "Shows Visitor Management in the menu, with Expected visitors, and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "visitors.view",
        "Shows Visitors in the menu: the visitor book, who is in the building, signing visitors out and closing off old visits, and everyone's invitations rather than only your own. Management and Support have it by default; the built-in HR and HR head roles start with it.",
      ),
      perm(
        "visitors.manage",
        "Create, switch off, rotate and delete reception tablet links, and keep the list of visitor companies. A tablet link needs no login and lists every employee by name and department, which is why this is separate from reading the book. Management has it by default; the built-in HR head role starts with it.",
      ),
    ],
    setup: [
      p("Someone allowed to set up reception tablets does this once for each desk:"),
      ol(
        runs("Open ", { b: "Settings › Reception tablets" }, " (or ", { b: "Reception tablets" }, " on the Visitors page)."),
        runs("Under ", { b: "Add a desk" }, ", type ", { b: "Where is it?" }, " — for example, Main reception — and select ", { b: "Create" }, "."),
        runs("Copy the ", { b: "Tablet link" }, " and open it in Chrome on the tablet."),
        runs("Add it to the tablet's home screen — ", { b: "Put it on the tablet as an app" }, " › ", { b: "Show me how" }, " has the steps — and open it from the icon, so it runs full screen with no address bar."),
        "In the tablet's own settings, switch off the screen lock and keep the display on.",
      ),
      p(runs("So visitors can pick the team they're seeing, people need a department — an admin sets it in ", { b: "Settings › Users" }, ". To have your vendors already on the tablet's company list, select ", { b: "Bring our vendors across" }, " on ", { b: "Visitors › Companies" }, ".")),
    ],
    tasks: [
      task(
        "Invite a visitor",
        ol(
          runs("Open ", { b: "People › Expected visitors" }, " and select ", { b: "Invite a visitor" }, "."),
          runs("Fill in ", { b: "Who's coming" }, " and ", { b: "When" }, ", and their phone, email and company if you have them."),
          runs("Choose ", { b: "What for" }, " and how many ", { b: "Others with them" }, ". ", { b: "Here to see" }, " is you unless you pick a colleague — they'll be told you booked it."),
          runs("Select ", { b: "Create the invitation" }, "."),
          runs("Select ", { b: "Copy the message" }, " and send it to them yourself, by WhatsApp or email."),
        ),
        p("Nothing is emailed automatically. The code works on the day and the following morning, and only at a reception tablet. When they sign in with it, the person they're here to see is notified."),
      ),
      task(
        "Sign in at reception (what a visitor does)",
        ol(
          runs("With a code: select ", { b: "I have an invite code" }, ", type it, check the name and select ", { b: "That's me — continue" }, "."),
          runs("Without one: choose ", { b: "A meeting" }, ", ", { b: "An interview" }, ", ", { b: "A delivery" }, " or ", { b: "Vendor or service" }, ", then the team and, if they know it, the person."),
          "Enter their name, phone number, company and email. Email is optional for a delivery.",
          "Take a quick photo, and add the names of anyone with them.",
          runs("Select ", { b: "Sign me in" }, "."),
        ),
        p("The tablet shows a visitor number, tells the visitor their host has been told, and resets itself for the next person."),
      ),
      task(
        "See who is in the building and sign visitors out",
        ol(
          runs("Open ", { b: "People › Visitors" }, ". The top shows how many are in the building."),
          runs("When somebody leaves, select ", { b: "Sign out" }, " on their entry."),
          runs("If visitors from an earlier day were never signed out, select ", { b: "Close them off" }, ". They are marked ", { b: "Not signed out" }, " rather than signed out, because nobody saw them leave."),
        ),
      ),
      task(
        "Cancel an invitation",
        ol(
          runs("Open ", { b: "People › Expected visitors" }, "."),
          "Select the cross on the invitation and confirm. Their code stops working.",
        ),
        p(runs("You can cancel invitations you made or that are for you; reception can cancel any. ", { b: "Tidy up old ones" }, " closes off invitations for days that have passed.")),
      ),
      task(
        "Take a tablet out of service or change its link",
        ol(
          runs("Open ", { b: "Settings › Reception tablets" }, "."),
          runs("Untick ", { b: "In service" }, " to stop a tablet working, or select ", { b: "Rotate" }, " to give it a new link — the old one stops working, and the tablet needs the new link opened on it."),
          "Delete a tablet only if nobody has signed in on it yet. Otherwise take it out of service.",
        ),
      ),
    ],
    settings: [
      setting(
        "Reception tablets",
        "Settings › Reception tablets",
        p(runs("One link per desk. Each shows how many people have signed in on it and when it was last used. ", { b: "In service" }, " switches it on and off; ", { b: "Copy" }, " and ", { b: "Open" }, " give you the link; ", { b: "Rotate" }, " replaces it.")),
        note("Anyone holding a tablet link can open the sign-in screen and see the employee list. Rotate it if it has been shared beyond the tablet.", "warning"),
      ),
      setting(
        "Visitor companies",
        "People › Visitors › Companies",
        p(runs("The list the tablet suggests as a visitor types their company. It grows on its own as visitors type new names. ", { b: "Bring our vendors across" }, " adds your vendors; ", { b: "Add one by hand" }, " adds one more. Untick ", { b: "Offered" }, " to stop suggesting a name, and use ", { b: "Merge" }, " to fold a misspelling into the right entry.")),
        p("Your customers are never on this list, because the tablet needs no login."),
      ),
    ],
    faq: [
      qa(
        "I can't see Visitors in the menu.",
        p("Either the module is switched off for your company in Settings › Modules, your role has had the section hidden in Settings › Roles & Permissions, or you aren't allowed to see the visitor book. You can still invite visitors from Expected visitors."),
      ),
      qa(
        "The tablet says “This tablet isn't set up. Please ask at the desk.”",
        p("The tablet has been taken out of service or deleted, or its link was rotated. Check it in Settings › Reception tablets and open the current link on the tablet."),
      ),
      qa(
        "Who is told when a visitor arrives?",
        p("The person they chose to see. If they chose only a team, everyone in that team is notified."),
      ),
      qa(
        "A visitor's invite code doesn't work.",
        p("A code works on the day of the visit and the following morning, and only on a reception tablet. A cancelled invitation's code stops working. Check the code on Expected visitors, or invite them again."),
      ),
      qa(
        "Can a visitor sign in without a photo?",
        p("A photo is needed to sign in. If the tablet's camera isn't working, it offers to continue without one, and the entry says the camera was unavailable."),
      ),
      qa(
        "Why does someone from yesterday still show as in the building?",
        p("They didn't sign out. Select Close them off on the Visitors page, or Sign out on their entry."),
      ),
    ],
    related: ["hr", "notifications"],
  },
};

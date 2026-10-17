import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Projects — written from src/app/(dashboard)/projects (the list, a project, New and Edit),
 * src/components/projects (the form, Plan & billing, People, Risks & updates, Documents, Credentials),
 * src/actions/project.ts, project-credential.ts and project-document.ts (who may do what),
 * src/lib/projects (who sees a project, status and progress, how a billing stage follows its invoice),
 * src/lib/authz/access.ts and the Project types card in Settings › Lists.
 */
export const guide: SeedGuide = {
  slug: "help/projects",
  title: "Projects",
  seo: {
    title: "Projects: delivered work with milestones and billing",
    description: "How to run customer projects in {siteName}: milestones and progress, billing stages and their invoices, the team, risks and updates, documents and stored credentials.",
    keywords: ["project management", "project milestones", "billing stages"],
  },
  guide: {
    module: "projects",
    heading: "Projects",
    summary: "Delivered work for customers, such as a website build, a migration or an implementation: milestones and billing stages, the team and the customer's people, risks and updates, documents and stored credentials. Each project is visible to the people on it.",
    purpose: [
      p("A project is a piece of work you deliver for one customer. It has a code like PRJ-2026-0001, a status, a health, a project manager, the dates it starts and is promised by, and a contract value."),
      ul(
        runs({ b: "Plan & billing" }, ": the milestones, ticked off as they are done, which give the project its progress; and the billing stages the contract bills at, each of which can raise its invoice."),
        runs({ b: "People" }, ": your team on the project, and who to talk to at the customer."),
        runs({ b: "Risks & updates" }, ": what might go wrong and what is being done about it, and posted updates on where things stand."),
        runs({ b: "Documents" }, ": the agreement, the NDA, the scope, sign-offs and the rest."),
        runs({ b: "Credentials" }, ": passwords and keys for the customer's systems, encrypted and opened only with your own password."),
      ),
      note("Projects are visible to the people on them, not to everyone. Adding a colleague to a project is what lets them see it."),
    ],
    access: [
      p("You see a project when you are on its team, are its project manager, or created it. The permission to see every project opens all of them. The customer's people listed on a project are contacts, not logins: they get no access to anything."),
      p("Being on a project lets you read it and download its documents. Changing anything needs the permission to run projects, and that works only on projects you can see."),
      p("The Credentials tab needs its own permission, which nobody has by default. Storing, changing or deleting a credential needs the permission to run projects as well."),
      p(runs("An admin can widen or narrow how far a role reaches into projects in ", { b: "Settings › Roles & Permissions" }, ", and for one person in ", { b: "Settings › Users" }, ".")),
    ],
    permissions: [
      perm("projects.view", "Opens the Projects module and a customer's Projects tab. Which projects appear still follows who is on them. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.projects", "Shows Projects in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("projects.manage", "Create and edit projects, and change their milestones, billing stages, team, risks, updates and documents, on the projects you can see. Management and Support have it by default."),
      perm("projects.viewAll", "See every project, not only the ones you are on. Meant for keeping projects looked after when the last person on one leaves, so grant it sparingly. Management has it by default."),
      perm("projects.credentials", "Shows the Credentials tab and lets somebody reveal a stored password or key, after typing their own password. Every reveal is recorded and the project manager is told. Nobody has it by default, not even Management."),
    ],
    setup: [
      p("Nothing has to be set up before the first project. If you deliver the same kinds of work again and again, an admin can save each kind with a standard plan, so a new project starts with its milestones already in place:"),
      ol(
        runs("Open ", { b: "Settings › Lists" }, " and find ", { b: "Project types" }, "."),
        runs("Type a name under ", { b: "Add a kind of project" }, ", such as a mail migration, and add it."),
        runs("Select ", { b: "Standard plan" }, ", then ", { b: "Add a step" }, " for each milestone, with how many ", { b: "days in" }, " from the project's start it is due."),
        runs("Select ", { b: "Save plan" }, ". Untick ", { b: "Offered" }, " to stop offering a kind for new projects."),
      ),
      p("Opening Settings › Lists needs the permission to change organisation settings, and saving project types needs the permission to run projects too. Changing a plan leaves existing projects alone."),
    ],
    tasks: [
      task(
        "Start a project",
        ol(
          runs("Open ", { b: "Delivery › Projects" }, " and select ", { b: "New project" }, ". Or start it from the customer's ", { b: "Projects" }, " tab."),
          runs("Choose the ", { b: "Customer" }, ". It can't be changed later."),
          runs("Choose the ", { b: "Kind of work" }, " if it is one of your project types, and give it a ", { b: "Name" }, " and ", { b: "What it covers" }, "."),
          runs("Set the ", { b: "Status" }, ", ", { b: "Health" }, " and ", { b: "Project manager" }, ", and the dates: ", { b: "Starts" }, ", ", { b: "Promised by" }, " and, once done, ", { b: "Actually finished" }, "."),
          runs("Fill in the ", { b: "Contract value" }, "."),
          runs("Leave ", { b: "Start from this project type's standard plan" }, " ticked to get its milestones, dated from the start date."),
          runs("Select ", { b: "Create project" }, "."),
        ),
        p("You and the project manager are added to the team automatically. Add the rest on the People tab."),
      ),
      task(
        "Plan the work with milestones",
        ol(
          runs("Open the project's ", { b: "Plan & billing" }, " tab."),
          runs("Under ", { b: "Milestones" }, ", type a name under ", { b: "Add a milestone" }, ", pick its due date and add it."),
          "Tick a milestone when it is done. Who ticked it, and when, is kept.",
        ),
        p(runs({ b: "Progress" }, " is how many milestones are done out of all of them. A due date turns red once it has passed and the milestone isn't done. A project of a kind with a standard plan, and no milestones yet, offers ", { b: "Use this project type's standard plan" }, ".")),
      ),
      task(
        "Bill in stages",
        ol(
          runs("Under ", { b: "Billing stages" }, ", type a name under ", { b: "Add a stage" }, ", such as an advance or a payment on sign-off, and its amount."),
          runs("Choose whether it is ", { b: "Not yet due" }, ", ", { b: "Due" }, " or ", { b: "Waived" }, ", and, if it is earned when a milestone is done, which one. Add it."),
          runs("When it is time to bill, select ", { b: "Raise invoice" }, ". A draft invoice opens in Sales Documents."),
          "Check the draft, including its tax, and issue it in the usual way.",
        ),
        p("Raising the invoice needs the permission to raise and issue sales documents as well. The stage then shows Invoiced, and Paid once the invoice is paid. If the invoice is cancelled, or the draft deleted, the stage goes back to Due."),
        p(runs("A stage earned on a milestone has its revenue held back until that milestone is ticked. See ", ["Revenue & Close", "/help/revenue-and-close"], ".")),
      ),
      task(
        "Add the people",
        ol(
          runs("Open the ", { b: "People" }, " tab."),
          runs("Under ", { b: "Our team" }, ", choose a colleague under ", { b: "Add a colleague" }, ", pick their role on the project, and add them."),
          runs("Under ", { b: "At the customer" }, ", choose one of the customer's contacts under ", { b: "Add a customer contact" }, ", pick their role, and add them."),
        ),
        p("A colleague you add can see the project from then on, and is told. Removing them takes that away, except from the project manager and the person who created it. The project manager can't be removed while they are the manager: change the manager first."),
      ),
      task(
        "Raise risks and post updates",
        ol(
          runs("Open the ", { b: "Risks & updates" }, " tab and select ", { b: "Raise a risk or issue" }, "."),
          runs("Say what might go wrong, choose the ", { b: "Kind" }, ", the ", { b: "Severity" }, " and the ", { b: "Owner" }, ", and write what is being done about it."),
          runs("Select ", { b: "Raise it" }, "."),
          runs("To post an update, write where things stand under ", { b: "Updates" }, ", choose the ", { b: "Health" }, ", and select ", { b: "Post" }, "."),
        ),
        p("Posting an update also sets the project's health, so the two can't disagree. An open risk with nothing written about what is being done is flagged."),
      ),
      task(
        "File documents",
        ol(
          runs("Open the ", { b: "Documents" }, " tab."),
          runs("Under ", { b: "Add a document" }, ", choose its type (Agreement, NDA, Scope of work and so on) and, if you like, a name."),
          runs("Select ", { b: "Choose file" }, ". It uploads as soon as you pick it: a PDF, Word file or image, up to 4 MB."),
        ),
        p("Everybody on the project can download a document. Adding and deleting need the permission to run projects."),
      ),
      task(
        "Store and reveal a credential",
        ol(
          runs("Open the ", { b: "Credentials" }, " tab and select ", { b: "Store one" }, "."),
          runs("Fill in ", { b: "What it opens" }, ", ", { b: "Username" }, ", ", { b: "Where" }, ", ", { b: "Password or key" }, " and, if it has one, ", { b: "Expires" }, ". Select ", { b: "Save" }, "."),
          runs("To read one, select ", { b: "Reveal" }, ", type ", { b: "Your password" }, " and select ", { b: "Reveal" }, ". Select ", { b: "Done" }, " when you have finished."),
        ),
        p(runs("Credentials are encrypted at rest. Every reveal asks for your password again, is recorded against the credential, and tells the project manager. For the company's own logins, such as a bank or a registrar, use the ", ["Credential Vault", "/help/credential-vault"], " instead.")),
      ),
    ],
    settings: [
      setting("Project types", "Settings › Lists", p("The kinds of work you deliver, each with the standard plan a new project of that kind starts from, as in Setting it up.")),
      setting(
        "Status and health",
        "In each project, under Edit",
        p("The status runs from Proposed through Discovery, Planning, In progress, Customer testing, Go live and Handover to Completed, with On hold and Cancelled beside them. Any status can be chosen at any time, and colleagues on the project are told when it changes."),
        p("The health is On track, At risk or Off track. It is set by hand, here or by posting an update; nothing works it out for you."),
      ),
    ],
    faq: [
      qa(
        "I can't see Projects in the menu.",
        p("Either the module is switched off for your company, the section is hidden for your role, or you don't have the permission to view projects. Ask an admin: the switch is in Settings › Modules, and the section and the permission are in Settings › Roles & Permissions."),
      ),
      qa("Why is my project list empty?", p("You haven't been added to any projects yet. Projects show only to the people on them, the project manager and whoever created them.")),
      qa("A colleague can't see a project.", p("Add them under Our team on the project's People tab. Somebody with the permission to run projects, who can see it, can do that.")),
      qa("Why can't I change anything on a project?", p("Changing a project needs the permission to run projects. Without it, being on a project lets you read it and download its documents.")),
      qa("Where is the Credentials tab?", p("It shows only to people with the permission to open stored credentials. Nobody has it by default; an admin grants it in Settings › Roles & Permissions or, for one person, in Settings › Users.")),
      qa("Why can't I delete a milestone or a billing stage?", p("A billing stage's revenue is waiting for that milestone, or revenue has already been scheduled on the stage, so it stays on the project.")),
      qa(
        "Who is told about projects?",
        p("In the app: you, when somebody adds you to a project; colleagues on a project, when its status changes; and the project manager, whenever somebody else opens a stored credential (that one can't be switched off). The rest can be switched off in Settings › Notification preferences."),
      ),
    ],
    related: ["companies", "sales_documents", "revenue_close", "vault"],
  },
};

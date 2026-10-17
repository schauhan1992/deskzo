import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Leads — written from src/app/(dashboard)/leads (the board, the table, a lead's page, the new-lead
 * form), src/components/leads, src/actions/lead.ts (who may see, add, move, edit and hand on a lead),
 * src/lib/pipeline and src/lib/leads (stages and their meanings, stage rules, connected pipelines,
 * scores, assignment), and the settings screens src/app/(dashboard)/settings/pipeline, lead-assignment
 * and lead-capture with src/components/settings/team-pipelines.tsx, pipeline-manager.tsx,
 * pipeline-automations.tsx, lead-assignment-manager.tsx and lead-capture-manager.tsx.
 */
export const guide: SeedGuide = {
  slug: "help/leads",
  title: "Leads",
  seo: {
    title: "Leads: your sales pipeline from new enquiry to won deal",
    description: "How to add leads in {siteName}, move them through your own stages and team pipelines, assign them automatically and capture website enquiries.",
    keywords: ["lead pipeline", "lead management", "lead assignment"],
  },
  guide: {
    module: "leads",
    heading: "Leads",
    summary: "The lead pipeline: every deal on a board from new to won, in your own stages and team pipelines — with stage rules, automatic assignment, lead scores and enquiries straight from your website.",
    purpose: [
      p("A lead is a real requirement from a company: what they want, roughly what it's worth and when it might close. Leads shows your pipeline as a board, one column per stage, or as a table — and each lead's page holds everything about the deal: its products, proposals, tasks, calls, meetings, visits and activity."),
      p("The stages are your own — Enquiry, Site visit, Quotation, Booked, whatever your team says. Each stage counts as one of a fixed set of meanings: New, Contacted, Qualifying, Qualified, Proposal sent, Negotiation, Won, Lost or Disqualified. The meaning is what the rest of the app acts on: a won lead in a sales pipeline counts towards targets and wins and makes its company a customer, and the forecast weighs open leads by how far along they are."),
      p("Different teams can have pipelines of their own — partner onboarding, vendor approval — and a pipeline can hand its won leads on to the next one. Each open lead also has a score out of 100, graded Hot, Warm or Cold, with every point explained on the lead."),
      note("Leads don't only come from people typing them in: your website can send enquiries through the Lead capture API, and forms and booking pages can open leads too. Who they go to is decided by your lead assignment rules."),
    ],
    access: [
      p("Anybody whose role can view leads can open the pipeline, add leads, move them through the stages, edit them and log activity. By default that's the Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles."),
      p("Which leads you see follows the accounts you can see: leads on the companies you manage and those of the people who report to you — or every company's, if you can see every account. An admin can set a different reach for leads."),
      p("On a lead's timeline you see the activity you and your team logged; somebody who can see everyone's calls, notes and meetings sees it all."),
      ul(
        "Choosing the salesperson for a new lead needs permission to assign leads (or to reassign accounts and leads). Without it, a new lead is yours if your role is Sales, and otherwise goes to the lead assignment rules.",
        "Passing a lead you own to a colleague needs permission to hand off your own accounts and leads. Changing the owner of anybody's lead, or leaving one with nobody, needs permission to reassign accounts and leads.",
        "Settings › Pipeline is for people who can manage the sales pipeline. Settings › Lead assignment and Settings › Lead capture API are for people who can change organisation settings — admins, unless it's given to another role.",
      ),
      p("Some of a lead's fields can be masked for your role. Where your role may unmask them, the lead's page says how many fields are masked, and opening the lead unmasks it for the rest of the day, within a daily limit."),
    ],
    permissions: [
      perm("leads.view", "Opens the lead pipeline — the Leads pages, a customer's Leads tab and the lead figures on the dashboard — and lets somebody add, move, edit and log activity on the leads they can see. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.leads", "Shows Leads in the menu under Sales and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("leads.assign", "Lets somebody pick the salesperson a new lead goes to. Without it, a new lead is theirs if they sell, and otherwise goes to the assignment rules. Management and Calling have it by default."),
      perm("accounts.reassign", "Lets somebody change the owner of any lead they can see — including leaving it with nobody — and choose a new lead's salesperson. Every change is written to the activity log. Management has it by default."),
      perm("accounts.handOffOwn", "Lets somebody pass a lead they own to a colleague, always to a person. Sales and Management have it by default."),
      perm("pipeline.manage", "Opens Settings › Pipeline: add and connect team pipelines, name the stages, set their order, colours and meanings, choose what a lead needs before it moves into a stage, and retire what's no longer used. Management has it by default."),
      perm("settings.manage", "Opens Settings › Lead assignment and Settings › Lead capture API, and lets somebody start a workflow for a pipeline's automations. No built-in role has it by default — admins hold it."),
      perm("companies.viewAll", "Widens which leads you see from the accounts you (and the people who report to you) manage to every account. Management, Accounts, Purchase, Support, Profiling and Calling have it by default — Sales does not."),
      perm("contacts.view", "Shows the lead's contact's email and phone, on its page and in the table. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("activities.viewAll", "Shows the activity everybody logged on a lead, not only yours and your team's. Management has it by default."),
      perm("products.edit", "Lets somebody change the quantity, renewal date or remarks of a product in a lead's Products required. Management and Sales have it by default."),
      perm("products.delete", "Lets somebody remove a product from a lead's Products required. Management has it by default."),
      perm("documents.issue", "Shows Create proposal on a lead, to raise a proposal from it. Sales, Accounts and Management have it by default."),
    ],
    setup: [
      p(runs("A new workspace starts with one pipeline, ", { b: "Sales" }, ", with a stage for each meaning — unless an industry template has set it up differently. Somebody who can manage the pipeline makes it yours once, in ", { b: "Settings › Pipeline" }, ":")),
      ul(
        "Rename, reorder and colour the stages, add your own and retire the ones you don't use.",
        "Choose what a lead must have before it moves into a stage — a value and a close date before Proposal sent, say.",
        "Add a pipeline for each team that works leads differently, and connect them if one team's won leads carry on to the next.",
      ),
      p(runs("An admin then sets who new leads go to in ", { b: "Settings › Lead assignment" }, " — otherwise a lead nobody assigns, including every website lead, arrives unassigned — and, for website enquiries, creates an API key in ", { b: "Settings › Lead capture API" }, ".")),
      p("Products required on a lead come from your catalogue, so they appear once Items & Inventory is on."),
    ],
    tasks: [
      task(
        "Add a lead",
        ol(
          runs("Open ", { b: "Sales › Leads" }, " and select ", { b: "New lead" }, "."),
          runs("If you have more than one pipeline, choose the ", { b: "Pipeline" }, ". The lead starts at its first stage."),
          runs("Choose the ", { b: "Company" }, " and, if there's one person behind it, the ", { b: "Contact" }, " — or ", { b: "+ New contact" }, "."),
          runs("Give it a ", { b: "Title" }, " and the ", { b: "Requirement details" }, "."),
          runs("Add the ", { b: "Estimated value (₹)" }, " and ", { b: "Expected close date" }, " if you know them, and the ", { b: "Source" }, " with any ", { b: "Source detail" }, "."),
          runs("Under ", { b: "Salesperson" }, ", pick who it's for — or leave it empty for the assignment rules to choose. (Without permission to assign, the form says where it will go.)"),
          runs("Add the ", { b: "Products required" }, " with ", { b: "+ Add product" }, ", and fill in ", { b: "More details" }, " if your workspace has its own lead fields."),
          runs("Select ", { b: "Create lead" }, "."),
        ),
        p("Whoever it's assigned to, if not you, is told. A company that was only a prospect moves on to the lead stage."),
      ),
      task(
        "Move a lead through the pipeline",
        ol(
          runs("On the board, drag the lead's card to the column of its new stage — or on the lead's page, choose the stage in the stage list beside ", { b: "Edit" }, "."),
          "Moving to a stage that counts as lost or disqualified asks for the reason first.",
          "If the stage asks for details the lead doesn't have yet, the move is stopped and you're told what to fill in. Fill it in and move it again.",
        ),
        p("Every move is noted on the lead's timeline. When a lead in a sales pipeline is won, its company becomes a customer, the win counts towards targets and wins, and — if the pipeline is connected to another — a new lead starts there with the same company, contact, owner and value."),
      ),
      task(
        "Work a lead from its page",
        ul(
          runs({ b: "Log activity" }, " — choose the kind (call, email, note or meeting), say what happened and log it. The lead's owner is told if it isn't you."),
          runs({ b: "Call" }, " — log a call to the contact; it also goes on the timeline."),
          runs({ b: "Schedule meeting" }, ", ", { b: "Plan visit" }, " or ", { b: "Create proposal" }, ", where those modules are on and you're allowed."),
          runs("Keep ", { b: "Products required" }, ", ", { b: "Tasks" }, " and the lead's own fields up to date."),
        ),
        p(runs("The ", { b: "Lead score" }, " card explains the score line by line — fit, intent, engagement and stage, less points for going quiet or a close date that has passed. Won and lost leads have no score.")),
      ),
      task(
        "Edit a lead's details",
        ol(
          runs("On the lead's page, select ", { b: "Edit" }, "."),
          runs("Change the ", { b: "Title" }, ", ", { b: "Value" }, ", ", { b: "Expected close date" }, ", ", { b: "Contact" }, " or ", { b: "Description" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p("A field masked for you can't be changed until the lead is unmasked; it keeps what it holds."),
      ),
      task(
        "Move a lead to another team's pipeline",
        ol(
          runs("On the lead's page, select ", { b: "Move to pipeline" }, ". It's offered for open leads where there's another pipeline in use."),
          runs("Choose the ", { b: "Pipeline" }, " and the ", { b: "Stage" }, " it should land in."),
          runs("Select ", { b: "Move to" }, " and the pipeline's name."),
        ),
        p("Its history stays with it and the move is noted on its timeline. A won or lost lead stays where it closed — reopen it first."),
      ),
      task(
        "Find leads",
        ul(
          runs("Choose ", { b: "Board" }, ", ", { b: "Table" }, " or ", { b: "Split" }, " (the table with the lead open beside it). With several pipelines, pick one from the row above the filters."),
          runs("Search the title or company, and filter by ", { b: "Stage" }, ", ", { b: "Owner" }, " (including ", { b: "Unassigned" }, "), ", { b: "Source" }, ", ", { b: "Score" }, " and ", { b: "Expected close" }, " — and by your own fields."),
          runs("Sort by ", { b: "Highest score" }, " to work the hottest leads first. In the table, choose which columns show."),
        ),
      ),
      task(
        "Reassign or move many leads at once",
        ol(
          runs("In the ", { b: "Table" }, " view, tick the leads."),
          runs("In the bar that appears, choose a new owner (or ", { b: "Unassign" }, ") and/or a stage. A lost or disqualified stage needs a ", { b: "Reason (required)" }, "."),
          runs("Select ", { b: "Apply" }, "."),
        ),
        p("A change of owner is all or nothing: if any of the leads isn't yours to hand on, no owner changes and you're told why. A change of stage is made lead by lead, each through the stage's own rule, and stops at the first lead that can't move."),
      ),
      task(
        "Export leads",
        p(runs("Select ", { b: "Export CSV" }, " on ", { b: "Sales › Leads" }, " for a spreadsheet of the leads you can see — title, company, contact, status, owner, value, close date, products and more — masked as the list is.")),
      ),
    ],
    settings: [
      setting(
        "Pipeline — team pipelines",
        "Settings › Pipeline",
        p("Add a pipeline with a Name, and choose whether it Counts as sales — won leads then count towards targets, wins and the forecast and make their company a customer. Leave it off for processes such as partner onboarding: their stages read Start, Under way, Done and Dropped. When a lead is won, carry it on into connects one pipeline to the next. Reorder pipelines, rename them, retire one once it has no open leads, or delete one that has never had a lead. The main pipeline can't be retired."),
      ),
      setting(
        "Pipeline — stages",
        "Settings › Pipeline",
        p("Each stage has a Name, what it Counts as, and a Colour; the board shows them as columns in their order. A stage with leads in it can't switch between open, won and lost. Retiring a stage first moves its leads to another stage of the same kind — open to open, won to won, lost to lost — with a note on each lead when the new stage counts as something else; a retired stage can be restored later. Each pipeline always keeps at least one stage for new, won and lost leads."),
      ),
      setting(
        "Pipeline — what a lead needs before it moves here",
        "Settings › Pipeline",
        p("Tick what a lead must have before it can move into a stage: Value, Expected close date, Contact, Owner, Description, or any of your own lead fields. Nothing ticked means a lead can move there as it is."),
      ),
      setting(
        "Pipeline — automations",
        "Settings › Pipeline",
        p("When a lead arrives in a pipeline or enters one of its stages, a workflow in Automate can make a task, email the contact, give the lead to someone, tell someone and more. An admin starts one with New workflow for this; it's then made and changed in Automate."),
      ),
      setting(
        "Lead assignment",
        "Settings › Lead assignment",
        p("Who a new lead goes to when nobody chooses — website leads, form and enquiry leads, and leads added with the salesperson left empty. Rules are tried top to bottom and the first that fits decides. Each rule can match any of a Brand, Product type, Contact's designation, Source or State (an Indian state), and Assign by Round robin, Fewest open leads, A named person or The account manager, between the people you choose. It can Skip anyone on approved leave that day. Test a lead shows who a lead would go to without assigning anything."),
      ),
      setting(
        "Lead capture API",
        "Settings › Lead capture API",
        p("API keys for your websites to send enquiries straight in as leads — scored, assigned by your rules and marked with where they came from. Create one per website or form with New key for and an optional Source label. The key ID and secret are shown once: copy them, and give the documentation on the same screen (Download (.md)) to your developer. The secret must stay on the website's server, never in a page's script. Revoke a key to stop it; leads already sent stay."),
      ),
    ],
    faq: [
      qa(
        "I don't see Leads in the menu.",
        p("The module may be switched off for your company, your role may have had the Leads section hidden, or your role may not be able to view leads. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
      qa(
        "Why won't a lead move into a stage?",
        p("That stage asks for details before a lead can move into it, and the lead is missing one. The message says what. Select Edit on the lead, fill it in, and move it again."),
      ),
      qa(
        "I can't pick the salesperson on a new lead.",
        p("Your role can't assign leads to other people. The form tells you where the lead will go: to you if your role is Sales, otherwise to whoever the lead assignment rules choose."),
      ),
      qa(
        "A lead I'm looking for isn't on the board.",
        p("It may be in another team's pipeline — choose that pipeline above the filters — or a filter is narrowing the board. If it's on an account you don't manage and you can't see every account, it isn't shown to you at all."),
      ),
      qa(
        "Website leads arrive unassigned.",
        p("No assignment rule fits them. An admin can add a rule with no conditions, placed last, so every lead that nothing else catches still goes to somebody — and use Test a lead to check."),
      ),
      qa(
        "Some fields on a lead say they're masked.",
        p("Your role's field access hides them. Where you're allowed to unmask, opening the lead unmasks it for the rest of the day, within a daily limit; otherwise ask an admin."),
      ),
      qa(
        "Can I delete a lead?",
        p("No. A lead that didn't work out is moved to a stage that counts as lost or disqualified, with the reason, so the pipeline's history stays whole."),
      ),
    ],
    related: ["companies", "sales_documents", "forecast", "automate"],
  },
};

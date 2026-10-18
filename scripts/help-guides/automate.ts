import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Automate — written from the working tree of src/app/(dashboard)/automate (Workflows, Templates, Runs,
 * a run's page, Connections), src/components/automate (the builder, its step forms and webhook panel, the
 * template gallery, the connections manager, the run and workflow buttons), src/actions/automate.ts (every
 * action needs settings.manage for now), src/lib/automate (triggers.ts, registry.ts and actions/*, the
 * engine's limits, templates.ts, test runs in store.ts) and src/components/settings/pipeline-automations.tsx.
 * Automate was still being built when this was written — connections, webhooks and outside calls were
 * uncommitted — so check it against the screens before publishing. Brought up to date on 18 Oct 2026
 * (Phases 6-8): the waiting and repeating steps, the plan's limits, owner-only changes and taking a
 * workflow over, who sees a run's data, retrying failed runs together, and restores.
 */
export const guide: SeedGuide = {
  slug: "help/automate",
  title: "Automate",
  seo: {
    title: "Automate: workflows that run on their own",
    description: "How to build, test and publish workflows that run on a schedule, when something happens, or when an outside app calls — and read every run.",
    keywords: ["workflow automation", "automated workflows", "webhooks"],
  },
  guide: {
    module: "automate",
    heading: "Automate",
    summary: "Workflows that run on their own — on a schedule, when something happens in your workspace, when an outside app calls, or when somebody presses Run — with every run and every step recorded.",
    purpose: [
      p("Automate does the routine follow-through for you. A workflow has one thing that starts it and a list of steps it then carries out, in order. A lead arrives, so it is assigned and thanked. An invoice falls overdue, so the customer is sent it again. Every morning, yesterday's wins are emailed to the managers."),
      p("Steps can create a task, notify a person, create, assign or move a lead, add a note to a lead, open or escalate a ticket, send an email, email a document or a report, schedule a meeting, call an outside app's web address, post to Slack or Microsoft Teams, send a WhatsApp template, or add a row to a Google Sheet. Between them a workflow can check a condition, branch into paths, wait, ask somebody to approve, wait for something to happen, repeat steps for each item in a list, or run paths at the same time."),
      p("Every workflow runs as the person who owns it, and can never do more than that person may do at that moment — it starts only on records they may see, and reads them as they see them. So only its owner changes, tests or publishes it. Each run is recorded with every step: when it ran, how long it took, what went in and what came out, and what went wrong."),
      note(runs("The automations a lead pipeline used to have are workflows here now. A pipeline's settings still list them and link to each one — see ", ["Leads", "/help/leads"], ".")),
    ],
    access: [
      p("For now, Automate is only for the people who can change the organisation's settings — the workspace's admins, unless an admin has given that permission to another role. Nobody else sees it in the menu."),
      p("What a workflow may do is decided by its owner, the person who made it, every time it runs:"),
      ul(
        "A step that needs a module your plan doesn't include, or one that is switched off, is greyed out in the builder with the reason, and refused if a run reaches it.",
        "A step the owner couldn't do themselves — they can't open that module, or don't hold the permission it needs — is refused the same way.",
        "If the owner's account is switched off, every step the workflow tries is refused.",
      ),
      p("A connection to an outside app belongs to the person who added it. Only they can change or remove it. If they share it with the workspace, anybody's workflows may use it."),
      p("A workflow belongs to its owner too. Anybody else who can open Automate may pause it, switch it on, run it or duplicate it, and sees it read-only in the builder. To change it, they take it over: it becomes theirs, switched off until they publish it, and its owner before is told."),
      p("A run's steps — their status, time and errors — are there for everybody who can open Automate. What each step took in and gave out is shown only to the workflow's owner and the super admin, because it is what the owner can see."),
    ],
    permissions: [
      perm(
        "settings.manage",
        "Opens Automate — Workflows, Templates, Runs and Connections — and lets somebody make workflows; change, test, publish and archive their own; pause, switch on, run, duplicate or take over anybody's; cancel and retry runs; and pause every workflow at once. Admins hold it by default. It also opens the organisation's settings, so give it to as few people as possible.",
      ),
      perm("documents.send", "Needed by a workflow's owner for an Email a document step to run. Sales, Accounts and Management have it by default, as do admins."),
      perm("meetings.schedule", "Needed by a workflow's owner for a Schedule a meeting step to run. Most built-in roles have it by default."),
      perm("tickets.create", "Needed by a workflow's owner for an Open a ticket step to run. Support, Sales and Management have it by default, as do admins."),
    ],
    setup: [
      p(runs("Nothing has to be set up before your first workflow. An admin opens ", { b: "Automate › Workflows" }, " and starts one from a template or from nothing.")),
      p(runs("Steps that talk to outside apps need a connection first, added in ", { b: "Automate › Connections" }, ": a Slack or Microsoft Teams channel to post to, or an outside API with its address and the headers it needs. Two ride on something else:")),
      ul(
        runs({ b: "Google Sheets" }, " uses your own Google mailbox connection, with Sheets allowed. Google has to be set up for mailboxes in ", { b: "Settings › Security & data protection" }, " first."),
        runs({ b: "WhatsApp" }, " uses the provider set up in ", { b: "Settings › Mail & messaging" }, ", once one is switched on for transactional messages."),
      ),
      p(runs("Steps that use another module — leads, tickets, documents, meetings, reports — need that module switched on in ", { b: "Settings › Modules" }, ".")),
    ],
    tasks: [
      task(
        "Start a workflow from a template",
        ol(
          runs("Open ", { b: "Automate › Templates" }, "."),
          runs("Pick a template and select ", { b: "Use this template" }, "."),
          "Fill in its few blanks — who to tell, how long to wait — if it has any.",
          runs("Select ", { b: "Open it in the builder" }, ". It opens as a draft: nothing runs until you publish it."),
        ),
        p("The templates are:"),
        ul(
          runs({ b: "Website enquiry: assign, acknowledge, remind" }, " — a website lead is assigned by your assignment rules, thanked, and its owner reminded if nobody has moved it on."),
          runs({ b: "New lead assignment" }, " — a new lead with no owner goes to whoever the assignment rules choose, and they are told."),
          runs({ b: "Follow up when a lead goes quiet" }, " — an open lead that hasn't moved stage for some days gets a follow-up task for its owner."),
          runs({ b: "Invoice payment reminders" }, " — the invoice is sent again before it falls due and on set days after. This one makes two workflows."),
          runs({ b: "Subscription renewal notices" }, " — the customer and the account manager are told 30, 15 and 7 days before a subscription ends."),
          runs({ b: "Escalate unanswered tickets" }, " — a ticket nobody has answered within some hours is raised to high priority and somebody is told."),
          runs({ b: "Booking confirmation and reminder" }, " — somebody who books a slot gets a confirmation at once and a reminder the day before."),
          runs({ b: "Daily sales report" }, " — yesterday's won deals by salesperson, emailed every morning to the people named."),
        ),
      ),
      task(
        "Build a workflow from nothing",
        ol(
          runs("In ", { b: "Automate › Workflows" }, ", select ", { b: "New workflow" }, ". It opens in the builder."),
          "Give it a name, and a line saying what it is for.",
          runs("Select the ", { b: "Starts when" }, " card and choose what starts it. Add rules under ", { b: "Only when" }, " to narrow it — for example, only leads from one source."),
          runs("Select ", { b: "Add a step here" }, " (the +) and choose a step. Under ", { b: "Flow" }, " are ", { b: "Only carry on if…" }, ", ", { b: "Branch into paths" }, ", ", { b: "Wait" }, " and ", { b: "End the run" }, "."),
          runs("Select a step's card to fill it in. Use ", { b: "Insert data" }, " to put in a value from what started the workflow or from an earlier step, such as the lead's title."),
        ),
        p(runs("The draft saves as you go — the top of the builder says ", { b: "Saved" }, ". Problems are marked on the cards that have them, and must be fixed before you can publish. Each card's menu moves it up or down, duplicates it or deletes it.")),
      ),
      task(
        "Test a draft",
        ol(
          runs("In the builder, select ", { b: "Test" }, "."),
          "The draft runs on the latest real record of its kind that you can see — the newest lead, for a workflow started by a lead.",
          "Read the result on each card, and in the line above them. The test also shows in Automate › Runs, marked test.",
        ),
        p("In a test, conditions and branches are worked out for real, waits are not waited for, and look-ups are done. Every other step only says what it would have done."),
        p(runs("Tick ", { b: "Do the safe steps for real" }, " to have the safe ones actually done on the test's record: creating a task, adding a note to a lead and notifying a person. Emails, documents, meetings and outside calls are never sent by a test.")),
      ),
      task(
        "Publish a workflow and switch it on",
        ol(
          runs("In the builder, select ", { b: "Publish" }, ". It stays greyed out while any problem is marked."),
          runs("Say what changed, if you like, under ", { b: "What changed (optional)" }, "."),
          runs("Select ", { b: "Publish" }, "."),
        ),
        p("The draft becomes the version that runs, from now on, and the workflow is switched on. Runs already under way finish on the version they started with. You can keep editing the draft afterwards: what runs doesn't change until you publish again."),
        p(runs("To go back to an earlier version, open ", { b: "More › Versions" }, " and select ", { b: "Back into the draft" }, " beside it, then publish.")),
      ),
      task(
        "Pause, switch on, run or archive a workflow",
        ul(
          runs("In ", { b: "Automate › Workflows" }, ", ", { b: "Pause" }, " stops a workflow starting new runs, and ", { b: "Switch on" }, " starts it again."),
          runs({ b: "Run now" }, " is there for a workflow that starts ", { b: "When somebody presses Run" }, "."),
          runs("In the builder, ", { b: "More" }, " has ", { b: "Pause it" }, ", ", { b: "Switch it on" }, ", ", { b: "Duplicate" }, " and ", { b: "Archive" }, ". Archiving stops a workflow for good; its runs stay in the history."),
          runs({ b: "Pause every workflow" }, " on the Workflows page stops everything in the workspace at once. Nothing starts or moves on until you select ", { b: "Let workflows run again" }, "."),
        ),
      ),
      task(
        "Check runs and deal with a failed one",
        ol(
          runs("Open ", { b: "Automate › Runs" }, ". Choose a ", { b: "State" }, " to see, for example, only the failed ones."),
          "Open a run to see each of its steps: when it started, how long it took, a summary of what went in and came out, and any error.",
          runs("For a failed run, fix the cause, then select ", { b: "Retry from the failed step" }, ". Or select ", { b: "Cancel run" }, "."),
        ),
        p(runs("A step that fails for a network reason is tried again on its own, a few times over several hours, before the run fails. A run marked ", { b: "Needs a decision" }, " stopped at a step whose outcome can't be known — choose ", { b: "Try the step again" }, " or ", { b: "Cancel run" }, ".")),
      ),
      task(
        "Take over a colleague's workflow",
        ol(
          "Open the workflow. The builder shows it read-only, with who it runs as.",
          runs("Select ", { b: "Take over" }, " and confirm. It is yours now, and switched off."),
          runs("Check its steps — it now runs as you, with your access and your connections — and select ", { b: "Publish" }, " to switch it on."),
        ),
        p(runs("To keep the original as it is, select ", { b: "More › Duplicate" }, " instead: the copy is yours to change.")),
      ),
      task(
        "Retry many failed runs at once",
        ol(
          "Fix what made them fail first — a connection, a module switched off, the owner's access.",
          runs("Open ", { b: "Automate › Runs" }, " and choose ", { b: "State: Failed" }, " (and a workflow, to narrow it)."),
          runs("Select ", { b: "Retry failed runs" }, ". Each goes back to the step that failed, the newest two hundred at a time."),
        ),
        p(runs("Runs marked ", { b: "Needs a decision" }, " are left out: each needs a person to decide whether its step went out.")),
      ),
      task(
        "Let an outside app start a workflow",
        ol(
          runs("In the builder, set ", { b: "Starts when" }, " to ", { b: "An outside app calls its webhook address" }, "."),
          runs("Select ", { b: "Make its address" }, " and ", { b: "Copy" }, " it."),
          "In the outside app — your website, a form tool, your own system — send JSON or a form to that address with POST.",
          runs("To accept only calls that prove where they came from, tick ", { b: "Take only calls signed with its secret" }, ", and give the app the secret from ", { b: "Show the secret" }, "."),
        ),
        p(runs("Keep the address private: anybody who has it can start the workflow. ", { b: "New address" }, " replaces it, and the old one stops working at once. Only the workflow's owner sees its address and secret. An address takes up to 60 calls a minute and 5,000 a day; a signed call is taken once, never again.")),
      ),
      task(
        "Connect Slack, Teams or an outside API",
        ol(
          runs("Open ", { b: "Automate › Connections" }, " and select ", { b: "Add a connection" }, "."),
          runs("Choose the ", { b: "Kind" }, ": Slack, Microsoft Teams or An outside API."),
          "Give it a name, and paste its address — for an API, also the headers it needs, such as its key. The screen says where to find each address.",
          runs("Tick ", { b: "Share with the workspace" }, " if other people's workflows may use it."),
          runs("Select ", { b: "Add" }, ". For Slack and Teams, ", { b: "Send a test" }, " posts a message so you can see it arrive."),
        ),
        p("Addresses and keys are kept encrypted and never shown again. To change one, give it anew."),
      ),
    ],
    settings: [
      setting(
        "Starts when",
        "In the builder, the first card",
        p("What starts the workflow. The choices are grouped: a schedule or somebody pressing Run; an outside app's call; a lead created, arriving in a pipeline, moving stage, won, lost or gone quiet; a ticket opened or changing status; a document issued, an invoice paid, falling due or overdue, a payment coming in; an order placed, approved or fulfilled, or a subscription coming up for renewal; a form sent or a slot booked; a task created or done. The ones marked daily are checked once a day."),
      ),
      setting("Every", "In the builder, on a schedule", p("How often a scheduled workflow runs — every hour, day, week or month — with the minutes past the hour or the time, the day of the week for a weekly one, the day of the month (1 to 28) for a monthly one, and, for an hourly or daily one, the days of the week it may run on. It runs by the workspace's clock.")),
      setting("Only when", "In the builder, on the Starts when card", p("Rules that narrow what starts it. Choose whether all of them or any one of them must hold. With no rules, it starts every time.")),
      setting("When a step fails", "In the builder, on the Starts when card", p("Stop the run there, or note the failure and carry on with the next step.")),
      setting("Wait", "In the builder, on a Wait step", p("For a while, until a time of day, or until a time in the data — such as some hours before a booking starts. A time already gone waits for nothing.")),
      setting(
        "Your plan's limits",
        "Automate › Workflows, the line at the top",
        p("How many workflows may be switched on at once, how many steps may run in a month (every action that ran, never a test, across the workspace, by the workspace's own calendar month), how long a finished run's history is kept, and which outside apps a workflow may reach. They come from your plans: the more people, the more steps. When four fifths of the month's steps are used, and again when none are left, the admins are told; with none left, no new run starts until the month turns, though runs already going finish. The Automate Plus add-on raises every limit and adds WhatsApp."),
      ),
      setting(
        "Signing secret",
        "Automate › Connections",
        p("Every call a workflow makes to an outside API is signed with this secret, so the app at the other end can check it came from your workspace. Show it only to give it to that app."),
      ),
      setting(
        "Pipeline automations",
        "Settings › Pipeline",
        p(runs("Each pipeline lists its automations, now workflows here, with a link to each. Choose ", { b: "When a lead arrives" }, " or when a lead enters a stage, and select ", { b: "New workflow for this" }, " to start a draft for that pipeline.")),
      ),
    ],
    faq: [
      qa("I don't see Automate in the menu.", p("Either the module is switched off for your company (Settings › Modules), or you don't hold the permission to change organisation settings, which Automate needs for now. Ask an admin.")),
      qa("Why is a step greyed out when I add it?", p("The workflow's owner can't use it right now: it needs a module your plan doesn't include or that is switched off, or a module or permission the owner doesn't have. The reason shows under the step's name.")),
      qa(
        "Who does a workflow run as?",
        p("Its owner — the person who made it, shown under Runs as on the Workflows page. Every step is checked against what that person may do at the moment it runs. If their account is switched off, the steps are refused."),
      ),
      qa(
        "My workflow paused itself.",
        p(runs("A workflow that fails twenty times in a row pauses itself, and its owner is notified. The reason shows on the Workflows page. Fix the cause, then select ", { b: "Switch on" }, ".")),
      ),
      qa("Does a test send emails or call outside apps?", p("No. A test does the look-ups and works out the conditions, and says what every other step would have done. With Do the safe steps for real ticked, it also creates the task, adds the lead note or sends the notification.")),
      qa("I changed a workflow, but runs still do the old thing.", p("Your changes are in the draft. Publish it to make it the version that runs. Runs that had already started finish on their own version.")),
      qa("Why can't I change or remove a connection?", p("Only the person who added a connection can change or remove it. If it's shared with the workspace you can still use it in your workflows.")),
      qa("Why can't I change a colleague's workflow?", p("A workflow runs as its owner — their mailbox, their connections, the records they may see — so only they change, test or publish it. Duplicate it to make your own, or take it over.")),
      qa("Why can't I see what a step took in or gave out?", p("That data is what the workflow's owner could see, so it is shown to the owner and the super admin only. You still see each step's status, time and error, and Copy for a support ticket puts them into a message.")),
      qa("It says this month's steps are used up.", p("Your plan's steps for the month have all run. No new run starts until the month turns — runs already going finish. Ask whoever manages your plan about more people or the Automate Plus add-on.")),
      qa("A step says it isn't on this workspace's plan.", p("Some outside apps come with some plans only: webhooks with every plan; saved APIs, Slack and Teams with any product; Google Sheets with the full suite or Automate Plus; WhatsApp with Automate Plus. A workflow already on when the plan changed pauses at that step, and its owner is told.")),
      qa("A run says a step went out before the workspace was restored.", p("Your workspace was put back from a backup, and the run came back with it. That step — an email, a call, a message — had already gone out after the backup, so it wasn't sent twice. Run it again if it should go again; otherwise cancel the run.")),
    ],
    related: ["leads", "helpdesk", "sales_documents", "notifications"],
  },
};

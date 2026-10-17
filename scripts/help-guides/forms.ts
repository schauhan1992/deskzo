import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Forms & Events — written from src/app/(dashboard)/marketing/forms (the list, the new-form picker, a
 * form's tabs, the builder), src/components/forms (builder, sharing, invitations, answers), src/actions/
 * forms.ts (who may see, change, invite to and read a form), src/lib/forms (kinds and their starters,
 * access, invitations) and src/actions/marketing-public.ts (what an answer makes and who is told).
 */
export const guide: SeedGuide = {
  slug: "help/forms-and-events",
  title: "Forms & Events",
  seo: {
    title: "Forms & Events: invitations, RSVPs, assessments and surveys",
    description: "How to build forms in {siteName} — event invitations with RSVPs and attendance, requirement assessments, enquiry and survey forms — and share them.",
    keywords: ["online forms", "event RSVP", "requirement assessment"],
  },
  guide: {
    module: "forms",
    heading: "Forms & Events",
    summary: "Forms built in the app: event invitations with RSVPs and an attendance register, requirement assessments, enquiry and survey forms. Share a public link, send personal invitations, or both — and decide per form who can see, change, invite to and read it.",
    purpose: [
      p("Forms & Events replaces the spreadsheet and the shared survey link. You build a form here, share it, and the answers come back to the customer's record — a new company and contact where there wasn't one, and a lead where the form makes one."),
      p("Five kinds of form each start with the questions they usually need, which you can change:"),
      ul(
        runs({ b: "Event or roundtable" }, " — a customer roundtable, a launch, a webinar. Invitations, RSVPs and who actually came, with a date, a venue and an optional seat limit."),
        runs({ b: "Requirement assessment" }, " — what a customer runs today and what they need next: the questions before a proposal."),
        runs({ b: "Enquiry" }, " — a public get-in-touch form. Every answer becomes a lead."),
        runs({ b: "Survey" }, " — ask customers something and count the answers."),
        runs({ b: "Something else" }, " — a blank form with just a name and an email."),
      ),
      p("Each form is shared deliberately: you see the forms you built and the ones somebody gave you, and each form decides who else can change it, invite to it and read what people answered."),
    ],
    access: [
      p("Everybody can open Forms & events and see the forms shared with them. Building a new form needs the permission to build forms; whoever builds a form owns it and can do everything with it."),
      p("On each form, its owner chooses who else has it — a person by name, or everybody with a role — and for each, any of three things on top of seeing it:"),
      ul(
        runs({ b: "Edit" }, " — change the questions and settings; open and close it."),
        runs({ b: "Invite" }, " — send invitations to their own customers, and record RSVPs."),
        runs({ b: "See answers" }, " — read every answer and the attendance register, and export them."),
      ),
      p("Somebody who can manage every form has full access to all of them, whoever built them. Only the owner and those people can change who has a form, or delete it."),
      note("A grant to see a form's answers is a deliberate decision to share them: it lets somebody read answers from customers whose accounts they otherwise can't see."),
    ],
    permissions: [
      perm("section.forms", "Shows Forms & events in the menu under Marketing and lets people open it. Every role has it until an admin unticks it for one."),
      perm("forms.create", "Lets somebody build forms — and so own the ones they build — and duplicate a form they can see. Management and Sales have it by default."),
      perm("forms.manageAll", "Lets somebody see, change, share and read the answers of every form, whoever built it. Management has it by default."),
    ],
    setup: [
      p("There's nothing to switch on beyond the module. Somebody who can build forms makes each one; nothing is shared until they share it."),
      p(runs("Answers that don't go to a named person are routed by your lead rules in ", { b: "Settings › Lead assignment" }, ", so it helps to have those set up if your forms make leads.")),
    ],
    tasks: [
      task(
        "Build a form",
        ol(
          runs("Open ", { b: "Marketing › Forms & events" }, " and select ", { b: "New form" }, "."),
          runs("Under ", { b: "What are you making?" }, ", pick a kind. Its starter questions are filled in."),
          runs("Under ", { b: "What it is" }, ", give it a ", { b: "Name" }, " (for the list here) and check the ", { b: "Web address" }, "."),
          runs("Under ", { b: "The page" }, ", write the ", { b: "Headline" }, ", ", { b: "Introduction" }, " and what people see ", { b: "After they send it" }, "."),
          runs("For an event, fill in ", { b: "The event" }, ": ", { b: "Starts" }, ", ", { b: "Finishes (optional)" }, ", ", { b: "Where" }, " and ", { b: "Seats (optional)" }, "."),
          runs("Choose ", { b: "Who can fill it in" }, " and ", { b: "What happens to the answers" }, " (see Settings below)."),
          runs("Change the ", { b: "Questions" }, ": edit any, use ", { b: "Add" }, " for more, move them up and down, or remove them. Name and email are always asked."),
          runs("Use ", { b: "Preview" }, " to see the form as people will, then select ", { b: "Create form" }, "."),
        ),
      ),
      task(
        "Share the public link",
        ol(
          "Open the form. Its public address is shown under its name — /forms/ followed by the web address.",
          runs("Select ", { b: "Copy link" }, " and put it on your website, in a post or a WhatsApp group. ", { b: "Open" }, " shows it as a visitor sees it."),
        ),
        p("The public link works while the form is open and lets anyone with the link answer — unless the form is set to Invited people only."),
      ),
      task(
        "Invite customers",
        ol(
          runs("Open the form and select the ", { b: "Invitations" }, " tab, then ", { b: "Invite people" }, "."),
          runs("Under ", { b: "Find people" }, ", search by name, address or company and select each person. Only contacts with an email address on accounts you can see are offered."),
          runs("Check the ", { b: "Subject" }, " and ", { b: "Message" }, ". Keep {{formLink}} in — it becomes each person's own link."),
          runs("Select ", { b: "Check" }, ". Anybody who can't be sent to is listed with the reason — they asked not to be sent marketing, opted out of the form's topic, or were sent one a few minutes ago."),
          runs("Select ", { b: "Send to" }, " the people who can receive it."),
        ),
        p(runs("Invitations are sent from you, one person at a time, and logged in the Mail log. To chase people, use ", { b: "Remind … who haven't answered" }, ". Each invitation can also be copied with ", { b: "Copy link" }, " to send another way, or stopped with ", { b: "Withdraw" }, ".")),
      ),
      task(
        "Run an event's RSVPs and attendance",
        ol(
          runs("Watch the ", { b: "Overview" }, ": Invited, Replied, Coming, Can't make it, Came and No-show."),
          runs("When somebody answers you in person or on the phone, record it on the ", { b: "Invitations" }, " tab with ", { b: "Coming" }, " or ", { b: "Can't come" }, ". Their own answer later updates it rather than counting them twice."),
          runs("On the day, open the ", { b: "Answers" }, " tab and mark each person under ", { b: "On the day" }, " as ", { b: "Came" }, " or ", { b: "No-show" }, "."),
        ),
        p("Once the seats are taken, new \"I'll be there\" answers are refused; \"Can't make it\" never is. An event stops taking RSVPs once it starts."),
      ),
      task(
        "Read and export the answers",
        ol(
          runs("Open the form and select the ", { b: "Answers" }, " tab."),
          "Search by name, email or company — for an event, filter by RSVP or by On the day too.",
          "Expand a row to see every answer, and whether it came from an invitation or the public link.",
          runs("Select ", { b: "Export all to CSV" }, " for a spreadsheet of every answer."),
        ),
        p(runs("Answers also show on the customer's page, in its ", { b: "Forms" }, " tab, for forms you can read — with anybody invited who hasn't answered yet.")),
      ),
      task(
        "Share a form with colleagues",
        ol(
          runs("Open the form and select the ", { b: "Sharing" }, " tab."),
          runs("Add a person, or ", { b: "Add everybody with a role" }, "."),
          runs("Tick what each may do beyond seeing it — ", { b: "Edit" }, ", ", { b: "Invite" }, ", ", { b: "See answers" }, " — and select ", { b: "Save sharing" }, "."),
        ),
      ),
      task(
        "Close, reopen, duplicate or delete a form",
        ul(
          runs({ b: "Close" }, " stops it taking answers; ", { b: "Reopen" }, " starts again."),
          runs({ b: "Duplicate" }, " copies it as a new form of your own, closed until you reopen it — change it first, then open it."),
          runs({ b: "Delete" }, " is only offered to the owner while nobody has answered and no invitation has gone out. After that, close it instead."),
        ),
      ),
    ],
    settings: [
      setting(
        "Who can fill it in",
        "In each form",
        ul(
          "Anyone with the link — share it anywhere.",
          "Invited people only — only the personal links you send work; the public address says the form isn't available.",
          "Both — personal invitations to the people you choose, and a link for everyone else.",
        ),
      ),
      setting("Stop taking answers at (optional)", "In each form", p("A date and time after which the form closes by itself, in your workspace's time zone. Without one, a form stays open until somebody closes it — and an event stops taking RSVPs when it starts.")),
      setting("Open — taking answers", "In each form", p("Whether the form takes answers at all. The same as Close and Reopen on the form's page.")),
      setting(
        "Tell and route to",
        "In each form",
        p("Who hears about new answers and owns the leads they make. An invited customer's answer always goes to whoever invited them. Everything else goes to this person — or, left empty, where the lead assignment rules send it."),
      ),
      setting("Topic", "In each form", p("What the form is about, for the customer's preferences. Somebody who opted out of this topic in the preference centre isn't sent an invitation to it.")),
      setting(
        "Make a lead from each new answer",
        "In each form",
        p("Makes a lead from each new answer, with the answers in its description — never from somebody declining an event. On by default for an assessment and an enquiry. Shown only where your workspace has leads; without leads, an answer still makes or finds the company and contact."),
      ),
      setting(
        "Save the answer to",
        "On each question",
        p("Saves a question's answer into a field of the lead the answer makes, or of the company or contact — the company and contact only when this answer creates them; a customer already on file is never changed from a form. Each field can take one question."),
      ),
      setting("Web address", "In each form", p("The end of the public link, /forms/ and this. Changing it after people have the link breaks the public link; personal invitations keep working.")),
    ],
    faq: [
      qa(
        "I don't see Forms & events in the menu.",
        p("Either the module is switched off for your company or your role has had the Forms & Events section hidden. Ask an admin: the switch is in Settings › Modules, and the section is in Settings › Roles & Permissions."),
      ),
      qa(
        "Why is there no New form button?",
        p("Your role doesn't have the permission to build forms. You still see the forms shared with you."),
      ),
      qa(
        "A colleague can see the form but not its answers.",
        p("Seeing a form and reading its answers are separate. Its owner, or somebody who manages every form, can tick See answers for them on the Sharing tab."),
      ),
      qa(
        "Why can't I delete this form?",
        p("Only the owner can delete a form, and only while nobody has answered it and no invitation has gone out. After that, close it — the answers are kept."),
      ),
      qa(
        "Somebody wasn't sent the invitation.",
        p("The check before sending lists each person who can't be sent to, with the reason — for example they asked us to stop sending marketing, they opted out of the form's topic, the address was suppressed, or they were sent one a few minutes ago. Nothing goes to them."),
      ),
      qa(
        "Someone answered twice from the public link.",
        p("An address already registered for an event on the public link is left as it was, so nobody can cancel or double-book somebody else's place by typing their email. Answering again from a personal invitation updates that person's one answer."),
      ),
    ],
    related: ["marketing", "leads", "companies"],
  },
};

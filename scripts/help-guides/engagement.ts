import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Speak Up & Forms — written from src/app/(dashboard)/speak-up, src/app/(dashboard)/surveys (the
 * list, a form, Manage forms) and src/app/(dashboard)/people/feedback, src/components/engagement,
 * src/actions/internal-feedback.ts (what is and isn't recorded, the daily limit, who is told),
 * src/actions/survey.ts and src/lib/engagement/anonymity.ts (the five-answer threshold, the splash).
 */
export const guide: SeedGuide = {
  slug: "help/speak-up-and-forms",
  title: "Speak Up & Forms",
  seo: {
    title: "Speak Up & Forms: anonymous feedback, forms and polls",
    description: "How to send anonymous feedback, read it as HR, and run forms, polls and votes for one person, some departments or everyone in {siteName}.",
    keywords: ["anonymous feedback", "employee surveys", "internal polls"],
  },
  guide: {
    module: "engagement",
    heading: "Speak Up & Forms",
    summary: "An anonymous feedback channel that records nothing about who sent what, plus forms, polls and votes HR can send to chosen people, departments or everyone. Results stay hidden until five people have answered.",
    purpose: [
      p(runs({ b: "Speak up" }, " lets anyone send praise, a concern, a suggestion, a grievance or something else — about the company or about a named colleague — without their name on it. It goes to the people allowed to read anonymous feedback: HR, the directors and admins.")),
      p(runs({ b: "Forms & polls" }, " is where HR asks the company something: a form, a poll or a vote, sent to everyone, to some departments or to chosen people. Each form is either anonymous or attributed, and people are told which before they answer. A form that must be filled in covers the screen the next time people sign in.")),
      note("Nothing can protect the words themselves. If feedback describes something only the writer and one other person saw, that person will know who wrote it."),
    ],
    access: [
      ul(
        runs({ b: "Everyone" }, " can send feedback through Speak up and answer the forms aimed at them in Forms & polls."),
        runs({ b: "Whoever reads anonymous feedback" }, " sees everything sent through Speak up, and is notified when something new arrives."),
        runs({ b: "Whoever creates forms" }, " builds, publishes and closes forms, polls and votes, and reads their results."),
      ),
      p("The person a piece of feedback is about never sees it directly — HR decides what to raise and how. A form's results stay hidden until five people have answered, whatever permissions you hold, and a form that isn't aimed at you shows as a page that doesn't exist."),
    ],
    permissions: [
      perm("section.engagement", "Shows Speak Up & Forms in the menu — Speak up and Forms & polls — and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "engagement.readFeedback",
        "Shows Anonymous feedback in the menu: read everything sent through Speak up, mark items reviewed with a note, and be notified when something arrives. It gives no way to find out who wrote anything. Management has it by default; the built-in HR head role starts with it. It is never passed on to somebody's manager.",
      ),
      perm(
        "engagement.manage",
        "Shows Manage forms on Forms & polls: build and publish forms, polls and votes, choose who they go to, open, close and delete them, and read their results. Management has it by default; the built-in HR and HR head roles start with it.",
      ),
    ],
    setup: [
      p("There is nothing to set up: Speak up and Forms & polls are there for everybody as soon as the module is on."),
      p(runs("Decide who reads the anonymous feedback. An admin ticks ", { b: "Read anonymous feedback" }, " for those roles in ", { b: "Settings › Roles & Permissions" }, ", and ", { b: "Create forms, polls and votes" }, " for whoever runs forms.")),
      p(runs("To send a form to departments, people need a department — an admin sets it in ", { b: "Settings › Users" }, ".")),
    ],
    tasks: [
      task(
        "Send anonymous feedback",
        ol(
          runs("Open ", { b: "People › Speak up" }, "."),
          runs("Choose ", { b: "What kind of thing" }, ": ", { b: "Praise" }, ", ", { b: "Concern" }, ", ", { b: "Suggestion" }, ", ", { b: "Grievance" }, " or ", { b: "Something else" }, "."),
          runs("Under ", { b: "About someone (optional)" }, ", pick a colleague, or leave it as ", { b: "About the company generally" }, ". Add a ", { b: "Rating (optional)" }, " if you like."),
          runs("Write ", { b: "What you want to say" }, " — at least ten characters — and select ", { b: "Send anonymously" }, "."),
        ),
        p(runs("The panel beside the form, ", { b: "How this stays anonymous" }, ", explains what is kept: no name, only the date and not the time, and nothing in the audit trail. You can send up to ten a day.")),
      ),
      task(
        "Read and review feedback",
        ol(
          runs("Open ", { b: "People › Anonymous feedback" }, "."),
          "Read each item. Nothing on it can be traced to a sender, so any follow-up has to come from what it says.",
          runs("Note ", { b: "What was done about it (optional)" }, " and select ", { b: "Mark reviewed" }, "."),
        ),
      ),
      task(
        "Create a form, poll or vote",
        ol(
          runs("Open ", { b: "People › Forms & polls" }, ", select ", { b: "Manage forms" }, " and then ", { b: "New form" }, "."),
          runs("Choose the ", { b: "Kind" }, " — ", { b: "Form" }, ", ", { b: "Poll" }, " or ", { b: "Vote" }, " — and, if it should close, the ", { b: "Closes on" }, " date. Write a ", { b: "Title" }, " and an ", { b: "Introduction" }, "."),
          runs("Under ", { b: "Answers are" }, ", choose ", { b: "Anonymous" }, " or ", { b: "Attributed" }, "."),
          runs("Under ", { b: "Who it goes to" }, ", choose ", { b: "Everyone" }, ", ", { b: "Selected departments" }, " or ", { b: "Selected people" }, ", and tick them."),
          runs("Tick ", { b: "Must be filled in" }, " if everyone it goes to has to answer."),
          runs("Write each question, pick its type and whether it is ", { b: "Required" }, ". For a choice question, type the options separated by commas. ", { b: "Add a question" }, " adds another."),
          runs("Under ", { b: "Publish as" }, ", choose ", { b: "Open — notify them now" }, " and select ", { b: "Publish and notify" }, ", or keep ", { b: "Draft — nobody sees it" }, " and select ", { b: "Save as draft" }, "."),
        ),
        p("Question types are Rating out of 5, Scale of 1 to 10, Choose one, Choose any, Yes or no, and Written answer."),
      ),
      task(
        "Answer a form",
        ol(
          runs("Open ", { b: "People › Forms & polls" }, ". Forms you still have to answer come first; ", { b: "Must fill" }, " marks the ones you have to answer."),
          "Open the form. It says at the top whether it is anonymous or attributed.",
          runs("Answer the questions and select ", { b: "Submit" }, "."),
        ),
        p(runs("A form that must be filled in opens over your screen when you sign in. ", { b: "Fill it in" }, " answers it there; ", { b: "Not now" }, " puts it away until you next sign in.")),
      ),
      task(
        "Read results, and close or delete a form",
        ol(
          runs("Open ", { b: "People › Forms & polls" }, " › ", { b: "Manage forms" }, "."),
          runs("Select ", { b: "Results" }, " on a form to see how many of those it went to have answered, who is still to answer, and the answers to each question added up."),
          runs("Change the status beside a form to ", { b: "Open" }, " or ", { b: "Closed" }, ", or back to ", { b: "Draft" }, "."),
          "Delete a form only while nobody has answered it. Once people have, close it instead — deleting would destroy their answers.",
        ),
        p("Results stay hidden until five people have answered. Written answers are listed without names."),
      ),
    ],
    settings: [
      setting(
        "Answers are",
        "Manage forms › New form",
        p("Anonymous: you'll know who has answered, never what they said — the answers are stored with no link to anybody. Attributed: each person's answers are recorded against their name, and the form tells them so before they answer. This can't be changed once anybody has answered."),
      ),
      setting(
        "Who it goes to",
        "Manage forms › New form",
        p("Everyone, Selected departments or Selected people. Only the people it goes to see the form at all."),
      ),
      setting(
        "Must be filled in",
        "Manage forms › New form",
        p("Covers the screen of everyone it goes to the next time they sign in, until they answer. They can put it away once each time they sign in."),
      ),
      setting(
        "Closes on",
        "Manage forms › New form",
        p("The last day answers are taken, to the end of that day on your workspace's clock. Leave it empty to keep the form open until you close it."),
      ),
      setting(
        "Status",
        "Manage forms, beside each form",
        p("Draft — nobody sees it. Open — people it goes to can answer. Closed — no more answers, and the results stay readable."),
      ),
    ],
    faq: [
      qa(
        "I can't see Speak up or Forms & polls in the menu.",
        p("Either the module is switched off for your company in Settings › Modules, or your role has had the section hidden in Settings › Roles & Permissions. Anonymous feedback also needs the permission to read it, and Manage forms the permission to create forms. Ask an admin."),
      ),
      qa(
        "Can HR or an admin find out who sent a piece of feedback?",
        p("No. No name is stored with it, only the date it was sent and not the time, and nothing is written to the audit trail. The count behind the daily limit is kept separately and never joined to what anyone wrote. Only the words themselves can give a sender away."),
      ),
      qa(
        "Why can't I see a form's results?",
        p("Fewer than five people have answered it. Results stay hidden until five have, whoever you are, and the results say how many more are needed."),
      ),
      qa(
        "Why does a form cover my screen when I sign in?",
        p("It's one you must fill in. Answer it, or select Not now — it comes back the next time you sign in until you've answered."),
      ),
      qa(
        "Can I switch a form between anonymous and attributed?",
        p("Only until somebody has answered it. After that, close it and start a new one — people answered on the understanding they were given."),
      ),
      qa(
        "I opened a draft form, but nobody was told.",
        p("People are notified when a form is published as open from New form. Changing a draft's status to Open later doesn't send a notification, so tell them yourself."),
      ),
      qa(
        "Is there a limit on how much feedback I can send?",
        p("Ten items a day. The limit resets the next day."),
      ),
    ],
    related: ["hr", "notifications"],
  },
};

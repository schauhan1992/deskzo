import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Workspace — written from src/app/(dashboard)/workspace (the lists, the editor, a list's page and the
 * calling queue), src/app/(dashboard)/verifications (Contact Checks), src/components/workspace (the
 * filter builder, assigning, the calling activity and the calling station), src/components/verifications,
 * src/actions/workspace.ts, src/actions/calling-activity.ts, src/actions/verification.ts and
 * src/lib/workspace (the filters and how a calling activity is shared out).
 */
export const guide: SeedGuide = {
  slug: "help/workspace",
  title: "Workspace",
  seo: {
    title: "Workspace: saved lists, calling activities and contact checks",
    description: "How to build saved lists of companies from filters, share and assign them, turn one into a calling activity for your callers, and review the contact details they report.",
    keywords: ["saved lists", "calling activity", "contact checks"],
  },
  guide: {
    module: "workspace",
    heading: "Workspace",
    summary:
      "Saved lists of companies built from filters — a territory, a renewal window, every account nobody has called in 90 days — that stay current as your data changes, can be handed to a team, and can become a calling activity.",
    purpose: [
      p(
        "A list in Workspace is a set of filters with a name. Open it and it runs again, so it always shows the companies that match today: a customer who renews next month joins a renewal list by itself, and one who has just been called drops off a not-called-in-90-days list.",
      ),
      p(
        "You can filter on who a company is (relationship, stage, industry, state, city, category, tags, size), who owns it, what it has bought (orders, products, brands, and the flip side — companies that have never bought something), its renewals, its leads, when it was last called, and what its domain says.",
      ),
      p(
        runs(
          "A list can also be turned into a ",
          { b: "calling activity" },
          ": the companies matching at that moment are frozen into a fixed set and shared out between callers, each of whom gets their own queue and a task. What callers find on the phone — a wrong number, a corrected email — lands in ",
          { b: "Prospecting › Contact Checks" },
          " for somebody to review.",
        ),
      ),
    ],
    access: [
      p("Everybody with Workspace in their menu can build lists, and open the lists others have shared. What a list shows follows your own access: it only ever lists companies you could see anyway, so the same list can show different people different companies."),
      ul(
        runs("A list is shared with everyone unless its builder unticks ", { b: "Everyone can see this list" }, ". A private list is seen only by the person who built it."),
        "Only the person who built a list can change its filters, assign it, delete it or start a calling activity on it — unless you hold Act on anyone's saved list. Anybody who can open a list can duplicate it and change their own copy.",
        "Starting a calling activity, and working a calling queue, needs the Calls module.",
        "Contact Checks needs View contacts, and shows only the checks on accounts whose contacts you can see.",
      ),
    ],
    permissions: [
      perm("section.workspace", "Shows Prospecting › Workspace in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("contacts.view", "Opens Prospecting › Contact Checks — the corrections callers reported and the email health of the address book — and lets you apply or reject them. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("workspace.manageAny", "Edit, delete, assign and open a private list somebody else built, and start a calling activity on it — for a list whose owner has left or is away. No role has it by default; admins do."),
      perm("companies.viewAll", "Lets a list match every account rather than only the ones you (or your team) manage. Held by default by Management, Accounts, Purchase, Support, Profiling and Calling — not by Sales."),
      perm("calls.view", "The Calls module, which a calling activity belongs to: without it you can't start one or work a calling queue. Management, Sales, Calling, Profiling, Support, Accounts and Purchase have it by default."),
      perm("data.exportCrm", "Download saved lists as a file from Settings › Import & export. No role has it by default; admins do."),
    ],
    setup: [
      p("There is nothing to set up. Lists are built by whoever needs them."),
      p(
        runs(
          "The filters read your existing data, so they offer only values that will match something: a city appears once a company has a location there. The domain filters need companies looked up in Domain Intel first — see ",
          ["Domain Intel", "/help/domain-intel"],
          ".",
        ),
      ),
    ],
    tasks: [
      task(
        "Build a list",
        ol(
          runs("Open ", { b: "Prospecting › Workspace" }, " and select ", { b: "New list" }, "."),
          runs("Choose filters in the groups below — ", { b: "Who they are" }, ", ", { b: "Who owns them" }, ", ", { b: "What they've bought" }, ", ", { b: "Products & brands" }, ", ", { b: "Renewals" }, ", ", { b: "Pipeline" }, ", ", { b: "Engagement" }, " and ", { b: "What their domain says" }, ". The count at the top shows how many companies match as you go."),
          runs("Give it a ", { b: "List name" }, " and, if it helps, say ", { b: "What it's for" }, "."),
          runs("Leave ", { b: "Everyone can see this list" }, " ticked to share it, or untick it to keep it to yourself."),
          runs("Select ", { b: "Save list" }, ". Nothing is saved until you do."),
        ),
        note(runs("Under ", { b: "Products & brands" }, ", ", { b: "Flip this: companies who have NEVER bought the above" }, " turns a who-has list into a cross-sell list.")),
      ),
      task(
        "Work a list",
        ol(
          runs("Open ", { b: "Prospecting › Workspace" }, ". Lists assigned to you are at the top, under ", { b: "Assigned to you" }, "; lists you opened most recently come first."),
          "Open a list. Its filters are shown as badges under the name.",
          runs("Use ", { b: "Search within this list…" }, " to find a company, or switch to ", { b: "Split" }, " to open each company beside the list."),
        ),
      ),
      task(
        "Assign a list to people",
        ol(
          runs("On the list, select ", { b: "Assign" }, " (or ", { b: "Change" }, ")."),
          "Pick the people who should work it.",
          runs("Say ", { b: "What should they do with it?" }, " if you like, and select ", { b: "Assign" }, "."),
        ),
        p("Each new person is notified, and the list shows under Assigned to you for them."),
      ),
      task(
        "Change, copy or delete a list",
        ul(
          runs({ b: "Edit filters" }, " opens the list in the editor; select ", { b: "Save changes" }, " when done."),
          runs({ b: "Duplicate" }, " makes your own copy — the way to change somebody else's list without touching theirs."),
          runs({ b: "Delete" }, " in the editor removes the saved list. The companies in it aren't affected."),
        ),
      ),
      task(
        "Turn a list into a calling activity",
        ol(
          runs("On the list, select ", { b: "Start calling activity" }, "."),
          runs("Under ", { b: "Who is calling?" }, ", pick the callers."),
          runs("Choose ", { b: "How should it be split?" }, ": ", { b: "Round robin" }, " (one each in turn), ", { b: "Equal blocks" }, " (each caller works one stretch end to end) or ", { b: "To the account owner" }, " (each company goes to whoever owns it; anything unowned is shared round robin)."),
          runs("Set ", { b: "Finish by" }, " for the due date on each caller's task, and write a ", { b: "Brief" }, "."),
          runs("Select ", { b: "Start with" }, " and the number of callers."),
        ),
        note("Starting freezes the companies that match right now. The list stops changing as the data does, so nobody's share reshuffles while they work it.", "warning"),
        p(runs("The list then shows progress instead of companies: how many are worked and left, time on records, and a row per caller with what they've done and whether their task is ", { b: "Finished" }, ", ", { b: "Overdue" }, " or ", { b: "In progress" }, ".")),
      ),
      task(
        "Work your calling queue",
        ol(
          runs("Open the activity and select ", { b: "Open my queue" }, ". You see only the companies given to you."),
          runs("Call the contact. Beside each number and email, select ", { b: "Right" }, " or ", { b: "Wrong" }, ". For a wrong one, type the correct value and select ", { b: "Save correction" }, ", or select ", { b: "Just wrong" }, " if you don't have one."),
          runs("Note ", { b: "How did it go?" }, " and select ", { b: "Done — next" }, ", or ", { b: "Skip" }, "."),
        ),
        p("Marking a detail wrong doesn't change the contact — it goes to Contact Checks for review. Finishing your last company closes your task."),
      ),
      task(
        "Review contact checks",
        ol(
          runs("Open ", { b: "Prospecting › Contact Checks" }, "."),
          runs("Under ", { b: "Reported on calls" }, " or ", { b: "With a correction" }, ", compare the old value with the new one."),
          runs("Select ", { b: "Apply" }, " to put the correction on the contact, ", { b: "Reject" }, " to turn it down, or ", { b: "Acknowledge" }, " for a detail reported wrong with nothing to replace it."),
          runs("Under ", { b: "Email health" }, ", work through the addresses that won't deliver or only reach a shared inbox. ", { b: "Re-check this page" }, " checks them again."),
        ),
        p("An email correction you apply counts as confirmed by a person, so it shows as verified straight away."),
      ),
    ],
    settings: [
      setting(
        "Everyone can see this list",
        "In each list's editor",
        p("Ticked, everybody with Workspace sees the list and can open and duplicate it; only you can change it. Unticked, it is yours alone."),
      ),
      setting(
        "How should it be split?",
        "Start calling activity",
        p("How a calling activity's companies are shared between the callers: Round robin, Equal blocks, or To the account owner. Shown on the activity afterwards."),
      ),
      setting("Import & export", "Settings › Import & export", p("Saved lists to and from a spreadsheet, for people who may export or import customer data.")),
    ],
    faq: [
      qa(
        "A colleague's list shows them more companies than it shows me.",
        p("A list only ever shows the companies the person opening it can see. Without See every account you see the accounts you and your team manage, so the same filters match fewer for you."),
      ),
      qa("Why can't I edit a list someone else built?", p("A shared list stays the builder's to change, so it isn't redefined under them. Select Duplicate and change your own copy, or ask someone who holds Act on anyone's saved list.")),
      qa(
        "I don't see Start calling activity.",
        p("Only the person who built a list (or someone who can act on anyone's list) can start one, and only with the Calls module in your plan. A list that is already a calling activity shows Open my queue instead."),
      ),
      qa("I opened my queue and it's empty.", p("Nothing on that activity was given to you. The person who started it chose the callers and how it was split.")),
      qa("Does marking a number wrong change the contact?", p("No. It files what you found in Contact Checks, and nothing changes until somebody applies the correction there.")),
      qa(
        "I can't see Workspace or Contact Checks in the menu.",
        p(
          "The Workspace module may be switched off for your company in Settings › Modules, or the Prospecting › Workspace section may be hidden from your role in Settings › Roles & Permissions. Contact Checks also needs View contacts.",
        ),
      ),
    ],
    related: ["calls", "companies", "domains", "renewals"],
  },
};

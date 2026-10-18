import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Calls — written from src/app/(dashboard)/calls, src/components/calls (the phone icon's dialog and the
 * call history), src/actions/call.ts (logging, callbacks, who sees which calls), src/lib/calls.ts (the
 * outcomes and what counts as connected), src/lib/tasks/server.ts (a callback's task) and
 * src/lib/notify.ts (the "Callback due" reminder); the phone app's calling from mobile/, src/lib/app and
 * src/app/(dashboard)/settings/phone; the team report from src/lib/call-report.ts and src/actions/call-report.ts.
 */
export const guide: SeedGuide = {
  slug: "help/calls",
  title: "Calls",
  seo: {
    title: "Calls: log every call and keep the callbacks you promise",
    description: "How to log a call in {siteName} from a company, lead, ticket or renewal, time it, record how it went and keep track of the callbacks you owe.",
    keywords: ["call logging", "callbacks", "connect rate"],
  },
  guide: {
    module: "calls",
    heading: "Calls",
    summary: "Log each call from the phone icon on a company, lead, ticket, order or renewal — timed, with how it went — and keep a list of the callbacks you promised until they're made.",
    purpose: [
      p("Calls is the call log for your calling and sales teams. You place the call on your phone as usual; the app times it and records who you rang, the number, how it went and what was said — so the account's history shows every conversation, not just the ones somebody remembered to write up."),
      p(runs("The ", { b: "Calls" }, " screen shows the day at a glance: ", { b: "Calls today" }, ", how many ", { b: "Connected" }, " (with the share of dials that reached a person), total ", { b: "Talk time" }, ", and ", { b: "Callbacks due" }, " — callbacks promised whose time has passed. Below that is every call logged, newest first.")),
      p("A callback you promise becomes a task for you, and you're reminded when it falls due. A call logged against a lead also goes on that lead's activity timeline."),
      p(runs("With the ", { b: "{siteName} app" }, " on an Android phone, calls log themselves: after each call with a customer the phone sends it to Calls, shows who a customer is while they ring, and asks how the call went. ", { b: "Team report" }, " shows each person's calling — how much reached somebody, when their day's calling starts and stops, and how fast new leads are called.")),
      note(runs("A call counts as connected when its outcome is ", { b: "Connected" }, ", ", { b: "Callback requested" }, " or ", { b: "Not interested" }, " — somebody actually spoke to a person. No answer, Busy, Switched off, Wrong number and Left voicemail are dials that didn't connect.")),
    ],
    access: [
      p("Anybody whose role can view calls can open the Calls screen and log calls. By default that is the Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles."),
      p("Which calls you see follows two rules, both at once:"),
      ul(
        "The account: you only see calls on companies you can see. A call's number and notes belong to the customer, so they stay with whoever looks after the account.",
        runs("The caller: you see the calls you logged and the calls of the people who report to you. Somebody who can ", { b: "See everyone's calls, notes & meetings" }, " sees every caller's."),
      ),
      p("The headline figures and the Callbacks due count are worked out from the same calls you can see, never the whole company's."),
    ],
    permissions: [
      perm("calls.view", "Opens the Calls screen, a company's Calls tab and the phone icon on a company's page. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.calls", "Shows Calls in the menu under Prospecting and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("activities.viewAll", "Shows every caller's calls instead of only your own and your team's — in the call log, the figures and the Caller filter. Management has it by default."),
      perm("companies.viewAll", "Widens which accounts' calls you can see, from the companies you (and the people who report to you) manage to every account. Management, Accounts, Purchase, Support, Profiling and Calling have it by default — Sales does not."),
    ],
    setup: [
      p("There is nothing to set up: once the module is on, the phone icon appears on companies, leads, tickets, orders and renewals."),
      p("The dialog offers the company's contacts who have a phone number on file, primary contact first. So the better your contacts' numbers are kept, the less anybody has to type — add numbers on the company's Contacts tab."),
      p(runs("For a manager to see their team's calls, each person in the team needs that manager as their ", { b: "Reporting manager" }, " in ", { b: "Settings › Users" }, ". To show somebody every caller's calls, tick ", { b: "See everyone's calls, notes & meetings" }, " for their role in ", { b: "Settings › Roles & Permissions" }, ".")),
      p(runs("For calls that log themselves, each person installs the {siteName} app on their Android phone and pairs it from ", { b: "Settings › {siteName} app" }, " — see the first task below. Nothing needs setting up for the company: a role that only admits approved devices gets each phone waiting for an administrator in ", { b: "Settings › Devices, networks & sign-ins" }, ".")),
    ],
    tasks: [
      task(
        "Have your calls log themselves",
        ol(
          "Install the {siteName} app on your Android phone.",
          runs("On a computer, open ", { b: "Settings › {siteName} app" }, " and select ", { b: "Show a pairing code" }, "."),
          runs("In the app, select ", { b: "Scan the code" }, " and point the camera at it — or type your workspace's address and the ten characters. A code works once, for ten minutes."),
          runs("Select ", { b: "Turn on call sync" }, " and allow the call log, phone and notification permissions. If the app says so, allow it to run in the background in the phone's battery settings."),
        ),
        p(runs("From then on, every call with a number on a customer or contact you can see is logged on Calls as yours — connected or no answer by its length — and on the lead it was about when there's only one. Calls with anybody else are not kept. A customer's missed call puts a callback on your list. In the app, ", { b: "How did these go?" }, " lists your calls waiting for a word: choose how it went, add a note, a callback and the lead, and save.")),
      ),
      task(
        "Ring your phone from a call dialog",
        ol(
          "Open the call dialog from the phone icon, as when logging a call, and pick who you're calling.",
          runs("Select ", { b: "Ring my" }, " and your phone's name. Your phone offers to dial the number — while the app is open it shows under ", { b: "Asked to call" }, "."),
          "Make the call. When it ends it logs itself, with what the dialog was about — the lead, ticket or order.",
        ),
        p("The button shows only when one of your phones is paired, approved and has call sync on."),
      ),
      task(
        "See how the team is calling",
        ol(
          runs("Open ", { b: "Prospecting › Calls" }, " and select ", { b: "Team report" }, "."),
          runs("Choose ", { b: "Today" }, ", ", { b: "Yesterday" }, ", ", { b: "This week" }, ", ", { b: "Last 7 days" }, ", ", { b: "This month" }, " or your own dates — up to three months."),
        ),
        p("Each person's row shows their calls and how many connected, talk time, their first and last call of the day, how many the app logged and how many still need a word, callbacks overdue, and for the leads they own that came in during the period, how fast each was first called. Over several days the first and last call are the middle value of the days they called. You see the people whose calls you can see — your own, your team's, or everybody's."),
      ),
      task(
        "Log a call",
        ol(
          runs("Open the company, lead, ticket, order or renewal you're calling about and select the phone icon (", { b: "Call" }, ")."),
          runs("Under ", { b: "Who are you calling?" }, ", pick the contact. Their number fills in under ", { b: "Number" }, " — or choose ", { b: "Someone else at this company" }, " and type the number."),
          runs("Select ", { b: "Start timer" }, " as the call begins, and stop it when you hang up. Stopping and starting again resumes the same timer; ", { b: "Reset" }, " starts over."),
          runs("Choose ", { b: "How did it go?" }, " and the ", { b: "Direction" }, " — ", { b: "We called them" }, " or ", { b: "They called us" }, "."),
          runs("Add ", { b: "Notes" }, " if there's anything worth keeping — what was said, and what happens next."),
          runs("Select ", { b: "Log call" }, "."),
        ),
        p("Only the outcome and the number are needed. You don't have to time a call — a call logged without the timer is saved with no duration. A call logged from a lead, ticket, order or renewal is linked to it, and shows the link in the call history."),
      ),
      task(
        "Promise a callback",
        ol(
          "Log the call as above.",
          runs("Set ", { b: "Call back on" }, " to the date and time you agreed. If the outcome is ", { b: "Callback requested" }, ", you must set it before you can save."),
          runs("Select ", { b: "Log call" }, "."),
        ),
        p(runs("The callback becomes a task for you, titled ", { b: "Call back" }, " with the person's name, due at that time, and lands under ", { b: "Callbacks owed" }, ". When it falls due you get a ", { b: "Callback due" }, " notification. It is yours, because you made the promise — not the account manager's.")),
      ),
      task(
        "Work through the callbacks you owe",
        ol(
          runs("Open ", { b: "Prospecting › Calls" }, " and select ", { b: "Callbacks owed" }, ". They're listed soonest first, with overdue ones marked ", { b: "Callback overdue" }, "."),
          "Make the call, and log it from the record as usual.",
          runs("Back on the earlier call, select ", { b: "Done" }, ". It shows ", { b: "Called back" }, " from then on."),
        ),
        p("Marking a callback done also completes its task — and completing the task in Tasks marks the callback done. The original promise stays on the call either way."),
      ),
      task(
        "See a company's call history",
        p(runs("Open the company and select its ", { b: "Calls" }, " tab. ", { b: "Call history" }, " lists every call on that account you can see, and you can log a new one from the same card.")),
      ),
      task(
        "Find calls and check the day's figures",
        ul(
          runs("Search by company, contact, number or a word in the notes in ", { b: "Search company, contact, number or notes…" }, "."),
          runs("Narrow by ", { b: "Outcome" }, ", by ", { b: "Caller" }, ", or by the dates in ", { b: "Called on" }, "."),
          runs("With no dates chosen the four cards at the top are for today; choose dates and they cover that period instead. ", { b: "Callbacks due" }, " always counts every overdue callback you can see."),
        ),
      ),
    ],
    settings: [
      setting(
        "Who sees which calls",
        "Settings › Roles & Permissions",
        p("Calls follow the account, then the caller: each person sees calls on the companies they can see, logged by themselves or the people who report to them. Tick See everyone's calls, notes & meetings for a role to show it every caller's calls, and See every account, not just your own to widen the accounts."),
      ),
      setting(
        "{siteName} app",
        "Settings › {siteName} app",
        p("Everybody's own: a code to pair your phone with the app, and the phones you have paired — signed in, waiting for approval or signed out — with whether call sync is on and when each was last seen. Sign a phone out here, and it stops at once. Administrators see every phone in Settings › Devices, networks & sign-ins."),
      ),
      setting(
        "Call back on",
        "In the call dialog",
        p("A date and time in your workspace's time zone. Anything set here makes a task for you and puts the call on the callbacks list. Required when the outcome is Callback requested; optional otherwise."),
      ),
    ],
    faq: [
      qa(
        "I don't see Calls in the menu.",
        p("The module may be switched off for your company, your role may have had the Calls section hidden, or your role may not have the permission to view calls. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
      qa(
        "Does the phone icon dial the number?",
        p("No. You make the call on your phone as you normally would. The dialog shows the number, times the call while you talk and records how it went."),
      ),
      qa(
        "The dialog says no contact has a phone number.",
        p("Nobody at that company has a number on file, or every one is too short to dial. Type the number in Number and the call is logged against the company. Then add the number to the right contact so it's there next time."),
      ),
      qa(
        "Why is there no phone icon on this company?",
        p("The company is managed by a reseller. A reseller's customers are theirs to contact, so the app neither shows their numbers nor offers the call button on the company's page."),
      ),
      qa(
        "I can't see a colleague's calls.",
        p("You see your own calls and your team's — the people who report to you — and only on accounts you can see. To see everybody's calls, your role needs See everyone's calls, notes & meetings."),
      ),
      qa(
        "Does the app send my personal calls?",
        p("Each call's number is checked against the customers and contacts you can see. A call with one of them is logged; any other call is dropped there and then — it isn't stored or shown anywhere. Calls from before you switched call sync on are never read, and the app doesn't record calls."),
      ),
      qa(
        "My phone stopped logging calls.",
        p("Open the app: it says if call sync is off, the phone was signed out, or it's waiting for an administrator's approval. If calls only log when you open the app, allow it to run in the background in the phone's battery settings — some phones stop apps that aren't allowed to."),
      ),
      qa(
        "Why can't I save the call?",
        p("Every call needs the number that was dialled and an outcome. If you chose Callback requested, set Call back on as well — a callback with no time is a promise nobody keeps."),
      ),
    ],
    related: ["companies", "leads", "tasks", "targets"],
  },
};

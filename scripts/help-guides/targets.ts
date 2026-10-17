import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Targets — written from src/app/(dashboard)/targets (My targets, All targets, one person's page),
 * src/components/targets (the target card, the Set a target dialog, the scheme picker),
 * src/actions/target.ts (who sees whose targets, who may set them), src/lib/targets/metrics.ts (what each
 * measure counts, the periods, the pace judgement) and src/app/(dashboard)/performance (the Performance
 * board, which the Help panel files under this guide).
 */
export const guide: SeedGuide = {
  slug: "help/targets",
  title: "Targets",
  seo: {
    title: "Targets: numbers for people and teams, measured live",
    description: "How to set sales, collection, call and visit targets in {siteName}, see who is ahead or behind pace, and read exactly what counts towards each one.",
    keywords: ["sales targets", "team targets", "target tracking"],
  },
  guide: {
    module: "targets",
    heading: "Targets",
    summary: "Numbers for people, teams or the whole company to hit — invoiced value, collections, calls connected, visits, tickets resolved — measured against what actually happened, every time you look.",
    purpose: [
      p("Targets gives each person, team or the whole company a number to hit over a month, a quarter or a year, and shows how they are doing against it."),
      p("Nothing is stored except the target itself. The achievement is worked out from the records each time the page loads, so a cancelled invoice or a reassigned lead changes the figure straight away. Each card says, in words, whether you are ahead of pace, on track, behind or at risk, and what each remaining day needs to look like for the period to land."),
      p(runs("Every measure says exactly what counts and what doesn't — open ", { b: "What counts" }, " on any card. That is usually the answer when a figure looks wrong.")),
      note(runs("To turn a target into money, attach an incentive scheme to it — see ", ["Incentives", "/help/incentives"], ".")),
    ],
    access: [
      p("Everybody can see their own targets. Beyond that, what you see depends on your permissions:"),
      ul(
        runs("Without any extra permission you see your own targets, the targets of anybody who reports to you (directly or further down), and every team and company target."),
        runs("With ", { b: "See everyone's targets" }, " you see the whole company's targets, and ", { b: "Performance › All targets" }, " appears in your menu."),
        runs("With ", { b: "Set targets" }, " you can give people and teams numbers, and you see everybody's targets too."),
      ),
      p("Who reports to whom comes from each person's reporting manager. A team target counts the work of everybody in that department."),
    ],
    permissions: [
      perm("section.targets", "Shows Targets in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("targets.viewAll", "Shows All targets in the menu: every target in the company and how each is doing. Without it, somebody sees their own, their reports' and the team and company targets. Management has it by default."),
      perm("targets.manage", "Lets somebody set targets for people, teams and the company, and (with Incentives) attach a scheme to a target. Holding it also shows everybody's targets. Management has it by default."),
      perm("performance.view", "Opens Reports › Performance: active time, records created and edited, leads won and ticket figures for every user, with the task XP leaderboard. Management has it by default."),
    ],
    setup: [
      p(runs("Targets work out of the box — there is nothing to switch on beyond the module itself, which an admin turns on in ", { b: "Settings › Modules" }, ".")),
      p(runs("For team targets and the team view to make sense, people need a department and a reporting manager. An admin sets both for each person in ", { b: "Settings › Users" }, "; the departments themselves are in ", { b: "Settings › Departments" }, ".")),
      p(runs("Somebody who holds ", { b: "Set targets" }, " — Management, by default — then hands out the numbers. The person given a target gets a notification saying so.")),
    ],
    tasks: [
      task(
        "Check how you're doing",
        ol(
          runs("Open ", { b: "Performance › My targets" }, "."),
          "Each card shows what you've achieved against the target, a bar with a mark for how far through the period you are, and a line saying what's left to do per day.",
          runs("If a figure looks wrong, open ", { b: "What counts" }, " on the card to see exactly what is and isn't counted."),
        ),
        p(runs("Targets whose period has ended move to ", { b: "Finished" }, ", kept as they were measured.")),
      ),
      task(
        "Set a target for one person, a team or the company",
        ol(
          runs("Open ", { b: "Performance › All targets" }, " and select ", { b: "Set a target" }, "."),
          runs("Leave ", { b: "One person" }, " selected."),
          runs("Under ", { b: "What's being measured" }, ", pick the measure, and under ", { b: "Over what period" }, ", pick this or next month, this or next quarter, or the financial year."),
          runs("Under ", { b: "Who carries it" }, ", choose ", { b: "One person" }, ", ", { b: "A team" }, " or ", { b: "The whole company" }, ", then the person or team."),
          runs("Type ", { b: "The number to hit" }, ". For one person, the dialog shows what they managed in the equivalent period before; ", { b: "Use +10%" }, " fills in that figure plus ten per cent."),
          runs("Add a ", { b: "Note" }, " if you like, and select ", { b: "Set it" }, "."),
        ),
      ),
      task(
        "Set the month for a whole team at once",
        ol(
          runs("In ", { b: "Set a target" }, ", select ", { b: "A whole team" }, "."),
          "Pick the measure and the period.",
          runs("Under ", { b: "Team" }, ", choose a department, or leave ", { b: "Everybody" }, "."),
          runs("Select ", { b: "Show what they did last period" }, " to see each person's previous figure beside their box."),
          runs("Type a number for each person who should have one, and select ", { b: "Set them" }, "."),
        ),
        p("Anybody left blank is skipped — nobody is given a target of nothing."),
      ),
      task(
        "Find the targets that need attention",
        p(runs("On ", { b: "Performance › All targets" }, ", the counts at the top show how many targets are ", { b: "Met" }, ", ", { b: "On track" }, ", ", { b: "Behind" }, " and ", { b: "At risk" }, ". Narrow the list with ", { b: "Measure" }, ", ", { b: "Whose" }, " and ", { b: "Period" }, " (current and upcoming by default, or ", { b: "Finished" }, " or ", { b: "Everything" }, "). Select a person's name on a card to see all of their targets.")),
      ),
      task(
        "See the whole team's activity",
        p(runs("With ", { b: "View team performance" }, ", open ", { b: "Reports › Performance" }, " and pick a ", { b: "Period" }, ". It lists each user's active time, records created and edited, leads won, tickets open and resolved, average resolution time and SLA met, and — where Tasks is on — who earned the most task XP.")),
      ),
    ],
    settings: [
      setting(
        "What's being measured",
        "In each target",
        p("Each measure has its own rule, shown on the card under What counts. Invoiced value is tax invoices issued, less credit notes in the same period. Collected is money received in the period, whenever it was invoiced. Order value and Order margin count orders you punched once they are past approval. Leads won, Value of leads won and Leads created are offered only where your plan includes Leads. There are also Calls connected, Time on the phone, Companies added, Contacts added, New customers won, Added seats, Purchase savings, Visits completed and Tickets resolved."),
      ),
      setting(
        "Over what period",
        "In each target",
        p("This month, next month, this quarter, next quarter, or the financial year. Quarters and years follow the April-to-March financial year, so Q1 is April to June. There can be only one target per person (or team) for the same measure and period."),
      ),
      setting(
        "Departments and reporting managers",
        "Settings › Users and Settings › Departments",
        p("A team target counts everybody in that department. A person's reporting manager decides who sees their targets without the permission to see everyone's."),
      ),
    ],
    faq: [
      qa(
        "How is \"on track\" decided?",
        p("By pace, not just percentage. The card compares what's been achieved with what an even run rate would have reached by today. More than ten per cent ahead is ahead of pace, within ten per cent is on track, and more than a quarter behind with the period past half way is at risk. Anything else short of pace is behind."),
      ),
      qa(
        "Why did my figure go down?",
        p("Because the achievement is worked out fresh from the records every time. A cancelled invoice, a credit note or a lead moved to somebody else is reflected straight away. Open What counts on the card to see the rule for that measure."),
      ),
      qa(
        "It says there's already a target for that. What now?",
        p("Each person, team or the company can have only one target for the same measure and period, so nobody is unsure which one counts. Pick a different period or measure."),
      ),
      qa(
        "Can I see my team's targets?",
        p("Yes — everybody who reports to you, directly or further down, as long as their reporting manager is set in Settings › Users. Select a person's name on a card to open all of their targets."),
      ),
      qa(
        "I don't see Targets, or All targets, in the menu.",
        p("If Targets is missing altogether, either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). All targets appears only to people who may see everyone's targets — ask an admin if you need it."),
      ),
      qa(
        "Do team and company targets pay an incentive?",
        p("No. They are measured and shown like any other target, but only a target for one person can turn into an incentive earning."),
      ),
    ],
    related: ["incentives", "reports", "wins", "visits"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Sales Wins — written from src/app/(dashboard)/wins (the wall, Most active, Hall of fame, Prizes &
 * settings), src/components/wins, src/actions/wins.ts, src/actions/prizes.ts and
 * src/actions/activity-awards.ts (who sees and changes what), src/lib/wins (what celebrates itself),
 * src/app/(dashboard)/settings/tv-screens, src/components/tv and src/actions/tv.ts (pairing a TV), and
 * src/app/(tv)/tv/wins (the TV board).
 */
export const guide: SeedGuide = {
  slug: "help/sales-wins",
  title: "Sales Wins",
  seo: {
    title: "Sales Wins: celebrate big deals, targets and top sellers",
    description: "How {siteName} celebrates big deals, targets reached and new customers, runs the monthly leaderboard and fortnightly awards, and shows wins on a TV.",
    keywords: ["sales leaderboard", "sales celebrations", "sales floor TV"],
  },
  guide: {
    module: "wins",
    heading: "Sales Wins",
    summary: "Wins that celebrate themselves — a big deal closed, a target reached, a new customer's first order, the month's top performer — with a leaderboard, fortnightly most-active awards, prizes and a TV screen for the sales floor.",
    purpose: [
      p("Sales Wins makes the good news visible without anybody having to announce it. When a big deal is won, a target is reached or a new customer places their first order, the app notices and celebrates it — a full-screen splash with confetti for everybody, or for the winner alone with a line in everybody else's greeting strip."),
      p(runs("The wall at ", { b: "Sales › Wins & leaderboard" }, " shows the month so far: what's booked against the target, deals won, new customers, targets reached, this month's ", { b: "Leaderboard" }, " and the ", { b: "Recent wins" }, " of the last 30 days. The leaderboard ranks orders booked this month at the selling price, before GST — the same measure as the order value target.")),
      p("On the 1st of each month the previous month's top performers are announced. Every fortnight, the most active people — counted from records, calls, visits, tickets and deals — are named too. You can put prizes on both, and keep a hall of fame of who won what."),
      note("Everybody sees the wall: the whole point is that the rest of the room sees the win."),
    ],
    access: [
      p("Everybody can open the wins wall, the Most active tab and the Hall of fame. On Most active, everybody sees their own points; the full ranking is for people who can view team performance."),
      p("Past awards and prizes are shown to whoever they were announced to: told to everybody, everybody sees them; told only to the winners, each winner sees their own; told to managers, the managers do."),
      p("Choosing what is celebrated, running the awards, setting prizes and marking them handed over is for people allowed to run wins, awards and prizes. Pairing a TV is a separate permission."),
    ],
    permissions: [
      perm("section.wins", "Shows Wins & leaderboard in the menu under Sales and lets people open it. Every role has it until an admin unticks it for one."),
      perm("wins.manage", "Opens the Prizes & settings tab: choose which sales moments celebrate themselves and how loudly, run the fortnightly most-active awards, set and announce prizes, and tick off each prize as it's handed over. Management has it by default."),
      perm("wins.tv", "Lets somebody pair a TV with its code so it shows the wins board for a branch or the whole company, rename it and take it off. Management has it by default."),
      perm("performance.view", "Shows the full most-active ranking as it builds up, every past award, and the whole hall of fame. Management has it by default."),
    ],
    setup: [
      p("The wall works from your orders, leads and targets as they are. Somebody who runs wins, awards and prizes sets the rest once:"),
      ul(
        runs("In ", { b: "Prizes & settings" }, ", choose ", { b: "What gets celebrated" }, " and how loudly, and whether rupee amounts show on the wall and the TV."),
        runs("Decide whether to ", { b: "Announce the most active every fortnight" }, ", and who hears about it."),
        "Set prizes for the top sellers and the most active, if you give any.",
        runs("Put a TV on the sales floor from ", { b: "Settings › TV screens" }, "."),
      ),
      p("For the wall's target figure and Targets reached, set targets in Targets."),
    ],
    tasks: [
      task(
        "Choose what celebrates itself",
        ol(
          runs("Open ", { b: "Sales › Wins & leaderboard" }, " and select ", { b: "Prizes & settings" }, "."),
          runs("Under ", { b: "What gets celebrated" }, ", tick the moments you want: ", { b: "A big deal won" }, " (and the smallest deal worth celebrating), ", { b: "A target reached" }, " (and which targets), ", { b: "A new customer's first order" }, " and ", { b: "Top performer of the month" }, " (and how many to name)."),
          runs("For each, choose ", { b: "Splash for everybody" }, " or ", { b: "Splash for the winner, strip for everybody else" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p(runs("Each win is celebrated once, for two days (three for the top performer). Switching a moment on never celebrates anything older than two days. ", { b: "Look for wins now" }, " checks straight away instead of waiting.")),
      ),
      task(
        "Run the fortnightly most-active awards",
        ol(
          runs("In ", { b: "Prizes & settings" }, ", under ", { b: "Most active of the fortnight" }, ", tick ", { b: "Announce the most active every fortnight" }, "."),
          runs("Choose ", { b: "Who hears about it" }, ": ", { b: "Everybody" }, ", ", { b: "Managers only" }, " or ", { b: "Only the winners" }, "."),
          runs("Set how many to name overall — the leader in sales and in support are named as well — and whether there's a ", { b: "Full-screen splash with confetti" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p(runs("The awards are announced on the 1st and the 16th, from 9 am, for the fortnight just finished. The ", { b: "Most active" }, " tab shows your points so far, past fortnights and how the points work. A change applies from the next announcement.")),
      ),
      task(
        "Set prizes",
        ol(
          runs("In ", { b: "Prizes & settings" }, ", find ", { b: "Prizes — top sellers of the month" }, " or ", { b: "Prizes — most active of the fortnight" }, "."),
          runs("Leave ", { b: "Standing — every month" }, " (or fortnight) chosen for a prize given every time, or pick one month or fortnight to plan a special prize that replaces the standing one for that period."),
          runs("For each place, type the prize, add a line about it if you like, ", { b: "Add a picture" }, " and select ", { b: "Save" }, "."),
        ),
        p(runs("Everybody is told automatically what's up for grabs as each period opens. Changed the prizes mid-way? Select ", { b: "Announce now" }, " to tell everybody again. Prizes for the top sellers are only shown while Top performer of the month is on; prizes for the most active only while those awards are told to everybody or the winners.")),
      ),
      task(
        "Hand over a prize",
        ol(
          runs("Open ", { b: "Hall of fame" }, ". It lists every month's top sellers and every fortnight's most active, with what they won."),
          runs("Select ", { b: "Mark handed over" }, " beside the winner. Everybody else sees ", { b: "Handed over" }, " and the date instead of ", { b: "On its way" }, "."),
        ),
      ),
      task(
        "Put the wins board on a TV",
        ol(
          "On the TV's browser, open your workspace's address followed by /tv. It shows a six-digit code and a QR code.",
          runs("In ", { b: "Settings › TV screens" }, " (or ", { b: "Put on a TV" }, " on the wall), type the code in ", { b: "Code on the TV" }, " — or scan the QR code with your phone, which fills it in."),
          runs("Give the screen a ", { b: "Name" }, ", choose whose wins it ", { b: "Shows the wins of" }, " — ", { b: "The whole company" }, " or one branch — and select ", { b: "Pair TV" }, "."),
        ),
        p("The TV opens the board by itself within a few seconds and refreshes every minute. Nobody signs in on it, it uses no seat, and it can show the board and nothing else. A win from the last two hours takes the top of the screen, with confetti."),
      ),
      task(
        "Show the board on a screen you're signed in on",
        p(runs("On the wall, select ", { b: "Open the TV screen" }, ". The board opens full screen in a new tab — handy for a meeting-room screen or a laptop on a stand.")),
      ),
    ],
    settings: [
      setting(
        "Wins, awards & prizes",
        "Sales › Wins & leaderboard › Prizes & settings",
        p("Everything behind the wall, in one place, for people who run wins: the prizes for the top sellers and the most active, what gets celebrated, and the most-active awards. It's also listed in Settings."),
      ),
      setting(
        "What gets celebrated",
        "Prizes & settings",
        ul(
          "A big deal won — when a lead is marked won, valued at its latest proposal (or its estimate) before GST, worth at least the amount you set.",
          "A target reached — measured exactly as Targets measures it, a person's, a team's or the company's. Tick the targets that count; none ticked means every one.",
          "A new customer's first order — the first order a company has ever had booked.",
          "Top performer of the month — announced in the first week of each month, by order value booked the month before. Name between 1 and 10.",
        ),
      ),
      setting(
        "Show rupee amounts on the wall and the TV",
        "Prizes & settings",
        p("Off shows ranks and progress to target only — useful when the sales floor shouldn't see each other's numbers."),
      ),
      setting(
        "Most active of the fortnight",
        "Prizes & settings",
        p("Whether the awards run, who hears about them (Everybody, Managers only or Only the winners), how many to name overall (1 to 10), and the splash. Points come only from work anybody can check, and time in the app counts for little, so it separates people who did the same work and nothing more."),
      ),
      setting(
        "TV screens",
        "Settings › TV screens",
        p("The TVs showing the wins board: pair one by its code, choose the whole company or a branch, rename it, see when it was last on, and take it off — the TV goes back to showing a code within a minute."),
      ),
    ],
    faq: [
      qa(
        "I don't see Wins & leaderboard in the menu.",
        p("Either the module is switched off for your company or your role has had the Sales Wins section hidden. Ask an admin: the switch is in Settings › Modules, and the section is in Settings › Roles & Permissions."),
      ),
      qa(
        "A big deal was won but nothing was celebrated.",
        p("Check that A big deal won is on and the deal was worth at least the smallest amount set — its latest proposal, or its estimate when there's no proposal, before GST. The deal must also be in a pipeline that counts as sales. To check at once instead of waiting, use Look for wins now."),
      ),
      qa(
        "Why don't I see the Prizes & settings tab?",
        p("It's only for people allowed to run wins, awards and prizes. Everybody else sees the wall, Most active and Hall of fame."),
      ),
      qa(
        "Why can I only see my own points on Most active?",
        p("The full ranking, as it builds up, is for people who can view team performance. Everybody sees their own tally, and the winners once they're announced — if the awards are told to everybody."),
      ),
      qa(
        "The TV shows a code again.",
        p("It was taken off in Settings › TV screens. Pair it again with the code it now shows. If instead it says the wins board is switched off, the module has been switched off for your company."),
      ),
      qa(
        "Do changes an admin makes while viewing as somebody earn points?",
        p("No. Work done while viewing as somebody counts for nobody, so the awards can't be gamed that way."),
      ),
    ],
    related: ["targets", "leads", "orders", "incentives"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Forecasting — written from src/app/(dashboard)/forecast (the five tabs), src/components/forecast (the
 * stage weights and the commits panel), src/actions/forecast.ts (what each figure is made of, whose
 * numbers, who may change the weights), src/lib/forecast (periods, learned stage weights, renewal rates
 * and collection timing).
 */
export const guide: SeedGuide = {
  slug: "help/forecasting",
  title: "Forecasting",
  seo: {
    title: "Forecasting: sales, renewals and cash, period by period",
    description: "How the {siteName} forecast weighs open deals, renewals, collections and warranties ending, beside targets, last year and each salesperson's commit.",
    keywords: ["sales forecast", "weighted pipeline", "sales commit"],
  },
  guide: {
    module: "forecast",
    heading: "Forecasting",
    summary: "What is coming, period by period: open deals weighted by how often each stage really wins, renewals by how each brand really renews, cash by how each customer really pays — beside targets, last year and your own commit.",
    purpose: [
      p("The forecast answers \"what will we book, renew and collect, and when?\" from the records you already keep — open leads, subscriptions, invoices and customers' machines — rather than from a spreadsheet somebody updates on Fridays."),
      p("It learns from your own history instead of guessing. A deal counts at the share of deals at its stage that went on to be won over the last twelve months. A renewal counts at the rate that brand's subscriptions have actually renewed. A bill is expected when that customer usually pays, not when the invoice says."),
      p(runs("Five tabs share the same periods and the same salesperson filter, so a month means the same thing on each: ", { b: "Sales" }, ", ", { b: "Renewals" }, ", ", { b: "Collections" }, ", ", { b: "Warranty → AMC" }, " and ", { b: "Commits" }, ".")),
      note("Figures are before GST, except Collections, which is cash and so includes it."),
    ],
    access: [
      p("Everybody can open the forecast. What it adds up is the accounts you can see: a salesperson sees their own accounts, a manager their team's as well, and somebody who can see every account sees the whole company. Picking a salesperson narrows it to one person inside that."),
      p("The stage weights and renewal rates are learned from the whole company's history, whoever is looking — a weight is a fact about the business, not about one person's slice of it."),
      p("Only people allowed to set forecast weights can override how much a stage counts. Everybody can enter their own commit."),
    ],
    permissions: [
      perm("section.forecast", "Shows Forecast in the menu under Sales and lets people open it. Every role has it until an admin unticks it for one."),
      perm("forecast.manage", "Lets somebody override how much a deal at each stage counts, or clear an override to go back to what the history says. Management has it by default."),
      perm("companies.viewAll", "Makes the forecast add up every account rather than only the ones you and the people who report to you manage. Management, Accounts, Purchase, Support, Profiling and Calling have it by default — Sales does not."),
    ],
    setup: [
      p("The forecast is worked out from your open deals, so it needs Leads in your workspace. Without it the page says so."),
      ul(
        runs("Give deals an ", { b: "Expected close date" }, " and a value — an estimate on the lead, or better, a proposal. A deal with no close date isn't in any period, and one with no value counts for nothing."),
        runs("Decide which team pipelines are sales in ", { b: "Settings › Pipeline" }, ". Only pipelines that count as sales are forecast."),
        runs("For the ", { b: "Target" }, " column, set order value targets for your salespeople in Targets."),
      ),
      p("The learned figures need history: until a stage has at least ten closed deals behind it, it uses a standard figure, and the screen says so."),
    ],
    tasks: [
      task(
        "Read the sales forecast",
        ol(
          runs("Open ", { b: "Sales › Forecast" }, ". The ", { b: "Sales" }, " tab opens first."),
          runs("Choose ", { b: "Month" }, ", ", { b: "Quarter" }, " or ", { b: "Financial year" }, ", and how many in ", { b: "How far ahead" }, "."),
          "Read each period's row: the deals closing in it, their full value (Pipeline), the deals at Proposal sent or Negotiation (Best case), those at Negotiation (In negotiation), and the Weighted figure — each deal's value times its stage's weight.",
          runs("Compare it with ", { b: "Booked so far" }, ", ", { b: "Target" }, ", ", { b: "Salespeople commit" }, " and ", { b: "Last year" }, ". Under the target, the percentage is what you'd reach with what's booked plus the forecast."),
          "Select a period to list its deals underneath, biggest weighted value first.",
        ),
        p(runs("Three rows sit outside the periods: ", { b: "Slipped — close date passed" }, " (open deals whose date has gone — give them a new one), ", { b: "Later" }, ", and ", { b: "No close date" }, ". A deal's value is its latest live proposal, or its estimate when it has none.")),
      ),
      task(
        "Forecast renewals",
        ol(
          runs("Select the ", { b: "Renewals" }, " tab."),
          "For each period, see the subscriptions falling due, how many have renewed or been lost, how many are still open, and the Expected value — what has already renewed, plus the open ones counted at their brand's renewal rate.",
          "Select a period to list each subscription, with its customer, end date and account manager.",
        ),
        p(runs({ b: "Renewal rates used" }, " shows the rates: of subscriptions that ran out between a year and a month ago, the share that was renewed — overall, and for each brand with enough history. Subscriptions that lapsed in the last 90 days without renewing are listed too, because late renewals still happen.")),
      ),
      task(
        "See when cash will come in",
        ol(
          runs("Select the ", { b: "Collections" }, " tab."),
          runs("Compare ", { b: "Due, as invoiced" }, " with ", { b: "Expected in" }, " for each period — each bill pushed back by however late that customer usually pays."),
          "Select a period to see the bills, with how many days late the customer usually is.",
        ),
        p(runs("Bills already past due are listed under ", { b: "Already overdue" }, ", without a guess at when they'll arrive.")),
      ),
      task(
        "Find machines coming out of warranty",
        p(runs("The ", { b: "Warranty → AMC" }, " tab counts customers' own machines whose warranty ends in each period with no AMC to follow it — and those that ended in the last 90 days. Select a period to see them by customer: an AMC is sold to the customer, not the machine.")),
      ),
      task(
        "Enter your commit",
        ol(
          runs("Select the ", { b: "Commits" }, " tab."),
          runs("For each of the next three months, enter your ", { b: "Commit" }, " — what you'll close — and, if you like, a ", { b: "Best case" }, " and a note on what it depends on."),
          runs("Select ", { b: "Commit" }, " (or ", { b: "Update" }, " to change it)."),
        ),
        p("Beside each month is what your own deals say. The number is there to argue with: you know which deal went quiet last week. A month that has ended keeps the commit it had. If you can see other people's accounts, Your team shows each person's commit beside what their deals say."),
      ),
      task(
        "Override a stage's weight",
        ol(
          runs("On the ", { b: "Sales" }, " tab, scroll to ", { b: "How deals are weighted" }, "."),
          runs("Type a percentage under ", { b: "Override" }, " for the stage and select ", { b: "Set" }, "."),
          runs("To go back to the learned figure, select ", { b: "Clear" }, "."),
        ),
        p("Each stage is marked learned, standard or override, with what the history says beside it. Only people allowed to set forecast weights see the Override column."),
      ),
    ],
    settings: [
      setting(
        "How deals are weighted",
        "Sales › Forecast › Sales",
        p("How much a deal at each open stage counts — New, Contacted, Qualifying, Qualified, Proposal sent and Negotiation. Learned from the deals closed in the last twelve months; a stage with fewer than ten closed deals behind it uses a standard figure; a later stage never counts for less than an earlier one. An override, 0 to 100, replaces the figure for everybody until it is cleared."),
      ),
      setting(
        "Counts as sales",
        "Settings › Pipeline",
        p("Only the open leads of pipelines that count as sales are forecast, and only their closed leads teach the weights. A partner-onboarding pipeline, for example, stays out."),
      ),
      setting(
        "Period and How far ahead",
        "Sales › Forecast",
        p("Month (3, 6 or 12 ahead), Quarter (2, 4 or 8) or Financial year (1, 2 or 3). The choice applies to every tab except Commits, which is always the next three months."),
      ),
      setting(
        "Salesperson",
        "Sales › Forecast",
        p("Shown when you can see more than one person's accounts. Narrows the forecast to one person's deals, accounts and bookings; Everybody I can see adds up all of them."),
      ),
    ],
    faq: [
      qa(
        "I don't see Forecast in the menu.",
        p("Either the module is switched off for your company or your role has had the Forecasting section hidden. Ask an admin: the switch is in Settings › Modules, and the section is in Settings › Roles & Permissions."),
      ),
      qa(
        "A deal I'm working on isn't in any month.",
        p("It has no expected close date, so it's under No close date — or its date has passed, and it's under Slipped. Give it a date on the lead. A lead in a pipeline that doesn't count as sales isn't forecast at all."),
      ),
      qa(
        "Why does a deal count for nothing?",
        p("It has no value: no estimate on the lead and no live proposal. The deal list says add an estimate or a proposal. Once it has one, it counts at its stage's weight."),
      ),
      qa(
        "Why does a stage say standard rather than learned?",
        p("Fewer than ten closed deals have been at that stage in the last year, which is too few to learn from. It uses a standard figure until there are more. Somebody allowed to set forecast weights can override it meanwhile."),
      ),
      qa(
        "Why are the stage names different from our pipeline's?",
        p("The forecast weighs each lead by what its stage counts as — the fixed meanings New, Contacted, Qualifying, Qualified, Proposal sent and Negotiation — so your own stage names map onto those. Which meaning each of your stages has is set in Settings › Pipeline."),
      ),
      qa(
        "I can't change last month's commit.",
        p("That's deliberate: a month that has ended keeps the commit made for it, so the forecast can be compared with what people actually called."),
      ),
    ],
    related: ["leads", "renewals", "receivables", "targets"],
  },
};

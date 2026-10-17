import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Incentives — written from src/app/(dashboard)/incentives (My incentives, the incentive queue, Schemes),
 * src/components/incentives (the queue with its approve/hold/cancel/pay controls and one-off award, the
 * scheme form with its preview), src/components/targets/scheme-picker.tsx (attaching a scheme to a target),
 * src/actions/incentive.ts (who may write schemes, work out and decide earnings, the collection gate) and
 * src/lib/incentives/compute.ts (the five ways a scheme pays, bands, threshold, cap, workings), with the
 * payroll hand-off in src/actions/payroll.ts.
 */
export const guide: SeedGuide = {
  slug: "help/incentives",
  title: "Incentives",
  seo: {
    title: "Incentives: turn targets into pay, with the workings shown",
    description: "How to write incentive schemes in {siteName}, attach them to targets, work out what's owed, approve it and pay it through payroll.",
    keywords: ["sales incentives", "commission schemes", "incentive payout"],
  },
  guide: {
    module: "incentives",
    heading: "Incentives",
    summary: "What hitting a target is worth: schemes with thresholds, bands and caps, worked out against what was achieved, approved by somebody else, and paid with salary.",
    purpose: [
      p("Incentives turns a target into money. You write a scheme — a percentage, a flat amount, so much per unit, or bands that pay more the further past target somebody goes — and attach it to a person's target. When the period ends, the app works out what each person earned."),
      p("Every earning carries its workings in plain words, for example the band it landed in and the rate it paid, so anyone can see how a figure was reached. The figure is frozen when it is worked out: editing a scheme next quarter can't change what was earned last quarter."),
      p("Somebody other than the earner approves it. If your company runs payroll here, approved incentives go out on the next payslip as a taxable earning."),
      note(runs("Incentives are built on targets — read ", ["Targets", "/help/targets"], " first.")),
    ],
    access: [
      p("Three jobs, kept apart on purpose:"),
      ul(
        runs({ b: "Everybody" }, " has ", { b: "My incentives" }, ": what they've earned, how it was worked out, and where it is."),
        runs("People who ", { b: "Manage incentive schemes" }, " write the schemes, attach them to targets, work out what's owed and make one-off awards."),
        runs("People who ", { b: "Approve and pay incentives" }, " decide what goes out — approve, hold, cancel or mark paid. Nobody can decide their own incentive, whatever they hold."),
      ),
      p("Both the scheme writers and the approvers see the whole incentive queue."),
    ],
    permissions: [
      perm("section.incentives", "Shows Incentives in the menu and lets people open My incentives. Every role has it until an admin unticks it for one."),
      perm("incentives.manage", "Opens Schemes and the incentive queue: write and retire schemes, attach them to targets, work out what's owed for finished periods, and make one-off awards. Management has it by default."),
      perm("incentives.approve", "Opens the incentive queue to approve, hold, cancel or mark paid what people have earned. Nobody can decide their own. Accounts has it by default."),
    ],
    setup: [
      p("Setting incentives up is a one-off job for whoever manages schemes (Management, by default):"),
      ol(
        runs("Make sure the people concerned have targets — see ", ["Targets", "/help/targets"], "."),
        runs("Write a scheme in ", { b: "Performance › Schemes" }, "."),
        runs("Attach it to each target that should pay, on ", { b: "Performance › All targets" }, "."),
      ),
      p(runs("To pay incentives with salary, payroll needs to be in use — see ", ["Payroll", "/help/payroll"], ". Otherwise an approver marks each one paid by hand.")),
    ],
    tasks: [
      task(
        "Write a scheme",
        ol(
          runs("Open ", { b: "Performance › Schemes" }, " and select ", { b: "New scheme" }, "."),
          runs("Give it a ", { b: "Name" }, " — it appears on people's payslip explanation."),
          runs("Under ", { b: "Pays on" }, ", choose the measure. It must match the targets you'll attach it to."),
          runs("Under ", { b: "How it pays" }, ", choose a way, then fill in its ", { b: "Rate (%)" }, ", ", { b: "Amount" }, ", ", { b: "Per unit" }, " or ", { b: "Bands" }, "."),
          runs("Optionally set ", { b: "Pays from (% of target)" }, ", a ", { b: "Cap on any one payout" }, " and ", { b: "Only pay once the money is in" }, "."),
          runs("Check the preview, ", { b: "What this pays against a … target" }, ", which shows the payout at several levels of achievement."),
          runs("Fix anything listed in the warnings, then select ", { b: "Create" }, "."),
        ),
      ),
      task(
        "Attach a scheme to a target",
        ol(
          runs("Open ", { b: "Performance › All targets" }, "."),
          runs("On the target's card, choose the scheme under ", { b: "Pays on" }, ". Only schemes for the same measure are listed."),
        ),
        p(runs("Choose ", { b: "Nothing — this target pays no incentive" }, " to take a scheme off again.")),
      ),
      task(
        "Work out what's owed",
        ol(
          runs("Open ", { b: "Performance › Incentive queue" }, "."),
          runs("Select ", { b: "Work out what's owed" }, "."),
        ),
        p("Every target with a scheme whose period has finished is worked out once. Running it again leaves those already done alone. A target that earned nothing is still recorded, with its reason, so the person can see why."),
      ),
      task(
        "Approve and pay",
        ol(
          runs("Open ", { b: "Performance › Incentive queue" }, ". Filter by ", { b: "Status" }, " to see what's ", { b: "Due" }, "."),
          runs("Read the workings on each card, then select ", { b: "Approve" }, "."),
          runs("An approved incentive goes out on the next payroll run automatically. To record a payment made another way, select ", { b: "Mark paid" }, "."),
        ),
        p(runs("To stop one, select ", { b: "Hold" }, " or ", { b: "Cancel" }, " and say why — the person is told, and your reason is what they read.")),
      ),
      task(
        "Give a one-off award",
        ol(
          runs("In ", { b: "Performance › Incentive queue" }, ", select ", { b: "One-off award" }, "."),
          runs("Choose ", { b: "Who" }, ", type ", { b: "How much" }, ", ", { b: "What to call it" }, " and ", { b: "What it's for" }, "."),
          runs("Select ", { b: "Award it" }, "."),
        ),
        p("It goes through the same approval as any other incentive, and reaches the payslip the same way."),
      ),
      task(
        "See what you've earned",
        p(runs("Open ", { b: "Performance › My incentives" }, ". It shows what's been paid so far, what's still to come, and each period with its status, its workings, any reason it was held, and the payslip it went out on.")),
      ),
    ],
    settings: [
      setting(
        "How it pays",
        "In each scheme, Performance › Schemes",
        ul(
          runs({ b: "Percentage of what was achieved" }, " — pays on the actual number, so beating the target pays more."),
          runs({ b: "Percentage of the target" }, " — pays the same however far past target somebody goes."),
          runs({ b: "A flat amount" }, " — the same sum for everybody who reaches the threshold."),
          runs({ b: "So much per unit" }, " — per call connected, per lead, per ticket resolved."),
          runs({ b: "Bands" }, " — a different rate for each range of achievement, such as 80–100% and 100% and above. Leave the top band's upper limit blank so it runs on."),
        ),
      ),
      setting(
        "Pays from (% of target)",
        "In each scheme",
        p("Nothing is paid below this share of the target. Leave it empty to pay from the first rupee."),
      ),
      setting(
        "Cap on any one payout",
        "In each scheme",
        p("The most a single earning can come to. When the cap applies, the workings say what it would otherwise have been."),
      ),
      setting(
        "Only pay once the money is in",
        "In each scheme",
        p("For invoiced value, order value and value of leads won: an approved incentive can't be paid until everything invoiced in the period, where the person is the salesperson, has been collected. The queue shows how much has come in."),
      ),
      setting(
        "Retiring a scheme",
        "Performance › Schemes",
        p("Use the eye button on a scheme to retire it, or to put it back in use. A retired scheme is no longer offered for new targets; what it has already paid is kept."),
      ),
    ],
    faq: [
      qa(
        "Why is my incentive zero?",
        p("The workings on the card say why — most often the achievement was below the scheme's Pays from threshold, or didn't fall in any of its bands."),
      ),
      qa(
        "Why can't I mark an approved incentive paid?",
        p("Its scheme pays only once the money is in, and not all of what was invoiced in that period has been collected yet. The card says how much has come in."),
      ),
      qa(
        "Why isn't this month's incentive showing yet?",
        p("Incentives are worked out only for periods that have finished, so a late credit note can't make a figure fall after somebody has seen it. While a period is running, watch the target instead."),
      ),
      qa(
        "Can I approve my own incentive?",
        p("No. Somebody else has to decide it, whatever permissions you hold."),
      ),
      qa(
        "Do team or company targets pay?",
        p("No. Only a target for one person turns into an earning; team and company targets are measured but not paid."),
      ),
      qa(
        "I don't see Incentives, or the queue, in the menu.",
        p("If Incentives is missing altogether, either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). The incentive queue appears only to people who manage schemes or approve incentives, and Schemes only to people who manage them."),
      ),
    ],
    related: ["targets", "payroll", "receivables"],
  },
};

import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Customer Feedback — written from src/app/(dashboard)/feedback (the list and About me), the
 * Feedback tab on a customer's page (src/components/companies/company-feedback.tsx), src/components/
 * feedback (the ask dialog, the list, the customer's form), src/app/(public)/review/[token],
 * src/actions/feedback.ts and feedback-public.ts (who sees and does what), src/lib/feedback/rating.ts
 * (scores and the review-page rule) and Settings › Customer feedback (feedback-manager.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/customer-feedback",
  title: "Customer Feedback",
  seo: {
    title: "Customer feedback: one-time links that ask how it went",
    description: "How to ask customers for feedback in {siteName} with a one-time link, follow up low scores, see what was said about you and offer happy customers your review page.",
    keywords: ["customer feedback", "feedback link", "customer satisfaction"],
  },
  guide: {
    module: "feedback",
    heading: "Customer Feedback",
    summary: "Send a customer a one-time link and ask how it went: about the person who dealt with them, and about the work itself. Every answer is kept whatever the score, and a happy customer can be offered your public review page.",
    purpose: [
      p("Customer Feedback asks a customer for a score. You make a link from the customer's page and send it to them; they answer a short form without signing in. The link works once and then closes, and it expires after a set number of days."),
      p("The form asks how it went overall, out of five stars. If you named the person who dealt with them, it asks about that person too, and if you said what the work was, it asks about the work."),
      p("Every answer is kept here, whatever the score. A score of 3 or below waits for somebody to record what was done about it. If you have a public review page, such as your Google Business Profile, customers can be offered it after they answer."),
      p(runs({ b: "About me" }, " shows each person what customers said about them.")),
    ],
    access: [
      p(runs("Everybody can open ", { b: "Support › Customer feedback" }, " and ", { b: "Support › About me" }, ". Without the permission to see all feedback, you see feedback about you, feedback you asked for, and feedback on the accounts you run (as their account manager or caller).")),
      p("Making a link needs the permission to ask customers for feedback. You can only ask a customer you can see. A reseller's end customer can't be asked: ask the reseller instead."),
      p("Customers need no account. Whoever holds the link can answer it once."),
    ],
    permissions: [
      perm("section.feedback", "Shows Customer Feedback in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("feedback.request", "Lets somebody make a feedback link from a customer's Feedback tab, and withdraw a link that hasn't been answered. Sales, Support and Management have it by default. Anybody can see what was said about their own work without it."),
      perm("feedback.viewAll", "Shows every response, including scores naming other people. Without it somebody sees feedback about themselves, feedback they asked for, and feedback on the accounts they run. Management has it by default."),
    ],
    setup: [
      p(runs("An admin opens ", { b: "Settings › Customer feedback" }, " once and sets how long a link lasts, what the form says at the top, and whether customers are offered your public review page (see Settings below). Then select ", { b: "Save" }, ".")),
      p("Everything else works without setting up: anybody with the permission can start asking straight away."),
      note(runs("Google's review policy prohibits offering the review page only to customers you already know are happy (“review gating”). The settings screen warns you when ", { b: "Offer it from" }, " filters by score; choose ", { b: "Everybody, whatever they rate" }, " to offer it to everyone."), "warning"),
    ],
    tasks: [
      task(
        "Ask a customer for feedback",
        ol(
          runs("Open the customer's page and its ", { b: "Feedback" }, " tab, and select ", { b: "Ask for feedback" }, "."),
          runs("Under ", { b: "Who are we asking?" }, ", choose a contact. You can leave it empty and send the link yourself."),
          runs("Under ", { b: "What about?" }, ", keep ", { b: "How we're doing generally" }, ", or pick a resolved or closed ticket, a completed visit or a fulfilled order. For a general one you can describe it under ", { b: "Or describe it" }, "."),
          runs("Under ", { b: "Who dealt with them?" }, ", choose the colleague the form should ask about, or ", { b: "Nobody in particular" }, "."),
          runs("Add ", { b: "A line from you" }, " if you like. It shows above the form."),
          runs("Select ", { b: "Make the link" }, "."),
          runs("Copy the link, or select ", { b: "Send on WhatsApp" }, " or ", { b: "Open in email" }, " when the contact has a phone or an email address. Then select ", { b: "Done" }, "."),
        ),
        p("The app doesn't email the link itself; it is sent from your WhatsApp or your own email. Anybody holding the link can answer it, so send it to that person and nobody else. Each request gets a reference like FB/2026-27/0001."),
      ),
      task(
        "Know what the customer sees",
        ul(
          "A short form, with the words you set at the top and your own line if you added one.",
          "How their experience was overall, from one star (Very poor) to five (Excellent).",
          "How the named colleague was to deal with, and how the work was, when those were chosen.",
          runs("A box for anything they'd like to add, and ", { b: "Send my feedback" }, "."),
        ),
        p(runs("After they answer, they are thanked. If they are offered your review page, they see ", { b: "Leave a review" }, " and are taken there after a few seconds unless they choose to stay.")),
      ),
      task(
        "Follow up a low score",
        ol(
          runs("Open ", { b: "Support › Customer feedback" }, " and set ", { b: "Show" }, " to ", { b: "Low scores nobody has answered" }, "."),
          runs("On the response, select ", { b: "Record what was done" }, "."),
          runs("Write it under ", { b: "What happened next" }, " and select ", { b: "Save" }, "."),
        ),
        p("It is kept against the response with your name and the date, and the colleague the feedback named is told. While a score of 3 or below has no answer, marketing campaigns leave that customer out."),
      ),
      task(
        "Find feedback",
        p(runs("Search for a company, a reference or what they wrote, and use ", { b: "Show" }, " to pick ", { b: "Answered" }, ", ", { b: "Waiting for a reply" }, ", ", { b: "3 stars or below" }, " or ", { b: "Low scores nobody has answered" }, ". The strip at the top gives the ", { b: "Average" }, ", how many ", { b: "Replied" }, " and the ", { b: "Spread" }, " of scores for what is shown.")),
        p(runs("A customer's own ", { b: "Feedback" }, " tab shows the same for that customer.")),
      ),
      task(
        "Send a link again or withdraw it",
        ol(
          runs("Find the response while it is ", { b: "Waiting for a reply" }, "."),
          runs("Select ", { b: "Show the link again" }, " to copy it again, or ", { b: "Withdraw" }, " to close it at once."),
        ),
        p("Once a customer has answered, the request can't be withdrawn: that would delete what they said."),
      ),
      task(
        "See what customers said about you",
        p(runs("Open ", { b: "Support › About me" }, ". It lists the answered feedback where you were named as the person the customer dealt with. The overall score is about the company; the score next to your name is about you.")),
      ),
    ],
    settings: [
      setting(
        "Public review page",
        "Settings › Customer feedback",
        p(runs("Your Google Business Profile review link (in Google Business Profile, “Ask for reviews” gives a short link ending in /review). It has to start with https://. Leave it blank and nobody is sent anywhere; the feedback is still recorded.")),
      ),
      setting(
        "Offer it from",
        "Settings › Customer feedback",
        p(runs("Which customers are offered the review page after answering, by their overall score: ", { b: "Everybody, whatever they rate" }, ", or a number of stars and above. The default is 4 stars and above. Every answer is stored either way.")),
      ),
      setting("A link lasts", "Settings › Customer feedback", p("How many days a new link stays open, from 1 to 365. The default is 30. It applies to links made after you change it.")),
      setting("What the form says at the top", "Settings › Customer feedback", p("Words for the customer, above the questions. Leave it blank for the default.")),
    ],
    faq: [
      qa(
        "I don't see Customer Feedback in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
      qa(
        "Why can't I see Ask for feedback?",
        p("You need the permission to ask customers for feedback, and the customer has to be one you can see. A vendor's page has no Feedback tab. A reseller's end customer can't be asked."),
      ),
      qa(
        "The customer says the feedback link is closed.",
        p("It has expired, been withdrawn or already been answered. A link works once. Make a new one from the customer's Feedback tab."),
      ),
      qa("Is a bad score hidden or thrown away?", p("No. Every answer is kept, whatever the score. Only the offer of your review page depends on the score.")),
      qa(
        "Why wasn't a happy customer offered our review page?",
        p("Either no Public review page is set in Settings › Customer feedback, or their overall score was below Offer it from."),
      ),
      qa("Can I ask about a ticket that is still open?", p("No. Only finished work is listed: resolved or closed tickets, completed visits and fulfilled orders.")),
      qa(
        "Who is told when feedback arrives?",
        p("The colleague it names, the person who asked for it and the customer's account manager get a notification in the app. Each can switch it off in Settings › Notification preferences."),
      ),
      qa(
        "What do the colours mean?",
        table(
          ["Score", "Shown as"],
          [
            ["4 or 5", "Green"],
            ["3", "Amber"],
            ["1 or 2", "Red"],
          ],
        ),
        p("In the summary, 4 and 5 count as happy and 3 or below as not. A 3 is followed up like a 1 or a 2."),
      ),
    ],
    related: ["helpdesk", "companies", "marketing", "customer_portal"],
  },
};

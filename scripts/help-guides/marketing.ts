import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Marketing Automation — written from src/app/(dashboard)/marketing (Campaigns, a campaign's report,
 * Send a mass mail, Journeys, Templates, Audiences, Mailing lists, Suppression list), src/components/
 * marketing, src/actions/marketing.ts and messaging-provider.ts (who may do what), src/lib/marketing
 * (the checks before every send in suppression.ts and pipeline.ts, consent and topics, the footer,
 * unsubscribing, triggers and journeys, sending hours) and Settings › Mail & messaging
 * (src/components/settings/marketing-manager.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/marketing-automation",
  title: "Marketing Automation",
  seo: {
    title: "Marketing automation: campaigns, journeys and consent",
    description: "How to send email campaigns and triggered journeys in {siteName}, build audiences and mailing lists, and how consent, unsubscribes and suppression are checked before every send.",
    keywords: ["marketing automation", "email campaigns", "customer journeys"],
  },
  guide: {
    module: "marketing",
    heading: "Marketing Automation",
    summary: "Campaigns and triggered journeys built from what your records already know: a renewal coming up, a warranty running out, more staff than seats. Every recipient is checked against consent and suppression first, and a reseller's end customers are never reachable.",
    purpose: [
      p("Marketing Automation sends email to your customers' contacts, as one-off campaigns or as journeys that start when something happens to a customer. Who it goes to comes from what is already in the system, not from a separate list kept somewhere else."),
      ul(
        runs({ b: "Templates" }, ": the wording of what is sent, with fields like the person's first name filled in for each recipient."),
        runs({ b: "Audiences" }, ": a saved set of filters over your companies, plus rules about who at each company to write to."),
        runs({ b: "Mailing lists" }, ": people uploaded from a spreadsheet, each made a contact, with a note of how they agreed to hear from you."),
        runs({ b: "Campaigns" }, ": a template sent once to an audience, a list, or both."),
        runs({ b: "Journeys" }, ": something happens to a customer and a sequence of steps starts. A step can email the customer, or give one of your people a task instead."),
        runs({ b: "Suppression list" }, ": who must not be written to, and why."),
      ),
      p("Before anything goes out, every recipient is checked: that they agreed to hear about the template's topic, haven't unsubscribed, bounced or marked you as spam, and have a working, checked address. A customer is also held back while they have a low feedback score nobody has answered, a ticket past its deadline, or an invoice 60 days or more overdue. The report says why each person was held back."),
      note("A reseller's end customers are left out of every audience and refused at every send. Their relationship belongs to the reseller."),
    ],
    access: [
      p("Four permissions split the work, because building something is not the same as sending it: building campaigns, sending them, approving a large send, and seeing the results."),
      p(runs("Campaigns, Journeys, Templates, Audiences and Mailing lists show their contents to people who can see marketing results or build campaigns. ", { b: "Send a mass mail" }, " and the ", { b: "Suppression list" }, " need the permission to build campaigns.")),
      p(runs("A send to as many people as ", { b: "Approval needed above" }, ", or more, waits until somebody else with the permission to approve a large send approves it. Nobody can approve a campaign they built, so that permission has to be held by at least two people for large sends to work.")),
      p(runs("The mail providers, the sending domain and the sending hours are in ", { b: "Settings › Mail & messaging" }, ", which needs the permission to change organisation settings.")),
    ],
    permissions: [
      perm("section.marketing", "Shows Marketing Automation in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("marketing.manage", "Build campaigns: write templates, build audiences, upload mailing lists, set up journeys, save campaigns as drafts, use Send a mass mail and look after the suppression list. Without the permission to send, what it builds waits for somebody who can. Management has it by default."),
      perm("marketing.send", "Put a campaign in the queue, start or pause a journey, stop a campaign and run the scheduler by hand. This reaches many customers at once and can't be recalled. Management has it by default."),
      perm("marketing.approve", "Approve a campaign big enough to need a second person. Nobody can approve their own. Management has it by default."),
      perm("marketing.viewAll", "See campaigns, journeys, templates, audiences and lists, and what was sent to whom, including why somebody was left out. Read-only on its own. Management and Sales have it by default."),
      perm("settings.manage", "Opens Settings › Mail & messaging: the providers, the sending domain and the sending hours. Only admins have it by default."),
    ],
    setup: [
      p("An admin sets up the sending side once, in Settings › Mail & messaging:"),
      ol(
        runs("Under ", { b: "Mail providers" }, ", select ", { b: "Set up" }, " on the service that will send your marketing, fill in its details, tick ", { b: "Switched on" }, " and ", { b: "Carries marketing" }, ", and give a ", { b: "From name" }, " and ", { b: "From address" }, ". Save it and select ", { b: "Test" }, "."),
        runs("Under ", { b: "Sending domain" }, ", enter the domain marketing goes out from (a subdomain, kept apart from the one your invoices come from) and select ", { b: "Check SPF, DKIM and DMARC" }, ". Fix what it reports with whoever runs your domain."),
        runs("Set the provider's delivery reports to the address shown under ", { b: "Delivery reports" }, ", so bounces and spam complaints come back and stop the next campaign reaching a dead address."),
        runs("Check ", { b: "When, and how often" }, ": quiet hours, weekends and holidays, how often one contact may hear from you, the approval size and the postal address for the footer. Select ", { b: "Save" }, "."),
      ),
      p(runs("Then give people the permissions they need in ", { b: "Settings › Roles & Permissions" }, ".")),
      note("Marketing only reaches people who agreed to hear about the template's topic. Consent is recorded when you upload a mailing list, with your note as the evidence, and when a person chooses topics on their own preferences page. A customer's Marketing tab shows what each of its contacts has agreed to."),
    ],
    tasks: [
      task(
        "Write a template",
        ol(
          runs("Open ", { b: "Marketing › Templates" }, " and select ", { b: "New template" }, "."),
          runs("Give it a ", { b: "Name" }, ", keep the ", { b: "Channel" }, " on Email, and choose its ", { b: "Topic" }, ": only contacts who agreed to hear about that topic receive it."),
          runs("Write the ", { b: "Subject" }, ", the ", { b: "Preview line" }, " and the ", { b: "Body" }, ", as plain text or HTML. Or select ", { b: "Upload .html or .zip" }, " for a design exported from an email builder."),
          runs("Use ", { b: "Insert a field" }, " to add a person's name, their company, your name and the like."),
          runs("Select ", { b: "Save" }, ", then ", { b: "Send a test to me" }, " to see it in your own inbox."),
        ),
        p("A field is written as {{firstName|there}}: the part after the bar is what somebody with no value sees. A field with no value and nothing after a bar holds that person back rather than sending a half-filled email. Every email gets a footer with an unsubscribe link and your postal address, unless you have placed them in the body yourself."),
        p("What a template says is fixed onto each message as it is queued, so editing a template later never rewrites what already went out."),
      ),
      task(
        "Build an audience",
        ol(
          runs("Open ", { b: "Marketing › Audiences" }, " and select ", { b: "New audience" }, "."),
          runs("Give it a ", { b: "Name" }, " and, so it still makes sense later, ", { b: "What it's for" }, "."),
          "Choose the company filters: who they are, who owns them, what they've bought, products and brands, renewals, the pipeline, how recently they were called, and what their domain says.",
          runs("Under ", { b: "Who at each company" }, ", pick the ", { b: "Job titles" }, " to write to and ", { b: "At most, per company" }, " (the primary contact is always kept first), or tick ", { b: "Primary contact only" }, "."),
          runs("Select ", { b: "Who'd get this?" }, " to see how many would receive it, how many wouldn't and why. Then select ", { b: "Save" }, "."),
        ),
      ),
      task(
        "Upload a mailing list",
        ol(
          runs("Open ", { b: "Marketing › Mailing lists" }, ". Under ", { b: "Upload a list" }, ", give a ", { b: "List name" }, "."),
          "Choose a CSV file whose first row names the columns: Email (required), Name, Company, Phone, Designation.",
          runs("Under ", { b: "What did they agree to hear about?" }, ", tick the topics, and under ", { b: "How did they agree?" }, " say where and when."),
          "Tick the box confirming that these people agreed to hear from you and the list wasn't bought or scraped.",
          runs("Select ", { b: "Upload list" }, "."),
        ),
        p("Each person is matched to a contact by email address, or added as a new contact. Your note is recorded as the evidence of their consent. Somebody who has already unsubscribed stays unsubscribed. The addresses are checked as the list is uploaded. A list can hold up to 5,000 people, in a CSV of up to 5 MB."),
      ),
      task(
        "Send a mass mail",
        ol(
          runs("Open ", { b: "Marketing › Send a mass mail" }, "."),
          runs("Under ", { b: "Choose the email" }, ", pick a template, or select ", { b: "New or upload" }, " to make one."),
          runs("Under ", { b: "Choose who gets it" }, ", pick an ", { b: "Audience" }, ", an ", { b: "Uploaded list" }, ", or both. Nobody is mailed twice. The summary shows how many will receive it and why the rest are held back."),
          runs("Under ", { b: "Check and send" }, ", check the ", { b: "Campaign name" }, " and choose ", { b: "Now" }, " or ", { b: "Later" }, "."),
          runs("Select ", { b: "Send a test to me" }, " if you want one more look, then ", { b: "Send to … people" }, " or ", { b: "Schedule it" }, "."),
        ),
        p(runs("Without the permission to send, the button reads ", { b: "Save for someone to send" }, ": somebody who can send it does so from the campaign list. A send big enough to need approval waits for a second person.")),
      ),
      task(
        "Build a campaign and send it",
        ol(
          runs("Open ", { b: "Marketing › Campaigns" }, " and select ", { b: "New campaign" }, "."),
          runs("Give it a ", { b: "Name" }, ", choose ", { b: "Who it goes to" }, " (an audience) and ", { b: "What they get" }, " (a template)."),
          runs("If it shouldn't go at once, set ", { b: "Not before" }, ", and ", { b: "Only between" }, " for a daily window."),
          runs("Select ", { b: "Save as draft" }, ". Nothing goes out yet."),
          runs("On the campaign, select ", { b: "Schedule" }, ". Read who receives it and who is held back, and why, then select ", { b: "Send to …" }, " (or ", { b: "Send for approval" }, ")."),
        ),
        p("Messages go out over the next few minutes. Quiet hours, weekends and company holidays apply on top of Not before: a campaign set for 2am on a Sunday waits until Monday morning."),
      ),
      task(
        "Approve a large send",
        ol(
          runs("Open ", { b: "Marketing › Campaigns" }, " and set ", { b: "Status" }, " to ", { b: "Waiting for approval" }, "."),
          runs("Open the campaign's report if you want to check it, then select ", { b: "Approve" }, " on it."),
        ),
        p("Approving queues it straight away. You can't approve a campaign you built."),
      ),
      task(
        "Read a campaign's report, or stop it",
        p(runs("Select a campaign's name. The report shows how many were ", { b: "Sent" }, ", ", { b: "Opened" }, " (approximate), ", { b: "Clicked" }, ", ", { b: "Unsubscribed" }, ", ", { b: "Bounced" }, ", ", { b: "Failed" }, " and ", { b: "Held back" }, ", with ", { b: "What they clicked" }, ", ", { b: "Why some weren't sent" }, ", the latest recipients, and one of the emails as it was sent.")),
        p(runs("To stop a scheduled campaign, select ", { b: "Stop" }, " on it. Messages still waiting aren't sent; any already on their way carry on.")),
      ),
      task(
        "Set up a journey",
        ol(
          runs("Open ", { b: "Marketing › Journeys" }, " and select ", { b: "New journey" }, "."),
          runs("Give it a ", { b: "Name" }, " and choose ", { b: "What starts it" }, ", such as ", { b: "Subscription coming up for renewal" }, ", ", { b: "Warranty running out" }, " or ", { b: "More staff than seats" }, ". Each says what it enrols and what it leaves out. Set its number of days where it asks."),
          runs("To keep it to some customers, choose an audience under ", { b: "Narrow it further" }, "."),
          runs("Under ", { b: "Steps" }, ", select ", { b: "Add" }, ". For each step choose ", { b: "Do what" }, ": ", { b: "Create a task for one of ours" }, " (a title, notes, ", { b: "Give it to" }, " and when it is due) or ", { b: "Email the customer" }, " (a template). Set ", { b: "Days after the previous step" }, "."),
          runs("Tick what should end it under ", { b: "Stop the sequence if" }, ", and fill in ", { b: "May start again after (days)" }, " if it should run again for the same customer, for example 365 for a yearly renewal."),
          runs("Select ", { b: "Who'd it catch?" }, ", then ", { b: "Save as draft" }, "."),
          runs("On the journey, select ", { b: "Start" }, ". ", { b: "Pause" }, " holds everybody where they are."),
        ),
        p("A task step needs no mail provider at all; it goes to the customer's account manager or caller. An email step writes to the contact the trigger found, or else to the customer's primary contact, and only to a checked address. Unsubscribing from everything ends any journey the person is in. The bottom of the Journeys page lists everything that can start one."),
      ),
      task(
        "Keep somebody from being written to",
        ol(
          runs("Open ", { b: "Marketing › Suppression list" }, " and select ", { b: "Suppress somebody" }, "."),
          runs("Under ", { b: "What" }, ", choose an ", { b: "Address" }, " or a ", { b: "Whole domain" }, " (or a contact or company), type it, and say ", { b: "Why" }, "."),
          runs("Select ", { b: "Add" }, "."),
        ),
        p("Unsubscribes, bounces and spam complaints land on the list by themselves. An unsubscribe or a complaint can't be removed by hand: if the person wants to hear from you again, they choose topics on their own preferences page, from the link in any email you sent them."),
      ),
    ],
    settings: [
      setting(
        "Mail providers",
        "Settings › Mail & messaging",
        p(runs("The services that actually send, such as Resend, Amazon SES, Elastic Email, Microsoft 365 (SMTP) or any other SMTP server. Each carries the kinds of message you tick for it, ", { b: "Carries transactional" }, " and ", { b: "Carries marketing" }, ". ", { b: "Order" }, " decides which goes first: lower goes first, and if one fails in a way worth retrying, the next one takes it.")),
        p("The same providers send other modules' mail, such as documents and helpdesk replies, when they carry transactional mail. Keep that on your main domain, and send marketing from a subdomain, so a campaign that annoys people can never stop your invoices arriving."),
        note(runs({ b: "Mock (records, sends nothing)" }, " is for trying things out. Its messages are recorded as sent, but nothing is delivered.")),
      ),
      setting("Sending domain", "Settings › Mail & messaging", p(runs("The domain marketing goes out from, checked with ", { b: "Check SPF, DKIM and DMARC" }, ". The address mail actually comes from is each provider's ", { b: "From address" }, "."))),
      setting(
        "When, and how often",
        "Settings › Mail & messaging",
        ul(
          runs({ b: "Quiet from" }, " and ", { b: "Until" }, ": nothing marketing goes out between these. The default is 8:00 pm to 9:00 am."),
          runs({ b: "Skip weekends and company holidays" }, ": on by default. Uses the same holiday calendar as HR; restricted holidays don't count."),
          runs({ b: "Most a contact hears from us" }, ": per week, across every campaign and journey at once. The default is 2."),
          runs({ b: "Approval needed above" }, ": the number of recipients at which a second person has to approve a send. The default is 200."),
          runs({ b: "Postal address for the footer" }, ": printed at the bottom of every marketing email. Leave it blank to use your registered office."),
        ),
      ),
      setting("Delivery reports", "Settings › Mail & messaging", p("The address to give your provider for bounces and complaints. The key in it is your workspace's own, so keep it out of anything public.")),
      setting(
        "Templates & journeys",
        "Marketing › Templates and Marketing › Journeys",
        p("What gets sent, to whom, and what starts it. Settings links here; the templates and journeys themselves are built in the module, as described in the tasks above."),
      ),
      setting(
        "Suppression list",
        "Marketing › Suppression list",
        p("Who must not be written to: They asked us to stop, Bounced, Marked us as spam, or Added by hand. Everything else that stops a send, like a reseller's customer or an unchecked address, is worked out fresh each time, so fixing the problem is enough on its own."),
      ),
      setting(
        "Topic",
        "In each template",
        p("What the message is about, and so who may receive it:"),
        table(
          ["Topic", "What it covers"],
          [
            ["Renewal reminders", "When a subscription or AMC is coming up for renewal."],
            ["Service notices", "Outages, maintenance windows and anything affecting their systems."],
            ["Offers and pricing", "Deals, bundles and vendor price changes."],
            ["Product news", "New products and features worth knowing about."],
            ["Events and webinars", "Invitations to things you run or take part in."],
            ["Newsletter", "The occasional round-up."],
          ],
        ),
      ),
    ],
    faq: [
      qa(
        "I can't see Marketing in the menu, or Send a mass mail is missing.",
        p("Either the module is switched off for your company, the section is hidden for your role, or you don't have the permission you need. Send a mass mail and the Suppression list need the permission to build campaigns. Ask an admin: the switch is in Settings › Modules, and the section and the permissions are in Settings › Roles & Permissions."),
      ),
      qa(
        "Why were some people held back?",
        p("The report, and the check before sending, give a reason for each:"),
        table(
          ["Reason", "What to do"],
          [
            ["Reseller's customer", "Nothing: go through the reseller."],
            ["No address, Address doesn't work, Bounced before", "Get a working address for the contact."],
            ["Marked us as spam, Unsubscribed, Suppressed by hand", "They are not to be written to."],
            ["Never opted in", "No recorded consent for this topic."],
            ["Address not verified", "The address has never been checked, or is a shared or free-mail one."],
            ["Complaint unanswered", "Record what was done about their low feedback score first."],
            ["Ticket past its SLA", "Sort out their overdue ticket first."],
            ["Invoice overdue", "An invoice is 60 days or more overdue: accounts go first."],
            ["Heard from us too recently", "They have had this week's share from you already."],
          ],
        ),
      ),
      qa(
        "Nothing has gone out.",
        p(runs("Check the top of ", { b: "Marketing › Campaigns" }, ". It warns when no provider carries marketing, and it says when the scheduler that sends the queue last ran. If you can send campaigns, ", { b: "run it now" }, " sends what is waiting. Remember that quiet hours, weekends and holidays hold messages back.")),
      ),
      qa("Can we write to a reseller's customers?", p("No. They are left out of every audience and refused at every send, whatever list they are on.")),
      qa(
        "How does somebody unsubscribe?",
        p("Every email ends with a link to their own preferences page, where they choose the topics they want or unsubscribe from everything. Unsubscribing puts them on the suppression list and ends any journey they are in. Mail about their account, such as an invoice, still reaches them."),
      ),
      qa("Why does a campaign wait for approval?", p("It goes to at least as many people as Approval needed above in Settings › Mail & messaging. Somebody else with the permission to approve a large send has to approve it.")),
      qa(
        "Why didn't a journey step send an email?",
        p("An email step writes to the contact the trigger found, or else to the customer's primary contact, and only when their address has been checked, they agreed to the template's topic, and nothing else holds them back. A task step instead needs the customer to have an account manager or caller to give it to."),
      ),
    ],
    related: ["forms", "companies", "resellers", "feedback"],
  },
};

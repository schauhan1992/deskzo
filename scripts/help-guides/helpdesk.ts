import { note, ol, p, perm, qa, runs, setting, table, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Helpdesk / Tickets — written from src/app/(dashboard)/tickets (the list, a ticket, New ticket, the
 * Support inbox, Support load), src/components/tickets, src/actions/ticket.ts and support-mail.ts (who
 * may do what), src/lib/support-mail (how an email becomes a ticket), src/lib/tickets.ts (the SLA),
 * src/lib/support/load.ts, src/lib/authz/access.ts (which tickets somebody reaches), the Support email
 * and Word filter settings screens, and src/lib/notifications/catalogue.ts.
 */
export const guide: SeedGuide = {
  slug: "help/helpdesk",
  title: "Helpdesk / Tickets",
  seo: {
    title: "Helpdesk: support tickets, by hand and by email",
    description: "How to log and work support tickets in {siteName}, turn your support email into tickets, reply to customers from a ticket and see which customers need the most support.",
    keywords: ["helpdesk", "support tickets", "email to ticket"],
  },
  guide: {
    module: "helpdesk",
    heading: "Helpdesk / Tickets",
    summary: "Support tickets against a company and contact, with a priority, a service deadline, an agent and a comment thread for your team. Forward your support mail to your helpdesk address and every email becomes a ticket.",
    purpose: [
      p("The Helpdesk keeps every support request as a ticket against a customer: who raised it, what it is about, how urgent it is, who is working on it and where it stands. Each ticket gets a number like TCK-000123."),
      p(runs("Tickets come in two ways. Somebody logs one with ", { b: "New ticket" }, ", or a customer emails your support address. Once that address forwards its mail to your helpdesk address, each new email opens a ticket. Your replies go back to the customer from the ticket, and their answers land on the same ticket.")),
      p(runs({ b: "Support load" }, " shows which customers take the most support, set against what they were billed over the same months.")),
      note(runs("Comments on a ticket are for your team only. The customer never sees them. To write to the customer, use the reply box in the ticket's ", { b: "Email conversation" }, ".")),
    ],
    access: [
      p("Everybody who can view tickets can open the Helpdesk, and most roles can by default. Which tickets you see follows the customer: if you can see a company, you can see its tickets."),
      p("Logging a ticket and sorting the Support inbox need the permission to create tickets. Deleting a ticket needs its own permission."),
      p(runs("A ticket can only be given to somebody in a support team: a department ticked for ", { b: "Ticket assignment" }, " in ", { b: "Settings › Departments" }, ".")),
      p(runs("An admin can change how far a role reaches into tickets (its own, its team's, its branch's or all of them) in ", { b: "Settings › Roles & Permissions" }, ", and for one person in ", { b: "Settings › Users" }, ". A ticket you can't reach doesn't open.")),
    ],
    permissions: [
      perm("tickets.view", "Opens the Helpdesk: the ticket list, a ticket's page, Support load and the Tickets tab on a customer's page. Which tickets appear follows which customers you can see. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("section.helpdesk", "Shows Helpdesk / Tickets in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm("tickets.create", "Lets somebody log a new ticket, and sort the Support inbox: open a ticket from an email, add an email to a ticket, or leave one out. Without it, Support inbox isn't in the menu. Support, Sales and Management have it by default."),
      perm("tickets.delete", "Lets somebody delete a ticket for good, with its comments, its email conversation and its tasks. Management has it by default."),
      perm("settings.manage", "Opens Settings › Support email and Settings › Word filter. Only admins have it by default."),
    ],
    setup: [
      p("An admin sets this up once:"),
      ol(
        runs("Make a support team. In ", { b: "Settings › Departments" }, ", tick ", { b: "Ticket assignment" }, " for the department (or departments) whose people answer tickets, and make sure those people are in it."),
        runs("Open ", { b: "Settings › Support email" }, ". Under ", { b: "Your helpdesk address" }, ", select ", { b: "Copy address" }, "."),
        runs("In your own mail service, forward the mail that arrives at your support address to your helpdesk address. ", { b: "How to forward your support mail" }, " has the steps for Gmail or Google Workspace, Microsoft 365 or Outlook, Zoho Mail and any other mail service. Your own address keeps working as it does now, and nothing changes on your domain."),
        runs("If Gmail sends a confirmation email, it shows on the same page under ", { b: "Gmail asked to confirm forwarding" }, ". Open its link to finish."),
        runs("Choose how new tickets are answered and who gets them, under ", { b: "New tickets by email" }, ", and which mail your replies go out from, under ", { b: "Replies to customers" }, "."),
        "Send yourself a test email. It should appear as a ticket, or in the Support inbox if you aren't a contact yet.",
      ),
      p("For an email to open a ticket by itself, its sender has to be a contact at one of your customers. Keep your customers' contacts and their email addresses up to date."),
      note(runs("If ", { b: "Settings › Support email" }, " says support email isn't switched on for this platform yet, there is no helpdesk address to forward to. You can still log tickets by hand.")),
    ],
    tasks: [
      task(
        "Log a ticket",
        ol(
          runs("Open ", { b: "Support › Tickets" }, " and select ", { b: "New ticket" }, ". Or open the customer's page and, on its ", { b: "Tickets" }, " tab, select ", { b: "+ New ticket" }, "."),
          runs("Choose the ", { b: "Company" }, ", then the ", { b: "Contact" }, " if it's about one person."),
          runs("If it's about something they bought, choose it under ", { b: "Order this is about" }, ". Otherwise it's logged as ", { b: "Free Support" }, "."),
          runs("Type a ", { b: "Title" }, " and a ", { b: "Description" }, "."),
          runs("Pick the ", { b: "Support type" }, " and the ", { b: "Priority" }, "."),
          runs("Under ", { b: "Assign to" }, ", choose somebody from the support team, or leave it ", { b: "Unassigned" }, "."),
          runs("Select ", { b: "Create ticket" }, "."),
        ),
        p("The ticket gets its number, and a service deadline worked out from its priority (see the questions below)."),
      ),
      task(
        "Work a ticket",
        ol(
          runs("Open the ticket from ", { b: "Support › Tickets" }, "."),
          runs("Change its ", { b: "Status" }, " or ", { b: "Priority" }, ". Each saves as soon as you pick it."),
          runs("To give it to somebody, select the agent (", { b: "Assigned: …" }, " or ", { b: "Unassigned" }, "), choose a person and select ", { b: "Save" }, "."),
          runs("To leave a note for your team, type in ", { b: "Add a comment…" }, " and select ", { b: "Post comment" }, "."),
        ),
        p("Setting a ticket to RESOLVED or CLOSED records when it happened. Moving it back to OPEN, IN PROGRESS or ON HOLD clears that again. The person the ticket is assigned to is told in the app when somebody else changes its status or comments on it."),
      ),
      task(
        "Reply to the customer by email",
        ol(
          runs("Open the ticket. In ", { b: "Email conversation" }, ", the box says who it goes to: ", { b: "Reply to …" }, ", the last person who emailed in, or else the ticket's contact."),
          "Type your reply.",
          runs("Add anybody to copy in under ", { b: "Cc (optional)" }, ", separated by commas."),
          runs("Select ", { b: "Send reply" }, "."),
        ),
        p(runs("Your name is added under the reply. When the customer answers, the answer comes back to the same ticket. If a reply couldn't be sent, it shows ", { b: "Not sent" }, " with the reason.")),
      ),
      task(
        "Sort the Support inbox",
        p("An email that can't find its ticket by itself waits in the Support inbox. The sender isn't a contact yet, is a contact at several companies, has left the company they were a contact at, or answered a ticket from an address that isn't on it. Each email says which."),
        ol(
          runs("Open ", { b: "Support › Support inbox" }, "."),
          runs("To open a ticket, choose the company under ", { b: "Open a ticket at" }, ". Companies where the sender, or others at their domain, are contacts come first. Tick ", { b: "Save … as a contact there" }, " and type ", { b: "Their name" }, " if their next email should open a ticket by itself. Then select ", { b: "Open ticket" }, "."),
          runs("To add the email to a ticket instead, type its number under ", { b: "Or add it to a ticket" }, " and select ", { b: "Add to ticket" }, "."),
          runs("If it doesn't need a ticket at all, select ", { b: "Leave out" }, "."),
        ),
        p("A ticket opened from the Support inbox starts unassigned, and the customer isn't sent the “we've received it” email. Adding an email to a resolved ticket doesn't open it again."),
      ),
      task(
        "Add an email sender as a contact",
        p(runs("When somebody who isn't a contact writes to a ticket, the ticket says so: “… isn't a contact at … yet.” Type ", { b: "Their name" }, " and select ", { b: "Add as contact" }, ". If the ticket has no contact, they become it. You need to be allowed to change that company's contacts.")),
      ),
      task(
        "Change many tickets at once",
        ol(
          runs("In ", { b: "Support › Tickets" }, ", choose the ", { b: "Table" }, " view."),
          "Tick the tickets, or tick the box at the top for every ticket on the page.",
          runs("In the bar that appears, pick an agent, a status, a priority, or any of them."),
          runs("Select ", { b: "Apply" }, "."),
        ),
        p("If one ticket can't be changed, it stops there. The tickets before it are already changed."),
      ),
      task(
        "See which customers take the most support",
        ol(
          runs("Open ", { b: "Support › Support load" }, "."),
          runs("Pick a period: ", { b: "3 months" }, ", ", { b: "6 months" }, ", ", { b: "12 months" }, " or ", { b: "24 months" }, "."),
          runs("Sort by ", { b: "Most tickets" }, ", ", { b: "Most support per rupee" }, " or ", { b: "Most recorded time" }, "."),
        ),
        p(runs({ b: "Heavy support" }, " means at least twice the typical customer's tickets per ₹1 lakh billed, and ", { b: "Light support" }, " half or less. With too few customers to compare, nobody is called heavy or light. Demo tickets aren't counted. The billed figures show only to people who can see payments, and calls and visits only to people who can see those.")),
        p(runs("A customer's own ", { b: "Tickets" }, " tab shows the same picture for the last 12 months.")),
      ),
    ],
    settings: [
      setting(
        "Your helpdesk address",
        "Settings › Support email",
        p(runs("The address to forward your support mail to, with ", { b: "Copy address" }, " and when the last email arrived. ", { b: "How to forward your support mail" }, " below it has the steps for each mail service.")),
      ),
      setting(
        "New tickets by email",
        "Settings › Support email",
        ul(
          runs({ b: "Reply to say we've received it" }, ": on by default. The customer gets the ticket number and can add to the ticket by replying. It is never sent to automatic replies."),
          runs({ b: "Give new tickets to" }, ": a person in a support team, or ", { b: "Nobody — the support team is told" }, " (the default)."),
        ),
      ),
      setting(
        "Replies to customers",
        "Settings › Support email",
        p(runs("Which mail sends your replies and the “we've received it” email, in your company's name: ", { b: "{siteName}'s mail" }, " (the default, nothing to set up), or ", { b: "Your mail server" }, ", the one set up for transactional mail in ", { b: "Settings › Mail & messaging" }, ". With your server, type your support address under ", { b: "Send as" }, ".")),
        p("If your mail server can't send a reply, it goes through the other mail instead and the ticket says why. Customers' answers always come back to the same ticket."),
      ),
      setting(
        "Tickets",
        "Settings › Word filter",
        p(runs("Tick ", { b: "Keep these words out of tickets" }, " to switch it on; it is off until you do. A ticket, a comment or an email reply your people write with one of the words isn't saved, and they're told which words to change. A customer's email still reaches its ticket, with the words shown as stars.")),
        ul(
          runs({ b: "Use {siteName}'s preset of abusive words" }, ": a list in English, Hindi and Hinglish, caught however it's disguised. ", { b: "See the preset's words" }, " lists them."),
          runs({ b: "Your own words" }, ": one a line. End a word with * to catch its endings."),
          runs({ b: "Let these preset words through" }, ": a name or a word your company uses that happens to be in the preset."),
          runs({ b: "Try a message" }, ": type something to see what the filter would do."),
        ),
        p("Words are matched whole, whatever the case. When Chat is on too, it has a list of its own on the same page."),
      ),
      setting("Ticket assignment", "Settings › Departments", p("Tick it for each department whose people can be assigned tickets. Only they are offered under Assign to and Give new tickets to.")),
      setting("Ticket", "Settings › Wording", p("If your company calls a ticket something else, an admin can rename the word. The menu, page titles and most buttons then use your word.")),
    ],
    faq: [
      qa(
        "I can't see Helpdesk / Tickets in the menu.",
        p("Either the module is switched off for your company, the section is hidden for your role, or you don't have the permission to view tickets. Ask an admin: the switch is in Settings › Modules, and the section and the permission are in Settings › Roles & Permissions. Support inbox also needs the permission to create tickets."),
      ),
      qa(
        "How is a ticket's deadline (SLA) worked out?",
        p("From its priority, counted from when the ticket was created:"),
        table(
          ["Priority", "Due within"],
          [
            ["URGENT", "4 hours"],
            ["HIGH", "24 hours"],
            ["MEDIUM", "72 hours"],
            ["LOW", "168 hours (7 days)"],
          ],
        ),
        p("The hours are fixed, and the clock keeps running while a ticket is ON HOLD. A resolved or closed ticket shows Resolved or Closed instead. The person a ticket is assigned to is told when it passes its deadline."),
      ),
      qa(
        "A customer emailed us, but no ticket appeared.",
        p(runs("Look in ", { b: "Support › Support inbox" }, " first. If it isn't there, check that the forwarding works: ", { b: "Settings › Support email" }, " says when the last email arrived. Some mail is never made a ticket, so that no mail loops start: automatic replies, bounces and delivery reports, newsletters and mailing lists, and more than 30 emails an hour from one address.")),
      ),
      qa(
        "Why did a reply go to the Support inbox instead of the ticket it names?",
        p("Only somebody already on a ticket can add to it by email: its contact, or an address in its email conversation. Anybody else's email waits in the Support inbox, so nobody can add to a customer's ticket by guessing its number. Add it to the ticket from there if it belongs."),
      ),
      qa(
        "An email opened a ticket at a company, but the sender isn't a contact there.",
        p("When a sender isn't a contact anywhere, but their email domain is used by contacts at exactly one company, the ticket opens there. The email says it was filed by the sender's domain. Free mail like Gmail never counts. Use Add as contact on the ticket if they should be a contact."),
      ),
      qa(
        "A resolved ticket opened again by itself.",
        p("The customer answered it by email. An email from somebody on the ticket sets a resolved or closed ticket back to OPEN, and its assignee (or the support team) is told."),
      ),
      qa(
        "Why can't I give a ticket to a colleague?",
        p("Only people in a department ticked for Ticket assignment can hold tickets. Ask an admin to tick it in Settings › Departments, or to move the person into a support department."),
      ),
      qa(
        "Who is told about tickets?",
        p("All of it is in the app: the assignee about tickets given to them, status changes, comments and missed deadlines. An email that opens a ticket goes to the person set under Give new tickets to, or to the whole support team; an email waiting in the Support inbox goes to the support team. Each person can switch these off in Settings › Notification preferences."),
      ),
    ],
    related: ["companies", "customer_portal", "feedback"],
  },
};

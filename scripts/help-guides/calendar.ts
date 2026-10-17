import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Calendar — written from src/app/(dashboard)/calendar (the board), src/components/calendar (the week and
 * agenda views, the Schedule meeting dialog with its busy strip, a record's Meetings card, Reschedule and
 * Cancel meeting, the Subscribe dialog, the connection notices), src/actions/calendar.ts (the switch,
 * Schedule meetings, colleagues' busy times only), src/lib/calendar (provider sync, the app's own calendar
 * and its emailed invitations, the overlays of tasks, visits, leave, holidays and bookings, the subscribe
 * feed, held meetings logged on a lead) and src/components/profile/mailbox-connection.tsx (connecting).
 */
export const guide: SeedGuide = {
  slug: "help/calendar",
  title: "Calendar",
  seo: {
    title: "Calendar: your meetings, tasks, visits and leave in one view",
    description: "How to connect Outlook, Google or Zoho Calendar to {siteName}, schedule meetings from a lead or customer, see colleagues' busy times and subscribe from your phone.",
    keywords: ["CRM calendar", "schedule meetings", "calendar sync"],
  },
  guide: {
    module: "calendar",
    heading: "Calendar",
    summary: "Your own Outlook, Google or Zoho calendar kept in step — or the app's own calendar, which emails the invitations — with your tasks, visits, leave and holidays beside your meetings.",
    purpose: [
      p("Calendar is your diary inside the app. Connect your own Outlook calendar, Google Calendar or Zoho Calendar and its meetings show here, kept in step. Meetings you schedule from here go into that calendar, with the invitations sent from it and, if you like, a Teams, Google Meet or Zoho Meeting link."),
      p("If you have no calendar connected, you aren't stopped: the meeting is kept in the app's own calendar, and the invitations are emailed for you with the meeting attached, so it lands in each guest's calendar."),
      p("Beside your meetings, read-only, the page shows your tasks that are due, the visits you've planned, your approved leave, the company's holidays and bookings made with you on a booking page — each only where that module is open to you."),
      p("Meetings can be scheduled straight from a lead, a customer, one of its contacts, a ticket or a planned visit, and stay listed on that record. A meeting scheduled from a lead is added to the lead's timeline as a meeting once it has ended."),
    ],
    access: [
      p("Everybody has their own calendar, and only their own. When you pick a time, you see colleagues' busy times — never what they're busy with, or with whom."),
      ul(
        runs("Scheduling or moving a meeting needs ", { b: "Schedule meetings" }, ". Without it you still see your diary, and you can still cancel a meeting you booked."),
        runs("On a record's ", { b: "Meetings" }, " card you see the meetings you and the people who report to you organised — or everybody's, with ", { b: "See everyone's calls, notes & meetings" }, "."),
        "Calendar isn't shown while an admin is viewing the app as somebody else.",
      ),
    ],
    permissions: [
      perm("section.calendar", "Shows Calendar in the menu and lets people open it. Every role has it until an admin unticks it for one."),
      perm("meetings.schedule", "Book a meeting from a customer, contact, lead, ticket or visit, or from the Calendar page, and reschedule one you booked. Without it, the Calendar still shows your own diary and you can cancel what you booked. Profiling, Calling, Sales, Support, Management, Accounts and Purchase have it by default."),
      perm("activities.viewAll", "On a record's Meetings card (and its activity), see the meetings everybody organised, not just your own and your team's. Management has it by default."),
    ],
    setup: [
      ol(
        runs("An admin switches Calendar on in ", { b: "Settings › Modules" }, "."),
        runs("To let people connect their own calendars, an admin sets up Microsoft 365, Google Workspace or Zoho in the ", { b: "Email & sign-in" }, " card of ", { b: "Settings › Security & data protection" }, "."),
        runs("Each person then connects their own, once: on ", { b: "My profile" }, ", in ", { b: "Your mailbox and calendar" }, ", select ", { b: "Connect Outlook" }, " (or Gmail, or Zoho Mail) and allow the calendar when asked. The Calendar page offers a Connect button too. Mail and calendar connect together."),
      ),
      note("Nobody has to connect a calendar to use this. Without one, meetings go into the app's own calendar and the invitations are emailed."),
    ],
    tasks: [
      task(
        "Find your way around the calendar",
        p(runs("Open ", { b: "My work › Calendar" }, ". Choose ", { b: "Week" }, " for a week at a time (a day at a time down the page on a phone) or ", { b: "Agenda" }, " for the next fortnight as a list. Use the arrows and ", { b: "Today" }, " to move about, and select anything to see its details — including ", { b: "Join the meeting" }, " where it has a link. With a calendar connected, ", { b: "Sync" }, " brings it up to date there and then; ", { b: "Print" }, " opens a printable page of the days shown.")),
      ),
      task(
        "Schedule a meeting",
        ol(
          runs("Select ", { b: "Schedule meeting" }, " on the Calendar page, or on a lead's, customer's or ticket's page — or ", { b: "+ Meeting" }, " in its ", { b: "Meetings" }, " card, or the calendar button beside a contact."),
          runs("Give it a ", { b: "Title" }, ", pick when it ", { b: "Starts" }, " and its ", { b: "Length" }, "."),
          runs("With a calendar connected, leave ", { b: "Add a Teams link" }, " (or Google Meet, or Zoho Meeting) ticked for an online meeting."),
          runs("Under ", { b: "Who's invited" }, ", tick the customer's people, add colleagues with ", { b: "Invite a colleague…" }, ", or type an email address and press Enter."),
          runs("Check ", { b: "Busy that day" }, ": your busy times and each invited colleague's are laid out against the slot you picked."),
          runs("Fill in ", { b: "Where" }, " and an ", { b: "Agenda" }, " if you like, and select ", { b: "Schedule and invite" }, "."),
        ),
        p("You can invite up to 50 people. For a customer that belongs to a reseller, only colleagues can be invited from here."),
      ),
      task(
        "Move or cancel a meeting you organised",
        ol(
          runs("Open the meeting on the Calendar page, or find it in the record's ", { b: "Meetings" }, " card."),
          runs("Select ", { b: "Reschedule" }, ", change it, and select ", { b: "Save and tell everyone" }, " — or select ", { b: "Cancel meeting" }, ", add ", { b: "A line for them (optional)" }, ", and confirm."),
        ),
        p("Either way, everybody invited is told."),
      ),
      task(
        "Put a planned visit in your calendar",
        p(runs("On a planned visit's page, the person making the visit selects ", { b: "Add to my calendar" }, " in its ", { b: "Meetings" }, " card. If the visit is moved or cancelled later, the calendar entry follows — see ", ["Field Visits", "/help/field-visits"], ".")),
      ),
      task(
        "See your calendar on your phone",
        ol(
          runs("On the Calendar page, select ", { b: "Subscribe" }, ", then ", { b: "Make my link" }, "."),
          runs("Copy the address straight away — it's shown only once. On an iPhone or a Mac, use ", { b: "open it to subscribe" }, "; in Google Calendar, add it under Other calendars › From URL; in Outlook, Add calendar › Subscribe from web."),
          runs("Tick ", { b: "Show each meeting's title" }, " if you want titles; left off, it shows only when you're busy."),
        ),
        p("The link shows the meetings kept in the app's own calendar — the ones you arranged here and the ones you're invited to — never who is in them. Keep it to yourself: anybody with the address sees what it shows."),
      ),
    ],
    settings: [
      setting(
        "Your mailbox and calendar",
        "My profile",
        p("Connect, reconnect or disconnect your Outlook, Gmail or Zoho Mail account, which brings your calendar with it. If you didn't allow the calendar when connecting, connect again and allow it. Disconnecting stops your calendar syncing."),
      ),
      setting(
        "Email & sign-in: Microsoft 365, Google Workspace or Zoho",
        "Settings › Security & data protection",
        p("Where an admin sets up the company's Microsoft 365, Google Workspace or Zoho, so each person can connect their own mailbox and calendar."),
      ),
      setting(
        "Subscribe link",
        "My work › Calendar › Subscribe",
        p(runs({ b: "Show each meeting's title" }, " puts titles in your phone's calendar instead of busy times. ", { b: "Make a new link" }, " replaces your link and stops the old one working; ", { b: "Turn it off" }, " ends it.")),
      ),
      setting(
        "Calendar on or off",
        "Settings › Modules",
        p("Switches Calendar on or off for the whole company. Holidays shown on the calendar come from the company's working calendar in Settings › Holidays & leave."),
      ),
    ],
    faq: [
      qa(
        "My calendar says it needs connecting again.",
        p("Your Microsoft, Google or Zoho account stopped letting the app in — often a changed password or a withdrawn permission. Select Reconnect on the Calendar page and allow the calendar. Until then, meetings you schedule go into the app's own calendar."),
      ),
      qa(
        "There's no option to add a Teams, Meet or Zoho Meeting link.",
        p("That option appears only when your own calendar is connected. Meetings kept in the app's own calendar have no meeting link — type one into Where if you need it."),
      ),
      qa(
        "Can colleagues see what's in my calendar?",
        p("No. When somebody picks a time, they see only that you're busy, never the title or who with. For a colleague with no calendar connected, only their meetings in the app's own calendar count as busy."),
      ),
      qa(
        "How do people without a calendar get my invitation?",
        p("It's emailed to them with the meeting attached, so it goes into their own calendar, and replies come back to you. The dialog says which address it will be sent from, and — when it goes through the app's own mail — how many more people can be invited today."),
      ),
      qa(
        "Why can't I schedule a meeting?",
        p("Your role doesn't have the permission to schedule meetings. You can still see your calendar and cancel meetings you already booked. Ask an admin if you need it."),
      ),
      qa(
        "I don't see Calendar in the menu.",
        p("Either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). Ask an admin."),
      ),
    ],
    related: ["tasks", "visits", "booking", "hr"],
  },
};

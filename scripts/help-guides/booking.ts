import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Booking pages — written from src/app/(dashboard)/booking-pages and src/components/booking (the pages
 * manager and the public booking widget), src/app/(public)/book/[slug], src/actions/booking.ts (making and
 * changing pages, booking.manage), src/actions/booking-public.ts and src/lib/booking (the times offered,
 * who gets a booking, the lead and the meeting it makes).
 */
export const guide: SeedGuide = {
  slug: "help/booking-pages",
  title: "Booking pages",
  seo: {
    title: "Booking pages: let customers book a meeting in your free time",
    description: "How to make a booking page in {siteName}: its address, hours, meeting length and hosts — and how each booking becomes a meeting and a lead.",
    keywords: ["booking page", "meeting scheduler", "online appointments"],
  },
  guide: {
    module: "booking",
    heading: "Booking pages",
    summary: "Public pages where customers book a meeting with your team in the time you have free. Each booking lands in the host's calendar with an invitation, and opens a lead in the pipeline you choose.",
    purpose: [
      p("A booking page saves the back-and-forth of finding a time. You share its address — on your website, in an email signature, in a message — and the customer picks a day and a time that suits them from the times your team is actually free."),
      p("Each page has its own address, its own weekly hours, a meeting length and the people a customer can meet. The times it offers leave out whatever the hosts are already busy with — their calendar's busy times, meetings already in the app and bookings already taken."),
      p("When somebody books, the meeting goes into the host's calendar and the customer gets an invitation. The booking also opens a lead, its company and its contact, as a website enquiry would — owned by the host it went to."),
      note("Where your workspace doesn't have leads, a booking still adds the company and the contact, just no lead."),
    ],
    access: [
      p("Only people allowed to manage booking pages can open Booking pages, make and change pages, and see what has been booked. For anybody else the page isn't there."),
      p("Hosts don't need that permission. Anybody active in the workspace with an email address can be a host, and their bookings come to them as calendar meetings and notifications."),
      p("The booking pages themselves are public: anybody with the address can book, without signing in."),
    ],
    permissions: [
      perm("booking.manage", "Opens Booking pages: make and change the pages customers book on — their address, hours, meeting length and hosts — switch them off, and see what has been booked. Management has it by default."),
      perm("section.booking", "Shows Booking pages in the menu under Sales and lets people open it. Every role has it until an admin unticks it for one."),
    ],
    setup: [
      p("Somebody who manages booking pages makes each page once. Before that:"),
      ul(
        "Make sure each host has an email address on their user — the invitation's replies go to it. Somebody without one can't be chosen as a host.",
        runs("Ask hosts to connect their Outlook, Google or Zoho calendar from ", { b: "My work › Calendar" }, ". Their busy times are then left out of the page, and a booking can come with an online meeting link. Without a connected calendar, a booking goes into {siteName}'s own calendar and the invitation is emailed."),
        "Decide which pipeline bookings should open leads in — the main one, or a team pipeline.",
      ),
    ],
    tasks: [
      task(
        "Make a booking page",
        ol(
          runs("Open ", { b: "Sales › Booking pages" }, " and select ", { b: "New booking page" }, "."),
          runs("Give it a ", { b: "Title" }, " — what the customer sees, such as Product demo. The ", { b: "Address" }, " fills in from it; change it if you like."),
          runs("Under ", { b: "What it is for" }, ", say what the meeting is about. It's shown on the page."),
          runs("Choose the ", { b: "Length" }, ", how many ", { b: "Days ahead" }, " it can be booked, the ", { b: "Notice (hours)" }, " you need, and any ", { b: "Gap between (minutes)" }, " meetings."),
          runs("Tick the people under ", { b: "Who customers can meet" }, "."),
          runs("Set the ", { b: "Hours" }, " for each day it's open; untick a day to close it."),
          runs("Choose the pipeline under ", { b: "Open a lead in" }, ", and whether to ", { b: "Add an online meeting link" }, "."),
          runs("Leave ", { b: "Taking bookings" }, " ticked and select ", { b: "Make the page" }, "."),
        ),
        p("The page's address is shown on its card. Open it to see what customers see, and copy it to share."),
      ),
      task(
        "Share a booking page",
        p(runs("Copy the address from the page's card in ", { b: "Sales › Booking pages" }, " — it ends in /book/ and the page's address. Put it on your website, in an email, an email signature or a message. Anybody with it can book.")),
      ),
      task(
        "What the customer does",
        ol(
          runs("They open the address and pick a day under ", { b: "Choose a day" }, ", then a time under ", { b: "Choose a time" }, ". Times are shown in your workspace's time zone, and the page says which."),
          runs("They enter ", { b: "Your name" }, " and ", { b: "Email" }, ", and if they like their ", { b: "Company" }, ", ", { b: "Phone" }, " and ", { b: "Anything we should know?" }, "."),
          runs("They select ", { b: "Book" }, " and see ", { b: "You're booked" }, ", with who they're meeting and when."),
        ),
      ),
      task(
        "See what has been booked",
        p(runs("The ", { b: "Bookings" }, " list on ", { b: "Sales › Booking pages" }, " shows the coming bookings (and yesterday's): when, who booked — linked to their lead — who they're meeting, and on which page. Each page's card also says how many are ", { b: "coming up" }, ".")),
      ),
      task(
        "Change or switch off a page",
        ol(
          runs("Select ", { b: "Change" }, " on the page's card, make your changes and select ", { b: "Save" }, ". Untick ", { b: "Taking bookings" }, " to stop new bookings without losing the page."),
          runs("To remove a page, select ", { b: "Delete" }, ". A page that has been booked is switched off instead, so its bookings are kept — the button says ", { b: "Switch off" }, " while bookings are coming up."),
        ),
      ),
    ],
    settings: [
      setting("Title and Address", "In each booking page", p("The title is what the customer sees, up to 80 characters. The address is 3 to 41 lower-case letters, digits and hyphens, and must not be used by another page. Changing it breaks the old link.")),
      setting("What it is for", "In each booking page", p("A description shown on the page, up to 1,000 characters.")),
      setting("Length", "In each booking page", p("How long a meeting is: 15, 20, 30, 45, 60, 90 or 120 minutes. Times start every half hour, or every meeting length when that is shorter.")),
      setting("Days ahead, Notice (hours) and Gap between (minutes)", "In each booking page", p("How far ahead it can be booked (1 to 90 days), how much warning you need before a meeting (0 to 336 hours), and how much time is kept clear before and after anything a host is busy with (0 to 120 minutes).")),
      setting(
        "Who customers can meet",
        "In each booking page",
        p("Up to ten hosts. A customer doesn't pick the person: a booking goes to whichever host is free at that time, the one with the fewest bookings coming up first. A time is offered while at least one host is free."),
      ),
      setting("Hours", "In each booking page", p("Each day's opening hours, in your workspace's time zone. At least one day must be open. New pages start Monday to Friday, 9:00 to 17:00.")),
      setting("Open a lead in", "In each booking page", p("The pipeline a booking's lead starts in. Shown only where your workspace has leads.")),
      setting("Add an online meeting link", "In each booking page", p("Adds an online meeting to the invitation when the host's calendar is connected. The page tells the customer the link comes with the invitation.")),
      setting("Taking bookings", "In each booking page", p("Whether the page is in use. Switched off, its address says the booking page isn't available.")),
    ],
    faq: [
      qa(
        "I don't see Booking pages in the menu.",
        p("The module may be switched off for your company, your role may have had the section hidden, or you may not be allowed to manage booking pages. Ask an admin: the switch is in Settings › Modules, and the section and permission are in Settings › Roles & Permissions."),
      ),
      qa(
        "It says nobody can host yet.",
        p("A host has to be somebody active in the workspace with an email address on their user. Check in Settings › Users that the people who should take meetings are active."),
      ),
      qa(
        "Customers see \"No times are free just now\".",
        p("Every time in the page's hours is taken, too soon for the notice you set, or beyond the days ahead — or the hosts' calendars show them busy. Widen the hours, add a host or shorten the notice."),
      ),
      qa(
        "A customer was told the time had just been taken.",
        p("Somebody else booked it, or the host became busy, between the customer opening the page and booking. The same time can never be booked twice. They can choose another."),
      ),
      qa(
        "The customer didn't get an invitation.",
        p("If the meeting couldn't be added to the host's calendar, the customer is told the host will send an invitation, and the host's notification says what went wrong. The host should then send one themselves."),
      ),
      qa(
        "Who does the lead belong to?",
        p("The host the booking went to. The lead is titled with the page and the customer's company (or name), and its company and contact are matched to ones already on file where they exist, as with a website enquiry."),
      ),
    ],
    related: ["leads", "calendar", "automate"],
  },
};

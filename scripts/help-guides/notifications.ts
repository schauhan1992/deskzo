import { note, ol, p, perm, qa, runs, setting, task } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Notifications — written from src/app/(dashboard)/notifications (Inbox, Archived, Preferences),
 * src/components/notifications (the list with its bulk actions, the per-kind switches, Sounds),
 * src/components/layout/notification-bell.tsx (the bell), src/actions/notification.ts,
 * src/lib/notifications/catalogue.ts (every kind, its group, the always-on ones), src/lib/notify.ts (what
 * is made when, preferences applied, which kinds are emailed) and src/lib/reminder-sounds.ts.
 */
export const guide: SeedGuide = {
  slug: "help/notifications",
  title: "Notifications",
  seo: {
    title: "Notifications: your inbox of alerts, and what you're told",
    description: "How the notification bell and inbox work in {siteName}: find and archive notifications, choose which kinds reach you, and turn reminder sounds on or off.",
    keywords: ["notifications", "notification preferences", "reminder sounds"],
  },
  guide: {
    module: "notifications",
    heading: "Notifications",
    summary: "Everything the app has told you, past the latest twenty the bell holds — searchable and archivable — with a switch for each kind, so you can turn down what you don't need.",
    purpose: [
      p("Notifications are how the app tells you something needs you: a task assigned to you or overdue, a callback due, a meeting about to start, a lead or ticket handed to you, an expense decided, a mention in chat."),
      p("The bell at the top of every page holds your latest twenty. The Notifications page holds all of them, with filters, an archive, and your preferences: a switch for each kind, so you can switch off what you don't need instead of learning to ignore the bell."),
    ],
    access: [
      p("Everybody has their own notifications, and only their own. Nobody else can read them, and the preferences you set apply only to you."),
      p("A few security notices are always on and can't be switched off, because their whole point is that you're told: a security alert, somebody opening a password you own, and somebody opening a project credential."),
    ],
    permissions: [
      perm("section.notifications", "Shows Notifications in the menu and lets people open the page. Every role has it until an admin unticks it for one."),
    ],
    setup: [
      p("There's nothing to set up. Every kind of notification is on until you switch it off, so a new kind reaches you without your having to find it."),
      p(runs("Each person tunes their own on the ", { b: "Preferences" }, " tab. An admin can switch the module off for the whole company in ", { b: "Settings › Modules" }, ".")),
    ],
    tasks: [
      task(
        "Check what's new",
        ol(
          "Select the bell at the top of the page. Unread notifications are marked with a dot.",
          "Select a notification to go to what it's about; it's marked read.",
          runs({ b: "Mark all read" }, " clears the count; ", { b: "See all notifications" }, " opens the full list."),
        ),
      ),
      task(
        "Find an older notification",
        ol(
          runs("Open ", { b: "My work › Notifications" }, "."),
          runs("Narrow the ", { b: "Inbox" }, " by kind (", { b: "Any kind" }, "), by date (", { b: "Any date" }, "), or to ", { b: "Unread only" }, "."),
        ),
      ),
      task(
        "Archive or delete notifications",
        ol(
          runs("Tick the notifications you want, or ", { b: "Select all on this page" }, "."),
          runs("Select ", { b: "Archive" }, " to move them to the ", { b: "Archived" }, " tab, or ", { b: "Delete" }, " to remove them for good."),
        ),
        p(runs("Archiving also marks them read. On the Archived tab, ", { b: "Put back" }, " returns them to the inbox.")),
      ),
      task(
        "Choose what you're told about",
        ol(
          runs("Open ", { b: "My work › Notifications" }, " and select ", { b: "Preferences" }, "."),
          runs("Under each group, untick ", { b: "In app" }, " for any kind you don't want in the bell."),
        ),
        p(runs("Each switch saves straight away. If you've switched some off, ", { b: "Turn all … back on" }, " puts everything back.")),
      ),
      task(
        "Turn reminder sounds on or off",
        p(runs("On the ", { b: "Preferences" }, " tab, the ", { b: "Sounds" }, " card plays a chime when a reminder or a chat message arrives. Untick ", { b: "Play a sound when a reminder or a chat message arrives" }, " to silence them all, or untick one kind — a meeting about to start, a task due or overdue, a note reminder, a callback due, a new chat message. ", { b: "Play the sound" }, " lets you hear it.")),
      ),
    ],
    settings: [
      setting(
        "Notification preferences",
        "Settings › Notification preferences — the Preferences tab of My work › Notifications",
        p("A row for every kind of notification, grouped into My work, Sales, Support, Money, People, Customers and Security, each saying when it's sent. In app decides whether it reaches your bell. Switching In app off for a kind stops that kind altogether, its email included."),
        note("The Email column is there for each kind, but today only one is actually emailed: a proforma issued on your deal. The rest are kept for when they're sent by email too."),
      ),
      setting(
        "Sounds",
        "My work › Notifications › Preferences",
        p("The chime plays while the app is open in a browser tab, after you've clicked anywhere on it once — browsers don't allow sound before that. Your choice follows you from one browser to another."),
      ),
    ],
    faq: [
      qa(
        "Why can't I switch off a security notification?",
        p("A security alert, somebody opening a password you own and somebody opening a project credential are always on. Access nobody is told about is access nobody reviews."),
      ),
      qa(
        "I set a reminder but didn't hear anything.",
        p("Sounds play only while the app is open in a tab, and only after you've clicked on the page once. Check the Sounds card on the Preferences tab too — that kind may be switched off."),
      ),
      qa(
        "A reminder came late.",
        p("Reminders, due tasks and meetings about to start are checked while you have the app open. If it was closed at the time, the notification is there the next time you open it."),
      ),
      qa(
        "Why don't I get these by email?",
        p("Today only one kind is emailed — a proforma issued on your deal. Everything else reaches the bell and the Notifications page."),
      ),
      qa(
        "Can I get back a notification I deleted?",
        p("No — Delete removes it for good. Archive instead if you might want it again."),
      ),
      qa(
        "I don't see Notifications in the menu.",
        p("Either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). Ask an admin."),
      ),
    ],
    related: ["tasks", "calendar", "chat", "notes"],
  },
};

import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Chat — written from src/app/(dashboard)/chat, src/components/chat (the chat list with search and
 * desktop alerts, the thread with replies, reactions, pins, edit and delete, the new chat, new group and
 * group info dialogs, the Settings › Chat form and the super admin's export), src/actions/chat.ts and
 * chat-admin.ts (members only, refused while viewing as somebody, mentions, record cards), src/lib/chat/rules.ts
 * (limits, the edit and delete windows, file types, retention choices, mute lengths), and Settings › Word
 * filter (src/app/(dashboard)/settings/word-filter, src/components/settings/word-filter-form.tsx,
 * src/lib/word-filter).
 */
export const guide: SeedGuide = {
  slug: "help/chat",
  title: "Chat",
  seo: {
    title: "Chat: private team messaging inside your workspace",
    description: "How to chat one to one and in groups in {siteName}, share files and records, mention colleagues, and how admins set file, retention and word-filter rules.",
    keywords: ["team chat", "internal messaging", "group chat"],
  },
  guide: {
    module: "chat",
    heading: "Chat",
    summary: "Chat between colleagues — one to one and in groups, with files, replies, reactions and read ticks — that never leaves the workspace. Only the people in a chat can read it.",
    purpose: [
      p("Chat is messaging for your team, built into the app. You can message any colleague one to one, or make a group — for a team, a department, a project. Messages can carry files, reply to an earlier message, mention somebody with @, and get a reaction."),
      p("Messages and files stay in your workspace's own database. Only the people in a chat can read it — admins included. Ticks show when a message has been delivered and read."),
      p("Paste a link to a customer, lead, order or ticket and it shows as a card. Each reader sees the record's name only if they're allowed to open it themselves, so sharing a link never shares access."),
    ],
    access: [
      p("Everybody can chat with any active colleague. A chat is readable only by its members:"),
      ul(
        "Nobody browses other people's chats — not managers, not admins.",
        runs("The workspace's super admin alone can export one chat, for an investigation or a legal request, from ", { b: "Settings › Chat" }, ". They see who is in a chat, never what was said, until they export it — and every export is recorded in the audit trail and the activity log."),
        "Chat isn't available while an admin is viewing the app as somebody else.",
      ),
      p("In a group, its admins rename it, add and remove people and make others admins. Whoever creates a group is its first admin. Anyone can leave a group."),
    ],
    permissions: [
      perm("section.chat", "Shows Chat in the menu and lets people chat with colleagues. Every role has it until an admin unticks it for one."),
      perm("settings.manage", "Opens Settings › Chat (view-only files, how long messages are kept) and Settings › Word filter. Only admins have it by default."),
    ],
    setup: [
      p("Chat works as soon as the module is on — nothing has to be set up."),
      p("An admin may want to decide, once:"),
      ul(
        runs("whether files sent in chat can be downloaded, and how long messages are kept — in ", { b: "Settings › Chat" }, ";"),
        runs("whether to keep abusive words out of chat — in ", { b: "Settings › Word filter" }, ", which is off until switched on."),
      ),
    ],
    tasks: [
      task(
        "Message a colleague",
        ol(
          runs("Open ", { b: "My work › Chat" }, ", or the chat icon at the top of the page."),
          runs("Select ", { b: "New chat" }, " and search for the person by name or department."),
          "Type your message and send it.",
        ),
        p("There's one chat for each pair of people, whoever starts it."),
      ),
      task(
        "Make a group",
        ol(
          runs("In the chat list, select ", { b: "New group" }, "."),
          runs("Type a ", { b: "Group name" }, "."),
          runs("Pick people, or use ", { b: "Add my team" }, " or ", { b: "Add a department…" }, " to add many at once."),
          runs("Select ", { b: "Create group" }, "."),
        ),
        p(runs("Later, open ", { b: "Group info" }, " from the chat's menu to rename it, use ", { b: "Add people" }, ", ", { b: "Make admin" }, " or ", { b: "Remove" }, " — or ", { b: "Leave group" }, ". When you leave, you keep what was said until then.")),
      ),
      task(
        "Reply, react, pin, edit or delete",
        p("Point at a message to see its buttons:"),
        ul(
          runs({ b: "React" }, " — one of six emoji, one per person."),
          runs({ b: "Reply" }, " — answers that message, quoting it."),
          runs({ b: "Pin to the top" }, " — up to three pinned messages a chat; pinning a fourth unpins the oldest."),
          runs({ b: "Edit" }, " — your own message, within 15 minutes of sending it."),
          runs({ b: "Delete for everyone" }, " — your own message, within an hour of sending it."),
        ),
      ),
      task(
        "Send files",
        p("Attach up to five files to a message, up to 5 MB in all: pictures, PDFs, Word, Excel and PowerPoint files, text, CSV and zip files. Pictures show in the conversation; other files show as a chip to open. Web pages, SVG images and programs can't be sent."),
      ),
      task(
        "Mention somebody in a group",
        p("Type @ and pick a name. They get a notification saying who mentioned them and in which group — never the message itself — even if they've muted the group."),
      ),
      task(
        "Mute a chat, or get desktop alerts",
        ul(
          runs("From a chat's menu, choose ", { b: "Mute for 8 hours" }, ", ", { b: "Mute for 1 week" }, " or ", { b: "Mute for good" }, ". ", { b: "Unmute" }, " undoes it. A muted group still tells you when you're @mentioned."),
          runs("The bell button at the top of the chat list turns on desktop alerts in this browser, so you see new messages while the app is in the background. They say who and where, never what."),
        ),
      ),
      task(
        "Find a message",
        p(runs("Type in ", { b: "Search chats and messages" }, " at the top of the chat list. It finds chats by name and messages by their words, in chats you're in.")),
      ),
    ],
    settings: [
      setting(
        "Files are view-only",
        "Settings › Chat",
        p("When ticked, pictures, PDFs and text files open in the browser with no download button, and other files can't be opened at all. It's a deterrent, like the copy and screenshot rules, not a guarantee."),
      ),
      setting(
        "Keep messages",
        "Settings › Chat",
        p("Keep messages for good (the default), or delete messages older than 90 days, 1 year or 3 years. Older messages are deleted each night, with their files, for everybody — and can't be brought back."),
      ),
      setting(
        "Export a chat",
        "Settings › Chat — the super admin only",
        p("Search for a chat by a person's or a group's name and export it as text. Every export is recorded."),
      ),
      setting(
        "Word filter for chat",
        "Settings › Word filter, the Chat section",
        p(runs("Tick ", { b: "Keep these words out of chat" }, " to switch it on. Use the built-in preset of abusive words in English, Hindi and Hinglish, add ", { b: "Your own words" }, " (one a line; end a word with * to catch its endings), and list any preset words to ", { b: "Let these preset words through" }, ". ", { b: "Try a message" }, " shows what the filter would do. A message or group name with a filtered word isn't sent; only the sender is told which words to change, and nothing is recorded.")),
        note(runs("Tickets have their own list in the same screen — see ", ["Helpdesk", "/help/helpdesk"], ".")),
      ),
      setting(
        "Chat sounds",
        "My work › Notifications › Preferences",
        p("The Sounds card has a switch for a new chat message. Muted chats stay quiet unless you're @mentioned."),
      ),
    ],
    faq: [
      qa(
        "Can my manager or an admin read my chats?",
        p("No. Only the people in a chat can read it. The workspace's super admin can export a single chat for an investigation or legal request, and every export is recorded."),
      ),
      qa(
        "My message wasn't sent and named some words.",
        p("Your company keeps those words out of chat. Change them and send it again. Nobody else is told, and nothing is recorded."),
      ),
      qa(
        "I can't edit or delete a message.",
        p("You can edit your own message for 15 minutes after sending it, and delete it for everyone for an hour. After that it stays as it is."),
      ),
      qa(
        "I can't download a file somebody sent.",
        p("Your company keeps chat files view-only. Pictures, PDFs and text open in the browser; other files can't be opened."),
      ),
      qa(
        "Old messages have disappeared.",
        p("Your company may have chosen to delete messages after 90 days, 1 year or 3 years, in Settings › Chat. Deleted messages can't be brought back."),
      ),
      qa(
        "I can't start a chat with somebody.",
        p("Their account is switched off. You can still read an existing chat with them, but not start a new one."),
      ),
      qa(
        "I don't see Chat in the menu.",
        p("Either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). Chat is also hidden while an admin is viewing as somebody else."),
      ),
    ],
    related: ["notifications", "helpdesk", "notes"],
  },
};

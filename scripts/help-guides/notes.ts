import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Sticky Notes — written from src/app/(dashboard)/notes, src/components/notes (the board, the note
 * dialog, a customer's Notes card), src/actions/note.ts (who may read a note) and src/lib/notify.ts
 * (reminders).
 */
export const guide: SeedGuide = {
  slug: "help/sticky-notes",
  title: "Sticky Notes",
  seo: {
    title: "Sticky Notes: quick notes for you, your team or everyone",
    description: "How to write sticky notes in {siteName}, keep them to yourself or share them with your department, stick them to a customer and set a reminder.",
    keywords: ["sticky notes", "shared notes", "note reminders"],
  },
  guide: {
    module: "notes",
    heading: "Sticky Notes",
    summary: "Quick notes that don't need to be a task: kept to yourself, shared with your department or the whole company, or stuck to a customer so the context stays with the record.",
    purpose: [
      p("Sticky Notes is a board of short notes — the things worth remembering that aren't a job for anybody. “They always order in March.” “Ask for Priya, not the front desk.” A note can be yours alone, shared with your department, or put on everybody's board."),
      p(runs("A note can also be stuck to a customer. It then shows in the ", { b: "Notes" }, " card on that customer's page, so whoever opens the record next sees it.")),
      note(runs("A note has no due date and nobody to do it. If something has to be done by someone, make it a task instead — see ", ["Tasks", "/help/tasks"], ".")),
    ],
    access: [
      p("Everybody in the workspace can write notes and read the ones shared with them. Each note says who can see it, and that is the only thing that decides it:"),
      ul(
        runs({ b: "Just me" }, " — nobody else can read it. Not your manager, not an admin, not the workspace's super admin."),
        runs({ b: "My team" }, " — everybody in your department can read it. If you aren't in a department, the note stays yours alone."),
        runs({ b: "Everyone" }, " — it goes on the board of every signed-in person in the company. Only people allowed to post to everyone can choose this."),
      ),
      p("A note stuck to a customer is also hidden from anybody who can't see that customer, whoever it was shared with. Only the person who wrote a note can change, pin, archive or delete it."),
    ],
    permissions: [
      perm("section.notes", "Shows Sticky Notes in the menu and lets people open the board. Every role has it until an admin unticks it for one."),
      perm("notes.broadcast", "Lets somebody choose Everyone, putting a note on the whole company's board. Management has it by default; without it, Everyone is greyed out in the note."),
    ],
    setup: [
      p("There is nothing to set up: the board is there for everybody as soon as the module is on."),
      p(runs("For ", { b: "My team" }, " to mean anything, people need a department. An admin gives each person one in ", { b: "Settings › Users" }, " (departments themselves are in ", { b: "Settings › Departments" }, ").")),
      p(runs("To let more people post to everyone, an admin ticks ", { b: "Post a note to everyone" }, " for their role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    tasks: [
      task(
        "Write a note",
        ol(
          runs("Open ", { b: "My work › Sticky Notes" }, " and select ", { b: "New note" }, "."),
          runs("Type the note. A ", { b: "Title" }, " is optional."),
          runs("Pick a ", { b: "Colour" }, " if you like — you can filter the board by colour later."),
          runs("Under ", { b: "Who can see it" }, ", choose ", { b: "Just me" }, ", ", { b: "My team" }, " or ", { b: "Everyone" }, "."),
          runs("Select ", { b: "Add note" }, "."),
        ),
      ),
      task(
        "Stick a note to a customer",
        ol(
          "Open the customer's page.",
          runs("In the ", { b: "Notes" }, " card, select ", { b: "Add note" }, "."),
          "Write the note and choose who can see it, as on the board.",
        ),
        p("The note shows on that customer's page and on your board, with the customer's name on it."),
      ),
      task(
        "Get reminded about a note",
        ol(
          "Open the note (or write a new one).",
          runs("Under ", { b: "Remind me" }, ", pick a date and time, or one of ", { b: "This evening" }, ", ", { b: "Tomorrow 9am" }, " and ", { b: "Next Monday" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p("When the time comes you get a notification with the note's title (or its first words). Only you are reminded, even on a shared note."),
      ),
      task(
        "Keep the board tidy",
        ul(
          runs({ b: "Pin to the top of the board" }, " keeps a note above the rest."),
          runs("Drag notes to put them in your own order."),
          runs("Archive a note you're done with. ", { b: "Archived" }, " at the top of the board shows them again, and you can bring one back."),
          "Delete a note only when you're sure — deleting can't be undone.",
        ),
      ),
      task(
        "Find a note",
        p(runs("Type in ", { b: "Search notes…" }, ", choose ", { b: "All notes" }, ", ", { b: "Mine" }, " or ", { b: "Shared with me" }, ", or select a colour to see only notes of that colour.")),
      ),
    ],
    settings: [
      setting("Who can see it", "In each note", p("Just me, My team or Everyone, as above. You can change it whenever you edit the note — Everyone only while you're allowed to post to everyone.")),
      setting("Remind me", "In each note", p("A date and time in your workspace's time zone. Clear it to stop the reminder. An archived note never reminds you.")),
    ],
    faq: [
      qa("Can an admin read my private notes?", p("No. A note set to Just me is readable by you alone — no permission, role or admin setting opens it.")),
      qa(
        "Why is Everyone greyed out?",
        p("You don't hold the permission to post to everyone. Ask an admin, or share the note with My team instead."),
      ),
      qa(
        "I shared a note with My team, but a colleague can't see it.",
        p("They need to be in the same department as you, and so do you. If either of you has no department, a team note stays with its writer. If the note is stuck to a customer, they must also be able to see that customer."),
      ),
      qa("Why can't I change somebody else's note?", p("Only the person who wrote a note can edit, pin, archive or delete it. You can still read it while it's shared with you.")),
      qa(
        "I don't see Sticky Notes in the menu.",
        p("Either the module is switched off for your company, or your role has had it hidden. Ask an admin: the switch is in Settings › Modules, and the menu section is in Settings › Roles & Permissions."),
      ),
      qa("Will a shared note remind my colleagues too?", p("No. A reminder is only ever for the person who set it. To put a deadline on someone else, give them a task.")),
    ],
    related: ["tasks", "companies"],
  },
};

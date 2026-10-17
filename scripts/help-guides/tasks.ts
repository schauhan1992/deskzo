import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Tasks — written from src/app/(dashboard)/tasks (the list and board, its filters), src/components/tasks
 * (the task form and its sections, the task panel with status, checklist, files, time, comments and
 * reminder, the board, challenges, a record's Tasks card), src/components/layout/rail-tasks.tsx (My tasks
 * in the side rail), src/actions/task.ts and task-extras.ts (who may change, work and delete a task;
 * limits), src/lib/tasks (status, Upcoming, XP, repeats, reminders, tasks given to you) and the task rule
 * in src/lib/authz/access.ts.
 */
export const guide: SeedGuide = {
  slug: "help/tasks",
  title: "Tasks",
  seo: {
    title: "Tasks: assign work, track it on a board, earn XP",
    description: "How to create and assign tasks in {siteName}, move them across a board, add checklists, files, time and comments, set reminders and repeats.",
    keywords: ["task management", "assign tasks", "task board"],
  },
  guide: {
    module: "tasks",
    heading: "Tasks",
    summary: "Assignable to-dos with due dates, priorities and reminders — on a list or a board, with checklists, files, time logged and comments, and optionally linked to a customer, lead or ticket.",
    purpose: [
      p("Tasks is where work that somebody has to do gets written down, given to a person and followed through. Each task has a status — To do, In progress, Done or Cancelled — a priority, a due date and, if you like, a start date, an estimate and a team."),
      p("Inside a task you can tick off a checklist, attach files, log the time spent and talk it through in comments. A task can be about a customer, a lead or a ticket, and then it shows on that record's page too."),
      p("Tasks can repeat every day, week or month, and can carry XP: points the person earns by finishing on time, which show on the Performance board. Challenges group tasks under a shared goal."),
      note(runs("For something worth remembering that isn't anybody's job, use a sticky note instead — see ", ["Sticky Notes", "/help/sticky-notes"], ".")),
    ],
    access: [
      p("Everybody can create tasks, give them to anyone, and see and change the company's tasks. A few rules keep that fair:"),
      ul(
        runs("A task given to you by somebody who doesn't report to you — your manager or a peer — is yours to ", { i: "work" }, ": move it along, tick its steps, comment, attach files and log time. Changing or deleting it is for whoever set it."),
        runs("You can delete tasks you created. Deleting anybody else's needs ", { b: "Delete any task" }, "."),
        "Nobody sets the XP on a task that's their own, so nobody awards themselves.",
      ),
      p(runs("An admin can narrow whose tasks a role reaches on the ", { b: "Record Access" }, " tab of that role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    permissions: [
      perm("section.tasks", "Shows Tasks in the menu and lets people open and use tasks. Every role has it until an admin unticks it for one."),
      perm("tasks.delete", "Delete a task that isn't yours. Anyone can already delete a task they created; one somebody else gave you stays theirs to delete. Management has it by default."),
    ],
    setup: [
      p(runs("There's nothing to set up — Tasks is ready as soon as the module is on in ", { b: "Settings › Modules" }, ".")),
      p(runs("Tasks' ", { b: "Team" }, " is your departments, so it helps if an admin has set them up in ", { b: "Settings › Departments" }, ". Who reports to whom, which decides the rules for tasks given to you, comes from each person's reporting manager in ", { b: "Settings › Users" }, ".")),
    ],
    tasks: [
      task(
        "Create and assign a task",
        ol(
          runs("Open ", { b: "My work › Tasks" }, " and select ", { b: "New task" }, "."),
          runs("Type the ", { b: "Task name" }, " and, optionally, a ", { b: "Description" }, " of what done looks like."),
          runs("Choose who it's ", { b: "Assigned to" }, " (or leave ", { b: "Nobody yet" }, "), the ", { b: "Due date" }, ", ", { b: "Priority" }, " and ", { b: "Status" }, ". Add a ", { b: "Team" }, " or ", { b: "Challenge" }, " if it belongs to one."),
          runs("Open any of ", { b: "Start & estimate" }, ", ", { b: "XP & badge" }, ", ", { b: "Repeat" }, ", ", { b: "Reminder" }, ", ", { b: "About" }, " and ", { b: "Checklist" }, " to add more. In ", { b: "Checklist" }, ", type one step a line."),
          runs("Select ", { b: "Create task" }, "."),
        ),
        p("The person you assign it to gets a notification. You can also add a task from the Tasks card on a customer, lead or ticket, or from My tasks in the side rail."),
      ),
      task(
        "Move a task along",
        ul(
          runs("Open a task and choose To do, In progress, Done or Cancelled from the status menu at the top."),
          runs("Or switch to the board (the grid button beside the list button) and drag the task into another column."),
        ),
        p("A task whose start date is still to come shows as Upcoming. Moving a task back from Done takes back any XP it earned."),
      ),
      task(
        "Work inside a task",
        p("Open a task to:"),
        ul(
          runs("tick off its ", { b: "Checklist" }, " steps, or ", { b: "Add a step" }, ";"),
          runs({ b: "Attach a file" }, " (up to 10 MB each);"),
          runs("log time — enter the ", { b: "Minutes" }, ", the day and what it was spent on, then select ", { b: "Log time" }, ";"),
          runs("write a comment and select ", { b: "Comment" }, ";"),
          "star it, so you can filter to your starred tasks.",
        ),
      ),
      task(
        "Get reminded",
        ol(
          "Open the task.",
          runs("Under ", { b: "Reminder" }, ", pick a time and ", { b: "How often" }, ": ", { b: "Once" }, ", or every hour, day or week until it's done."),
          runs("Select ", { b: "Remind me" }, "."),
        ),
        p("Reminders are yours alone — they come as a notification, with a sound if you have sounds on. A closed task never reminds you."),
      ),
      task(
        "Make a task repeat",
        p(runs("In the task form, open ", { b: "Repeat" }, ", choose ", { b: "Every day" }, ", ", { b: "Every week" }, " or ", { b: "Every month" }, ", and optionally ", { b: "Until (optional)" }, ". When the task is marked Done, the next one is made a day, week or month on, with its checklist unticked.")),
      ),
      task(
        "Set XP and run a challenge",
        ol(
          runs("In the task form, open ", { b: "XP & badge" }, " and set the ", { b: "Earned XP" }, " and, if you like, a ", { b: "Badge" }, ". The assignee earns them by finishing on or before the due date."),
          runs("To group tasks under a goal, select ", { b: "Challenges" }, " › ", { b: "New challenge" }, ", give it a ", { b: "Name" }, ", a ", { b: "Team" }, ", ", { b: "Starts" }, " and ", { b: "Ends" }, " dates and ", { b: "What it's for" }, ", then pick it as the task's ", { b: "Challenge" }, "."),
        ),
        p("Each challenge shows how many of its tasks are done and how much of its XP has been earned. XP earned shows on the Task XP board in Reports › Performance."),
      ),
      task(
        "Find tasks",
        p(runs("The page opens on the tasks assigned to you. Change ", { b: "Assigned to" }, " to ", { b: "Everyone" }, ", ", { b: "Set by me" }, ", ", { b: "Unassigned" }, " or a person, and filter by ", { b: "Status" }, ", ", { b: "Priority" }, ", ", { b: "Team" }, ", ", { b: "Challenge" }, ", ", { b: "Starred" }, " and the ", { b: "Due date" }, ". Search with ", { b: "Search tasks…" }, ".")),
      ),
    ],
    settings: [
      setting(
        "Status and priority",
        "In each task",
        p("Status is To do, In progress, Done or Cancelled; Done and Cancelled close the task. Priority is Low, Medium, High or Urgent."),
      ),
      setting(
        "Start & estimate",
        "In each task",
        p("A Start date keeps the task showing as Upcoming until that day. Estimate (minutes) sits beside the time logged, so you can see how a task is going against it."),
      ),
      setting(
        "XP & badge",
        "In each task",
        p("What the task is worth when it's done on or before its due date. Not offered on a task assigned to yourself."),
      ),
      setting(
        "Repeat",
        "In each task",
        p("Every day, every week or every month, until an optional end date."),
      ),
      setting(
        "Whose tasks a role reaches",
        "Settings › Roles & Permissions, the Record Access tab",
        p("By default everybody sees and changes every task and deletes their own. An admin can set a narrower level for a role here."),
      ),
    ],
    faq: [
      qa(
        "Why can't I edit a task that's assigned to me?",
        p("It was given to you by somebody who doesn't report to you, so it's yours to work, not to rewrite. You can still move it through its stages, tick its steps, comment, attach files and log time. Ask whoever set it to change it."),
      ),
      qa(
        "Why can't I set XP on my task?",
        p("Nobody sets the XP on a task assigned to themselves. Somebody else has to set it — then you earn it by finishing on time."),
      ),
      qa(
        "I finished a task but didn't get its XP.",
        p("XP is earned only when the task is done on or before its due date, by the person it's assigned to, and only if somebody other than them set it."),
      ),
      qa(
        "Why can't I delete this task?",
        p("You can delete tasks you created. A task somebody else created needs the permission to delete any task, and one given to you by your manager or a peer is theirs to delete."),
      ),
      qa(
        "Where do I see tasks with a due date in my calendar?",
        p(runs("Open tasks assigned to you that are due show on ", ["Calendar", "/help/calendar"], " beside your meetings.")),
      ),
      qa(
        "I don't see Tasks in the menu.",
        p("Either the module is switched off for your company (Settings › Modules) or your role has had the section hidden (Settings › Roles & Permissions). Ask an admin."),
      ),
    ],
    related: ["notes", "calendar", "notifications", "reports"],
  },
};

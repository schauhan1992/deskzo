/**
 * Advanced tasks (owner, 16 Oct 2026 — src/lib/tasks, src/actions/task.ts, src/actions/task-extras.ts,
 * src/app/api/tasks/files, the task screens).
 *
 *   · The rules: status (and Upcoming), XP on time, the next date of a repeat.
 *   · Making and changing a task with its team, challenge, dates, estimate, XP, badge and repeat — and
 *     nobody setting XP on their own task.
 *   · Moving one: Done earns, opening it again takes it back, a late one earns nothing, XP somebody set
 *     for themselves earns nothing; done, a repeat makes its next one, once; the old tick still works.
 *   · The list's filters and sorts, and stars.
 *   · Checklist, comments, files (and the route that serves them), time logged, challenges.
 *   · The leaderboard, and what the screens draw.
 *
 * Everything is named ZZPROBE_TA and removed in a finally.
 *
 *   npm run check:tasks-advanced
 */
import "dotenv/config";
import Module from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { earnsXp, effectiveStatus, minutesWords, nextOccurrence, shownStatus } from "../src/lib/tasks/rules";

/** The Dialog primitive portals into document.body; here it renders where it stands, so the markup can be read. */
function InlineDialog({ open, title, children }: { open: boolean; onClose: () => void; title: string; children?: ReactNode }) {
  return open ? createElement("div", { role: "dialog", "aria-label": title }, createElement("h2", null, title), children) : null;
}

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/components/ui/dialog" || /components[\/]ui[\/]dialog$/.test(request)) return { Dialog: InlineDialog };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      usePathname: () => "/tasks",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "SALES", name: "Zzprobe Ta", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_TA";
const MAIL = "@zzprobe-ta.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const said = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }] } });
    await db.taskChallenge.deleteMany({ where: { createdById: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  section("The rules, without a database");

  ok("closed by the old tick reads as Done; Cancelled stays Cancelled", effectiveStatus({ done: true, status: "TODO" }) === "DONE" && effectiveStatus({ done: true, status: "CANCELLED" }) === "CANCELLED");
  ok("  open with a closed status reads as To do; In progress stays", effectiveStatus({ done: false, status: "DONE" }) === "TODO" && effectiveStatus({ done: false, status: "IN_PROGRESS" }) === "IN_PROGRESS");
  ok("an open task starting tomorrow is Upcoming; today's is To do", shownStatus({ done: false, status: "TODO", startDate: "2026-10-17" }, "2026-10-16") === "UPCOMING" && shownStatus({ done: false, status: "TODO", startDate: "2026-10-16" }, "2026-10-16") === "TODO");
  ok("XP is earned on or before the due day, not after", earnsXp({ xp: 10, assignedToUserId: "u", dueDate: "2026-10-16" }, "2026-10-16") && !earnsXp({ xp: 10, assignedToUserId: "u", dueDate: "2026-10-16" }, "2026-10-17"));
  ok("  not with nobody assigned, or nothing to earn", !earnsXp({ xp: 10, assignedToUserId: null, dueDate: null }, "2026-10-16") && !earnsXp({ xp: 0, assignedToUserId: "u", dueDate: null }, "2026-10-16"));
  ok("repeats: a day, a week, the same date next month", nextOccurrence("2026-10-16", "DAILY") === "2026-10-17" && nextOccurrence("2026-10-16", "WEEKLY") === "2026-10-23" && nextOccurrence("2026-10-16", "MONTHLY") === "2026-11-16");
  ok("  the 31st to the month's last day, across the year", nextOccurrence("2026-01-31", "MONTHLY") === "2026-02-28" && nextOccurrence("2026-12-31", "MONTHLY") === "2027-01-31");
  ok("minutes in words", minutesWords(45) === "45 m" && minutesWords(120) === "2 h" && minutesWords(90) === "1 h 30 m");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const tasks = require("../src/actions/task") as typeof import("../src/actions/task");
  const extras = require("../src/actions/task-extras") as typeof import("../src/actions/task-extras");
  const { taskXpLeaders } = require("../src/lib/tasks/leaderboard") as typeof import("../src/lib/tasks/leaderboard");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");

  await cleanup();
  try {
    const make = async (key: string, role: "ADMIN" | "SALES", departmentId: string | null = null) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60), departmentId } });
      roles.set(u.id, role);
      return u;
    };
    const team = await db.department.create({ data: { name: `${TAG} Delta` } });
    const manager = await make("manager", "ADMIN");
    const worker = await make("worker", "SALES", team.id);
    const today = (await workspaceClock()).today();
    const tomorrow = nextOccurrence(today, "DAILY");
    const nextWeek = nextOccurrence(today, "WEEKLY");
    const yesterday = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) - 1)).toISOString().slice(0, 10);

    section("Challenges");

    actorId = manager.id;
    const made = await extras.saveTaskChallenge({ name: `${TAG} Database migration`, departmentId: team.id, startDate: today, endDate: nextWeek });
    ok("a challenge is made", made.ok, said(made));
    const challengeId = made.ok ? made.data.id : "";
    ok("  one that ends before it starts isn't", !(await extras.saveTaskChallenge({ name: `${TAG} Backwards`, startDate: nextWeek, endDate: today })).ok);
    actorId = worker.id;
    ok("  and only whoever made it changes it", !(await extras.saveTaskChallenge({ id: challengeId, name: "Renamed" })).ok);

    section("Making and changing a task");

    actorId = manager.id;
    const created = await tasks.createTask({
      title: `${TAG} Optimise image processing`,
      assignedToUserId: worker.id,
      priority: "HIGH",
      departmentId: team.id,
      challengeId,
      startDate: today,
      dueDate: nextWeek,
      estimateMinutes: 120,
      xp: 50,
      badge: "Speed demon",
      repeat: "WEEKLY",
      description: "Make the thumbnails twice as fast",
    });
    ok("a manager makes a task with everything on it", created.ok, said(created));
    const taskId = created.ok ? created.data.id : "";
    const row = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    ok("  priority, team, challenge, dates, estimate, XP, badge and repeat kept", row.priority === "HIGH" && row.departmentId === team.id && row.challengeId === challengeId && row.estimateMinutes === 120 && row.xp === 50 && row.badge === "Speed demon" && row.repeat === "WEEKLY");
    ok("  and who set the XP", row.xpSetById === manager.id);
    ok("a task can't start after it's due", !(await tasks.createTask({ title: `${TAG} Backwards`, startDate: nextWeek, dueDate: today })).ok);
    actorId = worker.id;
    const ownXp = await tasks.createTask({ title: `${TAG} My own`, assignedToUserId: worker.id, xp: 100 });
    ok("nobody sets XP on their own task", !ownXp.ok && /somebody else/.test(ownXp.error), said(ownXp));
    const bump = await tasks.updateTask({ id: taskId, title: `${TAG} Optimise image processing`, assignedToUserId: worker.id, dueDate: nextWeek, xp: 500 });
    ok("  nor raises it on a task that's theirs", !bump.ok, said(bump));
    await db.taskChallenge.update({ where: { id: challengeId }, data: { archivedAt: new Date() } });
    actorId = manager.id;
    ok("an archived challenge can't take new tasks", !(await tasks.createTask({ title: `${TAG} Late joiner`, challengeId })).ok);
    await db.taskChallenge.update({ where: { id: challengeId }, data: { archivedAt: null } });

    section("The list");

    const future = await tasks.createTask({ title: `${TAG} Plan the offsite`, startDate: tomorrow, dueDate: nextWeek, priority: "URGENT", assignedToUserId: worker.id });
    const futureId = future.ok ? future.data.id : "";
    const listed = async (params: Parameters<typeof tasks.listTasks>[0]) => (await tasks.listTasks({ search: TAG, ...params })).map((t) => t.id);
    ok("Upcoming is the open tasks still to start", (await listed({ status: "upcoming" })).includes(futureId) && !(await listed({ status: "upcoming" })).includes(taskId));
    ok("  To do leaves them out", (await listed({ status: "todo" })).includes(taskId) && !(await listed({ status: "todo" })).includes(futureId));
    ok("by priority, team and challenge", (await listed({ priority: "URGENT" })).join() === futureId && (await listed({ departmentId: team.id })).join() === taskId && (await listed({ challengeId })).join() === taskId);
    ok("sorted by priority, urgent first", (await listed({ sort: "priority" }))[0] === futureId);
    const star = await tasks.toggleTaskStar(taskId);
    ok("a star is the viewer's", star.ok && star.data.starred && (await listed({ starred: true })).join() === taskId);
    actorId = worker.id;
    ok("  nobody else's", (await listed({ starred: true })).length === 0);
    actorId = manager.id;
    const first = (await tasks.listTasks({ search: TAG })).find((t) => t.id === taskId);
    ok("a row carries its team, challenge, star and counts", first?.department?.name === team.name && first?.challenge !== null && first?.starred === true && first?._count.checklist === 0);

    section("Checklist, comments, files, time");

    // Steps are set by whoever set the task; the worker it was given to ticks them.
    actorId = manager.id;
    const step1 = await extras.addChecklistItem(taskId, "Profile the resizer");
    const step2 = await extras.addChecklistItem(taskId, "Cache the thumbnails");
    ok("steps are added", step1.ok && step2.ok);
    actorId = worker.id;
    if (step1.ok) await extras.toggleChecklistItem(step1.data.id);
    const progress = (await tasks.listTasks({ search: TAG })).find((t) => t.id === taskId);
    ok("  and ticked, the list counting them", progress?.checklistDone === 1 && progress?._count.checklist === 2, `${progress?.checklistDone}/${progress?._count.checklist}`);
    const comment = await extras.addTaskComment(taskId, "Halfway there");
    ok("a comment is left", comment.ok);
    ok("  and its maker is told", (await db.notification.count({ where: { userId: manager.id, type: "TASK_COMMENT" } })) === 1);
    const form = new FormData();
    form.set("taskId", taskId);
    form.set("file", new File(["timings: 120ms"], "timings.txt", { type: "text/plain" }));
    const file = await extras.uploadTaskFile(form);
    ok("a file is attached", file.ok, said(file));
    const bad = new FormData();
    bad.set("taskId", taskId);
    bad.set("file", new File(["MZ"], "tool.exe", { type: "application/octet-stream" }));
    ok("  a program isn't", !(await extras.uploadTaskFile(bad)).ok);
    ok("time is logged", (await extras.logTaskTime({ taskId, minutes: 45, note: "Profiling" })).ok);
    ok("  not on a day still to come", !(await extras.logTaskTime({ taskId, minutes: 30, spentOn: nextWeek })).ok);
    ok("  nor nothing, or more than a day", !(await extras.logTaskTime({ taskId, minutes: 0 })).ok && !(await extras.logTaskTime({ taskId, minutes: 1500 })).ok);
    const panel = await extras.getTaskPanel(taskId);
    ok("the panel has it all", panel?.checklist.length === 2 && panel.comments.length === 1 && panel.attachments.length === 1 && panel.loggedMinutes === 45 && panel.canEdit === true);
    actorId = manager.id;
    const timeId = panel?.timeLogs[0]?.id ?? "";
    ok("only whoever logged time takes it off", !(await extras.deleteTaskTime(timeId)).ok);
    const { GET } = require("../src/app/api/tasks/files/[id]/route") as typeof import("../src/app/api/tasks/files/[id]/route");
    const served = await GET(new Request(`http://x/api/tasks/files/${file.ok ? file.data.id : ""}?download=1`), { params: Promise.resolve({ id: file.ok ? file.data.id : "" }) });
    ok("the file route serves it to somebody who can see the task, as a download", served.status === 200 && (await served.text()) === "timings: 120ms" && /attachment/.test(served.headers.get("content-disposition") ?? ""));

    section("Moving a task");

    actorId = worker.id;
    const done = await tasks.setTaskStatus(taskId, "DONE");
    let t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    ok("done on time: closed, and its XP earned by its assignee", done.ok && t.done && t.status === "DONE" && t.xpEarned === 50 && t.xpEarnedById === worker.id, JSON.stringify({ done: t.done, xp: t.xpEarned }));
    const nextId = done.ok ? done.data.nextTaskId : null;
    const next = nextId ? await db.task.findUnique({ where: { id: nextId }, include: { checklist: true } }) : null;
    ok("  its next one is made a week on, open, its steps unticked", !!next && !next.done && next.dueDate?.toISOString().slice(0, 10) === nextOccurrence(nextWeek, "WEEKLY") && next.checklist.length === 2 && next.checklist.every((c) => !c.done) && next.repeatedFromId === taskId);
    ok("  with the same XP, set by the same person", next?.xp === 50 && next.xpSetById === manager.id);
    await tasks.setTaskStatus(taskId, "IN_PROGRESS");
    t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    ok("opened again: the XP goes back", !t.done && t.xpEarned === null && t.xpEarnedById === null);
    await tasks.setTaskStatus(taskId, "DONE");
    ok("  done again, it earns again but repeats only once", (await db.task.count({ where: { repeatedFromId: taskId } })) === 1 && (await db.task.findUniqueOrThrow({ where: { id: taskId } })).xpEarned === 50);

    actorId = manager.id;
    const late = await tasks.createTask({ title: `${TAG} Already late`, assignedToUserId: worker.id, dueDate: yesterday, xp: 30 });
    actorId = worker.id;
    if (late.ok) await tasks.setTaskStatus(late.data.id, "DONE");
    ok("done after its due day: no XP", late.ok && (await db.task.findUniqueOrThrow({ where: { id: late.data.id } })).xpEarned === null);

    actorId = manager.id;
    const sly = await tasks.createTask({ title: `${TAG} For myself later`, xp: 80 });
    ok("XP on an unassigned task is fine", sly.ok, said(sly));
    if (sly.ok) {
      await tasks.updateTask({ id: sly.data.id, title: `${TAG} For myself later`, assignedToUserId: manager.id });
      await tasks.setTaskStatus(sly.data.id, "DONE");
    }
    ok("  but whoever set it, taking the task, earns nothing", sly.ok && (await db.task.findUniqueOrThrow({ where: { id: sly.data.id } })).xpEarned === null);

    const ticked = await tasks.createTask({ title: `${TAG} The old tick`, assignedToUserId: worker.id });
    if (ticked.ok) await tasks.toggleTaskDone(ticked.data.id);
    const viaTick = ticked.ok ? await db.task.findUniqueOrThrow({ where: { id: ticked.data.id } }) : null;
    ok("the old tick closes it as Done", viaTick?.done === true && viaTick.status === "DONE");
    if (ticked.ok) await tasks.toggleTaskDone(ticked.data.id);
    ok("  and opens it again as To do", ticked.ok && (await db.task.findUniqueOrThrow({ where: { id: ticked.data.id } })).status === "TODO");
    ok("Cancelled closes it without XP", future.ok && (await tasks.setTaskStatus(futureId, "CANCELLED")).ok && (await db.task.findUniqueOrThrow({ where: { id: futureId } })).done === true);
    ok("a status that isn't one is refused", !(await tasks.setTaskStatus(taskId, "MAYBE")).ok);

    section("A task given, not set");

    // The worker reports to nobody here, and the manager set the task: the worker works it.
    actorId = worker.id;
    const rewrite = await tasks.updateTask({ id: taskId, title: `${TAG} Something else`, assignedToUserId: worker.id });
    ok("whoever a task was given to can't change it", !rewrite.ok && /given to you/.test(rewrite.error), said(rewrite));
    ok("  nor delete it", !(await tasks.deleteTask(taskId)).ok && (await db.task.count({ where: { id: taskId } })) === 1);
    ok("  nor add or remove its steps", !(await extras.addChecklistItem(taskId, "My own step")).ok && (!step2.ok || !(await extras.deleteChecklistItem(step2.data.id)).ok));
    ok("  but moves it along and ticks its steps", (await tasks.setTaskStatus(taskId, "IN_PROGRESS")).ok && (!step2.ok || (await extras.toggleChecklistItem(step2.data.id)).ok));
    const given = await extras.getTaskPanel(taskId);
    ok("the panel says so: work it, don't change it", given?.workOnly === true && given.canEdit && !given.canChange && !given.canDelete);
    ok("the list marks it for them", (await tasks.listTasks({ search: TAG })).find((t) => t.id === taskId)?.workOnly === true);
    actorId = manager.id;
    ok("  and not for whoever set it", (await tasks.listTasks({ search: TAG })).find((t) => t.id === taskId)?.workOnly === false);
    ok("  who still changes it", (await tasks.updateTask({ id: taskId, title: `${TAG} Optimise image processing`, assignedToUserId: worker.id, dueDate: nextWeek, xp: 50 })).ok);
    await tasks.setTaskStatus(taskId, "DONE");

    actorId = worker.id;
    const mine = await tasks.createTask({ title: `${TAG} My own list`, assignedToUserId: worker.id });
    ok("a task somebody set for themselves is theirs to change", mine.ok && (await tasks.updateTask({ id: mine.data.id, title: `${TAG} My own list, renamed`, assignedToUserId: worker.id })).ok);
    // The worker reports to the manager now; the worker sets the manager a task.
    await db.user.update({ where: { id: worker.id }, data: { managerId: manager.id } });
    const upward = await tasks.createTask({ title: `${TAG} Sign this off`, assignedToUserId: manager.id });
    actorId = manager.id;
    ok("a manager given a task by somebody who reports to them still changes it", upward.ok && (await tasks.updateTask({ id: upward.data.id, title: `${TAG} Sign this off today`, assignedToUserId: manager.id })).ok);
    const peer = await make("peer", "SALES", team.id);
    actorId = peer.id;
    const fromPeer = await tasks.createTask({ title: `${TAG} Cover my call`, assignedToUserId: worker.id });
    actorId = worker.id;
    ok("a peer's task: work it, don't change it", fromPeer.ok && !(await tasks.updateTask({ id: fromPeer.data.id, title: `${TAG} Not covering`, assignedToUserId: worker.id })).ok);
    await db.user.update({ where: { id: peer.id }, data: { active: false } });
    ok("  but once they've left, it's theirs to change — nobody else would", fromPeer.ok && (await tasks.updateTask({ id: fromPeer.data.id, title: `${TAG} Covered`, assignedToUserId: worker.id })).ok);

    section("Challenges and the leaderboard");

    const challenge = (await extras.listTaskChallenges()).find((c) => c.id === challengeId);
    ok("a challenge counts its tasks and their XP", challenge?.tasks === 2 && challenge.done === 1 && challenge.xp === 100 && challenge.xpEarned === 50, JSON.stringify(challenge));
    const leaders = await taskXpLeaders(null, 50);
    const me = leaders.find((l) => l.userId === worker.id);
    ok("the leaderboard has the worker's XP and badge", me?.xp === 50 && me.tasks === 1 && me.badges.includes("Speed demon"), JSON.stringify(me));
    ok("  and nobody who earned nothing", !leaders.some((l) => l.userId === manager.id));

    section("What the screens draw");

    const options = await extras.taskFormOptions();
    const { TaskDialog } = require("../src/components/tasks/task-dialog") as typeof import("../src/components/tasks/task-dialog");
    const dialog = renderToStaticMarkup(createElement(TaskDialog, { open: true, onClose: () => {}, options, viewerId: worker.id, task: null }));
    ok("the form has every field", ["Task name", "Status", "Team", "Challenge", "Assigned to", "Priority", "Start date", "Due date", "Estimate (minutes)", "Earned XP", "Badge", "Repeats", "Description"].every((l) => dialog.includes(l)));
    const { TasksWorkspace } = require("../src/components/tasks/tasks-workspace") as typeof import("../src/components/tasks/tasks-workspace");
    const rows = await tasks.listTasks({ search: TAG });
    const challenges = await extras.listTaskChallenges();
    const list = renderToStaticMarkup(createElement(TasksWorkspace, { tasks: rows, options, challenges, viewerId: manager.id, view: "list" }));
    ok("the table has its columns and the tasks", ["Task", "Team", "Challenge", "Assigned to", "Start", "Due", "Priority", "XP", "Status", "Actions", "Optimise image processing"].every((l) => list.includes(l)));
    const board = renderToStaticMarkup(createElement(TasksWorkspace, { tasks: rows, options, challenges, viewerId: manager.id, view: "board" }));
    ok("the board has a column a status", ["To do", "In progress", "Done", "Cancelled"].every((l) => board.includes(`>${l}<`)));
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll advanced task checks passed." : `\n${failures} advanced task check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

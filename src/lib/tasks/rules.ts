/**
 * The rules of advanced tasks (owner, 16 Oct 2026) — pure, for the screens, the actions and the checks.
 *
 *   · Status: To do, In progress, Done or Cancelled; an open task whose start day is still to come shows
 *     as Upcoming. `done` stays the one "closed" flag the rest of the app reads — Done and Cancelled set
 *     it — and a task closed through the old tick reads as Done whatever its status says.
 *   · XP: what a task is worth, earned by its assignee when it's done on or before its due day. Nobody
 *     sets the XP on a task that's theirs, so nobody awards themselves.
 *   · Repeats: done, a repeating task makes its next one, a day, a week or a month on.
 */

export type TaskStatusKey = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type ShownStatus = TaskStatusKey | "UPCOMING";
export type TaskPriorityKey = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskRepeatKey = "DAILY" | "WEEKLY" | "MONTHLY";
type Tone = "default" | "green" | "blue" | "red" | "amber" | "brand";

export const TASK_STATUSES: readonly TaskStatusKey[] = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
export const TASK_PRIORITIES: readonly TaskPriorityKey[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
export const TASK_REPEATS: readonly TaskRepeatKey[] = ["DAILY", "WEEKLY", "MONTHLY"];

export const STATUS_LABELS: Record<ShownStatus, string> = {
  UPCOMING: "Upcoming",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  CANCELLED: "Cancelled",
};
export const STATUS_TONES: Record<ShownStatus, Tone> = { UPCOMING: "blue", TODO: "default", IN_PROGRESS: "amber", DONE: "green", CANCELLED: "red" };
export const PRIORITY_LABELS: Record<TaskPriorityKey, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };
export const PRIORITY_TONES: Record<TaskPriorityKey, Tone> = { LOW: "default", MEDIUM: "blue", HIGH: "amber", URGENT: "red" };
export const REPEAT_LABELS: Record<TaskRepeatKey, string> = { DAILY: "Every day", WEEKLY: "Every week", MONTHLY: "Every month" };

/** The most a task can be worth, the longest estimate (minutes), and a badge's length. */
export const XP_MAX = 1000;
export const ESTIMATE_MAX_MINUTES = 60 * 24 * 60;
export const BADGE_MAX = 40;
/** A file on a task, at most; and a comment's length. */
export const TASK_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const COMMENT_MAX = 5000;

export const closes = (status: TaskStatusKey) => status === "DONE" || status === "CANCELLED";

/** Where a task stands, from its status and the closed flag together. */
export function effectiveStatus(task: { done: boolean; status?: TaskStatusKey | null }): TaskStatusKey {
  if (task.done) return task.status === "CANCELLED" ? "CANCELLED" : "DONE";
  if (!task.status || closes(task.status)) return "TODO";
  return task.status;
}

/** A stored day (`dueDate`, `startDate`) as the day it holds: they're kept as their midnight UTC. */
export const dayKeyOf = (value: Date | string) => (typeof value === "string" ? new Date(value) : value).toISOString().slice(0, 10);

/** What the task shows: its status, or Upcoming for an open one whose start is still to come. */
export function shownStatus(task: { done: boolean; status?: TaskStatusKey | null; startDate?: Date | string | null }, today: string): ShownStatus {
  const status = effectiveStatus(task);
  if (status === "TODO" && task.startDate && dayKeyOf(task.startDate) > today) return "UPCOMING";
  return status;
}

/** Whether finishing it on `doneDay` earns its XP: worth something, somebody's, and on time. */
export function earnsXp(task: { xp: number; assignedToUserId: string | null; dueDate: Date | string | null }, doneDay: string): boolean {
  if (task.xp <= 0 || !task.assignedToUserId) return false;
  return !task.dueDate || doneDay <= dayKeyOf(task.dueDate);
}

/** The day after `day` by the repeat: a day, a week, or the same date next month (the 31st to the 30th). */
export function nextOccurrence(day: string, repeat: TaskRepeatKey): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  if (repeat === "DAILY" || repeat === "WEEKLY") {
    const next = new Date(Date.UTC(y, m - 1, d + (repeat === "DAILY" ? 1 : 7)));
    return next.toISOString().slice(0, 10);
  }
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastOfNext))).toISOString().slice(0, 10);
}

/** Minutes as people read them: "45 m", "2 h", "1 h 30 m". */
export function minutesWords(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} m` : m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** The list's sort orders. */
export const TASK_SORTS = ["due", "start", "priority", "title", "created", "xp", "status"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/**
 * A task given, not set (owner, 17 Oct 2026: "x should just change the stage … instead of completely
 * edit that task"): somebody else set it for this person — their manager, a peer, anyone who doesn't
 * report to them. They work it: move it through its stages, tick its steps, comment, attach files and
 * log time. Its details, its steps and deleting it are whoever set it's. A task given by somebody in
 * their own downline (`downline`, src/lib/org-chart.ts) they still change, and one whose giver has left
 * (`giverActive` false) — nobody else would.
 */
export function onlyWorks(task: { assignedToUserId: string | null; createdByUserId: string }, userId: string, downline: readonly string[], giverActive = true): boolean {
  return task.assignedToUserId === userId && task.createdByUserId !== userId && giverActive && !downline.includes(task.createdByUserId);
}

export const ONLY_WORKS = "This task was given to you — you can move it along, tick its steps, comment and log time, but changing or deleting it is for whoever set it.";

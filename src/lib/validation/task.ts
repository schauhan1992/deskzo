import { z } from "zod";
import { BADGE_MAX, ESTIMATE_MAX_MINUTES, TASK_PRIORITIES, TASK_REMINDER_REPEATS, TASK_REPEATS, TASK_STATUSES, XP_MAX } from "@/lib/tasks/rules";

/**
 * Advanced tasks' fields (owner, 16 Oct 2026 — src/lib/tasks/rules.ts). Each optional: a form that
 * doesn't send one leaves it as it was, and an empty string clears it.
 */
const advancedFields = {
  status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
  startDate: z.string().optional().or(z.literal("")),
  estimateMinutes: z.number().int("Give the estimate in whole minutes").min(0).max(ESTIMATE_MAX_MINUTES, "That estimate is longer than two months").nullable().optional(),
  departmentId: z.string().optional().or(z.literal("")),
  challengeId: z.string().optional().or(z.literal("")),
  xp: z.number().int("XP is a whole number").min(0).max(XP_MAX, `A task is worth at most ${XP_MAX} XP`).optional(),
  badge: z.string().trim().max(BADGE_MAX, `A badge is at most ${BADGE_MAX} characters`).optional().or(z.literal("")),
  repeat: z.enum(TASK_REPEATS as [string, ...string[]]).optional().or(z.literal("")),
  repeatUntil: z.string().optional().or(z.literal("")),
};

export const createTaskSchema = z.object({
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  assignedToUserId: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  leadId: z.string().optional().or(z.literal("")),
  ticketId: z.string().optional().or(z.literal("")),
  /** Its checklist, typed with it (owner, 17 Oct 2026) — a step a line on the form. */
  steps: z.array(z.string().trim().min(1).max(200, "A step is at most 200 characters")).max(30, "At most 30 steps — add more in the task").optional(),
  /** A reminder for whoever makes it, as the task panel sets one: when (typed, the workspace's time) and how often. */
  remindAt: z.string().optional().or(z.literal("")),
  remindRepeat: z.enum(TASK_REMINDER_REPEATS).optional(),
  ...advancedFields,
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  assignedToUserId: z.string().optional().or(z.literal("")),
  /**
   * What it's about — a company, a lead or a ticket. Sent only by a form that offers it: left out, the
   * link stays as it was; sent empty, it's taken off.
   */
  about: z.object({ companyId: z.string().optional().or(z.literal("")), leadId: z.string().optional().or(z.literal("")), ticketId: z.string().optional().or(z.literal("")) }).optional(),
  /** Why, when the status is moved to Cancelled or Need help (src/lib/tasks/rules.ts, NOTE_FOR). */
  statusNote: z.string().optional(),
  ...advancedFields,
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const bulkRenewalTasksSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, "Select at least one subscription"),
  assignedToUserId: z.string().optional().or(z.literal("")),
  /** Defaults to each subscription's own expiry date when left blank. */
  dueDate: z.string().optional().or(z.literal("")),
});

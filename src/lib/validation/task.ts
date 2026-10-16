import { z } from "zod";
import { BADGE_MAX, ESTIMATE_MAX_MINUTES, TASK_PRIORITIES, TASK_REPEATS, TASK_STATUSES, XP_MAX } from "@/lib/tasks/rules";

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
  ...advancedFields,
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  assignedToUserId: z.string().optional().or(z.literal("")),
  ...advancedFields,
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const bulkRenewalTasksSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, "Select at least one subscription"),
  assignedToUserId: z.string().optional().or(z.literal("")),
  /** Defaults to each subscription's own expiry date when left blank. */
  dueDate: z.string().optional().or(z.literal("")),
});

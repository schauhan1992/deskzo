import { z } from "zod";

export const createTaskSchema = z.object({
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  assignedToUserId: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  leadId: z.string().optional().or(z.literal("")),
  ticketId: z.string().optional().or(z.literal("")),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  assignedToUserId: z.string().optional().or(z.literal("")),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const bulkRenewalTasksSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, "Select at least one subscription"),
  assignedToUserId: z.string().optional().or(z.literal("")),
  /** Defaults to each subscription's own expiry date when left blank. */
  dueDate: z.string().optional().or(z.literal("")),
});

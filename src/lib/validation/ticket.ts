import { z } from "zod";

export const ticketStatusValues = ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] as const;
export const ticketPriorityValues = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export const ticketTypeValues = ["PRODUCT_SUPPORT", "DEMO", "INSTALLATION", "TRAINING", "OTHER"] as const;

export const createTicketSchema = z.object({
  companyId: z.string().min(1, "Select a company"),
  contactId: z.string().optional().or(z.literal("")),
  companyProductId: z.string().optional().or(z.literal("")),
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  ticketType: z.enum(ticketTypeValues).default("PRODUCT_SUPPORT"),
  priority: z.enum(ticketPriorityValues).default("MEDIUM"),
  assignedToUserId: z.string().optional().or(z.literal("")),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketStatusSchema = z.object({
  ticketId: z.string().min(1),
  status: z.enum(ticketStatusValues),
});

export const updateTicketPrioritySchema = z.object({
  ticketId: z.string().min(1),
  priority: z.enum(ticketPriorityValues),
});

export const assignTicketSchema = z.object({
  ticketId: z.string().min(1),
  userId: z.string().optional().or(z.literal("")),
});

export const addTicketCommentSchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().trim().min(1, "Comment can't be empty"),
});

export const bulkUpdateTicketsSchema = z.object({
  ticketIds: z.array(z.string().min(1)).min(1, "Select at least one ticket"),
  /** "" leaves the field alone; "unassign" clears the agent. */
  assignedToUserId: z.string().optional().or(z.literal("")),
  status: z.enum(ticketStatusValues).optional().or(z.literal("")),
  priority: z.enum(ticketPriorityValues).optional().or(z.literal("")),
});

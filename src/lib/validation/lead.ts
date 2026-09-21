import { z } from "zod";

export const leadStatusValues = [
  "NEW",
  "CONTACTED",
  "QUALIFYING",
  "QUALIFIED",
  "PROPOSAL_SENT",
  "NEGOTIATION",
  "WON",
  "LOST",
  "DISQUALIFIED",
] as const;

export const activityTypeValues = ["CALL", "EMAIL", "NOTE", "MEETING", "STAGE_CHANGE"] as const;

export const leadRequirementInputSchema = z.object({
  itemId: z.string().min(1, "Select a product"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  notes: z.string().trim().optional().or(z.literal("")),
});

export type LeadRequirementInput = z.infer<typeof leadRequirementInputSchema>;

export const createLeadSchema = z.object({
  companyId: z.string().min(1),
  contactId: z.string().optional().or(z.literal("")),
  title: z.string().trim().min(2, "Title is required"),
  description: z.string().trim().optional().or(z.literal("")),
  estimatedValue: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().nonnegative().optional(),
  ),
  expectedCloseDate: z.string().optional().or(z.literal("")),
  ownerUserId: z.string().optional().or(z.literal("")),
  requirements: z.array(leadRequirementInputSchema).default([]),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const addLeadRequirementSchema = z.object({
  leadId: z.string().min(1),
  ...leadRequirementInputSchema.shape,
});

export type AddLeadRequirementInput = z.infer<typeof addLeadRequirementSchema>;

export const updateLeadRequirementSchema = z.object({
  id: z.string().min(1),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  notes: z.string().trim().optional().or(z.literal("")),
});

export type UpdateLeadRequirementInput = z.infer<typeof updateLeadRequirementSchema>;

export const updateLeadStatusSchema = z.object({
  leadId: z.string().min(1),
  status: z.enum(leadStatusValues),
  lostReason: z.string().trim().optional().or(z.literal("")),
});

export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;

export const logActivitySchema = z.object({
  leadId: z.string().min(1),
  type: z.enum(activityTypeValues),
  notes: z.string().trim().min(1, "Notes are required"),
});

export type LogActivityInput = z.infer<typeof logActivitySchema>;

export const bulkUpdateLeadsSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "Select at least one lead"),
  /** "" leaves the field alone; "unassign" clears the owner. */
  ownerUserId: z.string().optional().or(z.literal("")),
  status: z.enum(leadStatusValues).optional().or(z.literal("")),
  lostReason: z.string().trim().optional().or(z.literal("")),
});

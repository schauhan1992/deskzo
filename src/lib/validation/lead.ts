import { z } from "zod";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";

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

/**
 * A renewal date as a date input sends it — `YYYY-MM-DD` — or blank.
 *
 * Checked as a real calendar day, not just the shape: "2026-02-30" has the right digits and is not a
 * date, and `new Date()` would quietly roll it into March.
 */
const renewalDateField = z
  .string()
  .trim()
  .refine((v) => {
    if (v === "") return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Pick a valid renewal date")
  .optional()
  .or(z.literal(""));

/** Remarks on a product line — typically the reference of the subscription it concerns. */
const remarksField = z.string().trim().max(500, "Keep remarks under 500 characters").optional().or(z.literal(""));

export const leadRequirementInputSchema = z.object({
  itemId: z.string().min(1, "Select a product"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  notes: remarksField,
  renewalDate: renewalDateField,
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
  /** Blank means "let the assignment rules decide" — see `chooseOwner`. */
  ownerUserId: z.string().optional().or(z.literal("")),
  source: z.enum(LEAD_SOURCE_VALUES).default("OTHER"),
  sourceDetail: z.string().trim().max(300, "Keep the source detail under 300 characters").optional().or(z.literal("")),
  requirements: z.array(leadRequirementInputSchema).default([]),
  /** The workspace's own fields (src/lib/custom-fields) — checked by the action against its definitions. */
  customFields: z.record(z.string(), z.unknown()).optional(),
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
  notes: remarksField,
  renewalDate: renewalDateField,
});

/** A renewal date field's value to store — UTC midnight of the day, or null. See `LeadRequirement.renewalDate`. */
export function renewalDateToStore(value: string | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

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

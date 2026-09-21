import { z } from "zod";
import { visitPurposeValues, visitStatusValues } from "@/lib/visits";

export const createVisitSchema = z.object({
  companyId: z.string().min(1, "Select a company"),
  contactId: z.string().optional().or(z.literal("")),
  leadId: z.string().optional().or(z.literal("")),
  locationId: z.string().optional().or(z.literal("")),
  purpose: z.enum(visitPurposeValues).default("INTRO_MEETING"),
  agenda: z.string().trim().optional().or(z.literal("")),
  scheduledFor: z.string().min(1, "Pick a date and time"),
  address: z.string().trim().optional().or(z.literal("")),
  /** Planned round-trip distance; the mileage claim is raised separately as an expense. */
  distanceKm: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
  /** Blank means "me" — a manager can plan a visit for someone in their team. */
  userId: z.string().optional().or(z.literal("")),
});

export type CreateVisitInput = z.infer<typeof createVisitSchema>;

export const updateVisitSchema = createVisitSchema.extend({
  id: z.string().min(1),
});

export const completeVisitSchema = z.object({
  id: z.string().min(1),
  outcome: z.string().trim().min(1, "Write up what came of the visit"),
  /** Left blank when someone forgot to check in or out on the day. */
  checkInAt: z.string().optional().or(z.literal("")),
  checkOutAt: z.string().optional().or(z.literal("")),
  distanceKm: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
});

export const setVisitStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(visitStatusValues),
  /** Required when cancelling or marking a no-show, so the log says why. */
  note: z.string().trim().optional().or(z.literal("")),
});

import { z } from "zod";
import { paymentTermsValues } from "@/lib/gst";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/lib/tasks/rules";
import { companySourceValues, contactDesignationValues, relationshipTypeValues } from "@/lib/validation/company";
import { leadStatusValues } from "@/lib/validation/lead";
import { ticketPriorityValues, ticketTypeValues, ticketStatusValues } from "@/lib/validation/ticket";

/**
 * What the public API takes in a request body (src/lib/api/v1) — one place, read by the endpoints that
 * validate with them and by the documentation (src/lib/api/openapi.ts) that describes them, so the two
 * can't disagree. Plain zod: nothing here reads a database.
 */

export const money = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.number().nonnegative().max(9_999_999_999).optional());

export const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is yyyy-mm-dd.").optional();

export const leadCreateSchema = z
  .object({
    company: z.string().min(1, "Name the company — its ref (COM-000123) or id."),
    contact: z.string().optional(),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5000).optional(),
    value: money,
    expected_close_date: dayField,
    owner: z.string().max(200).optional().describe("A person's id or email; left out, the assignment rules choose."),
    source: z.enum(LEAD_SOURCE_VALUES).optional(),
    source_detail: z.string().trim().max(300).optional(),
    pipeline: z.string().max(40).optional().describe("A team pipeline's id; left out, the main one."),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const leadPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    value: money,
    expected_close_date: dayField.or(z.literal("")),
    contact: z.string().optional().describe("A contact's ref or id; \"\" takes it off."),
  })
  .strict();

export const leadStageSchema = z
  .object({
    stage: z.string().min(1).max(60).optional().describe("The stage's id or key (Settings › Pipeline)."),
    status: z.enum(leadStatusValues).optional().describe("Instead of a stage: the first stage with this meaning."),
    lost_reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.stage || v.status, { message: "Give a stage or a status." });

export const leadNoteSchema = z
  .object({
    type: z.enum(["NOTE", "CALL", "EMAIL", "MEETING"]).default("NOTE"),
    notes: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const addressSchema = z
  .object({
    label: z.string().trim().max(80).optional(),
    line: z.string().trim().max(500).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    pincode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(120).optional(),
    gstin: z.string().trim().max(15).optional(),
  })
  .strict();

export const contactFields = {
  name: z.string().trim().min(1).max(160),
  designation: z.enum(contactDesignationValues).optional(),
  designation_name: z.string().trim().max(80).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  linkedin_url: z.string().trim().max(300).optional(),
  is_primary: z.boolean().optional(),
  receives_documents: z.boolean().optional(),
};

export const companyCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    relationship_type: z.enum(relationshipTypeValues).optional(),
    website: z.string().trim().max(300).optional(),
    linkedin_url: z.string().trim().max(300).optional(),
    industry: z.string().max(40).optional().describe("An industry's id."),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    source: z.enum(companySourceValues).optional(),
    payment_terms: z.enum(paymentTermsValues).optional(),
    address: addressSchema.optional(),
    contacts: z.array(z.object(contactFields).strict()).max(20).optional(),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const companyPatchSchema = companyCreateSchema.omit({ address: true, contacts: true, custom_fields: true }).partial().strict();

export const contactCreateSchema = z.object({ company: z.string().min(1, "Name the company — its ref or id."), ...contactFields }).strict();

export const contactPatchSchema = z.object(contactFields).partial().strict();

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5000).optional(),
    due_date: dayField.optional(),
    assignee: z.string().max(200).optional().describe("A person's id or email; left out, the key's person."),
    status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
    priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
    company: z.string().optional(),
    lead: z.string().optional(),
    ticket: z.string().optional(),
    checklist: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  })
  .strict();

export const taskPatchSchema = taskCreateSchema
  .omit({ checklist: true, company: true, lead: true, ticket: true })
  .partial()
  .extend({ status_note: z.string().trim().max(4900).optional().describe("Why — needed with status CANCELLED (the reason) or NEED_HELP (what help); kept as a comment on the task.") })
  .strict();

export const ticketCreateSchema = z
  .object({
    company: z.string().min(1, "Name the company — its ref or id."),
    contact: z.string().optional(),
    order: z.string().optional(),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(10_000).optional(),
    type: z.enum(ticketTypeValues).optional(),
    priority: z.enum(ticketPriorityValues).optional(),
    assignee: z.string().max(200).optional(),
  })
  .strict();

export const ticketPatchSchema = z
  .object({
    status: z.enum(ticketStatusValues).optional(),
    priority: z.enum(ticketPriorityValues).optional(),
    assignee: z.string().max(200).optional().describe("A person's id or email; \"\" takes it off them."),
  })
  .strict();

export const ticketCommentSchema = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();

import { z } from "zod";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_LIMITS, CUSTOM_FIELD_TYPES, hasOptions } from "@/lib/custom-fields/rules";

const optionalText = (max: number, message: string) => z.string().trim().max(max, message).optional().or(z.literal(""));

/**
 * One option of a dropdown or multi-select as the settings dialog sends it: an existing option with
 * its stored value, or a new one with none (the server makes its value from the label).
 */
const optionSchema = z.object({
  value: z.string().trim().max(40).optional().or(z.literal("")),
  label: z.string().trim().min(1, "Name every option").max(CUSTOM_FIELD_LIMITS.optionLabel, `An option is ${CUSTOM_FIELD_LIMITS.optionLabel} characters at most`),
  archived: z.boolean().optional(),
});

/** A custom field as the settings dialog saves it. The type can't change once the field exists. */
export const customFieldDefinitionSchema = z
  .object({
    id: z.string().optional().or(z.literal("")),
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    label: z.string().trim().min(1, "Name the field").max(CUSTOM_FIELD_LIMITS.label, `A name is ${CUSTOM_FIELD_LIMITS.label} characters at most`),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(optionSchema).max(CUSTOM_FIELD_LIMITS.options, `${CUSTOM_FIELD_LIMITS.options} options at most`).default([]),
    required: z.boolean().default(false),
    helpText: optionalText(CUSTOM_FIELD_LIMITS.helpText, `A hint is ${CUSTOM_FIELD_LIMITS.helpText} characters at most`),
    group: optionalText(CUSTOM_FIELD_LIMITS.group, `A heading is ${CUSTOM_FIELD_LIMITS.group} characters at most`),
    restricted: z.boolean().default(false),
    showInList: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (!hasOptions(val.type)) return;
    const live = val.options.filter((o) => !o.archived);
    if (live.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Add at least one option to choose from", path: ["options"] });
    const seen = new Set<string>();
    for (const o of val.options) {
      const name = o.label.trim().toLowerCase();
      if (seen.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two options are called “${o.label.trim()}”`, path: ["options"] });
      seen.add(name);
    }
  });

export type CustomFieldDefinitionInput = z.infer<typeof customFieldDefinitionSchema>;

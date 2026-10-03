import { z } from "zod";
import { FOLLOW_UP_CHANNELS, REMARKS_MAX } from "@/lib/collections/rules";

const optionalDay = z.string().trim().optional().or(z.literal(""));

/**
 * A follow-up as the dialog sends it. The dates are checked against the workspace's today by the action
 * (`checkFutureDay`), which knows the clock; the amount against what is outstanding, which it looks up.
 */
export const logFollowUpSchema = z
  .object({
    /** The invoice chased — or the order, when it has no invoice. Exactly one. */
    documentId: z.string().trim().optional().or(z.literal("")),
    companyProductId: z.string().trim().optional().or(z.literal("")),
    channel: z.enum(FOLLOW_UP_CHANNELS, { error: "Pick how you reached them." }),
    remarks: z
      .string()
      .trim()
      .min(1, "Say what the client said.")
      .max(REMARKS_MAX, `Keep the remarks to ${REMARKS_MAX.toLocaleString("en-IN")} characters.`),
    promisedOn: optionalDay,
    promisedAmount: z.preprocess(
      (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
      z.number({ error: "Enter the promised amount as a number." }).positive("A promised amount is more than zero.").optional(),
    ),
    nextFollowUpOn: optionalDay,
  })
  .refine((v) => Boolean(v.documentId) !== Boolean(v.companyProductId), {
    message: "A follow-up is about one invoice or one order.",
    path: ["documentId"],
  })
  .refine((v) => v.promisedAmount === undefined || Boolean(v.promisedOn), {
    message: "A promised amount needs the date they promised it by.",
    path: ["promisedOn"],
  });

export type LogFollowUpInput = z.output<typeof logFollowUpSchema>;

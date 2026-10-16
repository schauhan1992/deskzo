"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { leadAccess } from "@/lib/authz/access";
import { isModuleEnabled } from "@/actions/module";
import { detailLeadMasker } from "@/lib/leads/masking";
import { formatLeadId } from "@/lib/order-id";
import { attemptUnmask, logUnmaskDenied, unmaskRequestMeta, unmaskUsageToday, type UnmaskUsageStatus } from "@/lib/authz/unmask";

/**
 * Unmasking a lead — what opening it from the Leads list does (src/components/leads/lead-unmask.tsx).
 *
 * Every time, in this order, and nothing taken from the caller but the lead's id:
 *
 *   1. who is asking — the session, and whether an admin is viewing as them;
 *   2. the plan, the Leads module and "View leads";
 *   3. that this lead is one they reach (the record engine's own `leadAccess`);
 *   4. which of its fields they see masked here and may unmask (field access);
 *   5. the daily limit — a unit for the lead's first unmasking today, none for a repeat, and a refusal
 *      once the units are gone — counted and logged in one transaction (src/lib/authz/unmask.ts).
 *
 * It returns no values. The lead's page reads them itself on the refresh that follows, as it always
 * does — through the same field access, which now sees today's unmasking — so a value never travels
 * by a second road, and a page reloaded tomorrow is masked again.
 *
 * Viewing as somebody unmasks nothing: it would spend their limit on somebody else's clicks, and put
 * their name on the log for it. The attempt is logged as refused, with the admin behind it.
 */

export type UnmaskOutcome = {
  result: "ALLOWED" | "REPEAT" | "QUOTA_EXHAUSTED" | "DENIED" | "NOTHING";
  /** What the page says about it, in words; null when there is nothing to say. */
  message: string | null;
  usage: UnmaskUsageStatus | null;
};

const NOT_FOUND = "Lead not found.";

export async function unmaskLead(leadId: unknown): Promise<UnmaskOutcome> {
  const user = await requireModuleUser("leads");
  const id = typeof leadId === "string" ? leadId.trim().slice(0, 64) : "";
  if (!id) return { result: "DENIED", message: NOT_FOUND, usage: null };

  const [viewAs, meta] = await Promise.all([viewAsContext(), unmaskRequestMeta()]);
  const subject = { userId: user.id, userName: user.name ?? "", impersonatedByUserId: viewAs?.actor.id ?? null, leadId: id, leadRef: null as string | null };

  const masker = await detailLeadMasker(user.id, id);
  // Nothing masked for this person here: there is nothing to unmask, and nothing worth a log row.
  if (masker.concealed.length === 0 && masker.revealable.length === 0) return { result: "NOTHING", message: null, usage: null };

  const mayOpen = (await isModuleEnabled("leads")) && (await can(user.id, "leads.view"));
  const lead = mayOpen ? await db.lead.findFirst({ where: { AND: [{ id }, await leadAccess(user.id, "view")] }, select: { id: true, leadSeq: true } }) : null;
  if (!lead) {
    // Out of reach and missing answer alike, as the lead's page does — but the attempt is kept.
    await logUnmaskDenied(subject, [...masker.revealable, ...masker.concealed], "Not a lead this person can open.", meta);
    return { result: "DENIED", message: NOT_FOUND, usage: null };
  }
  subject.leadRef = formatLeadId(lead.leadSeq);

  if (masker.revealable.length === 0) {
    await logUnmaskDenied(subject, masker.concealed, "No permission to unmask these fields.", meta);
    return { result: "DENIED", message: "You can't unmask this lead's hidden fields.", usage: await unmaskUsageToday(user.id) };
  }
  if (viewAs) {
    await logUnmaskDenied(subject, masker.revealable, `While ${viewAs.actor.name} was viewing as ${viewAs.user.name}.`, meta);
    return {
      result: "DENIED",
      message: `You're viewing as ${viewAs.user.name}. Fields stay masked: unmasking would use their daily limit.`,
      usage: await unmaskUsageToday(user.id),
    };
  }

  const attempt = await attemptUnmask(subject, masker.revealable, meta);
  switch (attempt.result) {
    case "ALLOWED":
      return { result: "ALLOWED", message: null, usage: attempt.usage };
    case "REPEAT":
      return { result: "REPEAT", message: null, usage: attempt.usage };
    case "QUOTA_EXHAUSTED":
      return {
        result: "QUOTA_EXHAUSTED",
        message: `You've unmasked ${attempt.usage.limit} leads today, your daily limit. Sensitive fields stay masked on leads you haven't opened today; it resets at midnight.`,
        usage: attempt.usage,
      };
    default:
      return { result: "DENIED", message: NOT_FOUND, usage: attempt.usage };
  }
}

import type { LeadStatus, Prisma } from "@prisma/client";
import { formatLeadId } from "@/lib/order-id";
import { emitEvents } from "@/lib/automate/events";
import type { EventCause } from "@/lib/automate/action-types";

/**
 * Deskzo Automate's lead events (Phase 2): `lead.created`, `lead.stage_changed`, `lead.won`,
 * `lead.lost`. Called inside the transaction that makes the change, so every way a lead is made or
 * moved — the form, the API, a booking, a card, a connected pipeline, a person — records the same
 * event with the same fields (src/lib/automate/triggers.ts lists them).
 *
 * The payload is the lead's ids and the few fields a workflow tests or writes into a message — never
 * the contact's email or phone, which an action looks up from the lead when it needs them. The lead is
 * read behind the event's savepoint (`emitEvents`), so a workspace without a newer lead column loses
 * the event, never the change.
 */

export type LeadStageAt = { stageId: string | null; status: LeadStatus | string; pipelineId: string | null };

async function leadFacts(tx: Prisma.TransactionClient, leadId: string) {
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      leadSeq: true,
      title: true,
      status: true,
      stageId: true,
      pipelineId: true,
      source: true,
      ownerUserId: true,
      companyId: true,
      contactId: true,
      estimatedValue: true,
      expectedCloseDate: true,
      lostReason: true,
      company: { select: { name: true } },
      contact: { select: { name: true } },
    },
  });
  if (!lead) return null;
  return {
    lead: {
      id: lead.id,
      ref: formatLeadId(lead.leadSeq),
      title: lead.title,
      status: lead.status,
      stageId: lead.stageId,
      pipelineId: lead.pipelineId,
      source: lead.source,
      ownerUserId: lead.ownerUserId,
      companyId: lead.companyId,
      contactId: lead.contactId,
      value: lead.estimatedValue === null ? null : Number(lead.estimatedValue),
      expectedCloseDate: lead.expectedCloseDate?.toISOString() ?? null,
      lostReason: lead.lostReason,
    },
    company: { id: lead.companyId, name: lead.company.name },
    contact: lead.contactId ? { id: lead.contactId, name: lead.contact?.name ?? null } : null,
  };
}

/** A lead was made. `via` says how: "person", "form", "api", "booking", "card", "carried-on". */
export async function emitLeadCreated(tx: Prisma.TransactionClient, leadId: string, actorUserId: string | null, via: string, cause: EventCause | null = null): Promise<void> {
  await emitEvents(tx, "lead.created", async () => {
    const facts = await leadFacts(tx, leadId);
    return facts && { type: "lead.created", recordType: "lead", recordId: leadId, payload: { ...facts, via }, actorUserId, ...cause };
  });
}

/**
 * A lead moved: to another stage, or another pipeline. A move into a won stage is also `lead.won`;
 * into a lost or disqualified one, `lead.lost` — each only when it wasn't already so. `cause` when a
 * workflow's step moved it.
 */
export async function emitLeadMoved(tx: Prisma.TransactionClient, leadId: string, actorUserId: string | null, from: LeadStageAt, to: LeadStageAt, cause: EventCause | null = null): Promise<void> {
  await emitEvents(tx, "lead.stage_changed", async () => {
    const facts = await leadFacts(tx, leadId);
    if (!facts) return null;
    const payload = { ...facts, from, to };
    const base = { recordType: "lead", payload, actorUserId, ...cause };
    const lost = (s: string) => s === "LOST" || s === "DISQUALIFIED";
    return [
      // Keyed by lead and stage, so the once-a-minute rule (src/lib/automate/engine.ts) never swallows a
      // second move made within the minute — only the same move twice.
      { ...base, type: "lead.stage_changed", recordId: `${leadId}>${to.stageId ?? to.status}` },
      ...(to.status === "WON" && from.status !== "WON" ? [{ ...base, type: "lead.won", recordId: leadId }] : []),
      ...(lost(String(to.status)) && !lost(String(from.status)) ? [{ ...base, type: "lead.lost", recordId: leadId }] : []),
    ];
  });
}

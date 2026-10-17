import { z } from "zod";
import { db } from "@/lib/db";
import { formatLeadId } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { detailLeadMasker, maskLeadTitle } from "@/lib/leads/masking";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { pipelineById } from "@/lib/pipeline/rules";
import { defineAction } from "@/lib/automate/action-types";
import { notReached, reach, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Look a record up as it is now (Deskzo Automate, Phase 3) — for the steps after a delay, or after
 * one that changed it: what started the run was the record as it was then. Read only: nothing changes,
 * so a retry just reads again, and a test run reads for real.
 *
 * As the workflow's owner sees it on the record's page: a lead they reach, its name, company and
 * contact masked where their field access masks them — what a step writes into a task or an email is
 * never more than they could have copied off the page.
 */

const lead = z.object({ leadId: recordIdField("lead") }).strict();

export const leadGet = defineAction({
  key: "lead.get",
  label: "Look up a lead",
  description: "Reads a lead as it is now — its stage, owner and value — for the steps after.",
  module: "leads",
  permission: null,
  risk: "read",
  input: lead,
  outputs: ["id", "ref", "title", "status", "stageId", "stage", "pipelineId", "pipeline", "ownerUserId", "owner", "companyId", "company", "contactId", "contact", "hasContactEmail", "value", "valueText", "source", "expectedCloseDate"],
  preview: () => "Would read the lead as it is now.",
  async run(ctx, i) {
    await reach(ctx, "leads", "view", i.leadId, "lead");
    const row = await db.lead.findUnique({
      where: { id: i.leadId },
      select: {
        id: true,
        leadSeq: true,
        title: true,
        status: true,
        source: true,
        ownerUserId: true,
        companyId: true,
        contactId: true,
        estimatedValue: true,
        expectedCloseDate: true,
        owner: { select: { name: true } },
        company: { select: { name: true } },
        contact: { select: { name: true, email: true } },
      },
    });
    if (!row) throw notReached("lead");
    const [pipeline, stages, masker] = await Promise.all([leadStages(), stagesOfLeads([{ id: row.id, status: row.status }]), detailLeadMasker(ctx.actorId, row.id)]);
    const stage = stages.get(row.id) ?? null;
    const value = row.estimatedValue === null ? null : Number(row.estimatedValue);
    return {
      id: row.id,
      ref: formatLeadId(row.leadSeq),
      title: maskLeadTitle(masker, row.title),
      status: row.status,
      stageId: stage?.id ?? null,
      stage: stage?.label ?? "",
      pipelineId: stage?.pipelineId ?? null,
      pipeline: stage ? pipelineById(pipeline.pipelines, stage.pipelineId).name : "",
      ownerUserId: row.ownerUserId,
      owner: row.owner?.name ?? "",
      companyId: row.companyId,
      company: masker.present("companyName", row.company.name) ?? "",
      contactId: row.contactId,
      contact: row.contact ? (masker.present("contactName", row.contact.name) ?? "") : "",
      hasContactEmail: !!row.contact?.email,
      value,
      // As the pipeline's automations wrote it into a message: 1,50,000.
      valueText: value ? value.toLocaleString("en-IN") : "",
      source: masker.present("source", row.source) ?? "",
      expectedCloseDate: row.expectedCloseDate?.toISOString() ?? null,
    };
  },
});

const ticket = z.object({ ticketId: recordIdField("ticket") }).strict();

export const ticketGet = defineAction({
  key: "ticket.get",
  label: "Look up a ticket",
  description: "Reads a ticket as it is now — its status, who has it, and whether anybody has answered.",
  module: "helpdesk",
  permission: null,
  risk: "read",
  input: ticket,
  outputs: ["id", "ref", "title", "status", "priority", "assignedToUserId", "companyId", "answered", "replies", "open"],
  preview: () => "Would read the ticket as it is now.",
  async run(ctx, i) {
    await reach(ctx, "tickets", "view", i.ticketId, "ticket");
    const row = await db.ticket.findUnique({
      where: { id: i.ticketId },
      select: { id: true, ticketSeq: true, title: true, status: true, priority: true, assignedToUserId: true, companyId: true, createdByUserId: true, _count: { select: { comments: true } } },
    });
    if (!row) throw notReached("ticket");
    const emailed = await db.supportEmail.count({ where: { ticketId: row.id, direction: "OUTBOUND" } });
    const open = row.status === "OPEN";
    return {
      id: row.id,
      ref: formatTicketId(row.ticketSeq),
      title: row.title,
      status: row.status,
      priority: row.priority,
      assignedToUserId: row.assignedToUserId,
      companyId: row.companyId,
      // Answered: a reply went to the customer, somebody wrote on it, or it moved on from Open.
      answered: emailed > 0 || row._count.comments > 0 || !open,
      replies: emailed,
      open,
    };
  },
});

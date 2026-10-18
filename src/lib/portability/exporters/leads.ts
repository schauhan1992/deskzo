import { db } from "@/lib/db";
import { leadAccess } from "@/lib/authz/access";
import { exportCells } from "@/lib/custom-fields/sheets";
import { listLeadMasker } from "@/lib/leads/masking";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { MAIN_PIPELINE_ID, kindOf, pipelineById } from "@/lib/pipeline/rules";
import { workspaceClock } from "@/lib/time/workspace";
import type { Exporter } from "./types";

/**
 * Leads, the ones this person may see (`leadAccess`, as the list asks), masked as the list masks them —
 * an export is a list that leaves the building, never unmasked. Its columns are the leads import's
 * (src/lib/portability/importers/leads.ts), so an exported file edited and handed back changes only what
 * was edited, and a masked cell reads back as no change.
 *
 * Days are the workspace's: a closed deal's `Closed on` is when it moved to its closing stage, `Created on`
 * when it was made, each on the workspace's clock.
 */
export const leadsExporter: Exporter = async (scope) => {
  const [rows, pipeline, masker, clock] = await Promise.all([
    db.lead.findMany({
      where: { AND: [await leadAccess(scope.userId, "view")] },
      orderBy: { leadSeq: "asc" },
      select: {
        id: true,
        leadSeq: true,
        title: true,
        status: true,
        estimatedValue: true,
        expectedCloseDate: true,
        stageChangedAt: true,
        source: true,
        sourceDetail: true,
        lostReason: true,
        description: true,
        externalId: true,
        captureKeyId: true,
        createdAt: true,
        company: { select: { name: true } },
        contact: { select: { name: true, email: true, phone: true } },
        owner: { select: { name: true } },
      },
    }),
    leadStages(),
    listLeadMasker(scope.userId),
    workspaceClock(),
  ]);
  const stages = await stagesOfLeads(rows.map((l) => ({ id: l.id, status: l.status })));
  const several = pipeline.pipelines.filter((p) => !p.archived).length > 1;
  const show = (field: string, value: string | null | undefined) => masker.present(field, value) ?? "";

  const base = rows.map((l) => {
    const stage = stages.get(l.id);
    const closed = kindOf(l.status) !== "OPEN";
    return {
      Key: `LEAD-${String(l.leadSeq).padStart(6, "0")}`,
      // The other CRM's id, kept so its file re-imports onto the same lead; a website's enquiry id isn't one.
      "Old system ID": l.captureKeyId ? "" : (l.externalId ?? ""),
      Title: show("title", l.title),
      Company: show("companyName", l.company.name),
      Contact: show("contactName", l.contact?.name),
      "Contact email": show("email", l.contact?.email),
      "Contact phone": show("phone", l.contact?.phone),
      Pipeline: several ? pipelineById(pipeline.pipelines, stage?.pipelineId ?? MAIN_PIPELINE_ID).name : "",
      Stage: stage?.label ?? l.status,
      Owner: l.owner?.name ?? "",
      Value: l.estimatedValue === null ? null : Number(l.estimatedValue),
      // A calendar day held as midnight UTC, so its UTC date is the day typed.
      "Expected close": l.expectedCloseDate ? l.expectedCloseDate.toISOString().slice(0, 10) : "",
      "Closed on": closed && l.stageChangedAt ? clock.dateKey(l.stageChangedAt) : "",
      "Created on": clock.dateKey(l.createdAt),
      Source: show("source", l.source),
      "Source detail": show("source", l.sourceDetail),
      "Lost reason": l.lostReason ?? "",
      Description: show("description", l.description),
    };
  });
  // The workspace's own lead fields this person may see, after the built-in columns (src/lib/custom-fields/sheets.ts).
  const custom = await exportCells("LEAD", scope.userId, rows.map((l) => l.id), Object.keys(base[0] ?? {}));
  return base.map((b, n) => ({ ...b, ...custom(rows[n]!.id) }));
};

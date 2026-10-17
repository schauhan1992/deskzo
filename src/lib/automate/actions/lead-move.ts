import { z } from "zod";
import { LeadStatus } from "@prisma/client";
import { afterStageMove, planStageMove, writeStageMove } from "@/lib/leads/stage-move";
import { ActionError, causedBy, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withEffect } from "@/lib/automate/effects";
import { byWorkflow, reach, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Move a lead to a stage of its pipeline (Deskzo Automate, Phase 2) — exactly as dragging it on the
 * board does (src/lib/leads/stage-move.ts): the stage's rule may stop it, a lost lead needs a reason, a
 * win makes a customer and may carry on into the next pipeline, and the stage's own automations run.
 *
 * The move is a `lead.stage_changed` event caused by this run, so a workflow that starts on a stage
 * change and moves the lead doesn't start itself again (src/lib/automate/engine.ts).
 */

type Output = { leadId: string; stageId: string | null; status: string; moved: boolean };

const input = z
  .object({
    leadId: recordIdField("lead"),
    /** The stage, by id — one of the lead's own pipeline. */
    stageId: z.string().trim().min(1, "Choose a stage.").max(60).optional(),
    /** Or the first stage of its pipeline with this meaning: "WON", "LOST"… */
    status: z.enum(LeadStatus).optional(),
    /** Needed to mark a lead lost or disqualified. */
    lostReason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((i) => !!i.stageId !== !!i.status, { message: "Choose a stage, or a meaning — one of the two.", path: ["stageId"] });

export const leadMove = defineAction({
  key: "lead.move",
  label: "Move a lead to a stage",
  description: "Moves a lead to another stage of its pipeline, under the stage's rules.",
  module: "leads",
  permission: null,
  risk: "change",
  input,
  outputs: ["leadId", "stageId", "status", "moved"],
  preview: (i) => `Would move the lead to ${i.stageId ? "the chosen stage" : `its pipeline's ${String(i.status).toLowerCase()} stage`}.`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    await reach(ctx, "leads", "edit", i.leadId, "lead");
    const planned = await planStageMove({ leadId: i.leadId, stageId: i.stageId, status: i.status, lostReason: i.lostReason });
    if (!planned.ok) throw new ActionError(planned.error, "PERMANENT");
    const move = planned.move;
    // There already: nothing is recorded, as on the board.
    if (!move) return { leadId: i.leadId, stageId: i.stageId ?? null, status: String(i.status ?? ""), moved: false };

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      await writeStageMove(tx, move, ctx.actorId, causedBy(ctx));
      return { output: { leadId: move.lead.id, stageId: move.target.id, status: move.status, moved: true }, recordType: "lead", recordId: move.lead.id };
    });
    if (fresh) await afterStageMove(move, ctx.actorId, `moved to ${move.target.label} ${byWorkflow(ctx)}`);
    return output;
  },
});

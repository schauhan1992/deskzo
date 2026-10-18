import type { AiProvider } from "@prisma/client";
import { AiRefusal, aiService, aiTurn, aiUnavailable } from "@/lib/ai/gateway";
import { copilotConfig } from "@/lib/copilot/settings";
import type { ToolSpec, Turn, TurnOutcome } from "@/lib/copilot/types";

/**
 * The one place Automate's AI drafting reaches a model (Phase 5).
 *
 * Since 17 Oct 2026 it goes through Deskzo AI's gateway (src/lib/ai/gateway.ts), as the feature
 * "automate.draft": the model Deskzo chose for it in the console, paid for from the workspace's credits
 * and charged to the person drafting. The workspace's own switch for drafting comes first; then
 * everything the gateway checks — AI paused, the feature not set up, no credits left, the person's
 * daily cap. Nothing that calls this file changed when it moved.
 */

export class DraftingRefusal extends Error {}

/** Why drafting can't run for this person now, or null when it can. */
export async function draftingUnavailable(userId: string): Promise<string | null> {
  if (!(await copilotConfig()).draftingEnabled) return "Drafting with AI is switched off. An admin can switch it on in Settings → Deskzo AI.";
  return aiUnavailable(userId, "automate.draft");
}

/** The AI service a description is sent to, in words — shown before anybody types one. */
export async function draftingProvider(): Promise<string> {
  const service = await aiService("automate.draft");
  if (!service) return "Deskzo AI";
  return `Deskzo AI (${service.model}, processed in ${service.residency}${service.noTraining ? ", never used for training" : ""})`;
}

export type DraftingTurn = { system: string; history: Turn[]; tools: ToolSpec[]; signal?: AbortSignal };
export type DraftingOutcome = TurnOutcome & { provider: AiProvider };

/** One model turn for `userId`, charged to the workspace's credits. Throws `DraftingRefusal` with words for a person. */
export async function draftingTurn(userId: string, turn: DraftingTurn): Promise<DraftingOutcome> {
  const refusal = await draftingUnavailable(userId);
  if (refusal) throw new DraftingRefusal(refusal);
  try {
    const outcome = await aiTurn({ userId, feature: "automate.draft", system: turn.system, history: turn.history, tools: turn.tools, signal: turn.signal });
    return { text: outcome.text, toolCalls: outcome.toolCalls, native: outcome.native, usage: outcome.usage, stop: outcome.stop, model: outcome.model, provider: outcome.family };
  } catch (err) {
    if (err instanceof AiRefusal) throw new DraftingRefusal(err.message);
    throw err;
  }
}

import type { AiProvider } from "@prisma/client";
import { adapterFor, PROVIDERS } from "@/lib/copilot/providers";
import { copilotConfig, providerKey, recordUsage } from "@/lib/copilot/settings";
import { friendlyError, unavailableBecause } from "@/lib/copilot/agent";
import type { ToolSpec, Turn, TurnOutcome } from "@/lib/copilot/types";

/**
 * The one place Automate's AI drafting reaches a model (Phase 5).
 *
 * Today it goes through the workspace's AI copilot: its provider (Claude, ChatGPT or Gemini), its key,
 * its model and its allowances — the switch, `copilot.use`, the plan's monthly tokens and each
 * person's daily limit — with the tokens counted as the copilot's. The owner decided on 17 Oct 2026
 * that AI moves to a Deskzo gateway paid in credits; when that exists, this file is what changes, and
 * nothing that calls it does.
 */

export class DraftingRefusal extends Error {}

/** Why drafting can't run for this person now, or null when it can. */
export async function draftingUnavailable(userId: string): Promise<string | null> {
  return unavailableBecause(userId);
}

/** The AI service a description is sent to, in words — shown before anybody types one. */
export async function draftingProvider(): Promise<string> {
  return PROVIDERS[(await copilotConfig()).provider].label;
}

export type DraftingTurn = { system: string; history: Turn[]; tools: ToolSpec[]; signal?: AbortSignal };
export type DraftingOutcome = TurnOutcome & { provider: AiProvider };

/** One model turn for `userId`, counted against their allowance. Throws `DraftingRefusal` with words for a person. */
export async function draftingTurn(userId: string, turn: DraftingTurn): Promise<DraftingOutcome> {
  const refusal = await draftingUnavailable(userId);
  if (refusal) throw new DraftingRefusal(refusal);
  const config = await copilotConfig();
  const apiKey = await providerKey(config.provider);
  if (!apiKey) throw new DraftingRefusal("The AI copilot has no API key for its provider yet — an admin adds it in Settings → AI copilot.");
  let outcome: TurnOutcome;
  try {
    outcome = await adapterFor(config.provider).runTurn({ apiKey, model: config.model, system: turn.system, history: turn.history, tools: turn.tools, signal: turn.signal, onText: () => {} });
  } catch (err) {
    console.error("automate drafting: provider call failed", err);
    throw new DraftingRefusal(friendlyError(err));
  }
  await recordUsage(userId, outcome.usage);
  return { ...outcome, provider: config.provider };
}

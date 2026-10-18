import type { AiProvider } from "@prisma/client";
import { MILLI, creditsText, familyOf, type AiFeature } from "@/lib/ai/catalogue";
import { AiNotReady, routeFor, withoutSecrets, type Route } from "@/lib/ai/accounts";
import { chargeTurn, creditStanding, usedTodayBy, type Charge } from "@/lib/ai/credits";
import { aiPaused } from "@/lib/ai/settings";
import { redactSecrets } from "@/lib/console-shared/redact";
import { copilotConfig } from "@/lib/copilot/settings";
import { adapterFor } from "@/lib/copilot/providers";
import type { Connection, ToolSpec, Turn, TurnOutcome } from "@/lib/copilot/types";
import { currentTenant } from "@/lib/tenancy/resolve";
import { clockOfTenant } from "@/lib/time/workspace";

/**
 * Deskzo AI's gateway (owner, 17 Oct 2026): the one way any feature reaches a model. The copilot, Automate's
 * drafting and whatever comes next ask for a feature, never a provider or a key.
 *
 *   1. Refused before anything is spent: AI paused platform-wide (console › Settings › AI), the feature not
 *      set up, no credits left in the workspace (the hard stop), or the person's daily cap reached. Each
 *      feature checks its own switch and permission first (src/lib/copilot/agent.ts, src/lib/automate/ai).
 *   2. The feature's model and account (src/lib/ai/accounts.ts `routeFor`) — Claude on Bedrock India to
 *      start with — through the adapter for the API it speaks.
 *   3. The turn charged when it ends, tokens × the model's rates, to the person, the feature and the model
 *      (src/lib/ai/credits.ts). A turn that fails costs nothing; one that answers is charged even if the
 *      person has gone.
 */

/** Words for the person asking: why AI can't do this for them now. */
export class AiRefusal extends Error {}

const NOT_SET_UP = "Deskzo AI isn't available right now. Try again later, or write to Deskzo support if it goes on.";

/** Why `feature` can't run for `userId` now, or null when it can — every check the gateway makes, nothing spent. */
export async function aiUnavailable(userId: string, feature: AiFeature): Promise<string | null> {
  if (await aiPaused()) return "Deskzo AI is paused for a short while. Try again later.";
  if (!(await routeFor(feature))) return NOT_SET_UP;
  const tenant = await currentTenant();
  const standing = await creditStanding(tenant);
  if (standing.metered && standing.available !== null && standing.available <= 0) {
    if (standing.allowance === 0 && standing.packsRemaining === 0 && standing.allowanceUsed === 0) return "Deskzo AI isn't part of this workspace's plan. A credit pack adds it — whoever manages billing buys one in Settings → Plan & billing.";
    const renews = clockOfTenant(tenant).date(standing.renewsAt);
    return `This workspace has used all its Deskzo AI credits. They renew on ${renews}, or whoever manages billing can buy a pack in Settings → Plan & billing.`;
  }
  const { dailyCreditLimit } = await copilotConfig();
  if (dailyCreditLimit !== null && (await usedTodayBy(userId, tenant)) >= dailyCreditLimit * MILLI) return `You've used today's ${creditsText(dailyCreditLimit * MILLI)} Deskzo AI credits. They reset at midnight.`;
  return null;
}

/** Where a feature's requests go, in words shown before anybody uses it: the model, who runs it, where, and whether it trains. */
export type AiService = { model: string; residency: string; noTraining: boolean };

export async function aiService(feature: AiFeature): Promise<AiService | null> {
  const route = await routeFor(feature);
  return route ? { model: route.model.label, residency: route.account.residency, noTraining: route.account.noTraining } : null;
}

/** What to tell a person when the provider's call fails. The provider's own words go to the server log only. */
export function friendlyError(err: unknown): string {
  if (err instanceof AiNotReady) return NOT_SET_UP;
  const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : null;
  if (status === 429) return "Deskzo AI is busy just now. Try again in a minute.";
  if (status !== null && status >= 500) return "Deskzo AI's provider had a problem answering. Try again in a minute.";
  return "Deskzo AI couldn't answer just now. Try again in a minute.";
}

export type AiTurn = {
  userId: string;
  feature: AiFeature;
  system: string;
  history: Turn[];
  tools: ToolSpec[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
};

export type AiTurnOutcome = TurnOutcome & {
  /** The API it was spoken in — kept with the turn, so a provider's own form of it is replayed only to that API. */
  family: AiProvider;
  /** The model's key in Deskzo AI ("claude-sonnet-5-india"). */
  modelKey: string;
  charge: Charge;
};

/** One model turn for a person, through the feature's model, charged to the workspace. Throws `AiRefusal` with words for them. */
export async function aiTurn(turn: AiTurn): Promise<AiTurnOutcome> {
  const refusal = await aiUnavailable(turn.userId, turn.feature);
  if (refusal) throw new AiRefusal(refusal);
  const route = (await routeFor(turn.feature)) as Route;
  const family = familyOf(route.account.kind);
  let outcome: TurnOutcome;
  let connection: Connection | null = null;
  try {
    connection = route.connection();
    outcome = await adapterFor(family).runTurn({
      connection,
      model: route.model.providerModel,
      system: turn.system,
      history: turn.history,
      tools: turn.tools,
      signal: turn.signal,
      onText: turn.onText ?? (() => {}),
    });
  } catch (err) {
    if (turn.signal?.aborted) throw err;
    console.error(`[ai] ${turn.feature} on ${route.model.key} failed:`, redactSecrets(withoutSecrets(err instanceof Error ? err.message : String(err), connection)));
    const wrapped = new AiRefusal(friendlyError(err));
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
  const charge = await chargeTurn({ userId: turn.userId, feature: turn.feature, route, usage: outcome.usage });
  return { ...outcome, family, modelKey: route.model.key, charge };
}

/** Between the steps of a longer piece of work (the copilot's tool calls): whether to stop, in words, or null to carry on. */
export async function aiShouldStop(userId: string, feature: AiFeature): Promise<string | null> {
  return aiUnavailable(userId, feature);
}

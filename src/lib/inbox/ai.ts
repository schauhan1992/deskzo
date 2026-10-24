import { AiRefusal, aiTurn, aiUnavailable } from "@/lib/ai/gateway";
import type { Turn } from "@/lib/copilot/types";
import type { ChannelSettings } from "@/lib/inbox/settings";

/**
 * Deskzo AI answering a customer for the Customer inbox's bot (owner, 24 Oct 2026: set answers by
 * default, AI an option a channel switches on). Through Deskzo AI's gateway (src/lib/ai/gateway.ts) — the
 * workspace's credits, the platform's pause, the feature's model — as feature "inbox.answer".
 *
 * Told as little as will do (the owner is wary of what goes to a model): the conversation, the channel's
 * set answers and its notes about the business. No customer record, no other conversation. It answers
 * briefly from those alone, and says HANDOVER — and the bot passes the customer to a person — for
 * anything it isn't sure of, anything about the customer's own order or account, or a person asked for.
 * A refusal or a failure hands over the same way: a customer never waits on the AI.
 */

export const HANDOVER_MARK = "HANDOVER";

export type AiReply = { text: string } | { handover: true };

type Answerer = (input: { system: string; history: Turn[]; chargedTo: string }) => Promise<string | null>;
let testAnswerer: Answerer | null = null;

/** For the checks: every AI answer comes from here instead of a model. Null puts the gateway back. */
export function setTestInboxAi(answerer: Answerer | null) {
  testAnswerer = answerer;
}

/** What the model is told: who it speaks for, what it may say, and when to stop. */
export function aiSystemPrompt(settings: ChannelSettings, business: string): string {
  const answers = settings.bot.answers.map((a) => `- When asked about ${a.keywords}: ${a.answer}`).join("\n");
  return [
    `You answer customers in ${business}'s website chat and WhatsApp. Be brief — at most three short sentences — friendly and plain.`,
    "Answer only from the facts below. Never invent prices, dates, stock, offers or promises, and never ask for a password, card number or one-time code.",
    `Reply with exactly ${HANDOVER_MARK} and nothing else when: the answer isn't in the facts; the customer asks for a person, a quotation or a call; it's about their own order, invoice, account or a complaint; or you are not sure.`,
    "Reply in the language the customer writes in.",
    "",
    "Facts:",
    answers || "(no set answers)",
    settings.bot.ai.about ? `\nAbout the business:\n${settings.bot.ai.about}` : "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** The conversation, as turns: the customer's words as theirs, the bot's and the team's as the assistant's. The last ten. */
export function aiHistory(messages: { author: string; body: string }[]): Turn[] {
  const turns: Extract<Turn, { role: "user" | "assistant" }>[] = [];
  for (const m of messages.filter((x) => x.author !== "SYSTEM").slice(-10)) {
    const role = m.author === "CUSTOMER" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    // Two of the same in a row are one turn: the model wants them taking turns.
    if (last && last.role === role) {
      last.text = `${last.text}\n${m.body}`;
      continue;
    }
    turns.push(role === "user" ? { role, text: m.body } : { role, text: m.body, toolCalls: [] });
  }
  // It must start with the customer.
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

/** Deskzo AI's answer to the customer's latest message, or a handover. Never throws. */
export async function aiAnswer(input: { settings: ChannelSettings; business: string; messages: { author: string; body: string }[] }): Promise<AiReply> {
  const chargedTo = input.settings.bot.ai.chargedTo;
  if (!input.settings.bot.ai.on || !chargedTo) return { handover: true };
  const history = aiHistory(input.messages);
  if (!history.length || history[history.length - 1]!.role !== "user") return { handover: true };
  const system = aiSystemPrompt(input.settings, input.business);
  try {
    let text: string | null;
    if (testAnswerer) {
      text = await testAnswerer({ system, history, chargedTo });
    } else {
      if (await aiUnavailable(chargedTo, "inbox.answer")) return { handover: true };
      const outcome = await aiTurn({ userId: chargedTo, feature: "inbox.answer", system, history, tools: [] });
      text = outcome.stop === "done" ? outcome.text : null;
    }
    const answer = text?.trim() ?? "";
    if (!answer || answer.toUpperCase().includes(HANDOVER_MARK) || answer.length > 1200) return { handover: true };
    return { text: answer };
  } catch (err) {
    if (!(err instanceof AiRefusal)) console.error("[inbox] Deskzo AI couldn't answer; handed over", err instanceof Error ? err.message : err);
    return { handover: true };
  }
}

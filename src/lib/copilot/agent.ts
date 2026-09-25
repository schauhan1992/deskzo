import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { adapterFor } from "@/lib/copilot/providers";
import { copilotConfig, providerKey, recordUsage, usedToday } from "@/lib/copilot/settings";
import { indianToday, outputText, runTool, toolSpec, toolsFor } from "@/lib/copilot/tools";
import { systemPrompt } from "@/lib/copilot/prompt";
import type { ChatEvent, DisplayBlock, ToolCall, ToolResult, Turn } from "@/lib/copilot/types";

/**
 * One exchange with the copilot: the person's message in, the answer streamed out, with as many
 * tool calls in between as it takes (up to MAX_STEPS).
 *
 *   1. Refused before anything is spent if the copilot is off, has no key, the person lacks
 *      `copilot.use`, or they have used today's allowance.
 *   2. The conversation so far is read back, provider-neutral, and handed to whichever provider is
 *      configured now — see ./types.ts.
 *   3. Each model turn streams its text out as it is written. Tool calls are checked and run as the
 *      person (./tools.ts), and their results — plus any chart or confirmation card — go back to the
 *      model and out to the screen.
 *   4. Every turn is saved as it completes, and its tokens counted against the day, so a request
 *      that fails half way has still been paid for and is still on the record.
 */

export const MAX_STEPS = 8;
/** How much of a long conversation is sent back each time. Older turns stay saved, just not resent. */
const HISTORY_MESSAGES = 40;

type RunInput = {
  userId: string;
  userName: string;
  role: string;
  conversationId?: string | null;
  text: string;
  appName: string;
  emit: (event: ChatEvent) => void;
  signal?: AbortSignal;
};

export class CopilotRefusal extends Error {}

/** Why the copilot won't run for this person right now, or null when it will. */
export async function unavailableBecause(userId: string): Promise<string | null> {
  const config = await copilotConfig();
  if (!config.enabled) return "The copilot is switched off. An admin can switch it on in Settings → AI copilot.";
  if (!config.hasKey[config.provider]) return "The copilot has no API key for its provider yet — an admin adds it in Settings → AI copilot.";
  if (!config.model.trim()) return "No model is chosen for the copilot yet — an admin picks one in Settings → AI copilot.";
  if (!(await can(userId, "copilot.use"))) return "You don't have access to the AI copilot.";
  if ((await usedToday(userId)) >= config.dailyTokenLimit) return "You've used today's copilot allowance. It resets at midnight.";
  return null;
}

function turnOf(role: string, content: Prisma.JsonValue): Turn | null {
  const c = (content ?? {}) as Record<string, unknown>;
  if (role === "user") return { role: "user", text: String(c.text ?? "") };
  if (role === "note") return { role: "note", text: String(c.text ?? "") };
  if (role === "tool") return { role: "tool", results: (c.results as ToolResult[]) ?? [] };
  if (role === "assistant") {
    return {
      role: "assistant",
      text: String(c.text ?? ""),
      toolCalls: (c.toolCalls as ToolCall[]) ?? [],
      native: c.native as Extract<Turn, { role: "assistant" }>["native"],
    };
  }
  return null;
}

async function history(conversationId: string): Promise<Turn[]> {
  const rows = await db.copilotMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_MESSAGES,
    select: { role: true, content: true },
  });
  const turns = rows.reverse().map((r) => turnOf(r.role, r.content)).filter((t): t is Turn => t !== null);
  // Never start mid-exchange: a tool result whose call was cut off is a malformed request everywhere.
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

function friendlyError(err: unknown): string {
  const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : null;
  if (status === 401 || status === 403) return "The AI provider refused the API key. An admin should check it in Settings → AI copilot.";
  if (status === 404) return "The AI provider doesn't recognise the chosen model. An admin should pick another in Settings → AI copilot.";
  if (status === 429) return "The AI provider is busy or the account's limit is reached. Try again in a minute.";
  if (status !== null && status >= 500) return "The AI provider had a problem answering. Try again in a minute.";
  return "The copilot couldn't reach the AI provider. Try again in a minute.";
}

export async function runCopilot(input: RunInput): Promise<void> {
  const refusal = await unavailableBecause(input.userId);
  if (refusal) throw new CopilotRefusal(refusal);
  const text = input.text.trim();
  if (!text) throw new CopilotRefusal("Type a question first.");
  if (text.length > 4000) throw new CopilotRefusal("That's too long for one message — keep it under 4,000 characters.");

  const config = await copilotConfig();
  const apiKey = (await providerKey(config.provider))!;
  const adapter = adapterFor(config.provider);

  // The conversation — only ever the person's own.
  let conversation = input.conversationId
    ? await db.copilotConversation.findFirst({ where: { id: input.conversationId, userId: input.userId }, select: { id: true, title: true } })
    : null;
  if (input.conversationId && !conversation) throw new CopilotRefusal("That conversation isn't there any more.");
  if (!conversation) {
    const title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
    conversation = await db.copilotConversation.create({ data: { userId: input.userId, title }, select: { id: true, title: true } });
  }
  input.emit({ type: "conversation", id: conversation.id, title: conversation.title });

  const save = (role: string, content: object, extra: Partial<Prisma.CopilotMessageUncheckedCreateInput> = {}) =>
    db.copilotMessage.create({ data: { conversationId: conversation!.id, role, content: content as Prisma.InputJsonValue, ...extra } });
  await save("user", { text });

  const tools = await toolsFor();
  const specs = tools.map(toolSpec);
  const system = systemPrompt({ userName: input.userName, role: input.role, today: indianToday(), appName: input.appName });
  const ctx = { userId: input.userId, conversationId: conversation.id };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0) {
        if ((await usedToday(input.userId)) >= config.dailyTokenLimit) {
          const note = "\n\n_(Stopped: today's copilot allowance is used up.)_";
          input.emit({ type: "text", delta: note });
          await save("assistant", { text: note.trim(), toolCalls: [] });
          break;
        }
        input.emit({ type: "step" });
      }

      let written = "";
      let outcome;
      try {
        outcome = await adapter.runTurn({
          apiKey,
          model: config.model,
          system,
          history: await history(conversation.id),
          tools: specs,
          signal: input.signal,
          onText: (delta) => {
            written += delta;
            input.emit({ type: "text", delta });
          },
        });
      } catch (err) {
        if (input.signal?.aborted) {
          if (written) await save("assistant", { text: written, toolCalls: [] });
          return;
        }
        console.error("copilot provider call failed", err);
        if (written) await save("assistant", { text: written, toolCalls: [] });
        throw new CopilotRefusal(friendlyError(err));
      }

      await recordUsage(input.userId, outcome.usage);
      await save(
        "assistant",
        {
          text: outcome.text,
          toolCalls: outcome.toolCalls,
          ...(outcome.native ? { native: { provider: config.provider, model: outcome.model, content: outcome.native } } : {}),
        },
        { provider: config.provider, model: outcome.model, inputTokens: outcome.usage.input, outputTokens: outcome.usage.output },
      );

      if (outcome.stop === "refused") {
        const note = "The AI provider declined to answer that one. Try asking it differently.";
        input.emit({ type: "text", delta: (written ? "\n\n" : "") + note });
        await save("note", { text: note });
        break;
      }
      if (outcome.stop === "truncated") {
        input.emit({ type: "text", delta: "\n\n_(The answer was cut short — ask a narrower question.)_" });
        break;
      }
      if (outcome.stop !== "tools") break;

      // The calls, checked and run as the person — in parallel, their results returned together.
      const ran = await Promise.all(outcome.toolCalls.map((call) => runTool(tools, ctx, call.name, call.input)));
      const results: ToolResult[] = outcome.toolCalls.map((call, i) => ({ id: call.id, name: call.name, output: outputText(ran[i]!.output), isError: ran[i]!.isError }));
      const blocks: DisplayBlock[] = ran.flatMap((r) => [{ type: "activity" as const, label: r.activity }, ...(r.blocks ?? [])]);
      for (const block of blocks) input.emit({ type: "block", block });
      await save("tool", { results, blocks });
    }
  } finally {
    await db.copilotConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }
  input.emit({ type: "done", usedToday: await usedToday(input.userId), limit: config.dailyTokenLimit });
}

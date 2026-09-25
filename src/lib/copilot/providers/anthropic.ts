import Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";

/**
 * Claude, through the official SDK: a streamed turn with our tools, the answer handed out as it is
 * written, and the complete message collected with `finalMessage()`.
 *
 *   · Tool inputs stream as they are generated (`eager_input_streaming`), so the server no longer
 *     validates them — every input is checked against its schema in src/lib/copilot/tools.ts before
 *     anything runs, and an unparseable one re-issues the turn rather than running.
 *   · The system prompt and tools never change within a conversation, so the request is cached
 *     automatically (`cache_control` on the request) and each follow-up reads the history from cache.
 *   · On Claude Opus 5 and Fable 5, a refusal is retried on a suitable model server-side
 *     (`fallbacks: "default"`), so a harmless question tripped by a classifier still gets answered.
 */

const toolUseId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";

export function messagesFor(history: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of history) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text });
    else if (turn.role === "note") out.push({ role: "user", content: `(From the app, not typed by the user) ${turn.text}` });
    else if (turn.role === "tool") {
      out.push({
        role: "user",
        content: turn.results.map((r) => ({ type: "tool_result" as const, tool_use_id: toolUseId(r.id), content: r.output, is_error: r.isError === true })),
      });
    } else if (turn.native?.provider === "ANTHROPIC" && Array.isArray(turn.native.content)) {
      // Replayed exactly as it came back — thinking blocks included, which Claude needs to carry on.
      out.push({ role: "assistant", content: turn.native.content as Anthropic.Beta.BetaContentBlockParam[] });
    } else {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) content.push({ type: "tool_use", id: toolUseId(call.id), name: call.name, input: call.input });
      if (content.length) out.push({ role: "assistant", content });
    }
  }
  return out;
}

const refusalFallback = (model: string) => /^claude-(opus-5|fable-5)/.test(model);

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const client = new Anthropic({ apiKey: request.apiKey, maxRetries: 2 });
  const tools: Anthropic.Beta.BetaTool[] = request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));

  for (let attempt = 0; ; attempt++) {
    let written = "";
    const stream = client.beta.messages.stream(
      {
        model: request.model,
        max_tokens: 32000,
        system: request.system,
        messages: messagesFor(request.history),
        tools,
        cache_control: { type: "ephemeral" },
        ...(refusalFallback(request.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    );
    stream.on("text", (delta) => {
      written += delta;
      request.onText(delta);
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // Only a tool input that couldn't be parsed at all is worth another go — and only if nothing
      // has been shown yet, so the answer isn't written twice. API errors go to the caller.
      if (err instanceof Anthropic.APIError || attempt >= 2 || written) throw err;
      continue;
    }

    const toolCalls: ToolCall[] = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const u = message.usage;
    const usage = {
      input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + Math.ceil((u.cache_read_input_tokens ?? 0) / 10),
      output: u.output_tokens,
    };
    // A refusal can cut a tool call off mid-input, and so can running out of room: never run those.
    const stop: TurnOutcome["stop"] =
      message.stop_reason === "refusal"
        ? "refused"
        : message.stop_reason === "max_tokens"
          ? "truncated"
          : toolCalls.length > 0
            ? "tools"
            : "done";
    return { text, toolCalls: stop === "tools" ? toolCalls : [], native: message.content, usage, stop, model: message.model };
  }
}

async function listModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const ids: string[] = [];
  for await (const model of client.models.list()) ids.push(model.id);
  return ids;
}

export const anthropic: ProviderAdapter = { runTurn, listModels };

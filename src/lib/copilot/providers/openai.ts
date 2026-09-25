import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";

/**
 * ChatGPT, through OpenAI's official SDK: a streamed Chat Completions turn with our tools as
 * functions. Arguments arrive as a JSON string; they are parsed here and checked against the tool's
 * schema before anything runs (src/lib/copilot/tools.ts), like every provider's.
 */

export function messagesFor(system: string, history: Turn[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const turn of history) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text });
    else if (turn.role === "note") out.push({ role: "user", content: `(From the app, not typed by the user) ${turn.text}` });
    else if (turn.role === "tool") {
      for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.output}` : r.output });
    } else {
      out.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length
          ? {
              tool_calls: turn.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Handed to the schema check as-is, which refuses it and tells the model why.
    return { __unparseable: raw };
  }
}

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const client = new OpenAI({ apiKey: request.apiKey, maxRetries: 2 });
  const tools: ChatCompletionTool[] = request.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const stream = client.chat.completions.stream(
    {
      model: request.model,
      messages: messagesFor(request.system, request.history),
      tools,
      max_completion_tokens: 16000,
      stream_options: { include_usage: true },
    },
    { signal: request.signal },
  );
  stream.on("content.delta", ({ delta }) => request.onText(delta));
  const completion = await stream.finalChatCompletion();

  const choice = completion.choices[0];
  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? [])
    .filter((c) => c.type === "function")
    .map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
  const u = completion.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = { input: (u?.prompt_tokens ?? 0) - cached + Math.ceil(cached / 10), output: u?.completion_tokens ?? 0 };
  const stop: TurnOutcome["stop"] =
    choice?.finish_reason === "length"
      ? "truncated"
      : choice?.finish_reason === "content_filter" || choice?.message.refusal
        ? "refused"
        : toolCalls.length > 0
          ? "tools"
          : "done";
  return {
    text: choice?.message.content ?? "",
    toolCalls: stop === "tools" ? toolCalls : [],
    native: null,
    usage,
    stop,
    model: completion.model,
  };
}

async function listModels(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey, maxRetries: 1 });
  const ids: string[] = [];
  for await (const model of client.models.list()) ids.push(model.id);
  return ids;
}

export const openai: ProviderAdapter = { runTurn, listModels };

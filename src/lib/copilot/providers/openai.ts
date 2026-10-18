import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Connection, ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";

/**
 * OpenAI's Chat Completions, through its official SDK — from OpenAI, an Azure OpenAI resource (the model
 * named is the deployment), or any server that speaks the same API: vLLM, Ollama, Deskzo's own GPU. A
 * streamed turn with our tools as functions. Arguments arrive as a JSON string; they are parsed here and
 * checked against the tool's schema before anything runs (src/lib/copilot/tools.ts), like every provider's.
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

export function openaiClient(connection: Connection): OpenAI {
  switch (connection.kind) {
    case "OPENAI":
      return new OpenAI({ apiKey: connection.apiKey, maxRetries: 2 });
    case "AZURE_OPENAI":
      return new AzureOpenAI({ endpoint: connection.endpoint, apiKey: connection.apiKey, apiVersion: connection.apiVersion, maxRetries: 2 });
    case "OPENAI_COMPATIBLE":
      // The SDK wants a key; a server that takes none ignores the header.
      return new OpenAI({ baseURL: connection.baseURL, apiKey: connection.apiKey ?? "none", maxRetries: 2 });
    default:
      throw new Error(`A ${connection.kind} account doesn't speak OpenAI's API.`);
  }
}

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const client = openaiClient(request.connection);
  const tools: ChatCompletionTool[] = request.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const stream = client.chat.completions.stream(
    {
      model: request.model,
      messages: messagesFor(request.system, request.history),
      tools,
      max_completion_tokens: request.maxTokens ?? 16000,
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

export const openai: ProviderAdapter = { runTurn };

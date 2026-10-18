import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Connection, ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";

/**
 * Claude, through the official SDKs: Anthropic's own API, or Amazon Bedrock from one AWS region (Deskzo
 * AI's first provider, owner 17 Oct 2026: India's inference profiles keep requests in Mumbai and
 * Hyderabad). A streamed turn with our tools, the answer handed out as it is written, and the complete
 * message collected with `finalMessage()`.
 *
 *   · Anthropic's API: tool inputs stream as they are generated (`eager_input_streaming`), so the server
 *     no longer validates them. Every input is checked against its schema in src/lib/copilot/tools.ts
 *     before anything runs, and an unparseable one re-issues the turn rather than running. The request
 *     is cached automatically (`cache_control` on the request). On Claude Opus 5 and Fable 5 a refusal is
 *     retried server-side on a suitable model (`fallbacks: "default"`).
 *   · Bedrock: neither fallbacks nor eager input streaming are offered everywhere, and older models there
 *     refuse a request-level `cache_control`, so the cache is marked on the system prompt and the newest
 *     message instead (`bedrockBreakpoints`). A refusal is reported as one.
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

/**
 * Bedrock's cache marks: the system prompt (which, rendered after the tools, caches them too) and the
 * newest message, so each follow-up reads the conversation so far from cache. Two of the four allowed.
 */
export function bedrockBreakpoints(system: string, messages: Anthropic.Beta.BetaMessageParam[]) {
  const mark = { type: "ephemeral" as const };
  const marked = messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];
    const last = blocks.length - 1;
    if (last >= 0) blocks[last] = { ...blocks[last], cache_control: mark } as Anthropic.Beta.BetaContentBlockParam;
    return { ...m, content: blocks };
  });
  return { system: [{ type: "text" as const, text: system, cache_control: mark }], messages: marked };
}

const refusalFallback = (model: string) => /^claude-(opus-5|fable-5)/.test(model);

type Messages = Anthropic["beta"]["messages"];

/** The client for a connection. Bedrock's has the same `beta.messages` as Anthropic's, less batches and counting. */
export function claudeClient(connection: Connection): { messages: Pick<Messages, "stream">; bedrock: boolean } {
  if (connection.kind === "ANTHROPIC") return { messages: new Anthropic({ apiKey: connection.apiKey, maxRetries: 2 }).beta.messages, bedrock: false };
  if (connection.kind === "BEDROCK") {
    const client = connection.accessKeyId
      ? new AnthropicBedrock({ awsRegion: connection.region, awsAccessKey: connection.accessKeyId, awsSecretKey: connection.secret, maxRetries: 2 })
      : new AnthropicBedrock({ awsRegion: connection.region, apiKey: connection.secret, maxRetries: 2 });
    return { messages: client.beta.messages as unknown as Pick<Messages, "stream">, bedrock: true };
  }
  throw new Error(`A ${connection.kind} account doesn't speak Claude's API.`);
}

/** The request for one turn — apart from the client, so check:ai-gateway can read what each provider is sent. */
export type ClaudeParams = Parameters<Messages["stream"]>[0];

export function claudeParams(request: TurnRequest, bedrock: boolean): ClaudeParams {
  const messages = messagesFor(request.history);
  const tools: Anthropic.Beta.BetaTool[] = request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    ...(bedrock ? {} : { eager_input_streaming: true }),
  }));
  const maxTokens = request.maxTokens ?? 32000;
  if (bedrock) {
    const cached = bedrockBreakpoints(request.system, messages);
    return { model: request.model, max_tokens: maxTokens, system: cached.system, messages: cached.messages, tools };
  }
  return {
    model: request.model,
    max_tokens: maxTokens,
    system: request.system,
    messages,
    tools,
    cache_control: { type: "ephemeral" },
    ...(refusalFallback(request.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  } as ClaudeParams;
}

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const { messages, bedrock } = claudeClient(request.connection);
  const params = claudeParams(request, bedrock);

  for (let attempt = 0; ; attempt++) {
    let written = "";
    const stream = messages.stream(params, { signal: request.signal });
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

export const anthropic: ProviderAdapter = { runTurn };

import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { ProviderAdapter, ToolCall, Turn, TurnOutcome, TurnRequest } from "@/lib/copilot/types";

/**
 * Gemini, through Google's official SDK: a streamed `generateContent` turn with our tools as
 * function declarations.
 *
 * The model's parts are kept exactly as they came — every chunk's, in order — and replayed as they
 * are, because Gemini attaches thought signatures to them that it needs back to carry on.
 */

export function contentsFor(history: Turn[]): Content[] {
  const out: Content[] = [];
  for (const turn of history) {
    if (turn.role === "user") out.push({ role: "user", parts: [{ text: turn.text }] });
    else if (turn.role === "note") out.push({ role: "user", parts: [{ text: `(From the app, not typed by the user) ${turn.text}` }] });
    else if (turn.role === "tool") {
      out.push({
        role: "user",
        parts: turn.results.map((r) => ({
          functionResponse: { id: r.id, name: r.name, response: r.isError ? { error: r.output } : { output: r.output } },
        })),
      });
    } else if (turn.native?.provider === "GEMINI" && Array.isArray(turn.native.content)) {
      out.push({ role: "model", parts: turn.native.content as Part[] });
    } else {
      const parts: Part[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls) parts.push({ functionCall: { id: call.id, name: call.name, args: (call.input ?? {}) as Record<string, unknown> } });
      if (parts.length) out.push({ role: "model", parts });
    }
  }
  return out;
}

const REFUSED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

async function runTurn(request: TurnRequest): Promise<TurnOutcome> {
  const ai = new GoogleGenAI({ apiKey: request.apiKey });
  const stream = await ai.models.generateContentStream({
    model: request.model,
    contents: contentsFor(request.history),
    config: {
      systemInstruction: request.system,
      tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      maxOutputTokens: 16000,
      abortSignal: request.signal,
    },
  });

  const parts: Part[] = [];
  let text = "";
  let finish: string | undefined;
  let usage = { input: 0, output: 0 };
  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part);
      if (part.text && !part.thought) {
        text += part.text;
        request.onText(part.text);
      }
    }
    if (candidate?.finishReason) finish = String(candidate.finishReason);
    const u = chunk.usageMetadata;
    if (u) {
      const cached = u.cachedContentTokenCount ?? 0;
      usage = {
        input: (u.promptTokenCount ?? 0) - cached + Math.ceil(cached / 10),
        // Thinking is billed as output.
        output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      };
    }
  }

  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({ id: p.functionCall!.id || `call_${i}`, name: p.functionCall!.name!, input: p.functionCall!.args ?? {} }));
  const stop: TurnOutcome["stop"] =
    finish === "MAX_TOKENS" ? "truncated" : finish && REFUSED.has(finish) ? "refused" : toolCalls.length > 0 ? "tools" : "done";
  return { text, toolCalls: stop === "tools" ? toolCalls : [], native: parts, usage, stop, model: request.model };
}

async function listModels(apiKey: string): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
  const names: string[] = [];
  const pager = await ai.models.list();
  for await (const model of pager) {
    if (!model.name || (model.supportedActions && !model.supportedActions.includes("generateContent"))) continue;
    names.push(model.name.replace(/^models\//, ""));
  }
  return names;
}

export const gemini: ProviderAdapter = { runTurn, listModels };

import type { AiProvider } from "@prisma/client";
import type { ProviderAdapter } from "@/lib/copilot/types";
import { anthropic } from "@/lib/copilot/providers/anthropic";
import { openai } from "@/lib/copilot/providers/openai";
import { gemini } from "@/lib/copilot/providers/gemini";

/**
 * One adapter for each API a provider speaks (`AiFamily`, src/lib/ai/catalogue.ts): Claude's — from
 * Anthropic or Bedrock — OpenAI's, from OpenAI, Azure or a compatible server, and Gemini's, from AI
 * Studio or Vertex. Which account and model a feature uses is Deskzo's choice (src/lib/ai/gateway.ts).
 */
const ADAPTERS: Record<AiProvider, ProviderAdapter> = { ANTHROPIC: anthropic, OPENAI: openai, GEMINI: gemini };

/**
 * Replaced by the check suites, which must never reach a real provider — a test that spends money or
 * sends the business's data anywhere is not a test.
 */
let override: ProviderAdapter | null = null;
export function setTestProvider(adapter: ProviderAdapter | null) {
  override = adapter;
}

export function adapterFor(family: AiProvider): ProviderAdapter {
  return override ?? ADAPTERS[family];
}

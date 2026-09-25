import type { AiProvider } from "@prisma/client";
import type { ProviderAdapter } from "@/lib/copilot/types";
import { anthropic } from "@/lib/copilot/providers/anthropic";
import { openai } from "@/lib/copilot/providers/openai";
import { gemini } from "@/lib/copilot/providers/gemini";

export const PROVIDERS: Record<AiProvider, { label: string; adapter: ProviderAdapter; defaultModel: string; keyHint: string }> = {
  ANTHROPIC: { label: "Claude (Anthropic)", adapter: anthropic, defaultModel: "claude-opus-5", keyHint: "sk-ant-…" },
  OPENAI: { label: "ChatGPT (OpenAI)", adapter: openai, defaultModel: "", keyHint: "sk-…" },
  GEMINI: { label: "Gemini (Google)", adapter: gemini, defaultModel: "", keyHint: "AIza…" },
};

/**
 * Replaced by check:copilot, which must never reach a real provider — a test that spends money or
 * sends the business's data anywhere is not a test.
 */
let override: ProviderAdapter | null = null;
export function setTestProvider(adapter: ProviderAdapter | null) {
  override = adapter;
}

export function adapterFor(provider: AiProvider): ProviderAdapter {
  return override ?? PROVIDERS[provider].adapter;
}

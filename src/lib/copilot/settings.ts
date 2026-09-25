import type { AiProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { istDateParts } from "@/lib/india-time";

/**
 * The copilot's configuration and the daily allowance. Server-only: this is where the provider keys
 * are decrypted, and they go from here to the provider's SDK and nowhere else.
 */

export type CopilotConfig = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  dailyTokenLimit: number;
  hasKey: Record<AiProvider, boolean>;
};

const CIPHER_FIELD = { ANTHROPIC: "anthropicKeyCipher", OPENAI: "openaiKeyCipher", GEMINI: "geminiKeyCipher" } as const;
export { CIPHER_FIELD };

async function row() {
  return db.copilotSettings.findUnique({ where: { id: "global" } });
}

/**
 * Set only by check:copilot, so its chats run on a made-up configuration instead of rewriting the
 * real one under somebody who is using the copilot at the time.
 */
let testSettings: { config: CopilotConfig; keys: Partial<Record<AiProvider, string>> } | null = null;
export function setTestSettings(settings: typeof testSettings) {
  testSettings = settings;
}

export async function copilotConfig(): Promise<CopilotConfig> {
  if (testSettings) return testSettings.config;
  const r = await row();
  return {
    enabled: r?.enabled ?? false,
    provider: r?.provider ?? "ANTHROPIC",
    model: r?.model ?? "claude-opus-5",
    dailyTokenLimit: r?.dailyTokenLimit ?? 300_000,
    hasKey: { ANTHROPIC: !!r?.anthropicKeyCipher, OPENAI: !!r?.openaiKeyCipher, GEMINI: !!r?.geminiKeyCipher },
  };
}

/** The decrypted key for a provider, or null. Never returned to a browser. */
export async function providerKey(provider: AiProvider): Promise<string | null> {
  if (testSettings) return testSettings.keys[provider] ?? null;
  const r = await row();
  const cipher = r?.[CIPHER_FIELD[provider]];
  if (!cipher) return null;
  try {
    return decryptSecret(cipher);
  } catch {
    return null;
  }
}

/** Today in India, as the calendar day a `@db.Date` column holds. */
export function usageDay(now = new Date()): Date {
  const { year, month, day } = istDateParts(now);
  // `month` is 0-based, as Date has it.
  return new Date(Date.UTC(year, month, day));
}

export async function usedToday(userId: string, now = new Date()): Promise<number> {
  const u = await db.copilotUsage.findUnique({ where: { userId_day: { userId, day: usageDay(now) } } });
  return u ? u.inputTokens + u.outputTokens : 0;
}

export async function recordUsage(userId: string, usage: { input: number; output: number }, now = new Date()) {
  const day = usageDay(now);
  await db.copilotUsage.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, inputTokens: usage.input, outputTokens: usage.output, requests: 1 },
    update: { inputTokens: { increment: usage.input }, outputTokens: { increment: usage.output }, requests: { increment: 1 } },
  });
}

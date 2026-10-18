import { AI_PACK_DEFAULTS, TRIAL_CREDITS_DEFAULT, TRIAL_CREDITS_MAX, type AiPack } from "@/lib/ai/catalogue";
import { controlConfigured } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * Deskzo AI's platform settings (console › Settings › AI), apart from the accounts so that entitlements
 * and billing read them without loading a provider's SDK: the kill switch, the packs on sale and a free
 * trial's credits.
 */

/** Paused: no AI anywhere until it is lifted. Not paused without a control plane (the check suites' stand-ins). */
export async function aiPaused(): Promise<boolean> {
  if (!controlConfigured()) return false;
  return (await getSetting("ai.paused")) === "1";
}

export async function setAiPaused(paused: boolean, by: string): Promise<void> {
  await setSetting("ai.paused", paused ? "1" : null, by);
}

/** The packs on sale: staff's list when it is a valid one, the owner's defaults otherwise. */
export async function aiPacks(): Promise<AiPack[]> {
  const raw = controlConfigured() ? await getSetting("ai.packs") : null;
  if (!raw) return [...AI_PACK_DEFAULTS];
  try {
    return parsePacks(JSON.parse(raw));
  } catch {
    return [...AI_PACK_DEFAULTS];
  }
}

export function parsePacks(input: unknown): AiPack[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 6) throw new ConsoleRefused("Offer one to six packs.");
  const packs = input.map((p: { credits?: unknown; inr?: unknown }) => {
    const credits = Number(p?.credits);
    const inr = Number(p?.inr);
    if (!Number.isInteger(credits) || credits < 10 || credits > 1_000_000) throw new ConsoleRefused("A pack holds 10 to 10,00,000 credits.");
    if (!Number.isInteger(inr) || inr < 100 || inr > 100_000_000) throw new ConsoleRefused("A pack's price is between ₹1 and ₹10,00,000, in paise.");
    return { key: `ai-${credits}`, credits, inr };
  });
  if (new Set(packs.map((p) => p.credits)).size !== packs.length) throw new ConsoleRefused("Two packs can't hold the same number of credits.");
  return packs.sort((a, b) => a.credits - b.credits);
}

export async function saveAiPacks(input: unknown, by: string): Promise<AiPack[]> {
  const packs = parsePacks(input);
  await setSetting("ai.packs", JSON.stringify(packs), by);
  return packs;
}

export async function trialAiCredits(): Promise<number> {
  const raw = controlConfigured() ? await getSetting("trial.aiCredits") : null;
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= TRIAL_CREDITS_MAX ? n : TRIAL_CREDITS_DEFAULT;
}

export async function saveTrialAiCredits(input: unknown, by: string): Promise<number> {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > TRIAL_CREDITS_MAX) throw new ConsoleRefused(`A trial's credits are a whole number from 0 to ${TRIAL_CREDITS_MAX.toLocaleString("en-IN")}.`);
  await setSetting("trial.aiCredits", String(n), by);
  return n;
}

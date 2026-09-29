import { db } from "@/lib/db";

/**
 * Revenue & Close's settings (`RevenueCloseSettings`, a singleton like `LedgerLock`).
 *
 * Read without writing: a workspace that never opened the add-on has no row, and the nightly job reads
 * this in every workspace that has schedules, so a missing row is simply the defaults — the row is made
 * the first time somebody saves.
 */

export type CloseSettings = {
  /** "Post recognition and schedules automatically" — the nightly job, as the Automation account. */
  autoPost: boolean;
  /** What a new revenue schedule's `spreadEvenly` starts as (R2). */
  spreadEvenly: boolean;
  /** A flux row is flagged at this percentage change *and* `fluxAmount` rupees — both. */
  fluxPercent: number;
  fluxAmount: number;
};

export const CLOSE_SETTINGS_DEFAULTS: CloseSettings = { autoPost: true, spreadEvenly: false, fluxPercent: 20, fluxAmount: 25000 };

export async function readCloseSettings(): Promise<CloseSettings> {
  const row = await db.revenueCloseSettings.findUnique({ where: { id: "global" } });
  if (!row) return { ...CLOSE_SETTINGS_DEFAULTS };
  return {
    autoPost: row.autoPost,
    spreadEvenly: row.spreadEvenly,
    fluxPercent: Number(row.fluxPercent),
    fluxAmount: Number(row.fluxAmount),
  };
}

/** Why a set of settings can't be saved, or null. The thresholds fit their columns (6,2 and 14,2). */
export function closeSettingsProblem(input: CloseSettings): string | null {
  if (typeof input.autoPost !== "boolean" || typeof input.spreadEvenly !== "boolean") return "Choose on or off.";
  if (!Number.isFinite(input.fluxPercent) || input.fluxPercent < 0 || input.fluxPercent > 9999) {
    return "The percentage is a number from 0 to 9,999.";
  }
  if (!Number.isFinite(input.fluxAmount) || input.fluxAmount < 0 || input.fluxAmount > 1e12) {
    return "The amount is a number of rupees, 0 or more.";
  }
  return null;
}

export async function writeCloseSettings(input: CloseSettings, userId: string): Promise<CloseSettings> {
  const data = {
    autoPost: input.autoPost,
    spreadEvenly: input.spreadEvenly,
    fluxPercent: Math.round(input.fluxPercent * 100) / 100,
    fluxAmount: Math.round(input.fluxAmount * 100) / 100,
    updatedById: userId,
  };
  await db.revenueCloseSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  return readCloseSettings();
}

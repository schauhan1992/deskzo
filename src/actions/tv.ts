"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { pairScreen } from "@/lib/tv/screens";
import type { ActionResult } from "@/actions/company";

/**
 * TV screens (owner, 17 Oct 2026): pair a TV showing its code, choose the branch whose wins it shows (or
 * everybody's), rename it, take it off. "Put Deskzo on a TV" (wins.tv) — Management and Admin by default.
 */

async function tvManager() {
  const user = await requireModuleUser("wins");
  return (await can(user.id, "wins.tv")) ? user : null;
}

const NAME_MAX = 60;
const cleanName = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_MAX);

async function branchOrNull(branchId: unknown): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const id = typeof branchId === "string" && branchId ? branchId : null;
  if (!id) return { ok: true, id: null };
  const branch = await db.branch.findUnique({ where: { id }, select: { id: true } });
  return branch ? { ok: true, id: branch.id } : { ok: false, error: "That branch no longer exists." };
}

export type TvScreenRow = {
  id: string;
  name: string;
  board: "WINS";
  branch: { id: string; name: string } | null;
  lastSeenAt: Date | null;
  pairedBy: string | null;
  createdAt: Date;
};

/** The TV screens, and the branches one may show. Null for somebody who can't put Deskzo on a TV. */
export async function listTvScreens(): Promise<{ screens: TvScreenRow[]; branches: { id: string; name: string }[] } | null> {
  if (!(await tvManager())) return null;
  const [screens, branches] = await Promise.all([
    db.tvScreen.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, board: true, lastSeenAt: true, createdAt: true, branch: { select: { id: true, name: true } }, pairedBy: { select: { name: true } } },
    }),
    db.branch.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return toPlain({ screens: screens.map(({ pairedBy, ...s }) => ({ ...s, pairedBy: pairedBy?.name ?? null })), branches });
}

/** Pairs the TV showing `code`: it shows the wins of `branchId`'s people, or everybody's. */
export async function pairTvScreen(input: { code: string; name: string; branchId?: string | null }): Promise<ActionResult<{ id: string }>> {
  const user = await tvManager();
  if (!user) return { ok: false, error: "You can't put Deskzo on a TV." };
  const code = String(input?.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, error: "Type the six digits the TV shows." };
  const name = cleanName(input?.name);
  if (name.length < 2) return { ok: false, error: "Give the screen a name — say, Sales floor TV." };
  const branch = await branchOrNull(input?.branchId);
  if (!branch.ok) return branch;
  let screen: { id: string; name: string } | null;
  try {
    screen = await pairScreen({ code, name, branchId: branch.id, pairedById: user.id });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "That TV couldn't be paired." };
  }
  // One answer for a typo and a stale code: which codes are live is nobody's business.
  if (!screen) return { ok: false, error: "No TV is showing that code — check the digits, or refresh the TV for a new one." };
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "TvScreen", entityId: screen.id, entityLabel: `TV screen paired: ${screen.name}` });
  revalidatePath("/settings/tv-screens");
  return { ok: true, data: { id: screen.id } };
}

export async function updateTvScreen(input: { id: string; name: string; branchId?: string | null }): Promise<ActionResult<null>> {
  const user = await tvManager();
  if (!user) return { ok: false, error: "You can't change TV screens." };
  const screen = await db.tvScreen.findUnique({ where: { id: String(input?.id ?? "") }, select: { id: true } });
  if (!screen) return { ok: false, error: "That screen was taken off." };
  const name = cleanName(input?.name);
  if (name.length < 2) return { ok: false, error: "Give the screen a name." };
  const branch = await branchOrNull(input?.branchId);
  if (!branch.ok) return branch;
  await db.tvScreen.update({ where: { id: screen.id }, data: { name, branchId: branch.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TvScreen", entityId: screen.id, entityLabel: `TV screen: ${name}` });
  revalidatePath("/settings/tv-screens");
  return { ok: true, data: null };
}

/** Takes a TV off: its secret stops working, and it shows a new code the next time it looks. */
export async function removeTvScreen(id: string): Promise<ActionResult<null>> {
  const user = await tvManager();
  if (!user) return { ok: false, error: "You can't take TV screens off." };
  const screen = await db.tvScreen.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!screen) return { ok: true, data: null };
  await db.tvScreen.delete({ where: { id: screen.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "TvScreen", entityId: screen.id, entityLabel: `TV screen taken off: ${screen.name}` });
  revalidatePath("/settings/tv-screens");
  return { ok: true, data: null };
}

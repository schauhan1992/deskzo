"use server";

import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAttachTo } from "@/lib/authz/attachments";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { createTask } from "@/actions/task";
import { createNote } from "@/actions/note";
import { AI_FEATURES, MILLI, type AiFeature } from "@/lib/ai/catalogue";
import { creditStanding, monthOf, usageBreakdown, usedTodayBy } from "@/lib/ai/credits";
import { aiService } from "@/lib/ai/gateway";
import { copilotConfig } from "@/lib/copilot/settings";
import { unavailableBecause } from "@/lib/copilot/agent";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import type { DisplayBlock, ProposalBlock } from "@/lib/copilot/types";
import type { ActionResult } from "@/actions/company";

/**
 * The copilot's screens: the person's own conversations and the drafts they confirm, and the admin's
 * Deskzo AI settings — the switches, a daily cap, and who used how many credits. The chat itself streams
 * from src/app/api/copilot/chat/route.ts; the models, where they run and their rates are Deskzo's (src/lib/ai).
 *
 * Conversations are private — every read here is filtered to the person's own — and none of it
 * works while "viewing as" somebody, which would otherwise open their chats.
 */

async function me() {
  const user = await requireUser();
  return (await viewAsContext()) ? null : user;
}

export type CopilotAvailability = {
  available: boolean;
  reason: string | null;
  /** Who runs it and where, in words: "Deskzo AI · India (Mumbai and Hyderabad)". */
  provider: string;
  model: string;
  /** Credits the person used today, and their daily cap (null: none), in thousandths. */
  usedToday: number;
  limit: number | null;
};

/** Whether the copilot button shows, and what it says underneath. */
export async function getCopilotAvailability(): Promise<CopilotAvailability | null> {
  const user = await me();
  if (!user || !(await can(user.id, "copilot.use"))) return null;
  const config = await copilotConfig();
  if (!config.enabled) return null;
  const [reason, service, usedToday] = await Promise.all([unavailableBecause(user.id), aiService("copilot.chat"), usedTodayBy(user.id)]);
  return {
    available: !reason,
    reason,
    provider: service ? `Deskzo AI · ${service.residency}` : "Deskzo AI",
    model: service?.model ?? "",
    usedToday,
    limit: config.dailyCreditLimit === null ? null : config.dailyCreditLimit * MILLI,
  };
}

export async function listCopilotConversations() {
  const user = await me();
  if (!user) return [];
  return db.copilotConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: { id: true, title: true, updatedAt: true },
  });
}

export type ChatSegment = { kind: "text"; text: string } | { kind: "block"; block: DisplayBlock };
export type ChatItem = { role: "user"; text: string } | { role: "assistant"; segments: ChatSegment[] } | { role: "note"; text: string };

/** A conversation as the chat shows it, with each confirmation card's current state. */
export async function getCopilotConversation(id: string): Promise<{ id: string; title: string; items: ChatItem[] } | null> {
  const user = await me();
  if (!user || typeof id !== "string") return null;
  const conversation = await db.copilotConversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true, messages: { orderBy: { createdAt: "asc" }, select: { role: true, content: true } } },
  });
  if (!conversation) return null;

  const proposals = await db.copilotProposal.findMany({ where: { conversationId: id, userId: user.id }, select: { id: true, status: true, error: true } });
  const state = new Map(proposals.map((p) => [p.id, p]));
  const items: ChatItem[] = [];
  const reply = (): Extract<ChatItem, { role: "assistant" }> => {
    const last = items.at(-1);
    if (last?.role === "assistant") return last;
    const fresh = { role: "assistant" as const, segments: [] as ChatSegment[] };
    items.push(fresh);
    return fresh;
  };
  for (const m of conversation.messages) {
    const c = (m.content ?? {}) as Record<string, unknown>;
    if (m.role === "user") items.push({ role: "user", text: String(c.text ?? "") });
    else if (m.role === "note") items.push({ role: "note", text: String(c.text ?? "") });
    else if (m.role === "assistant" && String(c.text ?? "").trim()) reply().segments.push({ kind: "text", text: String(c.text) });
    else if (m.role === "tool") {
      for (const block of (c.blocks as DisplayBlock[]) ?? []) {
        if (block.type === "proposal") {
          const p = state.get(block.id);
          reply().segments.push({ kind: "block", block: { ...block, status: p?.status ?? "CANCELLED", error: p?.error ?? null } satisfies ProposalBlock });
        } else reply().segments.push({ kind: "block", block });
      }
    }
  }
  return toPlain({ id: conversation.id, title: conversation.title, items });
}

export async function deleteCopilotConversation(id: string): Promise<ActionResult<null>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  await db.copilotConversation.deleteMany({ where: { id, userId: user.id } });
  return { ok: true, data: null };
}

// ─── The drafts ──────────────────────────────────────────────────────────────

const noteFor = (conversationId: string, text: string) =>
  db.copilotMessage.create({ data: { conversationId, role: "note", content: { text } } });

/**
 * Creates what the copilot drafted — through the same action the app's own form uses, as the person,
 * so every check that form makes is made here too. Claimed in one step first, so two clicks create
 * one task.
 */
export async function confirmCopilotProposal(id: string): Promise<ActionResult<{ recordId: string }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  const proposal = await db.copilotProposal.findFirst({ where: { id, userId: user.id } });
  if (!proposal) return { ok: false, error: "That draft isn't there any more." };
  if (proposal.status !== "PENDING") return { ok: false, error: proposal.status === "DONE" ? "That's already been done." : "That draft was cancelled." };

  const payload = proposal.payload as Record<string, string>;
  const moduleKey = proposal.kind === "TASK" ? "tasks" : "notes";
  if (!(await isModuleEnabled(moduleKey))) return { ok: false, error: `The ${moduleKey} module isn't available to you.` };
  // Checked again now: access can change between the draft and the click.
  if (!(await mayAttachTo(user.id, { companyId: payload.companyId || null, leadId: payload.leadId || null, ticketId: payload.ticketId || null }))) {
    return { ok: false, error: "You no longer have access to the record this was linked to." };
  }

  const claimed = await db.copilotProposal.updateMany({ where: { id, userId: user.id, status: "PENDING" }, data: { status: "DONE", decidedAt: new Date() } });
  if (claimed.count === 0) return { ok: false, error: "That's already been done." };

  const result = proposal.kind === "TASK" ? await createTask(payload) : await createNote({ ...payload, pinned: false });
  if (!result.ok) {
    await db.copilotProposal.update({ where: { id }, data: { status: "FAILED", error: result.error } });
    await noteFor(proposal.conversationId, `The user pressed confirm, but the ${proposal.kind === "TASK" ? "task" : "note"} “${proposal.summary}” couldn't be saved: ${result.error}`);
    return { ok: false, error: result.error };
  }
  await db.copilotProposal.update({ where: { id }, data: { recordId: result.data.id } });
  await noteFor(proposal.conversationId, `The user confirmed the ${proposal.kind === "TASK" ? "task" : "note"} “${proposal.summary}” and it was saved.`);
  return { ok: true, data: { recordId: result.data.id } };
}

export async function cancelCopilotProposal(id: string): Promise<ActionResult<null>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  const proposal = await db.copilotProposal.findFirst({ where: { id, userId: user.id }, select: { conversationId: true, kind: true, summary: true } });
  const changed = await db.copilotProposal.updateMany({ where: { id, userId: user.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
  if (proposal && changed.count) await noteFor(proposal.conversationId, `The user cancelled the drafted ${proposal.kind === "TASK" ? "task" : "note"} “${proposal.summary}”.`);
  return { ok: true, data: null };
}

// ─── Settings (admins) ───────────────────────────────────────────────────────

export type DeskzoAiSettings = {
  enabled: boolean;
  draftingEnabled: boolean;
  dailyCreditLimit: number | null;
  /** Each feature: what it sends, the model it runs on and where — null when Deskzo hasn't set it up. */
  services: { feature: AiFeature; label: string; sends: string; model: string | null; residency: string | null; noTraining: boolean }[];
  /** This month's credits, in thousandths. `metered` false: no limit, and no ledger. */
  credits: { metered: boolean; allowance: number | null; allowanceUsed: number; packsUsed: number; packsRemaining: number; available: number | null; renewsAt: string };
  /** Whether this admin may buy credits (`billing.manage`) — the page then links to billing. */
  canBuy: boolean;
  /** This month, by person: credits for each feature, all together, and today. Thousandths. */
  usage: { userId: string; name: string; byFeature: Record<string, number>; month: number; today: number; turns: number }[];
};

export async function getCopilotSettings(): Promise<DeskzoAiSettings | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const tenant = await currentTenant();
  const now = new Date();
  const month = monthOf(tenant, now);
  const clock = await workspaceClock();
  const todayFrom = clock.startOfDay(clock.dateKey(now))!;
  const [config, standing, services, canBuy] = await Promise.all([
    copilotConfig(),
    creditStanding(tenant, now),
    Promise.all(AI_FEATURES.map(async (f) => ({ f, service: await aiService(f.key) }))),
    can(user.id, "billing.manage"),
  ]);
  // A workspace without a ledger (no control plane) has nobody's charges to show.
  const [monthRows, todayRows] = standing.metered ? await Promise.all([usageBreakdown(tenant.id, month.from, month.to), usageBreakdown(tenant.id, todayFrom, month.to)]) : [[], []];
  const people = new Map<string, DeskzoAiSettings["usage"][number]>();
  for (const r of monthRows) {
    const u = people.get(r.userId) ?? { userId: r.userId, name: "", byFeature: {}, month: 0, today: 0, turns: 0 };
    u.byFeature[r.feature] = (u.byFeature[r.feature] ?? 0) + r.credits;
    u.month += r.credits;
    u.turns += r.turns;
    people.set(r.userId, u);
  }
  for (const r of todayRows) {
    const u = people.get(r.userId);
    if (u) u.today += r.credits;
  }
  const names = people.size ? await db.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true } }) : [];
  for (const n of names) people.get(n.id)!.name = n.name;
  return {
    enabled: config.enabled,
    draftingEnabled: config.draftingEnabled,
    dailyCreditLimit: config.dailyCreditLimit,
    services: services.map(({ f, service }) => ({ feature: f.key, label: f.label, sends: f.sends, model: service?.model ?? null, residency: service?.residency ?? null, noTraining: service?.noTraining ?? false })),
    credits: {
      metered: standing.metered,
      allowance: standing.allowance,
      allowanceUsed: standing.allowanceUsed,
      packsUsed: standing.packsUsed,
      packsRemaining: standing.packsRemaining,
      available: standing.available,
      renewsAt: standing.renewsAt.toISOString(),
    },
    canBuy,
    usage: [...people.values()].map((u) => ({ ...u, name: u.name || "Somebody no longer here" })).sort((a, b) => b.month - a.month),
  };
}

export type CopilotSettingsInput = {
  enabled: boolean;
  draftingEnabled: boolean;
  /** Whole credits a person may use in a day; null or 0: no cap of the workspace's own. */
  dailyCreditLimit: number | null;
};

export async function saveCopilotSettings(input: CopilotSettingsInput): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change Deskzo AI's settings." };
  const raw = input?.dailyCreditLimit;
  const limit = raw === null || raw === undefined || Number(raw) === 0 ? null : Math.round(Number(raw));
  if (limit !== null && (!Number.isFinite(limit) || limit < 1 || limit > 100_000)) return { ok: false, error: "Set a daily cap between 1 and 1,00,000 credits, or none." };
  const data = { enabled: input.enabled === true, draftingEnabled: input.draftingEnabled === true, dailyCreditLimit: limit, updatedById: user.id };
  await db.copilotSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const said = [`copilot ${data.enabled ? "on" : "off"}`, `drafting with AI ${data.draftingEnabled ? "on" : "off"}`, limit === null ? "no daily cap" : `${limit.toLocaleString("en-IN")} credits a person a day`];
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CopilotSettings", entityId: "global", entityLabel: `Deskzo AI — ${said.join(", ")}` });
  return { ok: true, data: null };
}

"use server";

import type { AiProvider, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAttachTo } from "@/lib/authz/attachments";
import { recordAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { createTask } from "@/actions/task";
import { createNote } from "@/actions/note";
import { adapterFor, PROVIDERS } from "@/lib/copilot/providers";
import { CIPHER_FIELD, copilotConfig, providerKey, usageDay, usedToday } from "@/lib/copilot/settings";
import { unavailableBecause } from "@/lib/copilot/agent";
import type { DisplayBlock, ProposalBlock } from "@/lib/copilot/types";
import type { ActionResult } from "@/actions/company";

/**
 * The copilot's screens: the person's own conversations and the drafts they confirm, and the admin's
 * settings. The chat itself streams from src/app/api/copilot/chat/route.ts.
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
  provider: string;
  model: string;
  usedToday: number;
  limit: number;
};

/** Whether the copilot button shows, and what it says underneath. */
export async function getCopilotAvailability(): Promise<CopilotAvailability | null> {
  const user = await me();
  if (!user || !(await can(user.id, "copilot.use"))) return null;
  const config = await copilotConfig();
  if (!config.enabled) return null;
  const reason = await unavailableBecause(user.id);
  return { available: !reason, reason, provider: PROVIDERS[config.provider].label, model: config.model, usedToday: await usedToday(user.id), limit: config.dailyTokenLimit };
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

const PROVIDER_KEYS: AiProvider[] = ["ANTHROPIC", "OPENAI", "GEMINI"];

export async function getCopilotSettings() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const config = await copilotConfig();
  const since = new Date(usageDay().getTime() - 29 * 86_400_000);
  const today = usageDay();
  const rows = await db.copilotUsage.findMany({ where: { day: { gte: since } }, select: { userId: true, day: true, inputTokens: true, outputTokens: true, requests: true, user: { select: { name: true } } } });
  const byUser = new Map<string, { name: string; today: number; month: number; requests: number }>();
  for (const r of rows) {
    const u = byUser.get(r.userId) ?? { name: r.user.name, today: 0, month: 0, requests: 0 };
    const tokens = r.inputTokens + r.outputTokens;
    u.month += tokens;
    u.requests += r.requests;
    if (r.day.getTime() === today.getTime()) u.today += tokens;
    byUser.set(r.userId, u);
  }
  return {
    ...config,
    providers: PROVIDER_KEYS.map((k) => ({ key: k, label: PROVIDERS[k].label, defaultModel: PROVIDERS[k].defaultModel, keyHint: PROVIDERS[k].keyHint })),
    usage: [...byUser.values()].sort((a, b) => b.month - a.month),
  };
}

export type CopilotSettingsInput = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  dailyTokenLimit: number;
  /** New keys typed in; a provider left out keeps the one it has. */
  keys?: Partial<Record<AiProvider, string>>;
  removeKeys?: AiProvider[];
};

export async function saveCopilotSettings(input: CopilotSettingsInput): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the copilot's settings." };
  if (!PROVIDER_KEYS.includes(input?.provider)) return { ok: false, error: "Choose a provider." };
  const model = String(input.model ?? "").trim();
  if (model && !/^[\w.\-:/@]{2,100}$/.test(model)) return { ok: false, error: "That doesn't look like a model name." };
  const limit = Math.round(Number(input.dailyTokenLimit));
  if (!Number.isFinite(limit) || limit < 1_000 || limit > 50_000_000) return { ok: false, error: "Set a daily limit between 1,000 and 5 crore tokens." };

  const data: Prisma.CopilotSettingsUncheckedUpdateInput = { enabled: input.enabled === true, provider: input.provider, model, dailyTokenLimit: limit, updatedById: user.id };
  const changedKeys: string[] = [];
  for (const provider of PROVIDER_KEYS) {
    const typed = input.keys?.[provider]?.trim();
    if (typed) {
      if (typed.length < 10 || typed.length > 500 || /\s/.test(typed)) return { ok: false, error: `That ${PROVIDERS[provider].label} key doesn't look right.` };
      data[CIPHER_FIELD[provider]] = await encryptSecret(typed);
      changedKeys.push(`${PROVIDERS[provider].label} key replaced`);
    } else if (input.removeKeys?.includes(provider)) {
      data[CIPHER_FIELD[provider]] = null;
      changedKeys.push(`${PROVIDERS[provider].label} key removed`);
    }
  }

  const current = await copilotConfig();
  const willHaveKey = input.keys?.[input.provider]?.trim() ? true : input.removeKeys?.includes(input.provider) ? false : current.hasKey[input.provider];
  if (data.enabled && !willHaveKey) return { ok: false, error: `Add a ${PROVIDERS[input.provider].label} key before switching the copilot on.` };
  if (data.enabled && !model) return { ok: false, error: "Choose a model before switching the copilot on." };

  await db.copilotSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...(data as Prisma.CopilotSettingsUncheckedCreateInput) },
    update: data,
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CopilotSettings",
    entityId: "global",
    entityLabel: `AI copilot ${data.enabled ? "on" : "off"} — ${PROVIDERS[input.provider].label}, ${model || "no model"}, ${limit.toLocaleString("en-IN")} tokens a day${changedKeys.length ? `; ${changedKeys.join(", ")}` : ""}`,
  });
  return { ok: true, data: null };
}

/**
 * The models a key can use, straight from the provider — so an admin picks a real one rather than
 * typing a name from memory. Uses the key just typed, or the saved one.
 */
export async function listCopilotModels(provider: AiProvider, typedKey?: string): Promise<ActionResult<string[]>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the copilot's settings." };
  if (!PROVIDER_KEYS.includes(provider)) return { ok: false, error: "Choose a provider." };
  const key = typedKey?.trim() || (await providerKey(provider));
  if (!key) return { ok: false, error: `Add a ${PROVIDERS[provider].label} key first.` };
  try {
    const models = await adapterFor(provider).listModels(key);
    return { ok: true, data: models.sort() };
  } catch (err) {
    const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : null;
    return { ok: false, error: status === 401 || status === 403 ? "The provider refused that key." : "Couldn't reach the provider — check the key and try again." };
  }
}

import type { AiAccount, AiModel, AiProviderKind } from "@deskzo/control-client";
import { redactSecrets } from "@/lib/console-shared/redact";
import { AI_FEATURES, PROVIDER_KINDS, aiTablesMissing, familyOf, isAiFeature, type AiFeature, type AiPack } from "@/lib/ai/catalogue";
import { aiPacks, aiPaused, trialAiCredits } from "@/lib/ai/settings";
import { adapterFor } from "@/lib/copilot/providers";
import type { Connection } from "@/lib/copilot/types";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { ConsoleRefused } from "@/lib/platform/refused";

/**
 * Where Deskzo AI runs (owner, 17 Oct 2026; console › Settings › AI): the provider accounts, the models on
 * them with their rates in credits, which model each feature uses, the kill switch, the packs on sale and
 * a free trial's credits. All of it in the control plane, changed by staff and read by the gateway
 * (src/lib/ai/gateway.ts) on every turn.
 *
 * An account's secret is sealed under the platform key ("ai-account") when saved and opened only to build
 * a connection for one call (`connectionFor`). No page, action result or log carries it.
 */

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type AccountView = {
  id: string;
  name: string;
  kind: AiProviderKind;
  region: string | null;
  endpoint: string | null;
  keyId: string | null;
  /** Whether a secret is saved — never the secret. */
  hasSecret: boolean;
  residency: string;
  noTraining: boolean;
  active: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
};

export type ModelView = Pick<AiModel, "id" | "accountId" | "key" | "label" | "providerModel" | "inputRate" | "outputRate" | "inputCost" | "outputCost" | "active" | "updatedAt"> & {
  /** The features it runs. */
  features: AiFeature[];
};

export type AiSetup = {
  paused: boolean;
  accounts: AccountView[];
  models: ModelView[];
  /** Every feature, set up or not. */
  routes: { feature: AiFeature; modelId: string | null }[];
  packs: AiPack[];
  trialCredits: number;
};

const viewOf = (a: AiAccount): AccountView => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  region: a.region,
  endpoint: a.endpoint,
  keyId: a.keyId,
  hasSecret: !!a.secretCipher,
  residency: a.residency,
  noTraining: a.noTraining,
  active: a.active,
  lastTestAt: a.lastTestAt,
  lastTestOk: a.lastTestOk,
  lastTestError: a.lastTestError,
  updatedAt: a.updatedAt,
});

export async function aiSetup(): Promise<AiSetup> {
  const control = controlDb();
  const [accounts, models, routes, paused, packs, trialCredits] = await Promise.all([
    control.aiAccount.findMany({ orderBy: { createdAt: "asc" } }),
    control.aiModel.findMany({ orderBy: [{ accountId: "asc" }, { createdAt: "asc" }] }),
    control.aiRoute.findMany(),
    aiPaused(),
    aiPacks(),
    trialAiCredits(),
  ]);
  return {
    paused,
    accounts: accounts.map(viewOf),
    models: models.map((m) => ({
      id: m.id,
      accountId: m.accountId,
      key: m.key,
      label: m.label,
      providerModel: m.providerModel,
      inputRate: m.inputRate,
      outputRate: m.outputRate,
      inputCost: m.inputCost,
      outputCost: m.outputCost,
      active: m.active,
      updatedAt: m.updatedAt,
      features: routes.filter((r) => r.modelId === m.id && isAiFeature(r.feature)).map((r) => r.feature as AiFeature),
    })),
    routes: AI_FEATURES.map((f) => ({ feature: f.key, modelId: routes.find((r) => r.feature === f.key)?.modelId ?? null })),
    packs,
    trialCredits,
  };
}

// ─── Accounts ────────────────────────────────────────────────────────────────────────────────────

const KINDS = Object.keys(PROVIDER_KINDS) as AiProviderKind[];
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max + 1) : "");
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const GCP_LOCATION = /^[a-z]+-[a-z]+\d+$/;
const AWS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{12,20}$/;

function urlOf(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConsoleRefused(`${label}: that isn't an address.`);
  }
  // Plain http only to a server on this machine or the private network — Deskzo's own GPU, say.
  const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ConsoleRefused(`${label} must start with https:// (http:// only on the private network).`);
  if (url.username || url.password) throw new ConsoleRefused(`${label} can't carry a user name or password; the key goes in its own field.`);
  return url.toString().replace(/\/$/, "");
}

/** A service account's key: the JSON Google gives, with its address and private key. */
function serviceAccount(raw: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConsoleRefused("Paste the service account's whole JSON key.");
  }
  const sa = json as Record<string, unknown>;
  if (sa?.type !== "service_account" || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new ConsoleRefused("That JSON isn't a service account key.");
  return sa;
}

export type AccountInput = {
  id?: string;
  name: string;
  kind: AiProviderKind;
  region?: string | null;
  endpoint?: string | null;
  keyId?: string | null;
  /** Blank keeps the saved one. */
  secret?: string | null;
  residency: string;
  noTraining: boolean;
  active: boolean;
};

/** Adds an account, or changes one. Returns what changed, by field name — never a value of the secret. */
export async function saveAccount(raw: unknown, by: string): Promise<{ id: string; name: string; kind: AiProviderKind; created: boolean; changed: string[] }> {
  const input = (raw ?? {}) as Partial<AccountInput>;
  const control = controlDb();
  const existing = typeof input.id === "string" && input.id ? await control.aiAccount.findUnique({ where: { id: input.id } }) : null;
  if (input.id && !existing) throw new ConsoleRefused("That account no longer exists.");
  const kind = existing?.kind ?? (KINDS.includes(input.kind as AiProviderKind) ? (input.kind as AiProviderKind) : null);
  if (!kind) throw new ConsoleRefused("Choose what kind of account it is.");
  if (existing && input.kind && input.kind !== existing.kind) throw new ConsoleRefused("An account's kind can't change. Add a new account instead.");
  const def = PROVIDER_KINDS[kind];

  const name = text(input.name, 60);
  if (name.length < 2 || name.length > 60) throw new ConsoleRefused("Give the account a name of 2 to 60 characters.");
  const residency = text(input.residency, 80);
  if (residency.length < 2 || residency.length > 80) throw new ConsoleRefused("Say where the provider processes what is sent, in 2 to 80 characters — workspaces are shown it.");

  let region: string | null = null;
  if (def.region) {
    region = text(input.region, 40).toLowerCase();
    if (kind === "BEDROCK" && !AWS_REGION.test(region)) throw new ConsoleRefused("Give an AWS region, like ap-south-1.");
    if (kind === "VERTEX" && !GCP_LOCATION.test(region)) throw new ConsoleRefused("Give a Vertex location, like asia-south1 — never global, which sends requests anywhere.");
  }
  const endpoint = def.endpoint ? urlOf(text(input.endpoint, 300), def.endpoint.label) : null;
  let keyId: string | null = null;
  if (def.keyId) {
    keyId = text(input.keyId, 200) || null;
    if (kind === "BEDROCK" && keyId && !AWS_KEY_ID.test(keyId)) throw new ConsoleRefused("That doesn't look like an AWS access key ID (AKIA… or ASIA…).");
    if (kind === "VERTEX" && (!keyId || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(keyId))) throw new ConsoleRefused("Give the Google Cloud project ID.");
    if (kind === "AZURE_OPENAI" && (!keyId || !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(keyId))) throw new ConsoleRefused("Give the API version, like 2024-10-21.");
  }

  const typed = typeof input.secret === "string" ? input.secret.trim() : "";
  if (typed) {
    if (typed.length > 20_000 || (kind !== "VERTEX" && /\s/.test(typed))) throw new ConsoleRefused(`That ${lowerFirst(def.secret.label)} doesn't look right.`);
    if (kind === "VERTEX") serviceAccount(typed);
    else if (typed.length < 10) throw new ConsoleRefused(`That ${lowerFirst(def.secret.label)} is too short.`);
  }
  const willHaveSecret = !!typed || !!existing?.secretCipher;
  if (!willHaveSecret && kind !== "OPENAI_COMPATIBLE") throw new ConsoleRefused(`Add the ${lowerFirst(def.secret.label)}.`);

  const data = {
    name,
    region,
    endpoint,
    keyId,
    residency,
    noTraining: input.noTraining === true,
    active: input.active !== false,
    updatedBy: by,
    ...(typed ? { secretCipher: sealForPlatform("ai-account", typed) } : {}),
  };
  if (!existing) {
    const made = await control.aiAccount.create({ data: { ...data, kind }, select: { id: true } });
    return { id: made.id, name, kind, created: true, changed: [] };
  }
  const changed = (["name", "region", "endpoint", "keyId", "residency", "noTraining", "active"] as const).filter((k) => existing[k] !== data[k]);
  if (typed) changed.push("secret" as never);
  await control.aiAccount.update({ where: { id: existing.id }, data });
  return { id: existing.id, name, kind, created: false, changed };
}

/** Removes an account and its models — refused while a feature runs on one of them. */
export async function removeAccount(id: unknown): Promise<{ name: string; kind: AiProviderKind }> {
  const control = controlDb();
  const account = typeof id === "string" ? await control.aiAccount.findUnique({ where: { id }, select: { id: true, name: true, kind: true, models: { select: { id: true, routes: { select: { feature: true } } } } } }) : null;
  if (!account) throw new ConsoleRefused("That account no longer exists.");
  if (account.models.some((m) => m.routes.length)) throw new ConsoleRefused("A feature still runs on one of its models. Move it to another model first.");
  await control.$transaction(async (tx) => {
    await tx.aiModel.deleteMany({ where: { accountId: account.id } });
    await tx.aiAccount.delete({ where: { id: account.id } });
  });
  return { name: account.name, kind: account.kind };
}

// ─── Models ──────────────────────────────────────────────────────────────────────────────────────

const MODEL_KEY = /^[a-z0-9][a-z0-9.-]{1,59}$/;
const PROVIDER_MODEL = /^[\w.\-:/@]{2,200}$/;
const MAX_RATE = 1_000_000;

function rate(value: unknown, label: string, optional: boolean): number | null {
  if (optional && (value === null || value === undefined || value === "")) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RATE * (optional ? 100 : 1)) throw new ConsoleRefused(`${label}: a whole number${optional ? ", or leave it empty" : ""}.`);
  return n;
}

export type ModelInput = {
  id?: string;
  accountId: string;
  key: string;
  label: string;
  providerModel: string;
  inputRate: number;
  outputRate: number;
  inputCost?: number | null;
  outputCost?: number | null;
  active: boolean;
};

export async function saveModel(raw: unknown, by: string): Promise<{ id: string; key: string; created: boolean; changed: string[] }> {
  const input = (raw ?? {}) as Partial<ModelInput>;
  const control = controlDb();
  const existing = typeof input.id === "string" && input.id ? await control.aiModel.findUnique({ where: { id: input.id }, include: { routes: { select: { feature: true } } } }) : null;
  if (input.id && !existing) throw new ConsoleRefused("That model no longer exists.");
  const accountId = existing?.accountId ?? (typeof input.accountId === "string" ? input.accountId : "");
  const account = await control.aiAccount.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw new ConsoleRefused("Choose the account it runs on.");
  // The key is kept on every charge, so it never changes once made.
  const key = existing?.key ?? text(input.key, 60).toLowerCase();
  if (!MODEL_KEY.test(key)) throw new ConsoleRefused("Give the model a key: lower-case letters, digits, dots and dashes, like claude-sonnet-5-india.");
  if (!existing && (await control.aiModel.findUnique({ where: { key }, select: { id: true } }))) throw new ConsoleRefused("Another model already has that key.");
  const label = text(input.label, 60);
  if (label.length < 2 || label.length > 60) throw new ConsoleRefused("Give the model a name of 2 to 60 characters.");
  const providerModel = text(input.providerModel, 200);
  if (!PROVIDER_MODEL.test(providerModel)) throw new ConsoleRefused("Give the provider's name for the model — a Bedrock inference profile, a deployment name.");
  const data = {
    label,
    providerModel,
    inputRate: rate(input.inputRate, "Credits for a million input tokens", false)!,
    outputRate: rate(input.outputRate, "Credits for a million output tokens", false)!,
    inputCost: rate(input.inputCost, "What a million input tokens cost Deskzo, in paise", true),
    outputCost: rate(input.outputCost, "What a million output tokens cost Deskzo, in paise", true),
    active: input.active !== false,
    updatedBy: by,
  };
  if (existing?.routes.length && !data.active) throw new ConsoleRefused("A feature runs on this model. Move it to another model before switching this one off.");
  if (!existing) {
    const made = await control.aiModel.create({ data: { ...data, key, accountId: account.id }, select: { id: true } });
    return { id: made.id, key, created: true, changed: [] };
  }
  const changed = (["label", "providerModel", "inputRate", "outputRate", "inputCost", "outputCost", "active"] as const).filter((k) => existing[k] !== data[k]);
  await control.aiModel.update({ where: { id: existing.id }, data });
  return { id: existing.id, key, created: false, changed };
}

export async function removeModel(id: unknown): Promise<{ key: string }> {
  const control = controlDb();
  const model = typeof id === "string" ? await control.aiModel.findUnique({ where: { id }, select: { id: true, key: true, routes: { select: { feature: true } } } }) : null;
  if (!model) throw new ConsoleRefused("That model no longer exists.");
  if (model.routes.length) throw new ConsoleRefused("A feature runs on this model. Move it to another model first.");
  await control.aiModel.delete({ where: { id: model.id } });
  return { key: model.key };
}

/** The suggested models for an account's kind (src/lib/ai/catalogue.ts), those whose keys are free. */
export async function addSuggestedModels(accountId: unknown, by: string): Promise<string[]> {
  const control = controlDb();
  const account = typeof accountId === "string" ? await control.aiAccount.findUnique({ where: { id: accountId }, select: { id: true, kind: true } }) : null;
  if (!account) throw new ConsoleRefused("That account no longer exists.");
  const suggested = PROVIDER_KINDS[account.kind].suggested.models;
  const taken = new Set((await control.aiModel.findMany({ where: { key: { in: suggested.map((m) => m.key) } }, select: { key: true } })).map((m) => m.key));
  const fresh = suggested.filter((m) => !taken.has(m.key));
  if (fresh.length) await control.aiModel.createMany({ data: fresh.map((m) => ({ ...m, accountId: account.id, updatedBy: by })) });
  return fresh.map((m) => m.key);
}

// ─── Routes ──────────────────────────────────────────────────────────────────────────────────────

/** Every feature's model at once; null takes a feature off (it is then not set up). Returns the features that changed. */
export async function saveRoutes(raw: unknown, by: string): Promise<string[]> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const control = controlDb();
  const current = await control.aiRoute.findMany();
  const changed: string[] = [];
  for (const { key } of AI_FEATURES) {
    if (!(key in input)) continue;
    const wanted = typeof input[key] === "string" && input[key] ? (input[key] as string) : null;
    const now = current.find((r) => r.feature === key)?.modelId ?? null;
    if (wanted === now) continue;
    if (wanted) {
      const model = await control.aiModel.findUnique({ where: { id: wanted }, select: { active: true, account: { select: { active: true } } } });
      if (!model) throw new ConsoleRefused("That model no longer exists.");
      if (!model.active || !model.account.active) throw new ConsoleRefused("Choose a model that is switched on, on an account that is switched on.");
      await control.aiRoute.upsert({ where: { feature: key }, create: { feature: key, modelId: wanted, updatedBy: by }, update: { modelId: wanted, updatedBy: by } });
    } else {
      await control.aiRoute.delete({ where: { feature: key } });
    }
    changed.push(key);
  }
  return changed;
}

// ─── What a turn runs on ─────────────────────────────────────────────────────────────────────────

/** Why a feature can't run, for staff — the workspace is told only that Deskzo AI isn't available. */
export class AiNotReady extends Error {}

export type Route = {
  feature: AiFeature;
  model: Pick<AiModel, "key" | "label" | "providerModel" | "inputRate" | "outputRate" | "inputCost" | "outputCost">;
  account: Pick<AiAccount, "id" | "name" | "kind" | "residency" | "noTraining">;
  /** Builds the connection, opening the secret — only for the call about to be made. */
  connection: () => Connection;
};

/**
 * Set only by the check suites, so a turn runs on a made-up route instead of a real account. The
 * adapter is stubbed apart (src/lib/copilot/providers `setTestProvider`).
 */
let testRoute: ((feature: AiFeature) => Route | null) | null = null;
export function setTestRoute(route: typeof testRoute) {
  testRoute = route;
}

/** The model and account a feature runs on now, or null when it isn't set up (or is switched off). */
export async function routeFor(feature: AiFeature): Promise<Route | null> {
  if (testRoute) return testRoute(feature);
  if (!controlConfigured()) return null;
  let row;
  try {
    row = await controlDb().aiRoute.findUnique({ where: { feature }, include: { model: { include: { account: true } } } });
  } catch (err) {
    if (aiTablesMissing(err)) return null;
    throw err;
  }
  if (!row || !row.model.active || !row.model.account.active) return null;
  const { model } = row;
  const account = model.account;
  return {
    feature,
    model: { key: model.key, label: model.label, providerModel: model.providerModel, inputRate: model.inputRate, outputRate: model.outputRate, inputCost: model.inputCost, outputCost: model.outputCost },
    account: { id: account.id, name: account.name, kind: account.kind, residency: account.residency, noTraining: account.noTraining },
    connection: () => connectionFor(account),
  };
}

/** The account as a connection, its secret opened. Throws `AiNotReady` with what is missing. */
export function connectionFor(account: Pick<AiAccount, "kind" | "region" | "endpoint" | "keyId" | "secretCipher" | "name">): Connection {
  let secret: string | null = null;
  if (account.secretCipher) {
    try {
      secret = openForPlatform("ai-account", account.secretCipher);
    } catch {
      throw new AiNotReady(`${account.name}: its key can't be opened under this platform key. Type it again.`);
    }
  }
  const need = (value: string | null, what: string) => {
    if (!value) throw new AiNotReady(`${account.name}: no ${what} is saved.`);
    return value;
  };
  switch (account.kind) {
    case "ANTHROPIC":
      return { kind: "ANTHROPIC", apiKey: need(secret, "API key") };
    case "BEDROCK":
      return { kind: "BEDROCK", region: need(account.region, "region"), accessKeyId: account.keyId, secret: need(secret, "secret key") };
    case "OPENAI":
      return { kind: "OPENAI", apiKey: need(secret, "API key") };
    case "AZURE_OPENAI":
      return { kind: "AZURE_OPENAI", endpoint: need(account.endpoint, "endpoint"), apiVersion: need(account.keyId, "API version"), apiKey: need(secret, "API key") };
    case "OPENAI_COMPATIBLE":
      return { kind: "OPENAI_COMPATIBLE", baseURL: need(account.endpoint, "base URL"), apiKey: secret };
    case "GEMINI":
      return { kind: "GEMINI", apiKey: need(secret, "API key") };
    case "VERTEX":
      return { kind: "VERTEX", project: need(account.keyId, "project ID"), location: need(account.region, "location"), credentials: serviceAccount(need(secret, "service account key")) };
  }
}

/** A provider's words with the connection's own secrets taken out, whatever shape they have — before anything keeps or shows them. */
export function withoutSecrets(message: string, connection: Connection | null): string {
  if (!connection) return message;
  const secrets: string[] = [];
  for (const [field, value] of Object.entries(connection)) {
    if (field === "kind" || field === "region" || field === "endpoint" || field === "baseURL" || field === "apiVersion" || field === "project" || field === "location") continue;
    if (typeof value === "string") secrets.push(value);
    else if (value && typeof value === "object") for (const inner of Object.values(value as Record<string, unknown>)) if (typeof inner === "string" && inner.length >= 12) secrets.push(inner);
  }
  return secrets.filter((s) => s.length >= 6).reduce((text, secret) => text.split(secret).join("***"), message);
}

/**
 * A real call through an account, to see that it answers: a few tokens on the model given (or its first
 * that is switched on), charged to no workspace. The result is kept on the account for the console.
 */
export async function testAccount(accountId: unknown, modelId?: unknown): Promise<{ ok: boolean; model: string | null; error: string | null }> {
  const control = controlDb();
  const account = typeof accountId === "string" ? await control.aiAccount.findUnique({ where: { id: accountId }, include: { models: { where: { active: true }, orderBy: { createdAt: "asc" } } } }) : null;
  if (!account) throw new ConsoleRefused("That account no longer exists.");
  const model = (typeof modelId === "string" && account.models.find((m) => m.id === modelId)) || account.models[0];
  if (!model) throw new ConsoleRefused("Add a model to the account first — the test asks one of its models a question.");
  let result: { ok: boolean; model: string | null; error: string | null };
  let connection: Connection | null = null;
  try {
    connection = connectionFor(account);
    const outcome = await adapterFor(familyOf(account.kind)).runTurn({
      connection,
      model: model.providerModel,
      system: "You are checking that an API connection works.",
      history: [{ role: "user", text: "Reply with the single word OK." }],
      tools: [],
      onText: () => {},
      maxTokens: 64,
      signal: AbortSignal.timeout(30_000),
    });
    result = { ok: true, model: outcome.model || model.providerModel, error: null };
  } catch (err) {
    const message = withoutSecrets(err instanceof Error ? err.message : String(err), connection);
    result = { ok: false, model: model.providerModel, error: (redactSecrets(message) ?? "").slice(0, 500) || "The provider refused the call." };
  }
  await control.aiAccount.update({ where: { id: account.id }, data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestError: result.error } });
  return result;
}

// ─── Usage across the platform ───────────────────────────────────────────────────────────────────

export type PlatformAiUsage = { modelKey: string; turns: number; credits: number; cost: number | null; workspaces: number };

/** Every workspace's charges between two instants, by model: what was charged (thousandths) and what it cost Deskzo (paise). */
export async function platformAiUsage(from: Date, to: Date): Promise<PlatformAiUsage[]> {
  const control = controlDb();
  const [byModel, pairs] = await Promise.all([
    control.aiUsage.groupBy({ by: ["modelKey"], where: { at: { gte: from, lt: to } }, _sum: { credits: true, cost: true }, _count: { _all: true } }),
    control.aiUsage.groupBy({ by: ["modelKey", "tenantId"], where: { at: { gte: from, lt: to } } }),
  ]);
  return byModel
    .map((r) => ({ modelKey: r.modelKey, turns: r._count._all, credits: r._sum.credits ?? 0, cost: r._sum.cost ?? null, workspaces: pairs.filter((p) => p.modelKey === r.modelKey).length }))
    .sort((a, b) => b.credits - a.credits);
}

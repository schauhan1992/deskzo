import type { AiProviderKind } from "@deskzo/control-client";

/**
 * Deskzo AI's fixed facts (owner, 17 Oct 2026), safe for the browser: the features that use AI, the
 * kinds of provider account, the credit arithmetic, and the defaults the owner chose. Nothing here reads
 * a database; src/lib/ai/accounts.ts and src/lib/ai/credits.ts do.
 *
 * A credit is ₹1 before GST. Amounts are kept in thousandths of a credit ("milli"), so a short turn on a
 * small model is charged what it cost rather than a whole credit. A model's rate is credits for a million
 * tokens: tokens × rate ÷ 1,000 is the charge in thousandths.
 */

// ─── Features ────────────────────────────────────────────────────────────────────────────────────

export type AiFeature = "copilot.chat" | "automate.draft" | "inbox.answer";

/** Each feature that calls a model: what it is called, and what it sends — shown before it is used. */
export const AI_FEATURES: readonly { key: AiFeature; label: string; sends: string }[] = [
  { key: "copilot.chat", label: "Copilot chat", sends: "The question, and the records the copilot looks up for the person asking." },
  { key: "automate.draft", label: "Automate: drafting a workflow", sends: "The description typed, and Deskzo's list of triggers and steps. No records." },
  // The Customer inbox's bot (owner, 24 Oct 2026): an option a channel switches on, src/lib/inbox/ai.ts.
  { key: "inbox.answer", label: "Customer inbox: answering customers", sends: "The customer's conversation, and the channel's set answers and notes about the business. No records." },
];

export const isAiFeature = (value: unknown): value is AiFeature => AI_FEATURES.some((f) => f.key === value);
export const featureLabel = (key: string) => AI_FEATURES.find((f) => f.key === key)?.label ?? key;

// ─── Provider accounts ───────────────────────────────────────────────────────────────────────────

/** The wire format a provider speaks — what the adapters in src/lib/copilot/providers are split by. */
export type AiFamily = "ANTHROPIC" | "OPENAI" | "GEMINI";

type Field = { label: string; placeholder: string; help?: string };

export type SuggestedModel = {
  key: string;
  label: string;
  providerModel: string;
  /** Credits for a million tokens. */
  inputRate: number;
  outputRate: number;
  /** Paise for a million tokens, what the provider charges. */
  inputCost: number;
  outputCost: number;
};

export type ProviderKindDef = {
  label: string;
  family: AiFamily;
  region?: Field;
  endpoint?: Field;
  keyId?: Field;
  secret: Field;
  /** Where to get what the form asks for, step by step — shown in the console's Add account dialog. docs/deskzo-ai.md has the long form. */
  steps: string[];
  /** Filled in when staff add an account of this kind; every value can be changed. */
  suggested: { name: string; residency: string; region?: string; endpoint?: string; keyId?: string; models: SuggestedModel[] };
};

/**
 * Suggested rates are about 1.5 times the provider's list price at ₹90 to the dollar (owner, 17 Oct 2026).
 * Bedrock prices its regional profiles itself: check the Bedrock price page before going live.
 */
const BEDROCK_INDIA: SuggestedModel[] = [
  { key: "claude-sonnet-5-india", label: "Claude Sonnet 5", providerModel: "in.anthropic.claude-sonnet-5", inputRate: 270, outputRate: 1350, inputCost: 18_000, outputCost: 90_000 },
  { key: "claude-opus-5-india", label: "Claude Opus 5", providerModel: "in.anthropic.claude-opus-5", inputRate: 675, outputRate: 3375, inputCost: 45_000, outputCost: 225_000 },
  { key: "claude-haiku-4-5-india", label: "Claude Haiku 4.5", providerModel: "in.anthropic.claude-haiku-4-5-20251001-v1:0", inputRate: 135, outputRate: 675, inputCost: 9_000, outputCost: 45_000 },
];

export const PROVIDER_KINDS: Record<AiProviderKind, ProviderKindDef> = {
  BEDROCK: {
    label: "Claude on Amazon Bedrock",
    family: "ANTHROPIC",
    region: { label: "AWS region", placeholder: "ap-south-1", help: "Where requests are sent from. India's inference profiles (in.…) keep them in Mumbai and Hyderabad." },
    keyId: { label: "Access key ID", placeholder: "AKIA…", help: "An IAM user allowed bedrock:InvokeModel. Leave it empty to use a Bedrock API key instead." },
    secret: { label: "Secret access key, or Bedrock API key", placeholder: "Saved sealed; type a new one to replace it" },
    steps: [
      "Sign in to the AWS console with an account that can manage IAM, and switch the region (top right) to Asia Pacific (Mumbai), ap-south-1.",
      "Open Amazon Bedrock › Model catalog (older consoles: Model access) and enable Claude Sonnet 5, Claude Opus 5 and Claude Haiku 4.5. For Anthropic's models AWS asks once for a short use-case form.",
      "Open IAM › Users › Create user — a name like deskzo-bedrock, no console access. Give it a policy allowing bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream on the in.anthropic.* inference profiles and Anthropic's models in ap-south-1 and ap-south-2 (docs/deskzo-ai.md has the policy to paste).",
      "On that user: Security credentials › Create access key › “Application running outside AWS”. Copy the Access key ID (AKIA…) into Access key ID and the Secret access key into the key field — AWS shows the secret once.",
      "Or, instead of an IAM user: Amazon Bedrock › API keys › Generate a long-term API key, paste it into the key field and leave Access key ID empty. Renew it before it expires.",
      "Before ticking “no training”: AWS's Bedrock terms say prompts and answers aren't used to train models or shared with the model's maker. Read them on aws.amazon.com/bedrock/security-compliance.",
    ],
    suggested: { name: "Bedrock India", residency: "India (Mumbai and Hyderabad)", region: "ap-south-1", models: BEDROCK_INDIA },
  },
  ANTHROPIC: {
    label: "Claude (Anthropic's API)",
    family: "ANTHROPIC",
    secret: { label: "API key", placeholder: "sk-ant-…" },
    steps: [
      "Sign in at console.anthropic.com with the company's organisation.",
      "Settings › API keys › Create key — name it Deskzo. Copy it; it's shown once.",
      "Requests are processed in the United States. Anthropic's commercial terms say API data isn't used for training.",
    ],
    suggested: {
      name: "Anthropic",
      residency: "United States",
      models: [{ key: "claude-sonnet-5", label: "Claude Sonnet 5", providerModel: "claude-sonnet-5", inputRate: 270, outputRate: 1350, inputCost: 18_000, outputCost: 90_000 }],
    },
  },
  OPENAI: {
    label: "OpenAI",
    family: "OPENAI",
    secret: { label: "API key", placeholder: "sk-…" },
    steps: [
      "Sign in at platform.openai.com with the company's organisation.",
      "API keys › Create new secret key, owned by a project for Deskzo. Copy it; it's shown once.",
      "OpenAI says API data isn't used for training by default.",
    ],
    suggested: { name: "OpenAI", residency: "United States", models: [] },
  },
  AZURE_OPENAI: {
    label: "Azure OpenAI",
    family: "OPENAI",
    endpoint: { label: "Resource endpoint", placeholder: "https://<resource>.openai.azure.com", help: "A resource in Central or South India, with Standard (regional) deployments, keeps processing there." },
    keyId: { label: "API version", placeholder: "2024-10-21" },
    secret: { label: "API key", placeholder: "Saved sealed; type a new one to replace it" },
    steps: [
      "In the Azure portal, create an Azure OpenAI resource in Central India or South India.",
      "In Azure AI Foundry, deploy each model as a Standard (regional) deployment — not Global — so processing stays in that region. The deployment's name is what goes in the model's “Name at the provider”.",
      "On the resource: Keys and Endpoint — copy the endpoint and KEY 1.",
    ],
    suggested: { name: "Azure OpenAI India", residency: "India (Central India)", keyId: "2024-10-21", models: [] },
  },
  GEMINI: {
    label: "Gemini (Google AI Studio)",
    family: "GEMINI",
    secret: { label: "API key", placeholder: "AIza…" },
    steps: [
      "Sign in at aistudio.google.com with the company's Google account.",
      "Get API key › Create API key, in a Google Cloud project for Deskzo. Copy it.",
      "Requests aren't confined to a region. Use Vertex AI in asia-south1 to keep them in India.",
    ],
    suggested: { name: "Gemini", residency: "United States", models: [] },
  },
  VERTEX: {
    label: "Gemini on Vertex AI",
    family: "GEMINI",
    region: { label: "Location", placeholder: "asia-south1", help: "Never 'global', which sends requests anywhere." },
    keyId: { label: "Project ID", placeholder: "my-project" },
    secret: { label: "Service account key (JSON)", placeholder: "Paste the whole JSON key file" },
    steps: [
      "In Google Cloud, choose (or create) a project and enable the Vertex AI API.",
      "IAM & Admin › Service accounts › Create — a name like deskzo-vertex — with the role Vertex AI User.",
      "On it: Keys › Add key › JSON. Paste the whole file into the key field; the project ID is in it as project_id.",
      "Use the location asia-south1 (Mumbai) and models Google lists for it in its data-residency table.",
    ],
    suggested: { name: "Vertex Mumbai", residency: "India (Mumbai)", region: "asia-south1", models: [] },
  },
  OPENAI_COMPATIBLE: {
    label: "OpenAI-compatible server",
    family: "OPENAI",
    endpoint: { label: "Base URL", placeholder: "https://ai.internal.example/v1", help: "vLLM, Ollama or another server speaking /chat/completions — Deskzo's own GPU when it comes." },
    secret: { label: "API key", placeholder: "Leave empty if the server takes none" },
    steps: [
      "The server's base URL ends in /v1 — vLLM and Ollama both serve OpenAI's /chat/completions there.",
      "If it asks for a key (vLLM's --api-key), put it in the key field; otherwise leave it empty.",
      "Plain http is accepted only on the private network.",
    ],
    suggested: { name: "Private AI", residency: "Deskzo's own servers", models: [] },
  },
};

export const PROVIDER_KIND_ORDER: readonly AiProviderKind[] = ["BEDROCK", "ANTHROPIC", "AZURE_OPENAI", "OPENAI", "VERTEX", "GEMINI", "OPENAI_COMPATIBLE"];

export const familyOf = (kind: AiProviderKind): AiFamily => PROVIDER_KINDS[kind].family;

// ─── Credits ─────────────────────────────────────────────────────────────────────────────────────

/** Thousandths of a credit in one credit. */
export const MILLI = 1000;

/** A charge, in thousandths of a credit: tokens × the model's rates (credits a million), rounded up. */
export function chargeFor(usage: { input: number; output: number }, rates: { inputRate: number; outputRate: number }): number {
  const input = Math.max(0, Math.round(usage.input));
  const output = Math.max(0, Math.round(usage.output));
  return Math.ceil((input * rates.inputRate + output * rates.outputRate) / 1000);
}

/** What a turn cost Deskzo, in paise, from the model's costs (paise a million); null when none are set. */
export function costFor(usage: { input: number; output: number }, costs: { inputCost: number | null; outputCost: number | null }): number | null {
  if (costs.inputCost === null && costs.outputCost === null) return null;
  return Math.round((Math.max(0, usage.input) * (costs.inputCost ?? 0) + Math.max(0, usage.output) * (costs.outputCost ?? 0)) / 1_000_000);
}

/** Thousandths as credits in words: whole from 100 up, one decimal below, never "-0". */
export function creditsText(milli: number): string {
  const credits = Math.max(0, milli) / MILLI;
  if (credits >= 100 || Number.isInteger(credits)) return Math.floor(credits).toLocaleString("en-IN");
  return (Math.floor(credits * 10) / 10).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The monthly allowances the owner chose, kept on the plans (`Plan.copilotTokens`, credits a month a unit). */
export const PLAN_CREDITS = { one: 100, product: 50, aiPlus: 750 } as const;

/** A free trial's credits for the whole workspace (`trial.aiCredits`, console › Settings › AI). */
export const TRIAL_CREDITS_DEFAULT = 200;
export const TRIAL_CREDITS_MAX = 100_000;

/** How long a pack's credits last. */
export const PACK_MONTHS = 12;

export type AiPack = { key: string; credits: number; /** Paise before GST. */ inr: number };

/** The packs on sale until staff change them (`ai.packs`, console › Settings › AI). Prices before GST. */
export const AI_PACK_DEFAULTS: readonly AiPack[] = [
  { key: "ai-500", credits: 500, inr: 49_900 },
  { key: "ai-2000", credits: 2_000, inr: 179_900 },
  { key: "ai-10000", credits: 10_000, inr: 799_900 },
];

export const packName = (credits: number) => `${credits.toLocaleString("en-IN")} Deskzo AI credits`;

/**
 * A control-plane table that isn't there yet: new code meeting a control plane before its migration ran
 * (Coolify runs `tenants:migrate` after the deploy). Deskzo AI then counts as not set up, never as an error.
 */
export const aiTablesMissing = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2021";

/** When a month's credits are said to be running low: four fifths used. */
export const LOW_SHARE = 0.8;

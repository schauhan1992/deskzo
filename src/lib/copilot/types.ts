import type { AiProvider } from "@prisma/client";
import type { ReportResult } from "@/lib/analytics/run";

/**
 * The shapes the copilot keeps a conversation in — belonging to no one provider, so a chat carries on
 * when Deskzo moves a feature to another model (console › Settings › AI). Each adapter in ./providers
 * turns these into its own API's messages and back.
 */

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; name: string; output: string; isError?: boolean };

export type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /**
       * The provider's own form of this turn, replayed to that provider verbatim — Claude's thinking
       * blocks and Gemini's thought signatures have to go back exactly as they came.
       */
      native?: { provider: AiProvider; model: string; content: unknown };
    }
  | { role: "tool"; results: ToolResult[] }
  /** Something the app tells the model after the fact — "the user confirmed the task". */
  | { role: "note"; text: string };

/** A tool as every provider is told about it: a name, what it does, and a JSON Schema for its input. */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

/**
 * How to reach a provider: one of Deskzo AI's accounts, its secret opened (src/lib/ai/accounts.ts).
 * Built on the server for one call and never kept, logged or handed to a browser.
 */
export type Connection =
  | { kind: "ANTHROPIC"; apiKey: string }
  /** `accessKeyId` null: `secret` is a Bedrock API key rather than an IAM user's secret key. */
  | { kind: "BEDROCK"; region: string; accessKeyId: string | null; secret: string }
  | { kind: "OPENAI"; apiKey: string }
  | { kind: "AZURE_OPENAI"; endpoint: string; apiVersion: string; apiKey: string }
  | { kind: "OPENAI_COMPATIBLE"; baseURL: string; apiKey: string | null }
  | { kind: "GEMINI"; apiKey: string }
  | { kind: "VERTEX"; project: string; location: string; credentials: Record<string, unknown> };

export type TurnRequest = {
  connection: Connection;
  model: string;
  system: string;
  history: Turn[];
  tools: ToolSpec[];
  /** Each piece of the answer as it is written. */
  onText: (delta: string) => void;
  /** The longest answer allowed; the adapter's own when absent. A test of an account asks for a few. */
  maxTokens?: number;
  signal?: AbortSignal;
};

export type TurnOutcome = {
  text: string;
  toolCalls: ToolCall[];
  native: unknown;
  /** Input counts cached tokens at a tenth — they are billed at about that. */
  usage: { input: number; output: number };
  /** done — answered; tools — wants tools run; truncated — ran out of room; refused — declined. */
  stop: "done" | "tools" | "truncated" | "refused";
  /** The model that actually answered, which a fallback can make different from the one asked. */
  model: string;
};

export type ProviderAdapter = {
  runTurn(request: TurnRequest): Promise<TurnOutcome>;
};

// ─── What the chat shows besides text ────────────────────────────────────────

export type ReportBlock = {
  type: "report";
  title: string;
  measureLabel: string;
  averaged: boolean;
  /** Capped for storage — see MAX_REPORT_ROWS. The grand total is the whole report's. */
  result: ReportResult;
};

export type ProposalBlock = {
  type: "proposal";
  id: string;
  kind: "TASK" | "NOTE";
  summary: string;
  /** Filled from the proposal row when a conversation is shown, so a confirmed card says so. */
  status?: "PENDING" | "DONE" | "CANCELLED" | "FAILED";
  error?: string | null;
};

/** A line saying what the copilot looked at — "Looked up 12 leads". */
export type ActivityBlock = { type: "activity"; label: string };

export type DisplayBlock = ReportBlock | ProposalBlock | ActivityBlock;

/** What the chat endpoint streams, one JSON object per line. */
export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "block"; block: DisplayBlock }
  | { type: "step" }
  /** Credits the person has used today, and their daily cap (null: none), in thousandths. */
  | { type: "done"; usedToday: number; limit: number | null }
  | { type: "error"; message: string };

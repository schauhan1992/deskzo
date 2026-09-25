import type { AiProvider } from "@prisma/client";
import type { ReportResult } from "@/lib/analytics/run";

/**
 * The shapes the copilot keeps a conversation in — belonging to no one provider, so a chat can carry
 * on after an admin switches from Claude to ChatGPT or Gemini. Each adapter in ./providers turns
 * these into its own API's messages and back.
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

export type TurnRequest = {
  apiKey: string;
  model: string;
  system: string;
  history: Turn[];
  tools: ToolSpec[];
  /** Each piece of the answer as it is written. */
  onText: (delta: string) => void;
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
  /** The models this key can use, for the settings screen. */
  listModels(apiKey: string): Promise<string[]>;
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
  | { type: "done"; usedToday: number; limit: number }
  | { type: "error"; message: string };

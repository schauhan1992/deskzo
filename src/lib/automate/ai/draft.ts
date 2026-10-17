import { definitionSchema, eachStep, type Definition } from "@/lib/automate/definition";
import { clearWorkspaceValues, splitProblems, type Cleared } from "@/lib/automate/blanks";
import { validateDefinition, type DefinitionProblem } from "@/lib/automate/validate";
import { ACTIONS, actorRefusal } from "@/lib/automate/registry";
import { draftingSystemPrompt, PROPOSE_WORKFLOW } from "@/lib/automate/ai/prompt";
import { draftingTurn, DraftingRefusal, type DraftingOutcome } from "@/lib/automate/ai/model";
import type { ToolCall, Turn } from "@/lib/copilot/types";

/**
 * A workflow drafted from a person's description (Deskzo Automate, Phase 5) — `draftWithAI`.
 *
 *   1. The model is told how a workflow is written and what this owner may use
 *      (src/lib/automate/ai/prompt.ts) — never anything of the workspace's — and given the description.
 *   2. Its draft is tidied (names and notes cut to length), cleared of what it mustn't name
 *      (src/lib/automate/blanks.ts) and checked as publishing would check it.
 *   3. A draft with mistakes beyond its blanks goes back once with the problems listed; one with no
 *      draft at all is asked for it once. At most three model turns, all counted to the person.
 *
 * It returns the draft. It creates nothing — not a workflow, never a version; the caller saves the
 * draft as a workflow that waits for a person to finish it and press Publish.
 */

export const MAX_DESCRIPTION = 2000;
const MAX_TURNS = 3;

export type Drafted = {
  name: string;
  description: string | null;
  definition: Definition;
  questions: string[];
  /** To choose in the builder: a person, a connection, a record, a stage. */
  blanks: DefinitionProblem[];
  /** Mistakes left after the repair, marked on their steps in the builder. */
  others: DefinitionProblem[];
  cleared: Cleared[];
  usage: { input: number; output: number; turns: number };
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Cuts what a model tends to overrun — names, notes, messages — so length alone never fails a draft. */
function tidy(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const step = { ...(raw as Record<string, unknown>) };
    if (typeof step.name === "string") step.name = step.name.slice(0, 80);
    if (typeof step.note === "string") step.note = step.note.slice(0, 300);
    if (typeof step.message === "string") step.message = step.message.slice(0, 300);
    if (Array.isArray(step.paths)) step.paths = step.paths.map((p) => (p && typeof p === "object" ? { ...(p as Record<string, unknown>), name: text((p as { name?: unknown }).name, 80) || "Path", steps: tidy((p as { steps?: unknown }).steps) } : p));
    if (Array.isArray(step.else)) step.else = tidy(step.else);
    return step;
  });
}

type Proposal = { name: string; description: string | null; questions: string[]; raw: unknown };

function proposalOf(call: ToolCall | undefined): Proposal | null {
  if (!call || call.name !== PROPOSE_WORKFLOW.name || !call.input || typeof call.input !== "object") return null;
  const input = call.input as Record<string, unknown>;
  let raw = input.definition;
  // Some models hand an object back as a string of JSON.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      /* left as it is: the check says why */
    }
  }
  if (raw && typeof raw === "object") raw = { ...(raw as Record<string, unknown>), steps: tidy((raw as { steps?: unknown }).steps) };
  const questions = Array.isArray(input.questions) ? input.questions.map((q) => text(q, 200)).filter(Boolean).slice(0, 5) : [];
  return { name: text(input.name, 80) || "Drafted workflow", description: text(input.description, 500) || null, questions, raw };
}

type Checked = { ok: true; definition: Definition; cleared: Cleared[]; blanks: DefinitionProblem[]; others: DefinitionProblem[] } | { ok: false; problems: string[] };

function check(raw: unknown): Checked {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "definition"}: ${i.message}`) };
  const { definition, cleared } = clearWorkspaceValues(parsed.data);
  const validated = validateDefinition(definition);
  const { blanks, others } = splitProblems(definition, validated.ok ? [] : validated.problems);
  return { ok: true, definition, cleared, blanks, others };
}

const said = (p: DefinitionProblem) => `${p.stepId ? `step "${p.stepId}"` : "the trigger"}${p.field ? `, ${p.field}` : ""}: ${p.message}`;

/** The actions this owner may use now — the only ones offered. */
export async function availableActions(ownerId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const action of ACTIONS) if (!(await actorRefusal(ownerId, action as never))) out.add(action.key);
  return out;
}

/**
 * A draft for `description`, for a workflow `userId` will own. Throws `DraftingRefusal`, in words for
 * a person, when drafting can't run or no usable draft came back.
 */
export async function draftWithAI(input: { userId: string; description: string; signal?: AbortSignal }): Promise<Drafted> {
  const description = input.description.trim();
  if (description.length < 10) throw new DraftingRefusal("Say a little more about what should happen — what starts it, and what it does.");
  if (description.length > MAX_DESCRIPTION) throw new DraftingRefusal(`Keep the description under ${MAX_DESCRIPTION.toLocaleString("en-IN")} characters.`);

  const system = draftingSystemPrompt(await availableActions(input.userId));
  const history: Turn[] = [{ role: "user", text: description }];
  const usage = { input: 0, output: 0, turns: 0 };
  let best: { proposal: Proposal; checked: Extract<Checked, { ok: true }> } | null = null;
  let repaired = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const outcome: DraftingOutcome = await draftingTurn(input.userId, { system, history, tools: [PROPOSE_WORKFLOW], signal: input.signal });
    usage.input += outcome.usage.input;
    usage.output += outcome.usage.output;
    usage.turns += 1;
    if (outcome.stop === "refused") throw new DraftingRefusal("The AI declined to draft that. Try describing it differently.");

    const call = outcome.toolCalls.find((c) => c.name === PROPOSE_WORKFLOW.name);
    history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.provider, model: outcome.model, content: outcome.native } } : {}) });
    const proposal = proposalOf(call);
    // Answered in words, or cut short: asked once more for the draft itself.
    if (!proposal) {
      if (outcome.toolCalls.length) history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: "Only propose_workflow is available.", isError: true })) });
      else history.push({ role: "user", text: "Call propose_workflow with the whole draft now. Leave out what you don't know." });
      continue;
    }
    const checked = check(proposal.raw);
    if (checked.ok && (!best || checked.others.length < best.checked.others.length)) best = { proposal, checked };
    if (checked.ok && checked.others.length === 0) break;
    if (repaired) break;
    repaired = true;
    const problems = checked.ok ? checked.others.map(said) : checked.problems;
    const fix = `The draft has these problems. Fix them and call propose_workflow again with the whole draft:\n- ${problems.join("\n- ")}\nFields left out on purpose (a person, a record, a connection, a stage) are fine as they are.`;
    // Every call made gets its answer, or the provider refuses the next turn.
    history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, isError: true, output: c.id === call!.id ? fix : "Ignored: one call with the whole draft is enough." })) });
  }

  if (!best) throw new DraftingRefusal("The AI didn't come back with a workflow Deskzo can read. Try describing it differently, or more simply.");
  const { proposal, checked } = best;
  return { name: proposal.name, description: proposal.description, definition: checked.definition, questions: proposal.questions, blanks: checked.blanks, others: checked.others, cleared: checked.cleared, usage };
}

/** How many steps a draft has, branches included — for saying what came back. */
export function stepCount(definition: Definition): number {
  return eachStep(definition.steps).length;
}

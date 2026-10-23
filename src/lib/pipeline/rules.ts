import type { LeadStatus } from "@prisma/client";
import { keyFromLabel } from "@/lib/custom-fields/rules";

/**
 * The workspace's own lead pipeline (Settings → Pipeline).
 *
 * A lead moves through stages the workspace names itself — Enquiry, Site visit, Quotation, Booked — in
 * its own order and colours. Each stage stands for one fixed meaning, a `LeadStatus`, and the meaning is
 * what the rest of the app acts on: a won lead counts towards targets and makes its company a customer,
 * the forecast weighs an open one by how far along it is, a lead reaching "qualified" credits whoever
 * qualified it, a proposal left unanswered can be followed up by a journey. So two stages may share a
 * meaning ("Site visit" and "Demo" are both qualifying), and the meaning, never the name, decides what
 * happens.
 *
 * A lead's `status` is always its stage's meaning: the two are written together, in one place
 * (`updateLeadStatus` in src/actions/lead.ts). Should they ever disagree — a lead written by a path that
 * set a status alone — the status wins and the lead shows the first stage with that meaning
 * (`stageOfLead`).
 *
 * A workspace may have several pipelines (owner, 14 Oct 2026 — "team pipelines", as Bigin has them):
 * sales, partner onboarding, renewals, each with its own stages. The main one always counts as sales;
 * another counts as sales only when it is set to, and a pipeline that doesn't is a process whose stages
 * mean start, under way, done or dropped (`meaningsFor`) — nothing that reads won leads as sales looks
 * at it. A pipeline may carry its won leads on into another (connected pipelines), and a stage may ask
 * for fields before a lead moves into it (its rule, `missingForStage`).
 *
 * Pure, so the settings screen, the board and `check:pipeline` share it without a database.
 */

export type StageKind = "OPEN" | "WON" | "LOST";

/** What a stage can stand for, in pipeline order, and what being there does. */
export const MEANINGS: { status: LeadStatus; label: string; kind: StageKind; hint: string }[] = [
  { status: "NEW", label: "New", kind: "OPEN", hint: "Where new leads arrive — by hand, from the website or a form." },
  { status: "CONTACTED", label: "Contacted", kind: "OPEN", hint: "The first conversation has happened." },
  { status: "QUALIFYING", label: "Qualifying", kind: "OPEN", hint: "Finding out whether it is a real opportunity." },
  { status: "QUALIFIED", label: "Qualified", kind: "OPEN", hint: "A real opportunity. Whoever first moves a lead here is credited with qualifying it." },
  { status: "PROPOSAL_SENT", label: "Proposal sent", kind: "OPEN", hint: "A quotation is with the customer: best case in the forecast, and a journey can follow up when nothing comes back." },
  { status: "NEGOTIATION", label: "Negotiation", kind: "OPEN", hint: "Agreeing terms: commit in the forecast." },
  { status: "WON", label: "Won", kind: "WON", hint: "Counts towards targets and wins, and makes the company a customer." },
  { status: "LOST", label: "Lost", kind: "LOST", hint: "Closed without a sale; the reason is asked for." },
  { status: "DISQUALIFIED", label: "Disqualified", kind: "LOST", hint: "Not a real opportunity after all; closed, with the reason asked for." },
];

/**
 * What a stage can stand for in a pipeline that isn't sales — partner onboarding, vendor approval: a
 * process, not a deal. Four of the same meanings, named for what they are there. "Done" is a won lead in
 * the data, but nothing that reads won leads as sales looks at a pipeline that isn't one (`sales`).
 */
const PROCESS_MEANINGS: { status: LeadStatus; label: string; kind: StageKind; hint: string }[] = [
  { status: "NEW", label: "Start", kind: "OPEN", hint: "Where a record arrives — added by hand, from a form or booking page, or carried on from another pipeline." },
  { status: "CONTACTED", label: "Under way", kind: "OPEN", hint: "Being worked on." },
  { status: "WON", label: "Done", kind: "WON", hint: "Finished — and carried on into the next pipeline, when one is connected." },
  { status: "LOST", label: "Dropped", kind: "LOST", hint: "Stopped before the end; the reason is asked for." },
];

/** What a stage may count as in a pipeline: every meaning in a sales pipeline, the four of a process otherwise. */
export function meaningsFor(sales: boolean) {
  return sales ? MEANINGS : PROCESS_MEANINGS;
}

/** Every pipeline keeps at least one stage for each of these: somewhere for a new lead to start, and somewhere to win and to lose. */
export const REQUIRED_MEANINGS: LeadStatus[] = ["NEW", "WON", "LOST"];

export const meaningOf = (status: LeadStatus) => MEANINGS.find((m) => m.status === status)!;
/** A meaning's name in a pipeline: "Won" in sales, "Done" in a process. */
export const meaningLabel = (status: LeadStatus, sales = true) => (meaningsFor(sales).find((m) => m.status === status) ?? meaningOf(status)).label;
export const kindOf = (status: LeadStatus): StageKind => meaningOf(status).kind;
export const isClosed = (status: LeadStatus) => kindOf(status) !== "OPEN";

/** The badge tones a stage may take — the semantic ones, so a stage stays legible in dark mode. */
export const STAGE_COLORS = ["default", "blue", "amber", "brand", "green", "red"] as const;
export type StageColor = (typeof STAGE_COLORS)[number];
export const STAGE_COLOR_LABELS: Record<StageColor, string> = {
  default: "Grey",
  blue: "Blue",
  amber: "Amber",
  brand: "Brand",
  green: "Green",
  red: "Red",
};
export const isStageColor = (value: unknown): value is StageColor => (STAGE_COLORS as readonly unknown[]).includes(value);

export const PIPELINE_LIMITS = { stages: 30, label: 40, pipelines: 15 } as const;

// ── Pipelines ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The pipeline every workspace has, made by the migration that brought several
 * (20261102100000_team_pipelines): always sales, never retired. A lead with no pipeline is in it.
 */
export const MAIN_PIPELINE_ID = "lpip_sales";

export type PipelineDef = {
  id: string;
  /** Fixed once made: what a link names (`/leads?pipeline=onboarding`). The name is free to change. */
  key: string;
  name: string;
  /** Its won leads are sales: targets, wins, the forecast, and the company becoming a customer. */
  sales: boolean;
  /** Connected pipelines: a lead won here carries on as a new lead at the first stage of this one. */
  nextPipelineId: string | null;
  archived: boolean;
};

/** The pipelines of a workspace still waiting for the migration: the main one, as the migration makes it. */
export function defaultPipelines(): PipelineDef[] {
  return [{ id: MAIN_PIPELINE_ID, key: "sales", name: "Sales", sales: true, nextPipelineId: null, archived: false }];
}

export type PipelineInput = { name: string; sales: boolean; nextPipelineId: string | null };

/**
 * What is wrong with a pipeline as entered, or null. `id` is the one being changed (null for a new one);
 * `pipelines` every pipeline there is. The main one is always sales; a connected pipeline must be one in
 * use, and following the connections from it must never come back here — a lead won in each would
 * otherwise start the next round for ever.
 */
export function checkPipeline(input: PipelineInput, id: string | null, pipelines: PipelineDef[]): string | null {
  const name = input.name.trim();
  if (!name) return "Give the pipeline a name.";
  if (name.length > PIPELINE_LIMITS.label) return `Keep the name to ${PIPELINE_LIMITS.label} characters.`;
  if (pipelines.some((p) => p.id !== id && !p.archived && p.name.trim().toLowerCase() === name.toLowerCase())) return `There is already a pipeline called ${name}.`;
  if (id === MAIN_PIPELINE_ID && !input.sales) return "The main pipeline always counts as sales.";
  if (input.nextPipelineId) {
    const next = pipelines.find((p) => p.id === input.nextPipelineId);
    if (!next || next.archived) return "Choose a pipeline in use to carry won leads on to.";
    if (id && next.id === id) return "A pipeline can't carry its won leads on to itself.";
    const seen = new Set<string>();
    for (let at: PipelineDef | undefined = next; at; at = pipelines.find((p) => p.id === at!.nextPipelineId)) {
      if (id && at.nextPipelineId === id) return `${next.name} already carries its won leads on to this pipeline — that would go round in a circle.`;
      if (seen.has(at.id)) break;
      seen.add(at.id);
    }
  }
  return null;
}

/** A pipeline in a list by id; the main one for null (a lead written before there were several). */
export function pipelineById(pipelines: PipelineDef[], id: string | null | undefined): PipelineDef {
  return pipelines.find((p) => p.id === (id ?? MAIN_PIPELINE_ID)) ?? pipelines.find((p) => p.id === MAIN_PIPELINE_ID) ?? defaultPipelines()[0]!;
}

/** The stages of one pipeline, in the order given. */
export function stagesOfPipeline<S extends Pick<LeadStageDef, "pipelineId">>(stages: S[], pipelineId: string): S[] {
  return stages.filter((s) => s.pipelineId === pipelineId);
}

export type LeadStageDef = {
  id: string;
  /** The pipeline it is a stage of. */
  pipelineId: string;
  /** Fixed once made: what a link or a saved filter names, unique within its pipeline. The label is free to change. */
  key: string;
  label: string;
  status: LeadStatus;
  color: StageColor;
  archived: boolean;
  /** The stage's rule: what a lead must have before it moves here (`RULE_FIELDS`, or "cf:<key>"). */
  requiredFields: string[];
};

/**
 * The pipeline every workspace starts with — the stages the app always had, under the same ids the
 * migration seeds (`lstg_<key>`), so a workspace still waiting for the migration shows the same thing.
 */
export function defaultStages(): LeadStageDef[] {
  const color: Record<LeadStatus, StageColor> = {
    NEW: "default",
    CONTACTED: "blue",
    QUALIFYING: "blue",
    QUALIFIED: "amber",
    PROPOSAL_SENT: "amber",
    NEGOTIATION: "amber",
    WON: "green",
    LOST: "red",
    DISQUALIFIED: "red",
  };
  return MEANINGS.map((m) => {
    const key = m.status.toLowerCase();
    return { id: `lstg_${key}`, pipelineId: MAIN_PIPELINE_ID, key, label: m.label, status: m.status, color: color[m.status], archived: false, requiredFields: [] };
  });
}

/**
 * The stage a lead in this status goes to in a pipeline — the main one unless named: the first one with
 * that meaning still in use, else any with it. Stages of different pipelines share their sort order, so a
 * search across all of them would find another team's stage.
 */
export function stageForStatus<S extends Pick<LeadStageDef, "pipelineId" | "archived" | "status">>(stages: S[], status: LeadStatus, pipelineId: string = MAIN_PIPELINE_ID): S | null {
  const own = stages.filter((s) => s.pipelineId === pipelineId);
  return own.find((s) => !s.archived && s.status === status) ?? own.find((s) => s.status === status) ?? null;
}

/**
 * The stage a lead shows: its own when that still means what the lead's status says, otherwise the
 * first stage in its pipeline with the status's meaning — and when that pipeline has none, a stand-in
 * named for it, so a lead is never shown without one. A lead with neither stage nor pipeline is in the
 * main pipeline.
 */
export function stageOfLead(stages: LeadStageDef[], lead: { status: LeadStatus; stageId?: string | null; pipelineId?: string | null }): LeadStageDef {
  const own = lead.stageId ? stages.find((s) => s.id === lead.stageId) : undefined;
  if (own && own.status === lead.status) return own;
  const pipelineId = own?.pipelineId ?? lead.pipelineId ?? MAIN_PIPELINE_ID;
  const byMeaning = stageForStatus(stages, lead.status, pipelineId);
  if (byMeaning) return byMeaning;
  const meaning = meaningOf(lead.status);
  return { id: `lstg_${lead.status.toLowerCase()}`, pipelineId, key: lead.status.toLowerCase(), label: meaning.label, status: lead.status, color: "default", archived: true, requiredFields: [] };
}

/** A new stage's key from its label: lower case, underscores, never one already taken (as custom fields make theirs). */
export function stageKeyFromLabel(label: string, taken: Iterable<string>): string {
  return keyFromLabel(label, taken);
}

export type StageInput = { label: string; status: LeadStatus; color: StageColor };

/**
 * What is wrong with a stage as entered, or null. `others` is every other stage of its pipeline still in
 * use, so a label can't repeat one — two "Quotation" columns on a board would leave nobody sure which is
 * which. A pipeline that isn't sales offers only a process's meanings (`meaningsFor`).
 */
export function checkStage(input: StageInput, others: LeadStageDef[], sales = true): string | null {
  const label = input.label.trim();
  if (!label) return "Give the stage a name.";
  if (label.length > PIPELINE_LIMITS.label) return `Keep the name to ${PIPELINE_LIMITS.label} characters.`;
  if (!meaningsFor(sales).some((m) => m.status === input.status)) return "Choose what the stage counts as.";
  if (!isStageColor(input.color)) return "Choose one of the colours.";
  if (others.some((s) => !s.archived && s.label.trim().toLowerCase() === label.toLowerCase())) return `There is already a stage called ${label}.`;
  return null;
}

/**
 * Why this stage can't stop meaning what it means — retired, deleted, or changed to count as something
 * else — or null when it can. The last stage of its pipeline still in use for a required meaning has to
 * stay.
 */
export function mustKeep(stage: LeadStageDef, stages: LeadStageDef[], sales = true): string | null {
  if (!REQUIRED_MEANINGS.includes(stage.status)) return null;
  const others = stages.filter((s) => s.pipelineId === stage.pipelineId && s.id !== stage.id && !s.archived && s.status === stage.status);
  if (others.length > 0) return null;
  const what = stage.status === "NEW" ? "new leads to start in" : stage.status === "WON" ? (sales ? "won leads" : "finished ones") : sales ? "lost leads" : "dropped ones";
  return `${stage.label} is the only stage for ${what}. Add another stage that counts as ${meaningLabel(stage.status, sales).toLowerCase()} first.`;
}

/**
 * Where a retired stage's leads may go: a stage of the same pipeline still in use, of the same kind. Open
 * leads may move to any open stage; won and lost ones only to another won or lost stage, so retiring a
 * column never closes a deal, reopens one, or changes when it was won.
 */
export function rehomeTargets(stage: LeadStageDef, stages: LeadStageDef[]): LeadStageDef[] {
  return stages.filter((s) => s.pipelineId === stage.pipelineId && s.id !== stage.id && !s.archived && kindOf(s.status) === kindOf(stage.status));
}

// ── A stage's rule ────────────────────────────────────────────────────────────────────────────────

/** What a stage's rule can ask for, beside the workspace's own lead fields ("cf:<key>"). */
export const RULE_FIELDS = [
  { key: "estimatedValue", label: "Value" },
  { key: "expectedCloseDate", label: "Expected close date" },
  { key: "contactId", label: "Contact" },
  { key: "ownerUserId", label: "Owner" },
  { key: "description", label: "Description" },
  // A proposal, proforma or invoice issued for the lead (owner, 19 Oct 2026; src/lib/leads/quotes.ts) —
  // offered only where the workspace can raise one, and off until a stage asks for it.
  { key: "quotation", label: "An issued quotation" },
] as const;

/** The rule that asks for a quotation rather than a field: it is met by issuing one, not by filling anything in. */
export const QUOTE_RULE = "quotation";

export const RULE_LIMIT = 12;

const CUSTOM_RULE = /^cf:[a-z][a-z0-9_]{0,39}$/;

/** Whether a rule may name this: one of `RULE_FIELDS`, or a custom field as "cf:<key>". */
export const isRuleField = (key: string) => RULE_FIELDS.some((f) => f.key === key) || CUSTOM_RULE.test(key);

/** What a stage's rule reads of a lead. */
export type RuleLead = {
  estimatedValue: unknown;
  expectedCloseDate: unknown;
  contactId: string | null;
  ownerUserId: string | null;
  description: string | null;
  customFields: unknown;
  /** Has had a quotation sent (`hasQuoteSent`) — read only when a stage asks for one. */
  quoted?: boolean;
};

const filled = (value: unknown) => value !== null && value !== undefined && !(typeof value === "string" && !value.trim()) && !(Array.isArray(value) && value.length === 0);

/** What this lead still lacks for the stage's rule, by key — empty when it may move there. */
export function missingForStage(stage: Pick<LeadStageDef, "requiredFields">, lead: RuleLead): string[] {
  const custom = lead.customFields && typeof lead.customFields === "object" ? (lead.customFields as Record<string, unknown>) : {};
  return stage.requiredFields.filter((key) => {
    if (key.startsWith("cf:")) return !filled(custom[key.slice(3)]);
    if (key === QUOTE_RULE) return !lead.quoted;
    if (key === "estimatedValue") return !filled(lead.estimatedValue) || Number(String(lead.estimatedValue)) <= 0;
    return !filled((lead as Record<string, unknown>)[key]);
  });
}

/** A rule field as a person reads it. `custom` names the workspace's own fields by key. */
export function ruleFieldLabel(key: string, custom: Map<string, string> = new Map()): string {
  if (key.startsWith("cf:")) return custom.get(key.slice(3)) ?? key.slice(3);
  return RULE_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/**
 * Why a lead can't move into the stage: "Before Proposal sent, fill in Value and Expected close date." —
 * or, `quote` when it still needs a quotation, "Before Proposal sent, issue a quotation for it" first.
 */
export function ruleRefusal(stageLabel: string, missing: string[], quote = false): string {
  const list = missing.length <= 1 ? (missing[0] ?? "") : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  if (quote) return missing.length ? `Before ${stageLabel}, issue a quotation for it and fill in ${list}.` : `Before ${stageLabel}, issue a quotation for it.`;
  return `Before ${stageLabel}, fill in ${list}.`;
}

// ── The history a move leaves ─────────────────────────────────────────────────────────────────────

/**
 * The note a stage change leaves on the lead's activity. It begins as it always has —
 * `Status changed from QUALIFYING to PROPOSAL_SENT` — because the forecast learns win rates from that
 * phrase (src/lib/forecast/stages.ts) and wins are found by " to WON" (src/lib/wins/detect.ts); the
 * stages' own names follow in brackets, for the person reading the timeline (`readStageNote`).
 */
export function stageChangeNote(from: Pick<LeadStageDef, "status" | "label">, to: Pick<LeadStageDef, "status" | "label">, reason?: string | null): string {
  const names = from.label === to.label ? "" : ` (${from.label} → ${to.label})`;
  return `Status changed from ${from.status} to ${to.status}${names}${reason ? `: ${reason}` : ""}`;
}

const NOTE = /^Status changed from ([A-Z_]+) to ([A-Z_]+)(?: \((.+?) → (.+?)\))?(?::\s*([\s\S]*))?$/;

/**
 * A stage change's note as a person reads it: "Moved from Site visit to Quotation", with the reason
 * after it. Older notes carry only the meanings, which read as the workspace's first stage with each.
 * Anything else comes back as written.
 */
export function readStageNote(note: string, stages: LeadStageDef[]): string {
  const m = NOTE.exec(note.trim());
  if (!m) return note;
  const [, fromStatus, toStatus, fromLabel, toLabel, reason] = m;
  const name = (status: string, label: string | undefined) => {
    if (label) return label;
    const known = MEANINGS.find((x) => x.status === status);
    return known ? (stageForStatus(stages, known.status)?.label ?? known.label) : status;
  };
  const text = `Moved from ${name(fromStatus!, fromLabel)} to ${name(toStatus!, toLabel)}`;
  return reason?.trim() ? `${text}: ${reason.trim()}` : text;
}

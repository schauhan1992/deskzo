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

/** Every pipeline keeps at least one stage for each of these: somewhere for a new lead to start, and somewhere to win and to lose. */
export const REQUIRED_MEANINGS: LeadStatus[] = ["NEW", "WON", "LOST"];

export const meaningOf = (status: LeadStatus) => MEANINGS.find((m) => m.status === status)!;
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

export const PIPELINE_LIMITS = { stages: 30, label: 40 } as const;

export type LeadStageDef = {
  id: string;
  /** Fixed once made: what a link or a saved filter names. The label is free to change. */
  key: string;
  label: string;
  status: LeadStatus;
  color: StageColor;
  archived: boolean;
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
    return { id: `lstg_${key}`, key, label: m.label, status: m.status, color: color[m.status], archived: false };
  });
}

/** The stage a lead in this status goes to: the first one with that meaning still in use, else any with it. */
export function stageForStatus<S extends LeadStageDef>(stages: S[], status: LeadStatus): S | null {
  return stages.find((s) => !s.archived && s.status === status) ?? stages.find((s) => s.status === status) ?? null;
}

/**
 * The stage a lead shows: its own when that still means what the lead's status says, otherwise the
 * first stage with the status's meaning — and when the workspace has none, a stand-in named for it, so
 * a lead is never shown without one.
 */
export function stageOfLead(stages: LeadStageDef[], lead: { status: LeadStatus; stageId?: string | null }): LeadStageDef {
  const own = lead.stageId ? stages.find((s) => s.id === lead.stageId) : undefined;
  if (own && own.status === lead.status) return own;
  const byMeaning = stageForStatus(stages, lead.status);
  if (byMeaning) return byMeaning;
  const meaning = meaningOf(lead.status);
  return { id: `lstg_${lead.status.toLowerCase()}`, key: lead.status.toLowerCase(), label: meaning.label, status: lead.status, color: "default", archived: true };
}

/** A new stage's key from its label: lower case, underscores, never one already taken (as custom fields make theirs). */
export function stageKeyFromLabel(label: string, taken: Iterable<string>): string {
  return keyFromLabel(label, taken);
}

export type StageInput = { label: string; status: LeadStatus; color: StageColor };

/**
 * What is wrong with a stage as entered, or null. `others` is every other stage still in use, so a label
 * can't repeat one — two "Quotation" columns on a board would leave nobody sure which is which.
 */
export function checkStage(input: StageInput, others: LeadStageDef[]): string | null {
  const label = input.label.trim();
  if (!label) return "Give the stage a name.";
  if (label.length > PIPELINE_LIMITS.label) return `Keep the name to ${PIPELINE_LIMITS.label} characters.`;
  if (!MEANINGS.some((m) => m.status === input.status)) return "Choose what the stage counts as.";
  if (!isStageColor(input.color)) return "Choose one of the colours.";
  if (others.some((s) => !s.archived && s.label.trim().toLowerCase() === label.toLowerCase())) return `There is already a stage called ${label}.`;
  return null;
}

/**
 * Why this stage can't stop meaning what it means — retired, deleted, or changed to count as something
 * else — or null when it can. The last stage still in use for a required meaning has to stay.
 */
export function mustKeep(stage: LeadStageDef, stages: LeadStageDef[]): string | null {
  if (!REQUIRED_MEANINGS.includes(stage.status)) return null;
  const others = stages.filter((s) => s.id !== stage.id && !s.archived && s.status === stage.status);
  if (others.length > 0) return null;
  const what = stage.status === "NEW" ? "new leads to start in" : stage.status === "WON" ? "won leads" : "lost leads";
  return `${stage.label} is the only stage for ${what}. Add another stage that counts as ${meaningOf(stage.status).label.toLowerCase()} first.`;
}

/**
 * Where a retired stage's leads may go: a stage still in use of the same kind. Open leads may move to any
 * open stage; won and lost ones only to another won or lost stage, so retiring a column never closes a
 * deal, reopens one, or changes when it was won.
 */
export function rehomeTargets(stage: LeadStageDef, stages: LeadStageDef[]): LeadStageDef[] {
  return stages.filter((s) => s.id !== stage.id && !s.archived && kindOf(s.status) === kindOf(stage.status));
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

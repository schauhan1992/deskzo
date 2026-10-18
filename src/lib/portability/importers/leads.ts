import { LeadSource, type CompanyStage, type LeadStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { valuesFor } from "@/lib/custom-fields/server";
import { normalizeCompanyName } from "@/lib/company-name";
import { STILL_THERE } from "@/lib/contacts/left";
import { isModuleEntitled } from "@/lib/modules-access";
import { listLeadMasker } from "@/lib/leads/masking";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { leadStages, stageWrite, stagesOfLeads, type Pipeline } from "@/lib/pipeline/server";
import { MAIN_PIPELINE_ID, kindOf, pipelineById, stageChangeNote, stageForStatus, type LeadStageDef } from "@/lib/pipeline/rules";
import type { FieldMasker } from "@/lib/authz/fields";
import { workspaceClock } from "@/lib/time/workspace";
import { findUser, names, type UserRef } from "./lookups";
import { keyOf, RowReader, seqFromKey, trim, type FieldChange, type Importer, type ImportContext, type PlannedRow, type Resolved } from "./types";

/**
 * Leads and deals, from Deskzo's own export or another CRM's (owner, 18 Oct 2026 — moving from Zoho CRM,
 * HubSpot, Salesforce or Pipedrive). One row a lead.
 *
 *   · **Matching.** `Key` (LEAD-000123, what our export writes), else `Old system ID` — the other CRM's
 *     record id, kept in `Lead.externalId` with no capture key — so the same file again changes nothing.
 *     Anything else is a new lead.
 *   · **Companies.** Found by name (`normalizeCompanyName`). One Deskzo doesn't have is created as a
 *     prospect, with the row's contact; Zoho's Leads and Deals both arrive this way. A contact is found at
 *     the company by email, then name, among the people still there, and created when it isn't.
 *   · **Stages.** A stage named like one of the pipeline's goes there; otherwise the usual words decide
 *     its meaning (`stageMeaning`) — Closed Won is won, Proposal/Price Quote is proposal sent,
 *     Qualification is qualifying. One that fits nothing refuses the row, naming the stages there are.
 *   · **Closed deals** come across dated as they closed (`Closed on`, else `Expected close`), so wins,
 *     targets and the forecast's history land in their month. A won deal with no date is refused rather
 *     than counted as won today.
 *   · **Owners.** One who isn't a Deskzo user, often somebody who left, gives the new lead to the company's
 *     account manager (or to whoever imports, for a company the import creates); an existing lead keeps
 *     its owner. The preview says so.
 *   · **Quiet.** Importing notifies nobody, sets off no workflow, and doesn't run assignment rules.
 *   · **Masked fields** (src/lib/leads/masking.ts) of an existing lead are left alone, as the contacts
 *     import leaves a reseller's customer's details — a masked export reads back as no change.
 */

const C = {
  key: "Key",
  oldId: "Old system ID",
  title: "Title",
  company: "Company",
  contact: "Contact",
  email: "Contact email",
  phone: "Contact phone",
  pipeline: "Pipeline",
  stage: "Stage",
  owner: "Owner",
  value: "Value",
  expected: "Expected close",
  closed: "Closed on",
  created: "Created on",
  source: "Source",
  sourceDetail: "Source detail",
  lostReason: "Lost reason",
  description: "Description",
} as const;

/** Read, but not in the template or the export: other systems split what a Deskzo file holds as one. */
const X = { first: "First name", last: "Last name", mobile: "Contact mobile" } as const;

/**
 * The usual headings in CRM exports (Zoho CRM's Deals and Leads, HubSpot, Salesforce, Pipedrive),
 * matched ignoring case and punctuation. Left out on purpose: Zoho's "Expected Revenue" (the amount times
 * the stage's probability, not the deal's value) and Pipedrive's "Won Time"/"Lost Time" (both columns are
 * in one file, and two headings can't fill one column). To be tightened against real exports.
 */
const ALIASES: Record<string, string[]> = {
  [C.oldId]: ["Record Id", "Deal Id", "Lead Id", "Opportunity Id"],
  [C.title]: ["Deal Name", "Opportunity Name", "Deal Title"],
  [C.company]: ["Account Name", "Company Name", "Organization", "Organisation", "Organization Name"],
  [C.contact]: ["Contact Name", "Full Name", "Contact Person", "Person"],
  [C.email]: ["Email", "Email Address", "Email ID"],
  [C.phone]: ["Phone", "Phone Number"],
  [X.mobile]: ["Mobile", "Mobile Number", "Mobile Phone"],
  [C.stage]: ["Deal Stage", "Lead Status", "Opportunity Stage", "Status"],
  [C.owner]: ["Deal Owner", "Lead Owner", "Opportunity Owner", "Owner Name", "Assigned To"],
  [C.value]: ["Amount", "Deal Value", "Deal Amount", "Opportunity Amount"],
  [C.expected]: ["Closing Date", "Close Date", "Expected Close Date", "Expected Closing Date"],
  [C.closed]: ["Closed Date", "Actual Close Date", "Closed Time", "Date Closed"],
  [C.created]: ["Created Time", "Created Date", "Create Date", "Created At", "Date Created", "Deal Created"],
  [C.source]: ["Lead Source", "Deal Source"],
  [C.lostReason]: ["Reason For Loss", "Loss Reason", "Lost Reason", "Closed Lost Reason"],
  [C.description]: ["Deal Description", "Details"],
};

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * What another system's stage or lead status means, from its words — the meaning a Deskzo stage is then
 * found by. Null when the words say nothing. Order matters: "not qualified" before "qualified",
 * "not contacted" before "contacted", "closed won" before anything else.
 */
export function stageMeaning(text: string): LeadStatus | null {
  const t = words(text);
  if (!t) return null;
  const has = (re: RegExp) => re.test(t);
  if (has(/\bwon\b|\bconverted\b/)) return "WON";
  if (has(/\bjunk\b|\bnot qualified\b|\bunqualified\b|\bdisqualif/)) return "DISQUALIFIED";
  if (has(/\blost\b|\bdead\b/)) return "LOST";
  if (has(/negotiat|\breview\b|\bcontract\b|\bcommit/)) return "NEGOTIATION";
  if (has(/proposal|\bquote\b|\bquotation\b|\bprice\b|\bestimate\b/)) return "PROPOSAL_SENT";
  if (has(/\bpre qualified\b/)) return "QUALIFYING";
  if (has(/\bqualified\b/)) return "QUALIFIED";
  if (has(/qualif|needs analysis|value proposition|decision maker|perception|discovery|\bdemo\b|presentation|appointment|meeting/)) return "QUALIFYING";
  if (has(/\bnot contacted\b|\buncontacted\b/)) return "NEW";
  if (has(/contact|attempted|in touch|follow up|working|engaged|in progress/)) return "CONTACTED";
  if (has(/\bnew\b|\bopen\b|prospect|\bfresh\b|\bcold\b|\bincoming\b/)) return "NEW";
  return null;
}

/** A pipeline that isn't sales has four meanings (src/lib/pipeline/rules.ts); the others fold into them. */
function processMeaning(status: LeadStatus): LeadStatus {
  if (status === "DISQUALIFIED") return "LOST";
  if (status === "QUALIFYING" || status === "QUALIFIED" || status === "PROPOSAL_SENT" || status === "NEGOTIATION") return "CONTACTED";
  return status;
}

const SOURCE_WORDS: [RegExp, LeadSource][] = [
  [/linkedin/, "LINKEDIN"],
  [/walk ?in/, "WALK_IN"],
  [/existing customer|upsell|up sell|cross sell|renewal/, "EXISTING_CUSTOMER"],
  [/refer|word of mouth/, "REFERRAL"],
  [/partner|reseller|channel|distributor/, "PARTNER"],
  [/trade show|tradeshow|seminar|webinar|exhibition|conference|expo|\bevent/, "EVENT"],
  [/advert|\bads?\b|google|facebook|instagram|campaign|\bppc\b|paid/, "ADVERTISEMENT"],
  [/cold call|\bcall|phone|tele/, "CALLING"],
  [/e ?mail|mailer|newsletter/, "EMAIL"],
  [/\bweb|online|organic|\bseo\b|chat|form/, "WEBSITE"],
];

/**
 * A source cell as one of Deskzo's, by name or by its words; anything else is Other, with the text kept as
 * the detail rather than lost.
 */
export function sourceOf(text: string): { source: LeadSource; detail?: string } {
  const exact = text.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (exact in LeadSource) return { source: exact as LeadSource };
  const t = words(text);
  for (const [re, source] of SOURCE_WORDS) if (re.test(t)) return { source };
  return { source: "OTHER", detail: text.trim() };
}

type ExistingLead = {
  id: string;
  leadSeq: number;
  title: string;
  status: LeadStatus;
  companyId: string;
  contactId: string | null;
  ownerUserId: string | null;
  estimatedValue: unknown;
  expectedCloseDate: Date | null;
  stageChangedAt: Date | null;
  source: LeadSource;
  sourceDetail: string | null;
  lostReason: string | null;
  description: string | null;
  externalId: string | null;
  company: { name: string };
  contact: { name: string; email: string | null } | null;
  owner: UserRef | null;
};

type KnownCompany = { isNew: false; id: string; name: string; stage: CompanyStage; createdById: string | null; owner: { id: string; name: string } | null };
type NewCompany = { isNew: true; name: string; normalizedName: string };
type KnownContact = { isNew: false; id: string; name: string };
type NewContact = { isNew: true; name: string; email: string | null; phone: string | null };

type Row = {
  existing: ExistingLead | null;
  title: string;
  company: KnownCompany | NewCompany;
  contact: KnownContact | NewContact | null;
  pipeline: Pipeline;
  stage: LeadStageDef;
  /** The stage it is in now — the target for a new lead. */
  from: LeadStageDef | null;
  /** When it entered `stage`: the close date for a closed deal, now for an open one. */
  stageDate: Date;
  /** The `Closed on` the file gives an unmoved closed lead, when it differs from what's stored. */
  redate: Date | null;
  owner: { id: string; name: string } | null;
  /** The owner the file named who isn't a Deskzo user, when the lead went to somebody else for it. */
  ownerNotFound: string | null;
  value?: number;
  expected?: Date;
  /** When it was made, as the workspace's midnight on the day the file gives. */
  createdOn?: Date;
  /** The days the preview shows, on the workspace's clock: closed on (new), closed on (stored), created on. */
  closedDay: string;
  storedDay: string;
  createdDay: string;
  source?: LeadSource;
  sourceDetail?: string;
  lostReason?: string;
  description?: string;
  oldId?: string;
  /** Cells for fields masked from the importer, left as they are. */
  heldHidden: boolean;
};

const LEAD_SELECT = {
  id: true,
  leadSeq: true,
  title: true,
  status: true,
  companyId: true,
  contactId: true,
  ownerUserId: true,
  estimatedValue: true,
  expectedCloseDate: true,
  stageChangedAt: true,
  source: true,
  sourceDetail: true,
  lostReason: true,
  description: true,
  externalId: true,
  company: { select: { name: true } },
  contact: { select: { name: true, email: true } },
  owner: { select: { id: true, name: true, email: true, active: true } },
} as const;

const COMPANY_SELECT = { id: true, name: true, stage: true, createdById: true, owner: { select: { id: true, name: true } } } as const;

/** Reads made once per file rather than per row: the stages, who may see what, who is importing. */
type Shared = { pipeline: Pipeline; masker: FieldMasker; entitled: boolean; actor: { id: string; name: string }; clock: Awaited<ReturnType<typeof workspaceClock>> };
const shared = new WeakMap<ImportContext, Promise<Shared>>();
function sharedFor(ctx: ImportContext): Promise<Shared> {
  let found = shared.get(ctx);
  if (!found) {
    found = (async () => {
      const [pipeline, masker, entitled, actor, clock] = await Promise.all([
        leadStages(),
        listLeadMasker(ctx.actorUserId),
        isModuleEntitled("leads"),
        db.user.findUniqueOrThrow({ where: { id: ctx.actorUserId }, select: { id: true, name: true } }),
        workspaceClock(),
      ]);
      return { pipeline, masker, entitled, actor, clock };
    })();
    shared.set(ctx, found);
  }
  return found;
}

const heading = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const dayKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const stageList = (stages: LeadStageDef[]) => stages.map((s) => s.label).join(", ");

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<Row>> {
  const { pipeline, masker, entitled, actor, clock } = await sharedFor(ctx);
  if (!entitled) return { error: "Leads isn't part of this workspace's plan." };
  const r = new RowReader(row, clock);

  // ── Which lead ──
  const keyCell = r.text(C.key);
  const oldId = r.text(C.oldId) || undefined;
  let existing: ExistingLead | null = null;
  if (keyCell) {
    const seq = seqFromKey("LEAD", keyCell);
    if (seq === null) return { error: `Key "${keyCell}" isn't a lead's key, like LEAD-000123. Remove it to create a new lead.` };
    existing = (await db.lead.findUnique({ where: { leadSeq: seq }, select: LEAD_SELECT })) as ExistingLead | null;
    if (!existing) return { error: `No lead with key ${keyOf("LEAD", seq)}. Remove the Key cell to create a new lead.` };
  } else if (oldId) {
    existing = (await db.lead.findFirst({ where: { externalId: oldId, captureKeyId: null }, select: LEAD_SELECT })) as ExistingLead | null;
  }
  // A field masked from this person is theirs to leave alone, not to overwrite with what they were shown.
  const hidden = (field: string) => !!existing && masker.visibility(field) !== "clear";
  let heldHidden = false;
  const cell = (column: string, field: string | null) => {
    const value = r.text(column);
    if (value && field && hidden(field)) {
      heldHidden = true;
      return "";
    }
    return value;
  };

  // ── Company ──
  const companyCell = cell(C.company, "companyName");
  let company: KnownCompany | NewCompany;
  if (companyCell) {
    const normalizedName = normalizeCompanyName(companyCell);
    const found = await db.company.findUnique({ where: { normalizedName }, select: COMPANY_SELECT });
    company = found ? { isNew: false, ...found } : { isNew: true, name: companyCell.trim(), normalizedName };
  } else if (existing) {
    company = { isNew: false, ...(await db.company.findUniqueOrThrow({ where: { id: existing.companyId }, select: COMPANY_SELECT })) };
  } else {
    return { error: "Company is required — every lead belongs to a company." };
  }

  // ── Contact ──
  const contactName = cell(C.contact, "contactName") || (hidden("contactName") ? "" : [r.text(X.first), r.text(X.last)].filter(Boolean).join(" "));
  const email = cell(C.email, "email").toLowerCase() || null;
  const phone = cell(C.phone, "phone") || (hidden("phone") ? "" : r.text(X.mobile)) || null;
  let contact: Row["contact"] = null;
  const theirs = existing?.contact && existing.contactId ? existing.contact : null;
  const namesTheirs =
    !!theirs && (contactName.toLowerCase() === theirs.name.toLowerCase() || (!!email && email === (theirs.email ?? "").toLowerCase()));
  if (namesTheirs && existing?.contactId && theirs) {
    // The lead's own contact, even one who has since left the company: our export writes them, and reading it back is no change.
    contact = { isNew: false, id: existing.contactId, name: theirs.name };
  } else if (contactName || email) {
    // By email first: two people may share a name, never an address. Only people still there.
    const at = (where: Prisma.ContactWhereInput) =>
      company.isNew ? null : db.contact.findFirst({ where: { companyId: company.id, ...STILL_THERE, ...where }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
    const found =
      (email ? await at({ email: { equals: email, mode: "insensitive" } }) : null) ??
      (contactName ? await at({ name: { equals: contactName, mode: "insensitive" } }) : null);
    contact = found ? { isNew: false, id: found.id, name: found.name } : { isNew: true, name: contactName || email!, email, phone };
  }

  // ── Pipeline and stage ──
  const pipelineCell = r.text(C.pipeline);
  let pipelineId = MAIN_PIPELINE_ID;
  const current = existing ? ((await stagesOfLeads([{ id: existing.id, status: existing.status }])).get(existing.id) ?? null) : null;
  if (pipelineCell) {
    const named = pipeline.pipelines.find((p) => heading(p.name) === heading(pipelineCell) || heading(p.key) === heading(pipelineCell));
    if (!named) return { error: `No pipeline called "${pipelineCell}". There are: ${pipeline.pipelines.filter((p) => !p.archived).map((p) => p.name).join(", ")}.` };
    if (named.archived) return { error: `The ${named.name} pipeline is no longer in use.` };
    pipelineId = named.id;
  } else if (current) {
    pipelineId = current.pipelineId;
  }
  const own = pipeline.stages.filter((s) => s.pipelineId === pipelineId && !s.archived);
  const stageCell = r.text(C.stage);
  let stage: LeadStageDef | null = null;
  if (stageCell) {
    stage = own.find((s) => heading(s.label) === heading(stageCell) || heading(s.key) === heading(stageCell)) ?? null;
    if (!stage) {
      const meaning = stageMeaning(stageCell);
      const sales = pipelineById(pipeline.pipelines, pipelineId).sales;
      stage = meaning ? stageForStatus(pipeline.stages, sales ? meaning : processMeaning(meaning), pipelineId) : null;
    }
    if (!stage) return { error: `Stage "${stageCell}" isn't one Deskzo can place. This pipeline's stages: ${stageList(own)}.` };
  } else if (current && current.pipelineId === pipelineId) {
    stage = current;
  } else {
    stage = stageForStatus(pipeline.stages, "NEW", pipelineId);
    if (!stage) return { error: `The ${pipelineById(pipeline.pipelines, pipelineId).name} pipeline has no stage for new leads.` };
  }

  // ── Dates ──
  const expected = r.date(C.expected);
  const closedOn = r.date(C.closed);
  const createdOn = r.date(C.created);
  const value = r.number(C.value);
  if (value !== undefined && value < 0) r.fail(`${C.value} can't be negative.`);
  if (r.error) return { error: r.error };
  const closed = kindOf(stage.status) !== "OPEN";
  const moves = !current || current.id !== stage.id;
  // A typed day is the workspace's: stored as its midnight there, so its own clock reads the day back as typed.
  const midnight = (day: Date) => clock.startOfDay(dayKey(day)) ?? day;
  let stageDate = new Date();
  if (closed && moves) {
    const when = closedOn ?? expected ?? (stage.status === "WON" ? null : (createdOn ?? null));
    if (!when && stage.status === "WON") return { error: `A won deal needs the day it was won — give ${C.closed}, or ${C.expected}. Without it, it would count as won today.` };
    if (when) stageDate = midnight(when);
  }
  const storedDay = existing?.stageChangedAt ? clock.dateKey(existing.stageChangedAt) : "";
  const redate = closed && !moves && closedOn && dayKey(closedOn) !== storedDay ? midnight(closedOn) : null;

  // ── Owner ──
  const ownerCell = r.text(C.owner);
  const fallback = company.isNew ? actor : (company.owner ?? actor);
  let owner: Row["owner"] = existing?.owner ?? null;
  let ownerNotFound: string | null = null;
  if (ownerCell && !(existing?.owner && names(ownerCell, existing.owner))) {
    const found = await findUser(ownerCell, false);
    if (found) owner = found;
    else if (!existing) {
      owner = fallback;
      ownerNotFound = ownerCell;
    } else ownerNotFound = ownerCell;
  } else if (!existing) owner = fallback;

  // ── The rest ──
  const sourceCell = cell(C.source, "source");
  const parsedSource = sourceCell ? sourceOf(sourceCell) : null;
  const detailCell = cell(C.sourceDetail, "source");

  return {
    value: {
      existing,
      title: cell(C.title, "title") || (existing ? existing.title : company.name),
      company,
      contact,
      pipeline,
      stage,
      from: current,
      stageDate,
      redate,
      owner,
      ownerNotFound,
      value,
      expected,
      createdOn: createdOn ? midnight(createdOn) : undefined,
      closedDay: closed ? clock.dateKey(redate ?? stageDate) : "",
      storedDay,
      createdDay: createdOn ? dayKey(createdOn) : "",
      source: parsedSource?.source,
      sourceDetail: detailCell || parsedSource?.detail,
      lostReason: closed ? r.text(C.lostReason) || undefined : undefined,
      description: cell(C.description, "description") || undefined,
      oldId,
      heldHidden,
    },
  };
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const HIDDEN_NOTICE = "Some cells are for lead fields masked from you — those were left as they are.";
const OWNER_NOTICE = "Owners who aren't Deskzo users: a new lead goes to the company's account manager, an existing one keeps its owner.";

/** What the row changes, for the preview. The custom fields' are added by the caller. */
function changesOf(p: Row): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, from: unknown, to: unknown) => {
    const a = trim(from);
    const b = trim(to);
    if (a !== b) out.push({ field, from: a || "(empty)", to: b || "(empty)" });
  };
  const e = p.existing;
  const companyName = p.company.isNew ? `${p.company.name} (new company)` : p.company.name;
  const contactName = p.contact ? (p.contact.isNew ? `${p.contact.name} (new contact)` : p.contact.name) : "";
  const ownerName = p.owner ? `${p.owner.name}${p.ownerNotFound && !e ? ` (for ${p.ownerNotFound}, not in Deskzo)` : ""}` : "";
  const stageLabel = p.pipeline.pipelines.length > 1 && p.stage.pipelineId !== MAIN_PIPELINE_ID ? `${pipelineById(p.pipeline.pipelines, p.stage.pipelineId).name} › ${p.stage.label}` : p.stage.label;
  const closed = kindOf(p.stage.status) !== "OPEN";
  if (!e) {
    const fresh = (field: string, to: unknown) => {
      const b = trim(to);
      if (b) out.push({ field, from: "(new)", to: b });
    };
    fresh(C.title, p.title);
    fresh(C.company, companyName);
    fresh(C.contact, contactName);
    fresh(C.stage, stageLabel);
    if (closed) fresh(C.closed, p.closedDay);
    fresh(C.owner, ownerName);
    if (p.value !== undefined) fresh(C.value, rupees(p.value));
    fresh(C.expected, dayKey(p.expected));
    fresh(C.created, p.createdDay);
    fresh(C.source, p.source);
    fresh(C.sourceDetail, p.sourceDetail);
    fresh(C.lostReason, p.lostReason);
    fresh(C.description, p.description);
    fresh(C.oldId, p.oldId);
    return out;
  }
  add(C.title, e.title, p.title);
  if (p.company.isNew || p.company.id !== e.companyId) add(C.company, e.company.name, companyName);
  if (p.contact && (p.contact.isNew || p.contact.id !== e.contactId)) add(C.contact, e.contact?.name, contactName);
  if (p.from?.id !== p.stage.id) add(C.stage, p.from?.label, stageLabel);
  if (closed && (p.from?.id !== p.stage.id || p.redate)) add(C.closed, p.storedDay, p.closedDay);
  if (p.owner && p.owner.id !== e.ownerUserId) add(C.owner, e.owner?.name, ownerName);
  if (p.value !== undefined && Number(e.estimatedValue ?? NaN) !== p.value) add(C.value, e.estimatedValue === null ? "" : rupees(Number(e.estimatedValue)), rupees(p.value));
  if (p.expected) add(C.expected, dayKey(e.expectedCloseDate), dayKey(p.expected));
  if (p.source) add(C.source, e.source, p.source);
  if (p.sourceDetail) add(C.sourceDetail, e.sourceDetail, p.sourceDetail);
  if (p.lostReason) add(C.lostReason, e.lostReason, p.lostReason);
  if (p.description) add(C.description, e.description, p.description);
  if (p.oldId) add(C.oldId, e.externalId, p.oldId);
  return out;
}

export const leadsImporter: Importer = {
  templateColumns: Object.values(C),
  headerAliases: ALIASES,
  extraColumns: Object.values(X),
  customEntity: "LEAD",

  async plan(row, line, ctx): Promise<PlannedRow> {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return { line, action: "error", key: "", label: trim(row[C.title]) || trim(row[C.company]), changes: [], error: resolved.error };
    const p = resolved.value;
    const custom = ctx.custom ? await ctx.custom.merge(p.existing ? await valuesFor("LEAD", p.existing.id) : {}, row) : null;
    if (custom && !custom.ok) return { line, action: "error", key: "", label: p.title, changes: [], error: custom.error };

    // A company two rows both name is created by the first; the preview says so on the second.
    const changes = changesOf(p).map((c) => {
      if (c.field !== C.company || !p.company.isNew) return c;
      const companyKey = `company:${p.company.normalizedName}`;
      const earlier = ctx.pendingKeys.has(companyKey);
      ctx.pendingKeys.add(companyKey);
      return earlier ? { ...c, to: `${p.company.name} (new company, from an earlier row)` } : c;
    });
    if (custom?.ok) changes.push(...custom.changes);
    const notice = p.heldHidden ? HIDDEN_NOTICE : p.ownerNotFound ? OWNER_NOTICE : undefined;
    const key = p.existing ? keyOf("LEAD", p.existing.leadSeq) : "";
    const action = p.existing ? (changes.length ? "update" : "skip") : "create";
    return { line, action, key, label: p.title, changes, ...(notice ? { notice } : {}) };
  },

  async apply(row, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const p = resolved.value;
    const custom = ctx.custom ? await ctx.custom.merge(p.existing ? await valuesFor("LEAD", p.existing.id) : {}, row) : null;
    if (custom && !custom.ok) throw new Error(custom.error);
    const customFields = custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {};
    const actorId = ctx.actorUserId;
    const sales = pipelineById(p.pipeline.pipelines, p.stage.pipelineId).sales;
    const status = p.stage.status;
    const closed = kindOf(status) !== "OPEN";

    // Everything read beforehand: `db` inside the transaction can deadlock the two-connection pool.
    const leadId = await db.$transaction(async (tx) => {
      const company = p.company.isNew
        ? await tx.company.upsert({
            where: { normalizedName: p.company.normalizedName },
            update: {},
            create: { name: p.company.name, normalizedName: p.company.normalizedName, relationshipType: "CLIENT", stage: "PROSPECT", createdById: actorId, ownerUserId: p.owner?.id ?? actorId },
            select: { id: true, stage: true, createdById: true },
          })
        : { id: p.company.id, stage: p.company.stage, createdById: p.company.createdById };

      let contactId: string | null | undefined;
      if (p.contact?.isNew) {
        const first = (await tx.contact.count({ where: { companyId: company.id } })) === 0;
        const made = await tx.contact.create({
          data: { companyId: company.id, name: p.contact.name, email: p.contact.email, phone: p.contact.phone, isPrimary: first, createdByUserId: actorId },
          select: { id: true },
        });
        contactId = made.id;
      } else if (p.contact) contactId = p.contact.id;

      let id: string;
      if (!p.existing) {
        const created = await tx.lead.create({
          data: {
            status,
            ...stageWrite(p.pipeline, p.stage, p.stageDate),
            companyId: company.id,
            contactId: contactId ?? null,
            title: p.title,
            description: p.description ?? null,
            estimatedValue: p.value ?? null,
            expectedCloseDate: p.expected ?? null,
            sourcedByUserId: company.createdById,
            ownerUserId: p.owner?.id ?? null,
            assignmentNote: p.ownerNotFound ? `Brought from the old system, where it was ${p.ownerNotFound}'s` : "Brought from the old system",
            source: p.source ?? "OTHER",
            sourceDetail: p.sourceDetail ?? null,
            lostReason: closed ? (p.lostReason ?? null) : null,
            externalId: p.oldId ?? null,
            createdByUserId: actorId,
            ...(p.createdOn ? { createdAt: p.createdOn } : {}),
            ...customFields,
          },
          select: { id: true },
        });
        id = created.id;
      } else {
        const e = p.existing;
        id = e.id;
        const moving = p.from?.id !== p.stage.id;
        await tx.lead.update({
          where: { id },
          data: {
            title: p.title,
            ...(p.company.isNew || p.company.id !== e.companyId ? { companyId: company.id } : {}),
            ...(contactId !== undefined ? { contactId } : {}),
            ...(moving ? { status, ...stageWrite(p.pipeline, p.stage, p.stageDate) } : {}),
            ...(!moving && p.redate ? { stageChangedAt: p.redate } : {}),
            ...(p.owner && p.owner.id !== e.ownerUserId ? { ownerUserId: p.owner.id } : {}),
            ...(p.value !== undefined ? { estimatedValue: p.value } : {}),
            ...(p.expected ? { expectedCloseDate: p.expected } : {}),
            ...(p.source ? { source: p.source } : {}),
            ...(p.sourceDetail ? { sourceDetail: p.sourceDetail } : {}),
            ...(p.lostReason ? { lostReason: p.lostReason } : {}),
            ...(p.description ? { description: p.description } : {}),
            ...(p.oldId ? { externalId: p.oldId } : {}),
            ...customFields,
          },
        });
        // The forecast and wins read this note (src/lib/pipeline/rules.ts); a move by import is still a move.
        if (moving && p.from) await tx.activity.create({ data: { leadId: id, userId: actorId, type: "STAGE_CHANGE", notes: stageChangeNote(p.from, p.stage, p.lostReason ?? null) } });
      }

      // What a lead does to its company, as everywhere else: an open one makes a prospect a lead, a sales win a customer.
      if (status === "WON" && sales) await tx.company.update({ where: { id: company.id }, data: { stage: "CUSTOMER" } });
      else if (!closed && company.stage === "PROSPECT") await tx.company.update({ where: { id: company.id }, data: { stage: "LEAD" } });
      return id;
    });

    await refreshLeadScore(leadId);
    await recordAudit({ userId: actorId, action: p.existing ? "UPDATE" : "CREATE", entityType: "Lead", entityId: leadId, entityLabel: `${p.title} (imported)` });
  },
};

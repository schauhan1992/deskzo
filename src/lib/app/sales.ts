import { getCompany, listCompaniesPaged } from "@/actions/company";
import { listAllContactsPaged } from "@/actions/contact";
import { getLead, listLeadsPaged } from "@/actions/lead";
import { searchRecords, searchScopesForMe } from "@/actions/search";
import { ApiError, pageOf, paging, type ApiAnswer } from "@/lib/api/handler";
import { customFieldsOut } from "@/lib/api/custom";
import { idOf, iso } from "@/lib/api/refs";
import { companiesOut, contactOut } from "@/lib/api/v1/companies";
import { leadsOut } from "@/lib/api/v1/leads";
import { needAppModule } from "@/lib/app/daily";
import type { AppCall } from "@/lib/app/handler";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/source";
import { accessContextFor, moduleAccessFor } from "@/lib/modules-access";
import { buildNavigation } from "@/lib/navigation";
import { activePipelines, activeStages } from "@/lib/pipeline/server";
import { slot } from "@/lib/terms/dictionary";
import { getWording } from "@/lib/terms/server";
import type { LeadStageDef } from "@/lib/pipeline/rules";
import { leadStatusValues } from "@/lib/validation/lead";

/**
 * The Deskzo app's sales screens (owner, 22 Oct 2026 — the app made native, sales first): leads, companies (the
 * web's Companies list: prospects and customers) and their contacts, and searching them — as the phone's person
 * (src/lib/app/handler.ts).
 *
 * The records are the public API's own (src/lib/api/v1): the same reads through the web's actions, the same
 * shapes, the same masking. Only what a phone needs on top is added here — a lead's history and its pipeline's
 * stages to move it along, a company's open leads and what last happened with them, and search over all three.
 */

type Row = Record<string, unknown> & { id: string };
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

const APP_PAGE_SIZE = 25;
const APP_MAX_PAGE_SIZE = 50;
/** The same answer for one that isn't there and one the person may not see — an id tells nobody which. */
const notFound = (what: string) => new ApiError(404, "not_found", `That ${what} isn't there, or isn't one you can open.`);

const CLOSED = new Set(["WON", "LOST", "DISQUALIFIED"]);

export const ACTIVITY_TYPES = [
  { value: "CALL", label: "Call" },
  { value: "MEETING", label: "Meeting" },
  { value: "EMAIL", label: "Email" },
  { value: "NOTE", label: "Note" },
] as const;

const stageOut = (s: LeadStageDef) => ({ id: s.id, key: s.key, name: s.label, status: s.status, color: s.color, required_fields: s.requiredFields });

/** A logged call, note, meeting or stage move, as a lead's or a company's history lists it. */
function activityOut(a: Row, lead?: { id: string; title: unknown }) {
  const user = rec(a.user);
  return {
    id: a.id,
    type: a.type,
    notes: str(a.notes) ?? "",
    occurred_at: iso(a.occurredAt as Date | string),
    by: user ? { id: user.id, name: user.name } : null,
    ...(lead ? { lead: { id: lead.id, title: lead.title } } : {}),
  };
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/** GET `?view=mine|all&search=&status=&stage=&pipeline=&page=`: the leads the person reaches, newest first. */
export async function appLeads(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("leads", call.actor.userId);
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, APP_MAX_PAGE_SIZE, APP_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  if (status && !(leadStatusValues as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", "Not a lead status.", { status: "Unknown status." });
  const { rows, total } = await listLeadsPaged({
    page,
    pageSize,
    search: q.get("search")?.slice(0, 100) || undefined,
    status: status as (typeof leadStatusValues)[number] | undefined,
    stage: q.get("stage")?.slice(0, 60) || undefined,
    pipeline: q.get("pipeline")?.slice(0, 60) || "all",
    ownerUserId: q.get("view") === "mine" ? call.actor.userId : undefined,
  });
  return { data: await leadsOut(call.actor.userId, rows as unknown as Row[]), page: pageOf(page, pageSize, total) };
}

/** One lead, with what happened on it (the calls, notes and meetings the person may read) and its pipeline's stages. */
export async function appLead(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("leads", call.actor.userId);
  const id = await idOf("lead", call.params.ref);
  const raw = id ? ((await getLead(id)) as Row | null) : null;
  if (!raw) throw notFound("lead");
  const [lead] = await leadsOut(call.actor.userId, [raw]);
  const activities = (Array.isArray(raw.activities) ? (raw.activities as Row[]) : []).slice(0, 50).map((a) => activityOut(a));
  // A lead in the main pipeline names none (null is the main one, src/lib/pipeline): its stages are the main one's.
  const stages = (await activeStages(lead!.pipeline?.id)).map(stageOut);
  return { data: { ...lead!, activities, stages } };
}

/** The pipelines a lead may be in, each with its stages, and what a new lead and a logged activity offer. */
export async function appPipelines(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("leads", call.actor.userId);
  const pipelines = await activePipelines();
  return {
    data: {
      pipelines: await Promise.all(pipelines.map(async (p) => ({ id: p.id, key: p.key, name: p.name, sales: p.sales, stages: (await activeStages(p.id)).map(stageOut) }))),
      sources: Object.entries(LEAD_SOURCE_LABELS).map(([value, label]) => ({ value, label })),
      activity_types: ACTIVITY_TYPES,
    },
  };
}

// ─── Companies and contacts ───────────────────────────────────────────────────

const COMPANY_STAGES = ["PROSPECT", "LEAD", "CUSTOMER"] as const;

/**
 * GET `?view=mine|all&stage=&search=&page=`: the companies the person reaches on the customer side — prospects and
 * customers, as the web's Companies list; "mine", those they're the account manager of.
 */
export async function appCompanies(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("companies", call.actor.userId);
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, APP_MAX_PAGE_SIZE, APP_PAGE_SIZE);
  const stage = q.get("stage")?.toUpperCase();
  if (stage && !(COMPANY_STAGES as readonly string[]).includes(stage)) throw new ApiError(400, "invalid_request", "Not a company stage.", { stage: "Unknown stage." });
  const { rows, total } = await listCompaniesPaged({
    page,
    pageSize,
    search: q.get("search")?.slice(0, 100) || undefined,
    stage: stage as (typeof COMPANY_STAGES)[number] | undefined,
    assignedToUserId: q.get("view") === "mine" ? call.actor.userId : undefined,
  });
  return { data: await companiesOut(call.actor.userId, rows as unknown as Row[]), page: pageOf(page, pageSize, total) };
}

/** One company: its contacts, the open leads the person may see, and the last things logged on them. */
export async function appCompany(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("companies", call.actor.userId);
  const id = await idOf("company", call.params.ref);
  const company = id ? ((await getCompany(id)) as Row | null) : null;
  if (!company) throw notFound("company");
  const [out] = await companiesOut(call.actor.userId, [company]);
  const contacts = (Array.isArray(company.contacts) ? (company.contacts as Row[]) : []).filter((c) => !c.leftAt);
  const custom = await customFieldsOut("CONTACT", call.actor.userId, contacts.map((c) => c.id));
  const leads = Array.isArray(company.leads) ? (company.leads as Row[]) : [];
  const leadsVisible = (await moduleAccessFor(call.actor.userId, "leads")) === "available";
  const open = leadsVisible ? leads.filter((l) => !CLOSED.has(String(l.status))) : [];
  const shaped = open.length ? await leadsOut(call.actor.userId, open.map((l) => ({ ...l, company }))) : [];
  const activities = leadsVisible
    ? leads
        .flatMap((l) => (Array.isArray(l.activities) ? (l.activities as Row[]).map((a) => activityOut(a, { id: l.id, title: l.title })) : []))
        .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
        .slice(0, 20)
    : [];
  return {
    data: {
      ...out!,
      contacts: contacts.map((c) => contactOut(c, company, custom.get(c.id))),
      open_leads: shaped,
      activities,
    },
  };
}

/** GET `?search=&page=`: the contacts the person reaches, at the companies they reach — not those who left. */
export async function appContacts(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("contacts_library", call.actor.userId);
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, APP_MAX_PAGE_SIZE, APP_PAGE_SIZE);
  const { rows, total } = await listAllContactsPaged({ page, pageSize, search: q.get("search")?.slice(0, 100) || undefined });
  const list = rows as unknown as Row[];
  const custom = await customFieldsOut("CONTACT", call.actor.userId, list.map((c) => c.id));
  return { data: list.map((c) => contactOut(c, rec(c.company), custom.get(c.id))), page: pageOf(page, pageSize, total) };
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** The header search's scopes the app searches: companies (prospects too), not only those that bought. */
const SEARCHED = { leads: "lead", companies: "company", contacts: "contact" } as const;

/**
 * GET `?q=`: leads, companies and contacts at once — each only where the web's header search offers it to the
 * person (src/actions/search.ts), a few of each, best first.
 */
export async function appSearch(call: AppCall): Promise<ApiAnswer> {
  const query = (call.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (query.length < 2) return { data: { query, results: [] } };
  const scopes = (await searchScopesForMe()).filter((s) => s.key in SEARCHED);
  const found = await Promise.all(scopes.map(async (s) => ({ scope: s, result: await searchRecords(s.key, query) })));
  const results = found.flatMap(({ scope, result }) =>
    result.ok ? result.hits.map((h) => ({ kind: SEARCHED[scope.key as keyof typeof SEARCHED], id: h.id, title: h.title, subtitle: h.subtitle ?? null })) : [],
  );
  return { data: { query, results } };
}

// ─── The More tab ─────────────────────────────────────────────────────────────

/**
 * Everything the person may open in Deskzo, as the web's menu lists it (src/lib/navigation.ts) and in the
 * workspace's own words (Settings › Wording — "Enquiries" for Leads), for the app's More tab, which opens what it
 * has screens for itself and the rest as the web's own page.
 */
export async function appModulesFor(userId: string) {
  const [sections, wording] = await Promise.all([accessContextFor(userId).then(buildNavigation), getWording()]);
  return sections.map((s) => ({
    group: s.group,
    items: s.items.map((i) => ({ label: i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label, href: i.href })),
  }));
}

/**
 * A public API operation (src/lib/api/v1) as an app route: the module asked of the person first, in the app's own
 * words, then the operation itself — its schema, its refusals and its answer, unchanged.
 */
export const throughApp =
  (moduleKey: string, operation: (call: AppCall) => Promise<ApiAnswer>) =>
  async (call: AppCall): Promise<ApiAnswer> => {
    await needAppModule(moduleKey, call.actor.userId);
    return operation(call);
  };

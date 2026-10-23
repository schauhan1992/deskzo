import { createLead, getLead, listLeadsPaged, logActivity, updateLeadDetails, updateLeadStatus } from "@/actions/lead";
import { ApiError, notFound, pageOf, paging, refusedBy, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { customFieldsOut } from "@/lib/api/custom";
import { leadCreateSchema, leadNoteSchema, leadPatchSchema, leadStageSchema } from "@/lib/api/v1/schemas";
import { needModule } from "@/lib/api/v1/shared";
import { amount, companyRef, contactRef, day, idOf, iso, leadRef, personId } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";
import { db } from "@/lib/db";
import { leadStatusValues } from "@/lib/validation/lead";

/**
 * Leads in the public API (src/lib/api): listed, read, added, changed, moved and noted — each through
 * the app's own lead actions as the key's person, so what reaches them, the field masking, the stage
 * rules and the assignment rules apply exactly as on the Leads screens.
 */

const STATUSES = leadStatusValues;
type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** What the API says about leads beyond what the screens' rows carry: stage, pipeline and refs, read by name. */
async function extrasFor(ids: string[]) {
  const leads = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, stage: { select: { id: true, key: true, label: true } }, pipeline: { select: { id: true, key: true, name: true } }, contact: { select: { contactSeq: true } } },
  });
  return new Map(leads.map((l) => [l.id, l]));
}

/** A lead as the API gives it, from a row the lead actions returned (masked for the key's person). */
function leadOut(row: Row, extra: Awaited<ReturnType<typeof extrasFor>> extends Map<string, infer V> ? V | undefined : never, custom: Record<string, unknown> | undefined) {
  const company = rec(row.company);
  const contact = rec(row.contact);
  const owner = rec(row.owner);
  return {
    id: row.id,
    ref: leadRef(row.leadSeq as number),
    title: row.title,
    description: str(row.description),
    status: row.status,
    stage: extra?.stage ? { id: extra.stage.id, key: extra.stage.key, name: extra.stage.label } : null,
    pipeline: extra?.pipeline ? { id: extra.pipeline.id, key: extra.pipeline.key, name: extra.pipeline.name } : null,
    value: amount(row.estimatedValue),
    expected_close_date: day(row.expectedCloseDate as Date | string | null),
    source: row.source ?? null,
    source_detail: str(row.sourceDetail),
    score: typeof row.score === "number" ? row.score : null,
    lost_reason: str(row.lostReason),
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    contact: contact
      ? { id: contact.id, ref: contactRef(extra?.contact?.contactSeq ?? null), name: contact.name, ...("email" in contact ? { email: contact.email ?? null, phone: contact.phone ?? null } : {}) }
      : null,
    owner: owner ? { id: owner.id, name: owner.name } : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

export async function leadsOut(userId: string, rows: Row[]) {
  const ids = rows.map((r) => r.id);
  const [extras, custom] = await Promise.all([extrasFor(ids), customFieldsOut("LEAD", userId, ids)]);
  return rows.map((r) => leadOut(r, extras.get(r.id), custom.get(r.id)));
}

/** One lead, read again through the screens' own read — or not found. */
export async function readLead(userId: string, id: string) {
  const lead = (await getLead(id)) as Row | null;
  if (!lead) throw notFound("lead");
  return (await leadsOut(userId, [lead]))[0]!;
}

export async function listLeadsApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  if (status && !(STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status is one of ${STATUSES.join(", ")}.`, { status: "Unknown status." });
  const owner = q.get("owner");
  const ownerUserId = owner ? (owner === "unassigned" ? "unassigned" : ((await personId(owner)) ?? "zz-nobody")) : undefined;
  const { rows, total } = await listLeadsPaged({
    page,
    pageSize,
    search: q.get("search")?.slice(0, 100) || undefined,
    status: status as (typeof STATUSES)[number] | undefined,
    stage: q.get("stage")?.slice(0, 60) || undefined,
    pipeline: q.get("pipeline")?.slice(0, 60) || "all",
    ownerUserId,
  });
  return { data: await leadsOut(call.actor.userId, rows as unknown as Row[]), page: pageOf(page, pageSize, total) };
}

export async function getLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  return { data: await readLead(call.actor.userId, id) };
}

export async function createLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const input = leadCreateSchema.parse(await call.body());
  const companyId = await idOf("company", input.company);
  if (!companyId) throw new ApiError(422, "refused", "No company by that reference reaches this key.", { company: "Not found." });
  const contactId = input.contact ? await idOf("contact", input.contact) : null;
  if (input.contact && !contactId) throw new ApiError(422, "refused", "No contact by that reference.", { contact: "Not found." });
  const ownerUserId = input.owner ? await personId(input.owner) : null;
  if (input.owner && !ownerUserId) throw new ApiError(422, "refused", "No active person by that id or email.", { owner: "Not found." });
  const made = await createLead({
    companyId,
    contactId: contactId ?? "",
    title: input.title,
    description: input.description ?? "",
    estimatedValue: input.value,
    expectedCloseDate: input.expected_close_date ?? "",
    ownerUserId: ownerUserId ?? "",
    source: input.source ?? "OTHER",
    sourceDetail: input.source_detail ?? "API",
    customFields: input.custom_fields,
    pipelineId: input.pipeline ?? "",
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readLead(call.actor.userId, made.data.id) };
}

export async function patchLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadPatchSchema.parse(await call.body());
  const current = (await getLead(id)) as Row | null;
  if (!current) throw notFound("lead");
  const contactId = input.contact === undefined ? (str(rec(current.contact)?.id) ?? "") : input.contact === "" ? "" : await idOf("contact", input.contact);
  if (contactId === null) throw new ApiError(422, "refused", "No contact by that reference.", { contact: "Not found." });
  // The screens' edit takes the whole set: what wasn't sent stays as it is.
  const value = input.value !== undefined ? input.value : amount(current.estimatedValue);
  const done = await updateLeadDetails({
    leadId: id,
    title: input.title ?? String(current.title),
    description: input.description ?? str(current.description) ?? "",
    estimatedValue: typeof value === "number" ? value : undefined,
    expectedCloseDate: input.expected_close_date !== undefined ? input.expected_close_date : (day(current.expectedCloseDate as Date | null) ?? ""),
    contactId,
  });
  if (!done.ok) throw refusedBy(done);
  return { data: await readLead(call.actor.userId, id) };
}

export async function moveLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadStageSchema.parse(await call.body());
  let stageId: string | undefined;
  if (input.stage) {
    const lead = await db.lead.findUnique({ where: { id }, select: { pipelineId: true } });
    const stage = await db.leadStage.findFirst({
      where: { archivedAt: null, OR: [{ id: input.stage }, { key: input.stage, pipelineId: lead?.pipelineId ?? "lpip_sales" }] },
      select: { id: true },
    });
    if (!stage) throw new ApiError(422, "refused", "No stage by that id or key in the lead's pipeline.", { stage: "Not found." });
    stageId = stage.id;
  }
  const done = await updateLeadStatus({ leadId: id, ...(stageId ? { stageId } : { status: input.status }), lostReason: input.lost_reason ?? "" });
  if (!done.ok) throw refusedBy(done);
  return { data: await readLead(call.actor.userId, id) };
}

export async function noteLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadNoteSchema.parse(await call.body());
  const done = await logActivity({ leadId: id, type: input.type, notes: input.notes });
  if (!done.ok) throw refusedBy(done);
  return { status: 201, data: { id: done.data.id, lead: (await readLead(call.actor.userId, id)).ref, type: input.type, notes: input.notes } };
}

import { checkInVisit, completeVisit, createVisit, getVisit, listVisitsPaged, setVisitStatus, visitFormOptions } from "@/actions/visit";
import { createExpense, deleteExpense, getExpense, listExpensesPaged, submitExpense } from "@/actions/expense";
import { cancelMeetingAction, listMyEvents, scheduleMeetingAction } from "@/actions/calendar";
import { ApiError, pageOf, paging, type ApiAnswer } from "@/lib/api/handler";
import { companyRef, idOf, iso } from "@/lib/api/refs";
import { needAppModule, readLocation, refused } from "@/lib/app/daily";
import type { AppCall } from "@/lib/app/handler";
import { db } from "@/lib/db";
import { expenseCategoryLabels, expensePaymentModeLabels, expenseStatusLabels, formatExpenseId, MAX_RECEIPT_BYTES } from "@/lib/expenses";
import { receiptRequiredAbove } from "@/lib/expenses/receipts";
import { workspaceClock } from "@/lib/time/workspace";
import { formatVisitId, visitPurposeLabels, visitStatusLabels } from "@/lib/visits";
import { keepVisitPlace, visitPlaces } from "@/lib/visits/locations";

/**
 * The Deskzo app's field work (owner, 22 Oct 2026 — phase 2 of the native app): customer visits checked in and out at
 * the customer's door, with where the phone was then (src/lib/visits/locations.ts); expense claims with a photo of the
 * receipt, by the company's receipt rule (src/lib/expenses/receipts.ts); and the person's meetings. Each through the
 * web's own actions, as the phone's person (src/lib/app/handler.ts) — so who may see and do what is the web's.
 */

type Row = Record<string, unknown> & { id: string };
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const notFound = (what: string) => new ApiError(404, "not_found", `That ${what} isn't there, or isn't one you can open.`);

const shiftDay = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ─── Visits ───────────────────────────────────────────────────────────────────

/** A visit by its id or its ref (VIS-000123). */
async function visitIdOf(ref: string | undefined): Promise<string | null> {
  if (!ref) return null;
  const seq = /^VIS-0*(\d{1,9})$/i.exec(ref.trim());
  if (seq) return (await db.visit.findUnique({ where: { visitSeq: Number(seq[1]) }, select: { id: true } }))?.id ?? null;
  return ref;
}

function visitOut(v: Row) {
  const company = rec(v.company);
  const contact = rec(v.contact);
  const lead = rec(v.lead);
  const user = rec(v.user);
  const status = String(v.status);
  const purpose = String(v.purpose);
  return {
    id: v.id,
    ref: formatVisitId(v.visitSeq as number),
    status,
    status_label: visitStatusLabels[status as keyof typeof visitStatusLabels] ?? status,
    purpose,
    purpose_label: visitPurposeLabels[purpose as keyof typeof visitPurposeLabels] ?? purpose,
    agenda: str(v.agenda),
    scheduled_for: iso(v.scheduledFor as Date | string),
    check_in_at: iso(v.checkInAt as Date | string | null),
    check_out_at: iso(v.checkOutAt as Date | string | null),
    outcome: str(v.outcome),
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    contact: contact ? { id: contact.id, name: contact.name, ...("phone" in contact ? { phone: contact.phone ?? null, email: contact.email ?? null } : {}) } : null,
    lead: lead ? { id: lead.id, title: lead.title } : null,
    by: user ? { id: user.id, name: user.name } : null,
  };
}

/** GET `?view=today|upcoming|past&page=`: the person's own visits — today's in order, the next thirty days', or what's done. */
export async function appVisits(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const view = call.url.searchParams.get("view") ?? "today";
  const today = (await workspaceClock()).today();
  const window = view === "upcoming" ? { from: shiftDay(today, 1), to: shiftDay(today, 30) } : view === "past" ? { to: shiftDay(today, -1) } : { from: today, to: today };
  const { page, pageSize } = paging(call.url, 50, view === "past" ? 25 : 50);
  const { rows, total } = await listVisitsPaged({ page, pageSize, userId: call.actor.userId, ...window });
  const out = (rows as unknown as Row[]).map(visitOut);
  // The list comes newest first; today's and what's coming read in the order they happen.
  if (view !== "past") out.reverse();
  return { data: out, page: pageOf(page, pageSize, total) };
}

/** One visit: who to see and where, its check-in and check-out places, and the claims made against it. */
export async function appVisit(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const id = await visitIdOf(call.params.id);
  const visit = id ? ((await getVisit(id)) as Row | null) : null;
  if (!visit) throw notFound("visit");
  const place = rec(visit.location);
  const expenses = Array.isArray(visit.expenses) ? (visit.expenses as Row[]) : [];
  return {
    data: {
      ...visitOut(visit),
      address: str(visit.address) ?? (place ? [place.address, place.city, place.state, place.pincode].filter(Boolean).join(", ") || null : null),
      distance_km: num(visit.distanceKm),
      places: (await visitPlaces(visit.id)).map((p) => ({ kind: p.kind, at: p.at, latitude: p.latitude, longitude: p.longitude, accuracy_m: p.accuracyM, mocked: p.mocked })),
      expenses: expenses.map((e) => ({ id: e.id, ref: formatExpenseId(e.expenseSeq as number), category: e.category, amount: num(e.amount), status: e.status })),
    },
  };
}

/** What a new visit offers: the purposes, and — for a company — its people and open leads. */
export async function appVisitOptions(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const ref = call.url.searchParams.get("company");
  const companyId = ref ? await idOf("company", ref) : null;
  const options = companyId ? await visitFormOptions(companyId) : { contacts: [], leads: [] };
  return {
    data: {
      purposes: Object.entries(visitPurposeLabels).map(([value, label]) => ({ value, label })),
      contacts: (options.contacts as Row[]).map((c) => ({ id: c.id, name: c.name })),
      leads: (options.leads as Row[]).map((l) => ({ id: l.id, title: l.title })),
    },
  };
}

/** POST `{ company, contact?, lead?, purpose?, scheduled_for, agenda? }`: a visit planned, by the web's own rules. */
export async function appPlanVisit(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const input = await call.body();
  const companyId = typeof input.company === "string" ? await idOf("company", input.company) : null;
  if (!companyId) throw new ApiError(422, "refused", "Choose a company you can see.", { company: "Not found." });
  const made = await createVisit({
    companyId,
    contactId: str(input.contact) ?? "",
    leadId: str(input.lead) ?? "",
    purpose: str(input.purpose) ?? undefined,
    agenda: str(input.agenda) ?? "",
    scheduledFor: str(input.scheduled_for) ?? "",
  });
  if (!made.ok) refused(made);
  return { status: 201, data: { id: made.data.id, ref: formatVisitId(made.data.visitSeq) } };
}

/** POST `{ latitude?, longitude?, accuracy?, mocked? }`: arrived — the time, and where the phone was if it shared it. */
export async function appCheckIn(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const id = await visitIdOf(call.params.id);
  if (!id) throw notFound("visit");
  const body = await call.body();
  const done = await checkInVisit(id);
  if (!done.ok) refused(done);
  const place = readLocation(body);
  const kept = await keepVisitPlace(id, "IN", place ? { ...place, mocked: body.mocked === true ? true : body.mocked === false ? false : null } : null, call.device.id);
  return { data: { id, place_kept: kept } };
}

/** POST `{ outcome, distance_km?, latitude?, … }`: left, and what came of it — written up as on the web. */
export async function appCompleteVisit(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const id = await visitIdOf(call.params.id);
  if (!id) throw notFound("visit");
  const body = await call.body();
  const done = await completeVisit({ id, outcome: str(body.outcome) ?? "", distanceKm: body.distance_km ?? undefined });
  if (!done.ok) refused(done);
  const place = readLocation(body);
  const kept = await keepVisitPlace(id, "OUT", place ? { ...place, mocked: body.mocked === true ? true : body.mocked === false ? false : null } : null, call.device.id);
  return { data: { id, place_kept: kept } };
}

/** POST `{ status: CANCELLED|NO_SHOW, note }`: a visit that didn't happen, and why. */
export async function appVisitStatus(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("visits", call.actor.userId);
  const id = await visitIdOf(call.params.id);
  if (!id) throw notFound("visit");
  const body = await call.body();
  const status = str(body.status);
  if (status !== "CANCELLED" && status !== "NO_SHOW") throw new ApiError(400, "invalid_request", "A visit is cancelled or a no-show here.", { status: "Unknown." });
  const done = await setVisitStatus({ id, status, note: str(body.note) ?? "" });
  if (!done.ok) refused(done);
  return { data: { id } };
}

// ─── Expense claims ───────────────────────────────────────────────────────────

function expenseOut(e: Row) {
  const visit = rec(e.visit);
  const company = rec(e.company);
  const category = String(e.category);
  const status = String(e.status);
  const mode = String(e.paymentMode);
  return {
    id: e.id,
    ref: formatExpenseId(e.expenseSeq as number),
    category,
    category_label: expenseCategoryLabels[category as keyof typeof expenseCategoryLabels] ?? category,
    amount: num(e.amount),
    spent_on: iso(e.spentOn as Date | string)?.slice(0, 10) ?? null,
    description: str(e.description) ?? "",
    payment_mode: mode,
    payment_mode_label: expensePaymentModeLabels[mode as keyof typeof expensePaymentModeLabels] ?? mode,
    status,
    status_label: expenseStatusLabels[status as keyof typeof expenseStatusLabels] ?? status,
    decision_note: str(e.decisionNote),
    has_receipt: !!e.receiptName || e.hasReceipt === true,
    visit: visit ? { id: visit.id, ref: typeof visit.visitSeq === "number" ? formatVisitId(visit.visitSeq) : null } : null,
    company: company ? { id: company.id, name: company.name } : null,
  };
}

/** GET `?status=&page=`: the person's own claims, newest first. */
export async function appExpenses(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  const { page, pageSize } = paging(call.url, 50, 25);
  const status = call.url.searchParams.get("status")?.toUpperCase();
  const { rows, total } = await listExpensesPaged({ page, pageSize, userId: call.actor.userId, ...(status ? { status: status as never } : {}) });
  return { data: (rows as unknown as Row[]).map(expenseOut), page: pageOf(page, pageSize, total) };
}

/** One claim — the person's, or one they may see. */
export async function appExpense(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  const expense = (await getExpense(call.params.id ?? "")) as Row | null;
  if (!expense) throw notFound("claim");
  return { data: expenseOut({ ...expense, hasReceipt: !!expense.receiptDataUrl }) };
}

/** What a claim offers: the categories, how it was paid, and over what amount a receipt is needed. */
export async function appExpenseOptions(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  return {
    data: {
      categories: Object.entries(expenseCategoryLabels).map(([value, label]) => ({ value, label })),
      payment_modes: Object.entries(expensePaymentModeLabels).map(([value, label]) => ({ value, label })),
      receipt_required_above: await receiptRequiredAbove(),
      receipt_max_bytes: MAX_RECEIPT_BYTES,
    },
  };
}

/** A form's fields and its receipt, or a JSON body without one. A receipt is bigger than a JSON body may be. */
async function claimInput(call: AppCall): Promise<{ input: Record<string, unknown>; receipt: string | null }> {
  if (!/multipart\/form-data/i.test(call.req.headers.get("content-type") ?? "")) return { input: await call.body(), receipt: null };
  // Before reading it: a receipt is at most 512 KB, and the rest of a claim a few lines.
  if (Number(call.req.headers.get("content-length") ?? 0) > MAX_RECEIPT_BYTES + 64 * 1024) throw new ApiError(413, "too_large", "That receipt is too big — the app makes it smaller; try again.");
  let form: FormData;
  try {
    form = await call.req.formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Send the claim as a form.");
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") input[key] = value;
  const file = form.get("receipt");
  if (!file || typeof file === "string" || file.size === 0) return { input, receipt: null };
  // The web's own check reads the type and the size again (createExpense's validateReceipt).
  return { input, receipt: `data:${file.type || "image/jpeg"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}` };
}

/**
 * POST a form: `category, amount, spent_on, description, payment_mode?, visit?, submit?` and the `receipt` photo —
 * a claim, saved or submitted. The web's own createExpense, with its receipt rule, its receipt checks and its approval
 * routing.
 */
export async function appCreateExpense(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  const { input, receipt } = await claimInput(call);
  const visitId = typeof input.visit === "string" && input.visit ? await visitIdOf(input.visit) : null;
  const made = await createExpense({
    category: str(input.category) ?? undefined,
    amount: input.amount,
    spentOn: str(input.spent_on) ?? "",
    description: str(input.description) ?? "",
    paymentMode: str(input.payment_mode) ?? undefined,
    reimbursable: input.reimbursable === false || input.reimbursable === "false" ? false : true,
    visitId: visitId ?? "",
    receiptDataUrl: receipt ?? "",
    receiptName: receipt ? "receipt.jpg" : "",
    submit: input.submit === true || input.submit === "true",
  });
  if (!made.ok) refused(made);
  return { status: 201, data: { id: made.data.id, ref: formatExpenseId(made.data.expenseSeq) } };
}

/** POST: a saved claim, submitted for approval (the receipt rule applies here). */
export async function appSubmitExpense(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  const done = await submitExpense(call.params.id ?? "");
  if (!done.ok) refused(done);
  return { data: { id: done.data.id } };
}

/** DELETE: a claim not yet decided, taken back — the web's own rule for which may be. */
export async function appDeleteExpense(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("expenses", call.actor.userId);
  const done = await deleteExpense(call.params.id ?? "");
  if (!done.ok) refused(done);
  return { data: { id: done.data.id } };
}

// ─── Meetings ─────────────────────────────────────────────────────────────────

/** GET `?from=&to=` (days, the workspace's; today and the next week when left out): the person's calendar. */
export async function appMeetings(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("calendar", call.actor.userId);
  const today = (await workspaceClock()).today();
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(call.url.searchParams.get("from")) ?? today;
  const to = day(call.url.searchParams.get("to")) ?? shiftDay(from, 7);
  const items = await listMyEvents({ from, to });
  return {
    data: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      starts_at: i.startsAt,
      ends_at: i.endsAt,
      all_day: i.allDay,
      status: i.status,
      location: i.location,
      join_url: i.joinUrl,
      organizer: i.isOrganizer,
    })),
  };
}

/**
 * POST `{ record: { kind: lead|company|contact|visit, id }, title, starts_at ("yyyy-mm-ddThh:mm", the workspace's time),
 * duration_minutes, online?, location?, agenda?, contact_ids? }`: a meeting scheduled from a record, the web's own way.
 */
export async function appScheduleMeeting(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("calendar", call.actor.userId);
  const i = await call.body();
  const done = await scheduleMeetingAction({
    record: i.record ?? null,
    title: i.title,
    startsAt: i.starts_at,
    durationMinutes: i.duration_minutes,
    online: i.online === true,
    location: i.location ?? "",
    agenda: i.agenda ?? "",
    contactIds: Array.isArray(i.contact_ids) ? i.contact_ids : [],
  });
  if (!done.ok) refused(done);
  return { status: 201, data: { id: done.data.eventId } };
}

/** POST `{ note? }`: one of the person's meetings, cancelled — those invited are told, as from the web. */
export async function appCancelMeeting(call: AppCall): Promise<ApiAnswer> {
  await needAppModule("calendar", call.actor.userId);
  const body = await call.body();
  const done = await cancelMeetingAction({ eventId: call.params.id ?? "", note: str(body.note) });
  if (!done.ok) refused(done);
  return { data: { id: call.params.id, warning: done.data.warning } };
}

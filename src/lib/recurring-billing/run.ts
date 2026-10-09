import { Prisma, type BillingCycle, type CompanyRelationshipType, type PaymentTerms, type RecurringBillingMode } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";
import { workspaceClock } from "@/lib/time/workspace";
import { recordAudit } from "@/lib/audit";
import { wants } from "@/lib/notifications/catalogue";
import { peopleHolding } from "@/lib/orders/handoff";
import { resellerOrderRefusal } from "@/lib/orders/reseller-gate";
import { partyDetails } from "@/lib/proposals/party";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { renewalOrderDraft } from "@/lib/subscriptions/renewal-order";
import { formatOrderId } from "@/lib/order-id";
import { tradeDocumentSchema } from "@/lib/validation/trade-document";
import { createDraftDocument } from "@/lib/documents/create-draft";
import { instalmentAmounts, instalmentPeriods, instalmentsDue, isoDay, renewalDue, type InstalmentCycle } from "@/lib/recurring-billing/periods";

/**
 * Recurring billing's daily job (owner, 9 Oct 2026) — called from the five-minute heartbeat
 * (src/lib/marketing/heartbeat.ts), which runs it once per workspace per day of its own.
 *
 * For every order switched on (`RecurringBilling`):
 *
 *   · **Instalments** — each part of the term that has begun, and began after the switch went on,
 *     is raised as a draft invoice: the order's price split evenly across the parts, to the paisa.
 *   · **Auto-renew** — on the first day of the next term, the renewal order is punched (for approval,
 *     like any renewal) and its invoice raised as a draft. The renewal carries the switch on, so the
 *     term after that renews itself too.
 *
 * **Nothing is issued.** An issued invoice takes a legal number and, in India, an IRN; somebody looks
 * at each draft first. One notice a day tells everybody who issues documents how many are waiting,
 * and links to them — the invoice list issues them in one go.
 *
 * **Once per period, for ever.** A `RecurringBillingPeriod` row is claimed before the draft is made
 * (its unique key is the order and the period's first day), so two runs can't both raise one; a draft
 * that fails to be made gives its claim back and is tried again tomorrow. A draft somebody deletes
 * leaves its period claimed — deleting it is how a period is skipped.
 *
 * Drafts are written as the Automation account, with the order's salesperson as theirs.
 */

export const RECURRING_BILLING_JOB = "recurring-billing";

/** Orders that still bill: the ones approved and going, not those waiting, refused or cancelled. */
const LIVE = ["APPROVED", "PROCESSING", "FULFILLED"] as const;

export type RecurringBillingReport = {
  ran: boolean;
  reason?: string;
  day: string;
  /** Draft invoices raised, and the renewal orders punched with them. */
  drafts: number;
  renewals: number;
  /** Orders looked at and passed over, each with why (no price, no site…). */
  passed: string[];
  errors: string[];
  notified: number;
};

/**
 * What the job reads of an order, written out by hand. Inferring it from a nested include (a
 * `GetPayload` over `satisfies`) cost the type checker more than the default heap — enough to fail
 * the deploy's `tsc` with no type error anywhere.
 */
type Money = Prisma.Decimal | null;
type Billing = {
  companyProductId: string;
  mode: RecurringBillingMode;
  cycle: BillingCycle | null;
  billFrom: Date | null;
  setById: string;
  order: {
    id: string;
    orderSeq: number;
    companyId: string;
    locationId: string;
    itemId: string;
    vendorId: string | null;
    endCustomerId: string | null;
    paymentTerms: PaymentTerms | null;
    quantity: number;
    unitPrice: Money;
    fullTermUnitPrice: Money;
    startDate: Date | null;
    endDate: Date | null;
    addedByUserId: string;
    company: { id: string; name: string; relationshipType: CompanyRelationshipType; ownerUserId: string | null };
    item: { id: string; name: string; unit: string | null; hsnCode: string | null; taxRatePercent: Money; billingCycle: BillingCycle | null };
    location: Parameters<typeof partyDetails>[0];
    renewedBy: { id: string } | null;
    addons: { id: string; quantity: number; unitPrice: Money; fullTermUnitPrice: Money; startDate: Date | null }[];
  };
};

async function loadBillings(only?: string[]): Promise<Billing[]> {
  const rows: unknown = await db.recurringBilling.findMany({
    where: { ...(only ? { companyProductId: { in: only } } : {}), order: { orderStatus: { in: [...LIVE] } } },
    select: {
      companyProductId: true,
      mode: true,
      cycle: true,
      billFrom: true,
      setById: true,
      order: {
        select: {
          id: true, orderSeq: true, companyId: true, locationId: true, itemId: true, vendorId: true, endCustomerId: true,
          paymentTerms: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true, endDate: true, addedByUserId: true,
          company: { select: { id: true, name: true, relationshipType: true, ownerUserId: true } },
          item: { select: { id: true, name: true, unit: true, hsnCode: true, taxRatePercent: true, billingCycle: true } },
          location: { select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true } },
          renewedBy: { select: { id: true } },
          addons: {
            where: { orderStatus: { not: "CANCELLED" } },
            select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
          },
        },
      },
    },
  });
  return rows as Billing[];
}

/**
 * Runs the day's billing. The options are for the check suite: `today` a day to run as, `only` the
 * orders to look at — so it drives its own fixture without touching anybody else's subscriptions —
 * `claim: false` to skip the once-a-day claim, and `notify: false` to tell nobody.
 */
export async function runRecurringBilling(opts: { today?: Date; only?: string[]; claim?: boolean; notify?: boolean } = {}): Promise<RecurringBillingReport> {
  const clock = await workspaceClock();
  const today = opts.today ?? clock.calendarDate(new Date());
  const report: RecurringBillingReport = { ran: false, day: isoDay(today), drafts: 0, renewals: 0, passed: [], errors: [], notified: 0 };

  if (!(await moduleAvailableForTenant("orders")) || !(await moduleAvailableForTenant("sales_documents"))) {
    return { ...report, reason: "orders or sales documents are not on" };
  }
  if (opts.claim !== false) {
    try {
      await db.dailyJobRun.create({ data: { job: RECURRING_BILLING_JOB, day: today } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ...report, reason: "another run claimed today" };
      throw err;
    }
  }
  report.ran = true;

  const actorId = await automationUserId();
  const billings = await loadBillings(opts.only);

  for (const billing of billings) {
    try {
      if (billing.mode === "INSTALMENTS") await raiseInstalments(billing, today, actorId, report);
      else await renew(billing, today, actorId, report);
    } catch (err) {
      report.errors.push(`${formatOrderId(billing.order.orderSeq)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (report.drafts > 0 && opts.notify !== false) report.notified = await tellIssuers(report, today);
  return report;
}

// ─── Instalments ─────────────────────────────────────────────────────────────────────────────────

async function raiseInstalments(billing: Billing, today: Date, actorId: string, report: RecurringBillingReport) {
  const order = billing.order;
  const label = formatOrderId(order.orderSeq);
  const cycle = billing.cycle;
  if (cycle !== "MONTHLY" && cycle !== "QUARTERLY") return void report.passed.push(`${label}: instalments need a monthly or quarterly cycle`);
  if (!order.startDate || !order.endDate) return void report.passed.push(`${label}: no term dates`);
  const price = order.unitPrice === null ? null : Number(order.unitPrice);
  if (price === null || price <= 0) return void report.passed.push(`${label}: no price`);

  const periods = instalmentPeriods(order.startDate, order.endDate, cycle as InstalmentCycle);
  const due = instalmentsDue(periods, today, billing.billFrom);
  if (due.length === 0) return;
  const shares = instalmentAmounts(price, periods.length);
  const raised = new Set(
    (await db.recurringBillingPeriod.findMany({ where: { companyProductId: order.id }, select: { periodStart: true } })).map((r) => isoDay(r.periodStart)),
  );

  for (const part of due) {
    if (raised.has(isoDay(part.start))) continue;
    const description = `Instalment ${part.index + 1} of ${part.count} — ${isoDay(part.start)} to ${isoDay(part.end)}`;
    const made = await claimAndRaise(order.id, part, actorId, () =>
      draftFor(billing, actorId, {
        unitPrice: shares[part.index]!,
        quantity: order.quantity,
        companyProductId: order.id,
        description,
        from: part.start,
        to: part.end,
        notes: `${label}, ${description.toLowerCase()}. Raised by recurring billing — check it, then issue it.`,
      }),
    );
    if (made.ok) report.drafts += 1;
    else report.errors.push(`${label} ${isoDay(part.start)}: ${made.error}`);
  }
}

// ─── Auto-renew ──────────────────────────────────────────────────────────────────────────────────

async function renew(billing: Billing, today: Date, actorId: string, report: RecurringBillingReport) {
  const order = billing.order;
  const label = formatOrderId(order.orderSeq);
  if (!order.endDate) return void report.passed.push(`${label}: no expiry date, so no next term`);
  if (!renewalDue(order.endDate, today)) return;
  // Renewed by hand already — or by an earlier run that punched the order and failed the draft.
  if (order.renewedBy) return;
  if (!order.locationId) return void report.passed.push(`${label}: no site to renew to`);
  const refusal = await resellerOrderRefusal(order.company);
  if (refusal) return void report.passed.push(`${label}: ${refusal}`);

  const group = renewalGroup([
    {
      id: order.id,
      quantity: order.quantity,
      unitPrice: order.unitPrice === null ? null : Number(order.unitPrice),
      fullTermUnitPrice: order.fullTermUnitPrice === null ? null : Number(order.fullTermUnitPrice),
      startDate: order.startDate,
      isAddon: false,
    },
    ...order.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice === null ? null : Number(a.unitPrice),
      fullTermUnitPrice: a.fullTermUnitPrice === null ? null : Number(a.fullTermUnitPrice),
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);
  const draft = renewalOrderDraft({
    quantity: order.quantity,
    unitPrice: order.unitPrice === null ? null : Number(order.unitPrice),
    fullTermUnitPrice: order.fullTermUnitPrice === null ? null : Number(order.fullTermUnitPrice),
    endDate: order.endDate,
    billingCycle: order.item.billingCycle,
    group,
  });
  if (!draft.term) return void report.passed.push(`${label}: no next term`);
  if (!draft.unitPrice || draft.unitPrice <= 0) return void report.passed.push(`${label}: no full-term price to renew at`);
  const term = { start: new Date(`${draft.term.startDate}T00:00:00.000Z`), end: new Date(`${draft.term.endDate}T00:00:00.000Z`) };

  // The claim first, so a second run can't punch a second renewal.
  const claim = await claimPeriod(order.id, term);
  if (!claim) return;
  try {
    const renewal = await db.$transaction(async (tx) => {
      const created = await tx.companyProduct.create({
        data: {
          companyId: order.companyId,
          locationId: order.locationId!,
          itemId: order.itemId,
          vendorId: order.vendorId,
          endCustomerId: order.endCustomerId,
          paymentTerms: order.paymentTerms,
          renewedFromId: order.id,
          businessType: "RENEWAL",
          quantity: draft.quantity,
          unitPrice: new Prisma.Decimal(draft.unitPrice!),
          fullTermUnitPrice: new Prisma.Decimal(draft.unitPrice!),
          startDate: term.start,
          endDate: term.end,
          notes: [`Renewal of ${label}, punched by recurring billing.`, ...draft.warnings].join(" "),
          orderStatus: "PENDING_APPROVAL",
          // The salesperson's, as if they had punched it: who "own" means for an order.
          addedByUserId: order.addedByUserId,
        },
        select: { id: true, orderSeq: true },
      });
      // The switch travels with the subscription.
      await tx.recurringBilling.create({ data: { companyProductId: created.id, mode: "AUTO_RENEW" satisfies RecurringBillingMode, setById: billing.setById } });
      await tx.recurringBillingPeriod.update({ where: { id: claim.id }, data: { renewalOrderId: created.id } });
      return created;
    });
    report.renewals += 1;
    await recordAudit({
      userId: actorId,
      action: "CREATE",
      entityType: "Order",
      entityId: renewal.id,
      entityLabel: `${formatOrderId(renewal.orderSeq)} — renewal of ${label}, punched by recurring billing`,
    });

    const made = await draftFor(billing, actorId, {
      unitPrice: draft.unitPrice,
      quantity: draft.quantity,
      companyProductId: renewal.id,
      description: `Renewal — ${draft.term.startDate} to ${draft.term.endDate}`,
      from: term.start,
      to: term.end,
      notes: `${formatOrderId(renewal.orderSeq)}, renewing ${label}. Raised by recurring billing — the order is waiting for approval; check this, then issue it.`,
    });
    if (made.ok) {
      await db.recurringBillingPeriod.update({ where: { id: claim.id }, data: { documentId: made.data.id } });
      report.drafts += 1;
    } else {
      // The renewal order stands — it is real, and it is waiting for approval — but its invoice is
      // for somebody to raise: the claim stays, so tomorrow's run doesn't punch the order again.
      report.errors.push(`${label}: renewed as ${formatOrderId(renewal.orderSeq)}, but its draft invoice wasn't raised — ${made.error}`);
    }
  } catch (err) {
    await db.recurringBillingPeriod.delete({ where: { id: claim.id } }).catch(() => {});
    throw err;
  }
}

// ─── Shared ──────────────────────────────────────────────────────────────────────────────────────

/** The period's row, or null when another run has it already. */
async function claimPeriod(companyProductId: string, period: { start: Date; end: Date }) {
  try {
    return await db.recurringBillingPeriod.create({
      data: { companyProductId, periodStart: period.start, periodEnd: period.end },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** Claims the period, raises its draft, and gives the claim back if the draft couldn't be made. */
async function claimAndRaise(
  companyProductId: string,
  period: { start: Date; end: Date },
  actorId: string,
  raise: () => Promise<{ ok: true; data: { id: string } } | { ok: false; error: string }>,
): Promise<{ ok: true; data: { id: string } } | { ok: false; error: string }> {
  const claim = await claimPeriod(companyProductId, period);
  if (!claim) return { ok: false, error: "another run has it" };
  try {
    const made = await raise();
    if (made.ok) await db.recurringBillingPeriod.update({ where: { id: claim.id }, data: { documentId: made.data.id } });
    else await db.recurringBillingPeriod.delete({ where: { id: claim.id } });
    return made;
  } catch (err) {
    await db.recurringBillingPeriod.delete({ where: { id: claim.id } }).catch(() => {});
    throw err;
  }
}

/** A draft tax invoice for one line of the order — its site's address, place of supply and GST. */
async function draftFor(
  billing: Billing,
  actorId: string,
  line: { unitPrice: number; quantity: number; companyProductId: string; description: string; from: Date; to: Date; notes: string },
) {
  const order = billing.order;
  const party = partyDetails(order.location, order.company.name);
  if (!party.ok) return party;
  const parsed = tradeDocumentSchema.safeParse({
    docType: "INVOICE",
    companyId: order.company.id,
    locationId: party.data.locationId,
    docNumber: "",
    placeOfSupplyCode: party.data.placeOfSupplyCode,
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    issueDate: (await workspaceClock()).today(),
    dueDate: "",
    validUntil: "",
    reference: formatOrderId(order.orderSeq),
    salespersonId: order.addedByUserId,
    notes: line.notes,
    terms: "",
    dispatchFromAddress: "",
    billing: party.data.address,
    shippingSameAsBilling: true,
    shipping: party.data.address,
    shippingGstin: "",
    shippingCharge: 0,
    shippingTaxRatePercent: 0,
    withholdingMode: "NONE",
    withholdingSection: "",
    withholdingRatePercent: 0,
    adjustmentLabel: "",
    adjustment: 0,
    sourceDocumentId: "",
    leadId: "",
    againstDocumentId: "",
    lines: [
      {
        itemId: order.item.id,
        companyProductId: line.companyProductId,
        name: order.item.name,
        description: line.description,
        servicePeriodFrom: isoDay(line.from),
        servicePeriodTo: isoDay(line.to),
        hsnCode: order.item.hsnCode ?? "",
        unit: order.item.unit ?? "",
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountMode: "PERCENT",
        discountValue: 0,
        taxRatePercent: Number(order.item.taxRatePercent ?? 0),
      },
    ],
  });
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "the invoice didn't validate" };
  return createDraftDocument({ id: actorId, branchFor: order.addedByUserId }, parsed.data, "RECURRING_BILLING");
}

/** One notice a day to whoever issues documents: how many drafts are waiting, and where. */
async function tellIssuers(report: RecurringBillingReport, today: Date): Promise<number> {
  const type = "RECURRING_DRAFTS_RAISED" as const;
  let told = 0;
  for (const userId of await peopleHolding("documents.issue")) {
    const preference = await db.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
      select: { inApp: true, email: true },
    });
    if (!wants(type, "inApp", preference)) continue;
    const { count } = await db.notification.createMany({
      data: [
        {
          userId,
          type,
          title: `${report.drafts} draft invoice${report.drafts === 1 ? "" : "s"} from recurring billing`,
          message: `${report.renewals > 0 ? `${report.renewals} subscription${report.renewals === 1 ? "" : "s"} renewed and ` : ""}instalments due today are waiting as drafts — check them, then issue them.`,
          link: "/sales/invoices?status=DRAFT&origin=RECURRING_BILLING",
          dedupeKey: `${RECURRING_BILLING_JOB}:${isoDay(today)}`,
        },
      ],
      skipDuplicates: true,
    });
    told += count;
  }
  return told;
}

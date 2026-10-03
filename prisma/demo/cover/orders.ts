import {
  Prisma,
  type AssetKind,
  type AssetMovementType,
  type AssetOwnership,
  type BillingCycle,
  type ConsignmentReason,
  type DealRegStatus,
  type ItemType,
  type OrderBusinessType,
  type OrderStatus,
  type PaymentTerms,
  type PrismaClient,
  type RenewalStage,
  type RevenuePattern,
  type StatementBilling,
} from "@prisma/client";
import type { DemoContext } from "../context";
import type { SeededCompany } from "../companies";
import { DEMO_SKU, DEMO_TAG, chance, daysAgo, daysAhead, duringWorkHours, int, log, personName, pick, rnd, some } from "../shared";
import { indiaClock } from "../../../src/lib/time/zone";
import { formatOrderId } from "../../../src/lib/order-id";
import { financialYearOf } from "../../../src/lib/gst-engine";
import { needsSalesApproval, priceCeiling, savingAmount } from "../../../src/lib/orders/handoff-rules";
import { matchingProgrammes, needsLossApproval, unitCostOf, type CostSource, type DealRegStatusKey } from "../../../src/lib/rebates/rules";
import { ORDER_REBATE_SELECT, rebateSummary } from "../../../src/lib/rebates/server";
import { postVendorCreditToLedger, reverseVendorCreditPosting } from "../../../src/lib/ledger/journal";
import { settleInvoice, settledStatus } from "../../../src/lib/receivables";
import { reconcile, type Billing, type SoldOrder, type StatementRow } from "../../../src/lib/reconcile/match";
import { applyMapping, guessMapping, type ColumnMapping } from "../../../src/lib/reconcile/mapping";
import { parseManualRows, type ManualRow } from "../../../src/lib/reconcile/manual";
import { canMove, checkOwnership, statusAfter } from "../../../src/lib/assets/lifecycle";
import { checkStep, stepKeyFromLabel, stepOfOrder, type OrderStepDef } from "../../../src/lib/pipeline/order-steps";
import type { StageColor } from "../../../src/lib/pipeline/rules";
import { renewalOrderDraft } from "../../../src/lib/subscriptions/renewal-order";
import { proRata, renewalGroup } from "../../../src/lib/subscriptions/proration";

/**
 * Orders, purchase, rebates, stock and IT assets — every state the order book can be in.
 *
 * The main demo punches a year of orders that all went straight through: approved, bought, delivered.
 * A real order book is mostly that, and the screens built for the rest of it are the ones a demo has to
 * show: the queue accounts has to approve, the order sales is holding until the advance clears, the
 * negative call waiting for a manager, the price purchase wants sales to accept, the cancelled order
 * whose vendor PO is still open, the renewal somebody pinned as lost. Each of those is made here by
 * walking an order through the same steps the actions in src/actions/order.ts take, in order, with the
 * fields each step writes — so the order page, the hand-off flags, the purchase-savings report and the
 * renewals list read them as they would read the app's own.
 *
 * Alongside: the workspace's order steps (Settings → Pipeline → Orders) with orders moved through them,
 * the backend-rebates add-on (programmes, rebates, vendor credits posted through the ledger's own
 * posting code), distributor statements reconciled by the app's own engine, a few more catalogue items
 * so every item type and billing cycle exists, two resellers that stopped trading, stock counts, and an
 * IT estate whose every asset got where it is by a sequence of movements the lifecycle rules allow.
 *
 * Re-runnable: each scenario order carries its own customer PO number (`4500700…`), each asset its own
 * tag (`DMO-A…`), each statement, programme and credit its own name or reference — anything already
 * there is left alone.
 */

const DAY = 86_400_000;
const clock = indiaClock;
/** The workspace's calendar day an instant falls on, as a `@db.Date` holds it. */
const calDay = (d: Date) => clock.calendarDate(d);
/** A `@db.Date` value as `yyyy-mm-dd`. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
/** The customer's PO number on each scenario order — what makes a second run skip it. */
const PO = (n: number) => `45007${String(n).padStart(5, "0")}`;
/** Not one of this file's scenario orders — written so an order with no PO number still counts. */
const NOT_SCENARIO: Prisma.CompanyProductWhereInput = { OR: [{ poNumber: null }, { NOT: { poNumber: { startsWith: "45007" } } }] };

type Person = { id: string; name: string };
type ItemRow = {
  id: string;
  sku: string;
  name: string;
  type: ItemType;
  price: number;
  cost: number;
  brandId: string | null;
  brand: string;
  billingCycle: BillingCycle | null;
};

/** Some moment after `prev`, in working hours, never in the future and never before `prev`. */
function later(prev: Date, minDays: number, maxDays: number): Date {
  let t = duringWorkHours(new Date(prev.getTime() + int(minDays, maxDays) * DAY));
  if (t.getTime() <= prev.getTime()) t = new Date(prev.getTime() + int(40, 200) * 60_000);
  const ceiling = Date.now() - 15 * 60_000;
  if (t.getTime() > ceiling) t = new Date(Math.max(prev.getTime() + 60_000, ceiling));
  return t;
}

/** A working-hours moment `n` days back. */
const back = (n: number) => duringWorkHours(daysAgo(n));

// ─── The catalogue additions ────────────────────────────────────────────────────────────────────

type NewItem = {
  sku: string;
  name: string;
  type: ItemType;
  billingCycle: BillingCycle;
  revenuePattern: RevenuePattern;
  price: number;
  cost: number;
  hsn: string;
  brand: string;
  description: string;
  /** Goods only: what came in first, and what happened to the stock since (see `seedStock`). */
  openingStock?: number;
  reorderLevel?: number;
};

/**
 * What the catalogue was missing for every type, cycle and revenue pattern to exist: perpetual
 * licences (owned outright, never on the renewals list), subscriptions billed monthly and quarterly,
 * a support contract earned over its year, and the kit the IT estate below is made of.
 */
const NEW_ITEMS: NewItem[] = [
  { sku: `${DEMO_SKU}101`, name: "Microsoft Office LTSC Standard 2024 (perpetual)", type: "PERPETUAL", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 38500, cost: 34800, hsn: "997331", brand: "Microsoft", description: "Volume licence, owned outright — no expiry, no renewal." },
  { sku: `${DEMO_SKU}102`, name: "Windows Server 2025 Standard — 16 core (perpetual)", type: "PERPETUAL", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 92000, cost: 84500, hsn: "997331", brand: "Microsoft", description: "Core-based perpetual licence. CALs sold separately." },
  { sku: `${DEMO_SKU}103`, name: "Microsoft 365 Business Premium (Monthly)", type: "SUBSCRIPTION", billingCycle: "MONTHLY", revenuePattern: "RATABLE", price: 740, cost: 698, hsn: "997331", brand: "Microsoft", description: "Month-to-month commitment, billed monthly." },
  { sku: `${DEMO_SKU}104`, name: "Microsoft Teams Rooms Pro (Monthly)", type: "SUBSCRIPTION", billingCycle: "MONTHLY", revenuePattern: "RATABLE", price: 3400, cost: 3190, hsn: "997331", brand: "Microsoft", description: "Per meeting room, billed monthly." },
  { sku: `${DEMO_SKU}105`, name: "Managed SOC Monitoring (Quarterly)", type: "SUBSCRIPTION", billingCycle: "QUARTERLY", revenuePattern: "RATABLE", price: 45000, cost: 26000, hsn: "998313", brand: "Acme", description: "24×7 monitoring of the customer's firewall and endpoints, billed each quarter." },
  { sku: `${DEMO_SKU}106`, name: "Premium Support Contract (Annual)", type: "SERVICE", billingCycle: "ANNUAL", revenuePattern: "RATABLE", price: 60000, cost: 24000, hsn: "998713", brand: "Acme", description: "Four-hour response, earned evenly over the contract year." },
  { sku: `${DEMO_SKU}107`, name: "Quarterly Health Check Visit", type: "SERVICE", billingCycle: "QUARTERLY", revenuePattern: "POINT_IN_TIME", price: 9500, cost: 4200, hsn: "998313", brand: "Acme", description: "An engineer on site once a quarter; earned when the visit is done." },
  { sku: `${DEMO_SKU}108`, name: "Dell P2425H 24\" Monitor", type: "GOOD", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 14500, cost: 12600, hsn: "85285200", brand: "Dell", description: "24-inch IPS, 100Hz.", openingStock: 18, reorderLevel: 4 },
  { sku: `${DEMO_SKU}109`, name: "Cisco IP Phone 8841", type: "GOOD", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 21500, cost: 18300, hsn: "85176290", brand: "Cisco", description: "Desk phone, PoE.", openingStock: 10, reorderLevel: 3 },
  { sku: `${DEMO_SKU}110`, name: "Lenovo Tab M11", type: "GOOD", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 18999, cost: 16400, hsn: "84713010", brand: "Lenovo", description: "11-inch tablet, 8GB/128GB.", openingStock: 6, reorderLevel: 2 },
  { sku: `${DEMO_SKU}111`, name: "Logitech MK540 Keyboard & Mouse Combo", type: "GOOD", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 2600, cost: 2050, hsn: "84716060", brand: "Logitech", description: "Wireless combo.", openingStock: 40, reorderLevel: 10 },
  { sku: `${DEMO_SKU}112`, name: "HP LaserJet Pro MFP 4104fdw", type: "GOOD", billingCycle: "ONE_TIME", revenuePattern: "POINT_IN_TIME", price: 42000, cost: 36400, hsn: "84433100", brand: "HP", description: "Mono laser multifunction, duplex, Wi-Fi.", openingStock: 5, reorderLevel: 2 },
];

// ─── The order steps ────────────────────────────────────────────────────────────────────────────

type StepStatus = "APPROVED" | "PROCESSING" | "FULFILLED";
const STEP_PLAN: { label: string; status: StepStatus; color: StageColor }[] = [
  { label: "Awaiting advance", status: "APPROVED", color: "amber" },
  { label: "Site ready", status: "APPROVED", color: "blue" },
  { label: "Material ordered", status: "PROCESSING", color: "default" },
  { label: "Material received", status: "PROCESSING", color: "blue" },
  { label: "Installation", status: "PROCESSING", color: "brand" },
  { label: "Handed over", status: "FULFILLED", color: "green" },
  { label: "Training done", status: "FULFILLED", color: "green" },
];
/** A step the workspace used for a while and retired, its orders moved on (`retireOrderStep`). */
const RETIRED_STEP = { label: "Awaiting PO copy", status: "APPROVED" as const, color: "red" as StageColor, movedTo: "Awaiting advance" };

export default async function seedOrders(db: PrismaClient, ctx: DemoContext): Promise<void> {
  // ── The cast ──────────────────────────────────────────────────────────────────────────────────
  const people = (pred: (p: DemoContext["people"][number]) => boolean): Person[] => {
    const found = ctx.people.filter(pred).map((p) => ({ id: p.id, name: p.name }));
    return found.length > 0 ? found : [ctx.admin];
  };
  const sales = people((p) => p.role === "SALES");
  /** `orders.approve`: accounts (and management — but never on their own order). */
  const approvers = people((p) => p.role === "ACCOUNTS");
  /** `orders.approveLoss`: management only. */
  const lossApprovers = people((p) => p.role === "MANAGEMENT");
  /** `orders.process`. */
  const purchasers = people((p) => p.role === "PURCHASE");
  /** `rebates.manage`. */
  const rebateManagers = people((p) => p.role === "ACCOUNTS" || p.role === "MANAGEMENT");
  /** `assets.manage`. */
  const assetKeepers = people((p) => p.role === "SUPPORT" && p.dept === "Support");
  const everyone = people(() => true);
  const salesIds = new Set(sales.map((s) => s.id));

  const withSite = (c: SeededCompany) => !!c.locationId;
  const customers = ctx.companies.filter((c) => c.relationship === "CLIENT" && c.stage === "CUSTOMER" && withSite(c));
  const vendorsWithBills = ctx.companies.filter((c) => c.relationship === "VENDOR");
  const distributors = ctx.companies.filter((c) => c.relationship === "DISTRIBUTOR");
  const supplyCompanies = [...distributors, ...vendorsWithBills];
  const oems = ctx.companies.filter((c) => c.relationship === "OEM");
  if (customers.length < 30 || supplyCompanies.length < 2) {
    log("Orders cover", "skipped — the demo has too few customers or vendors to work with");
    return;
  }
  const salespersonFor = (c: SeededCompany): string => (c.ownerId && salesIds.has(c.ownerId) ? c.ownerId : pick(sales).id);

  /**
   * Who each brand is bought from. Licensing through the distributors, hardware and services through
   * the vendors — one supplier a brand, as a system integrator of this size actually buys, so each
   * distributor's statement has a book of orders behind it.
   *
   * Read back from the orders already bought where there are any, so a second run agrees with the
   * first; otherwise assigned, the hardware vendors with open bills first — a vendor's credit note is
   * set against what we still owe it.
   */
  const SOFTWARE = ["Microsoft", "Adobe", "Autodesk", "Acronis", "Sophos", "Seqrite"];
  const HARDWARE = ["Dell", "HP", "Lenovo", "Cisco", "Logitech", "Synology", "Seagate", "APC", "Ubiquiti", "Acme"];
  const openBills = new Map(
    (
      await db.tradeDocument.groupBy({
        by: ["companyId"],
        where: { docType: "BILL", direction: "PURCHASE", status: { in: ["ISSUED", "PARTIALLY_PAID"] }, companyId: { in: vendorsWithBills.map((v) => v.id) } },
        _count: { _all: true },
      })
    ).map((g) => [g.companyId, g._count._all]),
  );
  const hardwareVendors = [...vendorsWithBills].sort((a, b) => (openBills.get(b.id) ?? 0) - (openBills.get(a.id) ?? 0));
  const supplierByBrand = new Map<string, SeededCompany>();
  {
    const licensing = distributors.length > 0 ? distributors : supplyCompanies;
    const hardware = hardwareVendors.length > 0 ? hardwareVendors : supplyCompanies;
    SOFTWARE.forEach((brand, i) => supplierByBrand.set(brand, licensing[i % licensing.length]!));
    HARDWARE.forEach((brand, i) => supplierByBrand.set(brand, hardware[i % hardware.length]!));
    const bought = await db.companyProduct.findMany({
      where: { company: { tags: { has: DEMO_TAG } }, vendorId: { not: null }, item: { brand: { isNot: null } } },
      select: { vendorId: true, item: { select: { brand: { select: { name: true } } } } },
    });
    const tally = new Map<string, Map<string, number>>();
    for (const o of bought) {
      const brand = o.item.brand!.name;
      const byVendor = tally.get(brand) ?? new Map<string, number>();
      byVendor.set(o.vendorId!, (byVendor.get(o.vendorId!) ?? 0) + 1);
      tally.set(brand, byVendor);
    }
    for (const [brand, byVendor] of tally) {
      const [top] = [...byVendor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const company = top ? supplyCompanies.find((c) => c.id === top[0]) : undefined;
      if (company) supplierByBrand.set(brand, company);
    }
  }
  const supplierOf = (brand: string) => supplierByBrand.get(brand) ?? supplyCompanies[0]!;

  // A fresh pool of customers for the scenarios, so no two land on the same account.
  const pool = some(customers, customers.length);
  const nextCustomer = () => pool.shift() ?? pick(customers);

  // ── 1. Catalogue ─────────────────────────────────────────────────────────────────────────────
  const itemsAdded = await seedItems(db, pick(purchasers).id);

  const items: ItemRow[] = (
    await db.item.findMany({
      where: { sku: { startsWith: DEMO_SKU } },
      select: { id: true, sku: true, name: true, type: true, sellingPrice: true, costPrice: true, brandId: true, billingCycle: true, brand: { select: { name: true } } },
      orderBy: { sku: "asc" },
    })
  ).map((i) => ({
    id: i.id,
    sku: i.sku,
    name: i.name,
    type: i.type,
    price: Number(i.sellingPrice),
    cost: Number(i.costPrice ?? 0),
    brandId: i.brandId,
    brand: i.brand?.name ?? "",
    billingCycle: i.billingCycle,
  }));
  const item = (needle: string): ItemRow => {
    const found = items.find((i) => i.name.includes(needle));
    if (!found) throw new Error(`orders cover: no demo item matching "${needle}"`);
    return found;
  };

  // ── 2. Order steps ───────────────────────────────────────────────────────────────────────────
  const steps = await seedOrderSteps(db, pick(lossApprovers).id);
  const stepNamed = (label: string) => {
    const s = steps.find((x) => x.label === label && !x.archived);
    if (!s) throw new Error(`orders cover: no step "${label}"`);
    return s;
  };

  // ── 3. What purchase did on the orders already there ─────────────────────────────────────────
  const backfill = await backfillPurchasing();

  // ── 4. The order scenarios ───────────────────────────────────────────────────────────────────
  const scenarios = await seedScenarios();

  // ── 5. Orders moved through the steps, and who is watching them ──────────────────────────────
  const placed = await placeDemoOrdersOnSteps();
  const watched = await seedWatchers();

  // ── 6. Renewals: pinned stages and the evidence the derived ones read ────────────────────────
  const renewalsNote = await seedRenewalStages();

  // ── 7. Backend rebates and vendor credits ────────────────────────────────────────────────────
  const rebatesNote = await seedRebates();

  // ── 8. Distributor statements ────────────────────────────────────────────────────────────────
  const statementsNote = await seedStatements();

  // ── 9. Resellers that stopped trading, stock counts, the IT estate ───────────────────────────
  const resellersNote = await seedResellerStatuses();
  const stockNote = await seedStock();
  const assetsNote = await seedAssets();

  log("Catalogue additions", `${itemsAdded} items — perpetual licences, monthly and quarterly cycles, estate kit`);
  log("Order steps", `${steps.filter((s) => !s.archived).length} in use, ${steps.filter((s) => s.archived).length} retired; ${placed} orders moved through them`);
  log("Purchasing history", backfill);
  log("Order scenarios", scenarios);
  log("Order watchers", `${watched} orders with people watching`);
  log("Renewal stages", renewalsNote);
  log("Backend rebates", rebatesNote);
  log("Vendor statements", statementsNote);
  log("Resellers", resellersNote);
  log("Stock", stockNote);
  log("IT estate", assetsNote);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // The order's own steps, as the actions in src/actions/order.ts take them.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  type OrderRef = { id: string; orderSeq: number };

  async function state(id: string) {
    return db.companyProduct.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, orderSeq: true, itemId: true, quantity: true, unitPrice: true, purchasePrice: true, dealPrice: true,
        quotedPurchasePrice: true, quotedById: true, lossApprovedCost: true, lossRequestedCost: true, orderStatus: true,
        purchaseRelease: true, addedByUserId: true, vendorId: true, pendingPurchasePrice: true, pendingVendorId: true,
        priceIncreaseReason: true, priceReviewRequestedById: true, purchasedByUserId: true, accountsNotes: true,
        item: { select: { sellingPrice: true } },
      },
    });
  }
  type OrderState = Awaited<ReturnType<typeof state>>;

  /** `lossNeeded` in src/actions/order.ts: below cost at `at` (or the best known), and not approved that high. */
  function lossNeed(o: OrderState, at?: { cost: number; from: CostSource }) {
    const known = at ?? unitCostOf({ purchasePrice: num(o.purchasePrice), dealPrice: num(o.dealPrice), quotedPurchasePrice: num(o.quotedPurchasePrice) });
    if (!known) return null;
    const unitPrice = num(o.unitPrice) ?? Number(o.item.sellingPrice);
    if (!needsLossApproval({ unitPrice, unitCost: known.cost, lossApprovedCost: num(o.lossApprovedCost) })) return null;
    return { unitPrice, cost: known.cost, from: known.from };
  }

  type Punch = {
    po: string;
    company: SeededCompany;
    item: ItemRow;
    quantity: number;
    unitPrice: number;
    by: string;
    at: Date;
    businessType?: OrderBusinessType;
    paymentTerms?: PaymentTerms | null;
    /** Sent to purchase now (the default), held as an in-hand order, or scheduled for a day. */
    handoff?: "NOW" | "HOLD" | { on: Date };
    quote?: { price: number; vendorId: string | null; vendorName?: string; contact?: string; remarks?: string };
    deal?: { status: DealRegStatus; number?: string; validTo?: Date | null; price?: number | null };
    start?: Date | null;
    end?: Date | null;
    notes?: string;
    endCustomerId?: string | null;
    watchers?: string[];
    extra?: Partial<Prisma.CompanyProductUncheckedCreateInput>;
  };

  /** `createOrder`: pending approval, with the hand-off, the distributor's price and the deal registration. */
  async function punch(p: Punch): Promise<OrderRef> {
    const handoff = p.handoff ?? "NOW";
    const release: Pick<Prisma.CompanyProductUncheckedCreateInput, "purchaseRelease" | "releaseOn" | "releasedAt" | "releasedById" | "bookedAt"> =
      handoff === "NOW"
        ? { purchaseRelease: "RELEASED", releasedAt: p.at, releasedById: p.by, bookedAt: p.at }
        : handoff === "HOLD"
          ? { purchaseRelease: "HELD", bookedAt: null }
          : { purchaseRelease: "SCHEDULED", releaseOn: handoff.on, bookedAt: null };
    const q = p.quote;
    return db.companyProduct.create({
      data: {
        ...release,
        companyId: p.company.id,
        locationId: p.company.locationId,
        itemId: p.item.id,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        businessType: p.businessType ?? "NEW",
        endCustomerId: p.endCustomerId ?? null,
        poNumber: p.po,
        paymentTerms: p.paymentTerms ?? null,
        startDate: p.start ?? null,
        endDate: p.end ?? null,
        notes: p.notes ?? null,
        addedByUserId: p.by,
        orderStatus: "PENDING_APPROVAL",
        createdAt: p.at,
        dealRegStatus: p.deal?.status ?? null,
        dealRegNumber: p.deal?.number ?? null,
        dealRegValidTo: p.deal?.validTo ?? null,
        dealPrice: p.deal?.price ?? null,
        ...(q
          ? {
              quotedPurchasePrice: q.price,
              quoteVendorId: q.vendorId,
              quoteVendorName: q.vendorId ? null : (q.vendorName ?? null),
              quoteContact: q.contact ?? null,
              quotedOn: calDay(p.at),
              quoteRemarks: q.remarks ?? null,
              quotedById: p.by,
              priceChanges: { create: { event: "QUOTED", toPrice: q.price, vendorId: q.vendorId, reason: q.remarks ?? null, byUserId: p.by, at: p.at } },
            }
          : {}),
        watchers: p.watchers?.length ? { connect: p.watchers.map((id) => ({ id })) } : undefined,
        ...p.extra,
      },
      select: { id: true, orderSeq: true },
    });
  }

  /** `approveOrder`, either way. Approving a negative call here is a manager's — the loss is approved with it. */
  async function decide(order: OrderRef, by: string, at: Date, approved: boolean, notes?: string) {
    const o = await state(order.id);
    if (o.orderStatus !== "PENDING_APPROVAL") throw new Error(`${formatOrderId(o.orderSeq)} was reviewed already`);
    if (o.addedByUserId === by) throw new Error("nobody approves their own order");
    const need = approved ? lossNeed(o) : null;
    if (need && !lossApprovers.some((m) => m.id === by)) throw new Error(`${formatOrderId(o.orderSeq)} is below cost — a manager approves it first`);
    await db.companyProduct.update({
      where: { id: order.id },
      data: {
        orderStatus: approved ? "APPROVED" : "REJECTED",
        accountsApprovedByUserId: by,
        accountsApprovedAt: at,
        accountsNotes: notes ?? null,
        ...(need ? { lossApprovedAt: at, lossApprovedById: by, lossApprovedCost: need.cost, lossApprovalNote: notes || "Approved with the order" } : {}),
      },
    });
  }

  /** `releaseOrder`: a held order goes to purchase, and books now if no payment booked it first. */
  async function release(order: OrderRef, by: string, at: Date) {
    await db.companyProduct.update({ where: { id: order.id }, data: { purchaseRelease: "RELEASED", releaseOn: null, releasedAt: at, releasedById: by } });
    await db.companyProduct.updateMany({ where: { id: order.id, bookedAt: null }, data: { bookedAt: at } });
  }

  /** `approveOrderLoss`: a manager approves selling below cost, at the highest cost in play. */
  async function approveLoss(order: OrderRef, by: string, at: Date, note: string, upToCost?: number) {
    const o = await state(order.id);
    if (o.addedByUserId === by) throw new Error("never on their own order");
    const known = unitCostOf({ purchasePrice: num(o.purchasePrice), dealPrice: num(o.dealPrice), quotedPurchasePrice: num(o.quotedPurchasePrice) });
    const candidates: { cost: number; from: CostSource }[] = [
      ...(known ? [known] : []),
      ...(o.lossRequestedCost !== null ? [{ cost: Number(o.lossRequestedCost), from: "PURCHASE" as const }] : []),
      ...(o.pendingPurchasePrice !== null ? [{ cost: Number(o.pendingPurchasePrice), from: "PURCHASE" as const }] : []),
      ...(upToCost !== undefined ? [{ cost: upToCost, from: "PURCHASE" as const }] : []),
    ];
    const highest = candidates.sort((a, b) => b.cost - a.cost)[0];
    const need = highest ? lossNeed(o, highest) : null;
    if (!need) throw new Error(`${formatOrderId(o.orderSeq)} isn't below cost`);
    await db.companyProduct.update({
      where: { id: order.id },
      data: { lossApprovedAt: at, lossApprovedById: by, lossApprovedCost: need.cost, lossApprovalNote: note, lossRequestedCost: null, lossRequestedAt: null },
    });
  }

  /** `processOrder`, the path that goes through: vendor, price, our PO, and the saving against sales's price. */
  async function buy(order: OrderRef, purchaser: string, vendorId: string, price: number, at: Date) {
    const o = await state(order.id);
    if ((o.orderStatus !== "APPROVED" && o.orderStatus !== "PROCESSING") || o.purchaseRelease !== "RELEASED") {
      throw new Error(`${formatOrderId(o.orderSeq)} isn't in purchase's queue`);
    }
    const quote = num(o.quotedPurchasePrice);
    const ceiling = priceCeiling({ quotedPurchasePrice: quote, quotedById: o.quotedById, orderStatus: o.orderStatus, purchasePrice: num(o.purchasePrice) }, purchaser);
    if (needsSalesApproval(ceiling, price)) throw new Error(`${formatOrderId(o.orderSeq)}: above sales's price — ask for an increase instead`);
    if (lossNeed(o, { cost: price, from: "PURCHASE" })) throw new Error(`${formatOrderId(o.orderSeq)}: below cost at ${price} — a manager approves it first`);
    const benchmark = ceiling === null ? null : quote;
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: order.id },
        data: {
          vendorId,
          purchasePrice: price,
          ourPoNumber: `PO/${financialYearOf(at)}/${String(int(100, 999))}`,
          purchasedByUserId: purchaser,
          orderStatus: "PROCESSING",
          pendingPurchasePrice: null,
          pendingVendorId: null,
          priceIncreaseReason: null,
          priceReviewRequestedAt: null,
          priceReviewRequestedById: null,
        },
      });
      await tx.orderPriceChange.create({
        data: { companyProductId: order.id, event: "PURCHASED", fromPrice: benchmark, toPrice: price, vendorId, byUserId: purchaser, at },
      });
      if (benchmark !== null) {
        const saving = {
          purchaserId: purchaser,
          quotedPrice: benchmark,
          actualPrice: price,
          quantity: o.quantity,
          amount: savingAmount(benchmark, price, o.quantity),
          recordedAt: at,
          recordedOn: calDay(at),
          cancelledAt: null,
        };
        await tx.purchaseSaving.upsert({ where: { companyProductId: order.id }, create: { companyProductId: order.id, ...saving }, update: saving });
      }
    });
  }

  /** `processOrder` above sales's price: nothing is bought; the price waits for sales. */
  async function askIncrease(order: OrderRef, purchaser: string, vendorId: string, price: number, reason: string, at: Date) {
    const o = await state(order.id);
    const ceiling = priceCeiling({ quotedPurchasePrice: num(o.quotedPurchasePrice), quotedById: o.quotedById, orderStatus: o.orderStatus, purchasePrice: num(o.purchasePrice) }, purchaser);
    if (!needsSalesApproval(ceiling, price) || reason.length < 10) throw new Error(`${formatOrderId(o.orderSeq)}: not an increase sales has to accept`);
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: order.id },
        data: { pendingPurchasePrice: price, pendingVendorId: vendorId, priceIncreaseReason: reason, priceReviewRequestedAt: at, priceReviewRequestedById: purchaser },
      });
      await tx.orderPriceChange.create({
        data: { companyProductId: order.id, event: "INCREASE_REQUESTED", fromPrice: ceiling, toPrice: price, vendorId, reason, byUserId: purchaser, at },
      });
    });
  }

  /** `acceptPriceIncrease`: processed at purchase's price, the difference a negative saving. */
  async function acceptIncrease(order: OrderRef, by: string, at: Date) {
    const o = await state(order.id);
    if (o.pendingPurchasePrice === null || !o.pendingVendorId || !o.priceReviewRequestedById) throw new Error("nothing waiting");
    const quote = num(o.quotedPurchasePrice);
    const price = Number(o.pendingPurchasePrice);
    if (lossNeed(o, { cost: price, from: "PURCHASE" })) throw new Error(`${formatOrderId(o.orderSeq)}: below cost at the higher price`);
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: order.id },
        data: {
          vendorId: o.pendingVendorId,
          purchasePrice: price,
          purchasedByUserId: o.priceReviewRequestedById,
          ourPoNumber: `PO/${financialYearOf(at)}/${String(int(100, 999))}`,
          orderStatus: "PROCESSING",
          pendingPurchasePrice: null,
          pendingVendorId: null,
          priceIncreaseReason: null,
          priceReviewRequestedAt: null,
          priceReviewRequestedById: null,
        },
      });
      await tx.orderPriceChange.create({
        data: { companyProductId: order.id, event: "INCREASE_ACCEPTED", fromPrice: quote, toPrice: price, vendorId: o.pendingVendorId, reason: o.priceIncreaseReason, byUserId: by, at },
      });
      if (quote !== null) {
        const saving = {
          purchaserId: o.priceReviewRequestedById!,
          quotedPrice: quote,
          actualPrice: price,
          quantity: o.quantity,
          amount: savingAmount(quote, price, o.quantity),
          recordedAt: at,
          recordedOn: calDay(at),
          cancelledAt: null,
        };
        await tx.purchaseSaving.upsert({ where: { companyProductId: order.id }, create: { companyProductId: order.id, ...saving }, update: saving });
      }
    });
  }

  /** `sendBackPriceIncrease`: purchase is told to look again. */
  async function sendBack(order: OrderRef, by: string, note: string, at: Date) {
    const o = await state(order.id);
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: order.id },
        data: { pendingPurchasePrice: null, pendingVendorId: null, priceIncreaseReason: null, priceReviewRequestedAt: null, priceReviewRequestedById: null },
      });
      await tx.orderPriceChange.create({
        data: { companyProductId: order.id, event: "SENT_BACK", fromPrice: o.quotedPurchasePrice, toPrice: o.pendingPurchasePrice, vendorId: o.pendingVendorId, reason: note, byUserId: by, at },
      });
    });
  }

  /** `processOrder` stopped for selling below cost: the cost it was stopped at is kept for a manager. */
  async function lossStopped(order: OrderRef, cost: number, at: Date) {
    const o = await state(order.id);
    if (!lossNeed(o, { cost, from: "PURCHASE" })) throw new Error(`${formatOrderId(o.orderSeq)} isn't below cost at ${cost}`);
    const asked = num(o.lossRequestedCost);
    if (asked === null || asked < cost) await db.companyProduct.update({ where: { id: order.id }, data: { lossRequestedCost: cost, lossRequestedAt: at } });
  }

  /** `fulfillOrder`. */
  async function fulfil(order: OrderRef, at: Date) {
    const o = await state(order.id);
    if (!o.vendorId || o.purchasePrice === null || o.pendingPurchasePrice !== null || o.purchaseRelease !== "RELEASED") {
      throw new Error(`${formatOrderId(o.orderSeq)} can't be fulfilled yet`);
    }
    await db.companyProduct.update({ where: { id: order.id }, data: { orderStatus: "FULFILLED", fulfilledAt: at } });
  }

  /** `cancelOrder`, by where the order had got to. */
  async function cancel(order: OrderRef, by: string, reason: string, at: Date) {
    const o = await state(order.id);
    const why = reason.trim();
    if (o.purchaseRelease === "RELEASED" && why.length < 3) throw new Error("a reason is needed once it is with purchase");
    const processing = o.orderStatus === "PROCESSING";
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({
        where: { id: order.id },
        data: {
          orderStatus: "CANCELLED",
          accountsNotes: why ? `Cancelled: ${why}` : o.accountsNotes,
          cancelledAt: at,
          cancelledById: by,
          cancelReason: why || null,
          vendorPoCancel: processing ? "PENDING" : null,
          ...(o.purchaseRelease === "SCHEDULED" ? { purchaseRelease: "HELD" as const, releaseOn: null } : {}),
          pendingPurchasePrice: null,
          pendingVendorId: null,
          priceIncreaseReason: null,
          priceReviewRequestedAt: null,
          priceReviewRequestedById: null,
        },
      });
      await tx.paymentAllocation.deleteMany({ where: { companyProductId: order.id } });
      await tx.purchaseSaving.updateMany({ where: { companyProductId: order.id, cancelledAt: null }, data: { cancelledAt: at } });
    });
  }

  /** `settleVendorPo`. */
  async function settlePo(order: OrderRef, by: string, outcome: "CANCELLED" | "NOT_NEEDED", at: Date) {
    await db.companyProduct.updateMany({
      where: { id: order.id, vendorPoCancel: "PENDING" },
      data: { vendorPoCancel: outcome, vendorPoSettledAt: at, vendorPoSettledById: by },
    });
  }

  /** `setOrderStep`: from the step it shows now to `label`, with the history row. */
  async function moveToStep(orderId: string, label: string, by: string, at: Date, note?: string) {
    const o = await db.companyProduct.findUniqueOrThrow({ where: { id: orderId }, select: { orderStatus: true, stepId: true } });
    const target = steps.find((s) => s.label === label && s.status === o.orderStatus && !s.archived);
    if (!target) throw new Error(`no step ${label} under ${o.orderStatus}`);
    const from = stepOfOrder(steps, { orderStatus: o.orderStatus, stepId: o.stepId });
    if (from?.id === target.id) return false;
    await db.$transaction(async (tx) => {
      await tx.companyProduct.update({ where: { id: orderId }, data: { stepId: target.id, stepChangedAt: at } });
      await tx.orderStepChange.create({
        data: { orderId, fromStepId: from?.id ?? null, fromLabel: from?.label ?? null, toStepId: target.id, toLabel: target.label, userId: by, note: note ?? null, createdAt: at },
      });
    });
    return true;
  }

  async function hasPo(po: string) {
    return !!(await db.companyProduct.findFirst({ where: { poNumber: po, company: { tags: { has: DEMO_TAG } } }, select: { id: true } }));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // Section bodies
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  async function seedItems(tx: PrismaClient, createdById: string): Promise<number> {
    let added = 0;
    for (const seed of NEW_ITEMS) {
      if (await tx.item.findUnique({ where: { sku: seed.sku }, select: { id: true } })) continue;
      const brand = await tx.brand.upsert({ where: { name: seed.brand }, create: { name: seed.brand }, update: {}, select: { id: true } });
      const createdAt = back(int(150, 300));
      const goods = seed.type === "GOOD";
      await tx.$transaction(async (t) => {
        const created = await t.item.create({
          data: {
            name: seed.name,
            sku: seed.sku,
            type: seed.type,
            hsnCode: seed.hsn,
            brandId: brand.id,
            unit: goods ? "Nos" : "Licence",
            billingCycle: seed.billingCycle,
            costPrice: seed.cost,
            sellingPrice: seed.price,
            taxRatePercent: 18,
            description: seed.description,
            // Only goods carry stock, as `createItem` enforces.
            trackInventory: goods,
            reorderLevel: goods ? (seed.reorderLevel ?? null) : null,
            stockQuantity: goods ? (seed.openingStock ?? 0) : 0,
            revenuePattern: seed.revenuePattern,
            createdById,
            createdAt,
          },
          select: { id: true },
        });
        if (goods && seed.openingStock) {
          await t.stockMovement.create({
            data: { itemId: created.id, type: "RECEIVED", quantityChange: seed.openingStock, reason: "Opening stock", createdByUserId: createdById, createdAt },
          });
        }
      });
      added += 1;
    }
    return added;
  }

  async function seedOrderSteps(tx: PrismaClient, managerId: string): Promise<OrderStepDef[]> {
    const read = async (): Promise<OrderStepDef[]> =>
      (await tx.orderStep.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })).map((r) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        status: r.status,
        color: (["default", "blue", "amber", "brand", "green", "red"].includes(r.color) ? r.color : "default") as StageColor,
        archived: r.archivedAt !== null,
      }));
    let current = await read();
    const setUpAt = back(int(250, 320));
    const add = async (label: string, status: StepStatus, color: StageColor) => {
      const same = current.find((s) => s.status === status && s.label.trim().toLowerCase() === label.toLowerCase());
      if (same) return same;
      const problem = checkStep({ label, status, color }, current);
      if (problem) throw new Error(`order step ${label}: ${problem}`);
      await tx.orderStep.create({
        data: { key: stepKeyFromLabel(label, current.map((s) => s.key)), label, status, color, sortOrder: current.length + 1, createdAt: setUpAt, updatedAt: setUpAt },
      });
      current = await read();
      return current.find((s) => s.label === label && s.status === status)!;
    };
    for (const s of STEP_PLAN) await add(s.label, s.status, s.color);

    // A step tried for a while and retired: the orders at it moved on, with the history saying why.
    if (!current.some((s) => s.label === RETIRED_STEP.label && s.status === RETIRED_STEP.status)) {
      const retired = await add(RETIRED_STEP.label, RETIRED_STEP.status, RETIRED_STEP.color);
      const target = current.find((s) => s.label === RETIRED_STEP.movedTo && s.status === RETIRED_STEP.status && !s.archived)!;
      const waiting = await tx.companyProduct.findMany({
        where: { orderStatus: "APPROVED", stepId: null, company: { tags: { has: DEMO_TAG } } },
        select: { id: true, createdAt: true, addedByUserId: true },
        take: 2,
        orderBy: { createdAt: "asc" },
      });
      const retiredAt = back(int(20, 40));
      for (const o of waiting) {
        const placedAt = later(o.createdAt, 1, 3);
        if (placedAt >= retiredAt) continue;
        // Put on the step by the salesperson (from the first step it showed), then moved on when it was retired.
        const first = current.find((s) => s.status === "APPROVED" && !s.archived && s.id !== retired.id)!;
        await tx.orderStepChange.create({
          data: { orderId: o.id, fromStepId: first.id, fromLabel: first.label, toStepId: retired.id, toLabel: retired.label, userId: o.addedByUserId, createdAt: placedAt },
        });
        await tx.companyProduct.update({ where: { id: o.id }, data: { stepId: target.id, stepChangedAt: retiredAt } });
        await tx.orderStepChange.create({
          data: { orderId: o.id, fromStepId: retired.id, fromLabel: retired.label, toStepId: target.id, toLabel: target.label, userId: managerId, note: `${retired.label} was retired`, createdAt: retiredAt },
        });
      }
      await tx.orderStep.update({ where: { id: retired.id }, data: { archivedAt: retiredAt } });
      current = await read();
    }
    return current;
  }

  /**
   * The orders the main demo marks as bought carry a purchase price but no supplier, and no trace of
   * the purchase in their price history — `fulfillOrder` refuses an order without a vendor, and
   * `processOrder` writes a PURCHASED step every time. Both are filled in here, the supplier by brand.
   * About a third also get the distributor price the salesperson had when punching it, and so the
   * purchaser's saving against it — the purchase-savings report needs a year of those.
   */
  async function backfillPurchasing(): Promise<string> {
    const orders = await db.companyProduct.findMany({
      where: {
        company: { tags: { has: DEMO_TAG } },
        orderStatus: { in: ["PROCESSING", "FULFILLED"] },
        purchasePrice: { not: null },
        priceChanges: { none: {} },
      },
      select: {
        id: true, createdAt: true, fulfilledAt: true, quantity: true, purchasePrice: true, vendorId: true, purchasedByUserId: true,
        addedByUserId: true, orderStatus: true, item: { select: { brand: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    let vendors = 0;
    let savings = 0;
    for (const o of orders) {
      const supplier = o.vendorId ?? supplierOf(o.item.brand?.name ?? "").id;
      const purchaser = o.purchasedByUserId ?? pick(purchasers).id;
      const price = Number(o.purchasePrice);
      const boughtAt = later(o.createdAt, 0, 3);
      const quoted = chance(0.35) && o.addedByUserId !== purchaser;
      const quote = quoted ? round2(price * (1.01 + rnd() * 0.04)) : null;
      await db.$transaction(async (tx) => {
        await tx.companyProduct.update({
          where: { id: o.id },
          data: {
            vendorId: supplier,
            purchasedByUserId: purchaser,
            ...(quote !== null
              ? {
                  quotedPurchasePrice: quote,
                  quoteVendorId: supplier,
                  quotedOn: calDay(o.createdAt),
                  quotedById: o.addedByUserId,
                  quoteContact: personName(),
                }
              : {}),
          },
        });
        if (quote !== null) {
          await tx.orderPriceChange.create({
            data: { companyProductId: o.id, event: "QUOTED", toPrice: quote, vendorId: supplier, byUserId: o.addedByUserId, at: o.createdAt },
          });
        }
        await tx.orderPriceChange.create({
          data: { companyProductId: o.id, event: "PURCHASED", fromPrice: quote, toPrice: price, vendorId: supplier, byUserId: purchaser, at: boughtAt },
        });
        if (quote !== null) {
          await tx.purchaseSaving.create({
            data: {
              companyProductId: o.id,
              purchaserId: purchaser,
              quotedPrice: quote,
              actualPrice: price,
              quantity: o.quantity,
              amount: savingAmount(quote, price, o.quantity),
              recordedAt: boughtAt,
              recordedOn: calDay(boughtAt),
            },
          });
          savings += 1;
        }
      });
      if (!o.vendorId) vendors += 1;
    }
    return orders.length === 0
      ? "already recorded"
      : `${orders.length} bought orders given their purchase step, ${vendors} their supplier, ${savings} a distributor price and saving`;
  }

  async function seedScenarios(): Promise<string> {
    let made = 0;
    const done = async (po: string, fn: () => Promise<unknown>) => {
      if (await hasPo(po)) return;
      await fn();
      made += 1;
    };
    const supplier = (i: ItemRow) => supplierOf(i.brand).id;
    const otherSupplier = (i: ItemRow) => (supplyCompanies.find((c) => c.id !== supplier(i)) ?? supplyCompanies[0]!).id;
    const approver = () => pick(approvers).id;
    const purchaser = () => pick(purchasers).id;
    const manager = (not: string) => (lossApprovers.find((m) => m.id !== not) ?? lossApprovers[0]!).id;
    const supportPeople = assetKeepers;
    const term = (start: Date) => ({ start: calDay(start), end: new Date(calDay(start).getTime() + 364 * DAY) });
    const dealNo = (prefix: string) => `${prefix}-${int(100000, 999999)}`;

    // S1 · Waiting for accounts: sent to purchase on punching, a distributor price, a registration applied for.
    await done(PO(1), async () => {
      const c = nextCustomer();
      const i = item("Microsoft 365 E3");
      const at = back(int(1, 3));
      await punch({
        po: PO(1), company: c, item: i, quantity: int(40, 120), unitPrice: Math.round(i.price * 0.97), by: salespersonFor(c), at,
        paymentTerms: "NET_30", businessType: "NEW_TO_US_RENEWAL", ...term(at),
        quote: { price: Math.round(i.cost * 0.995), vendorId: supplier(i), contact: personName(), remarks: "Price held until the end of the month" },
        deal: { status: "APPLIED", number: dealNo("MSDR"), validTo: calDay(daysAhead(90)) },
        notes: "Moving from their Google Workspace tenant — migration quoted separately.",
        watchers: some(supportPeople, 2).map((p) => p.id),
      });
    });

    // S2 · An in-hand order: the customer's advance PO, held back from purchase until the advance clears.
    await done(PO(2), async () => {
      const c = nextCustomer();
      const i = item("Dell PowerEdge R450");
      await punch({
        po: PO(2), company: c, item: i, quantity: 2, unitPrice: Math.round(i.price * 0.96), by: salespersonFor(c), at: back(int(2, 6)),
        paymentTerms: "ADVANCE", handoff: "HOLD",
        notes: "Advance PO received — hold until 50% advance is in the bank.",
      });
    });

    // S3 · A negative call waiting for a manager: the deal price is above what we sell at; the OEM's rebate is the margin.
    await done(PO(3), async () => {
      const c = nextCustomer();
      const i = item("Adobe Creative Cloud All Apps");
      const at = back(int(1, 4));
      await punch({
        po: PO(3), company: c, item: i, quantity: int(12, 30), unitPrice: Math.round(i.cost * 0.97), by: salespersonFor(c), at,
        paymentTerms: "NET_45", ...term(at),
        deal: { status: "APPROVED", number: dealNo("ADB-VIP"), validTo: calDay(daysAhead(120)), price: Math.round(i.cost * 0.99) },
        notes: "Competitive bid against a direct Adobe quote — the VIP rebate makes it worth it.",
      });
    });

    // S4 · Approved, and scheduled to go to purchase on a day after today.
    await done(PO(4), async () => {
      const c = nextCustomer();
      const i = item("Sophos XGS 2100");
      const at = back(int(4, 8));
      const by = salespersonFor(c);
      const o = await punch({
        po: PO(4), company: c, item: i, quantity: 1, unitPrice: Math.round(i.price * 0.95), by, at,
        paymentTerms: "NET_15", handoff: { on: calDay(daysAhead(int(5, 18))) },
        notes: "Customer wants the firewall delivered after their quarter-end freeze.",
      });
      await decide(o, approver(), later(at, 1, 2), true, "Terms fine — scheduled delivery noted.");
    });

    // S5 · In purchase's queue, on its "Site ready" step: registration approved at a deal price, distributor price on file.
    await done(PO(5), async () => {
      const c = nextCustomer();
      const i = item("Cisco Catalyst 1000");
      const at = back(int(6, 12));
      const by = salespersonFor(c);
      const o = await punch({
        po: PO(5), company: c, item: i, quantity: int(3, 8), unitPrice: Math.round(i.price * 0.94), by, at,
        paymentTerms: "DUE_ON_RECEIPT",
        quote: { price: Math.round(i.cost * 0.98), vendorId: supplier(i), contact: personName() },
        deal: { status: "APPROVED", number: dealNo("CSCO-DR"), validTo: calDay(daysAhead(60)), price: Math.round(i.cost * 0.95) },
        watchers: some(supportPeople, 1).map((p) => p.id),
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      await moveToStep(o.id, "Site ready", by, later(approvedAt, 1, 3), "Rack space confirmed by the customer's admin.");
    });

    // S6 · Purchase can only get it above the salesperson's price — waiting for sales to accept.
    await done(PO(6), async () => {
      const c = nextCustomer();
      const i = item("Microsoft 365 E5");
      const at = back(int(6, 10));
      const by = salespersonFor(c);
      const quote = Math.round(i.cost * 0.99);
      const o = await punch({
        po: PO(6), company: c, item: i, quantity: int(20, 60), unitPrice: Math.round(i.price * 0.99), by, at,
        paymentTerms: "NET_60", ...term(at), quote: { price: quote, vendorId: supplier(i), remarks: "Quarter-end promo price" },
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      await askIncrease(o, purchaser(), supplier(i), Math.round(quote * 1.025), "The quarter-end promo lapsed on the 30th — this is the list price from the distributor now.", later(approvedAt, 1, 3));
    });

    // S7 · Purchase was stopped: buying it puts the order below cost, and no manager has approved that yet.
    await done(PO(7), async () => {
      const c = nextCustomer();
      const i = item("Microsoft 365 Business Standard");
      const at = back(int(5, 9));
      const by = salespersonFor(c);
      const o = await punch({ po: PO(7), company: c, item: i, quantity: int(25, 80), unitPrice: Math.round(i.cost * 1.01), by, at, ...term(at) });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      await lossStopped(o, Math.round(i.cost * 1.03), later(approvedAt, 1, 2));
    });

    // S8 · Sales accepted purchase's higher price: processed at it, the difference a negative saving.
    await done(PO(8), async () => {
      const c = nextCustomer();
      const i = item("AutoCAD LT");
      const at = back(int(30, 60));
      const by = salespersonFor(c);
      const quote = Math.round(i.cost * 0.99);
      const buyer = purchaser();
      const o = await punch({
        po: PO(8), company: c, item: i, quantity: int(5, 15), unitPrice: Math.round(i.price * 0.98), by, at,
        paymentTerms: "NET_30", ...term(at), quote: { price: quote, vendorId: supplier(i) },
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      const askedAt = later(approvedAt, 1, 2);
      await askIncrease(o, buyer, supplier(i), Math.round(quote * 1.018), "Autodesk raised its India price list on the 1st — every distributor is at this now.", askedAt);
      const acceptedAt = later(askedAt, 0, 1);
      await acceptIncrease(o, by, acceptedAt);
      await moveToStep(o.id, "Material received", buyer, later(acceptedAt, 1, 2), "Licences provisioned in the customer's Autodesk account.");
    });

    // S9 · Sent back: the salesperson refused the higher price, purchase found it under the quote elsewhere.
    await done(PO(9), async () => {
      const c = nextCustomer();
      const i = item("Adobe Acrobat Pro DC");
      const at = back(int(40, 70));
      const by = salespersonFor(c);
      const quote = Math.round(i.cost * 0.99);
      const buyer = purchaser();
      const o = await punch({
        po: PO(9), company: c, item: i, quantity: int(15, 40), unitPrice: Math.round(i.price * 0.96), by, at,
        paymentTerms: "NET_45", ...term(at), quote: { price: quote, vendorId: supplier(i) },
        deal: { status: "REJECTED", number: dealNo("ADB-VIP") },
        notes: "Registration rejected — another partner registered the account first.",
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      const askedAt = later(approvedAt, 1, 2);
      await askIncrease(o, buyer, supplier(i), Math.round(quote * 1.03), "Our usual distributor is out of the VIP allocation this month.", askedAt);
      const sentAt = later(askedAt, 0, 1);
      await sendBack(o, by, "Try the other distributor — they matched this price for us last month.", sentAt);
      const boughtAt = later(sentAt, 0, 2);
      await buy(o, buyer, otherSupplier(i), Math.round(quote * 0.995), boughtAt);
      await moveToStep(o.id, "Material received", buyer, later(boughtAt, 1, 3));
    });

    // S10 · A negative call a manager approved on the order, then accounts approved and purchase bought within it.
    await done(PO(10), async () => {
      const c = nextCustomer();
      const i = item("Autodesk Revit");
      const at = back(int(50, 90));
      const by = salespersonFor(c);
      const quote = Math.round(i.cost * 1.0);
      const buyer = purchaser();
      const o = await punch({
        po: PO(10), company: c, item: i, quantity: int(3, 8), unitPrice: Math.round(i.cost * 0.985), by, at,
        paymentTerms: "NET_60", ...term(at), quote: { price: quote, vendorId: supplier(i) },
        deal: { status: "APPROVED", number: dealNo("ADSK"), validTo: calDay(daysAhead(30)) },
        notes: "Strategic logo — first Revit seats in their design office.",
      });
      const lossAt = later(at, 0, 1);
      await approveLoss(o, manager(by), lossAt, "Strategic account — the Autodesk back-end rebate takes it positive.");
      const approvedAt = later(lossAt, 0, 1);
      await decide(o, approver(), approvedAt, true);
      const boughtAt = later(approvedAt, 1, 3);
      await buy(o, buyer, supplier(i), Math.round(quote * 0.997), boughtAt);
      const s1 = later(boughtAt, 2, 5);
      await moveToStep(o.id, "Material received", buyer, s1);
      await moveToStep(o.id, "Installation", pick(supportPeople).id, later(s1, 2, 6), "Engineer booked to deploy the seats and the shared content library.");
    });

    // S11 · The whole road: quoted, approved, bought under the quote, delivered, handed over and trained.
    await done(PO(11), async () => {
      const c = nextCustomer();
      const i = item("Sophos XGS 2100");
      const at = back(int(120, 200));
      const by = salespersonFor(c);
      const quote = Math.round(i.cost * 1.02);
      const buyer = purchaser();
      const engineer = pick(supportPeople).id;
      const o = await punch({
        po: PO(11), company: c, item: i, quantity: 1, unitPrice: Math.round(i.price * 0.97), by, at,
        paymentTerms: "ADVANCE", quote: { price: quote, vendorId: supplier(i) },
        deal: { status: "APPROVED", number: dealNo("SOPH-DR"), validTo: calDay(new Date(at.getTime() + 90 * DAY)), price: Math.round(i.cost * 0.97) },
        watchers: [engineer],
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true, "Advance received in full.");
      const boughtAt = later(approvedAt, 1, 3);
      await buy(o, buyer, supplier(i), Math.round(i.cost * 0.97), boughtAt);
      const received = later(boughtAt, 3, 6);
      await moveToStep(o.id, "Material received", buyer, received);
      const installed = later(received, 2, 5);
      await moveToStep(o.id, "Installation", engineer, installed, "Installed and the old firewall's rules migrated.");
      const fulfilledAt = later(installed, 1, 2);
      await fulfil(o, fulfilledAt);
      await moveToStep(o.id, "Training done", engineer, later(fulfilledAt, 3, 8), "Two-hour admin training for their IT team.");
    });

    // S12, S13 · Rejected by accounts, each with the reason the salesperson reads back.
    await done(PO(12), async () => {
      const c = nextCustomer();
      const i = item("Microsoft 365 Business Premium (Annual)");
      const at = back(int(20, 45));
      const o = await punch({
        po: PO(12), company: c, item: i, quantity: int(30, 70), unitPrice: Math.round(i.price * 0.97), by: salespersonFor(c), at,
        paymentTerms: "NET_60", ...term(at), deal: { status: "REJECTED", number: dealNo("MSDR") },
      });
      await decide(o, approver(), later(at, 1, 2), false, "Customer is 90 days overdue on two invoices — clear the arrears before we extend 60-day terms.");
    });
    await done(PO(13), async () => {
      const c = nextCustomer();
      const i = item("HP ProBook 450");
      const at = back(int(60, 120));
      const o = await punch({
        po: PO(13), company: c, item: i, quantity: int(10, 25), unitPrice: Math.round(i.cost * 1.02), by: salespersonFor(c), at,
        paymentTerms: "NET_45",
      });
      await decide(o, approver(), later(at, 1, 2), false, "2% over cost doesn't cover freight and warranty handling — re-quote at list less 5%.");
    });

    // S14 · Cancelled while held — it never reached purchase, so nothing needed saying.
    await done(PO(14), async () => {
      const c = nextCustomer();
      const i = item("Synology DS923+");
      const at = back(int(30, 80));
      const by = salespersonFor(c);
      const o = await punch({ po: PO(14), company: c, item: i, quantity: 1, unitPrice: Math.round(i.price * 0.97), by, at, paymentTerms: "ADVANCE", handoff: "HOLD" });
      await cancel(o, by, "", later(at, 3, 10));
    });

    // S15 · Cancelled while scheduled: the go-ahead day is dropped, and it never goes.
    await done(PO(15), async () => {
      const c = nextCustomer();
      const i = item("Logitech Rally Bar");
      const at = back(int(20, 40));
      const by = salespersonFor(c);
      const o = await punch({
        po: PO(15), company: c, item: i, quantity: 2, unitPrice: Math.round(i.price * 0.95), by, at,
        paymentTerms: "NET_15", handoff: { on: calDay(daysAhead(int(10, 30))) },
      });
      await decide(o, approver(), later(at, 1, 2), true);
      await cancel(o, by, "Board-room refit postponed to next financial year.", later(at, 4, 9));
    });

    // S16 · Cancelled from purchase's queue — approved and released, not yet bought.
    await done(PO(16), async () => {
      const c = nextCustomer();
      const i = item("APC Smart-UPS");
      const at = back(int(30, 90));
      const by = salespersonFor(c);
      const o = await punch({ po: PO(16), company: c, item: i, quantity: int(2, 4), unitPrice: Math.round(i.price * 0.95), by, at, paymentTerms: "NET_30" });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      await cancel(o, approver(), "Customer bought the UPS units locally with their facility contractor.", later(approvedAt, 2, 6));
    });

    // S17–S19 · Cancelled after purchase had bought it: the vendor PO to cancel, cancelled, or not needed.
    const cancelledAfterPurchase = async (n: number, needle: string, outcome: "PENDING" | "CANCELLED" | "NOT_NEEDED", why: string, ago: [number, number]) =>
      done(PO(n), async () => {
        const c = nextCustomer();
        const i = item(needle);
        const at = back(int(ago[0], ago[1]));
        const by = salespersonFor(c);
        const buyer = purchaser();
        const subscription = i.type === "SUBSCRIPTION";
        const o = await punch({
          po: PO(n), company: c, item: i, quantity: subscription ? int(10, 40) : int(1, 4), unitPrice: Math.round(i.price * 0.96), by, at,
          paymentTerms: pick(["NET_30", "NET_15", "DUE_ON_RECEIPT"] as const), ...(subscription ? term(at) : {}),
          quote: { price: Math.round(i.cost * 1.01), vendorId: supplier(i) },
        });
        const approvedAt = later(at, 1, 2);
        await decide(o, approver(), approvedAt, true);
        const boughtAt = later(approvedAt, 1, 2);
        await buy(o, buyer, supplier(i), Math.round(i.cost), boughtAt);
        const cancelledAt = later(boughtAt, 1, 4);
        await cancel(o, by, why, cancelledAt);
        if (outcome !== "PENDING") await settlePo(o, buyer, outcome, later(cancelledAt, 0, 3));
      });
    await cancelledAfterPurchase(17, "Ubiquiti UniFi", "PENDING", "Customer's landlord won't allow ceiling work this quarter.", [3, 8]);
    await cancelledAfterPurchase(18, "Acronis Cyber Protect", "CANCELLED", "Customer chose to stay on their existing backup vendor after a retention discount.", [40, 90]);
    await cancelledAfterPurchase(19, "Seagate IronWolf", "NOT_NEEDED", "Duplicate of an order punched the same morning — the vendor PO had not gone out yet.", [60, 150]);

    // S20 · A reseller's order for its end customer: invoiced to the reseller, provisioned for the customer.
    await done(PO(20), async () => {
      const profile = await db.resellerProfile.findFirst({
        where: { status: "ACTIVE", company: { tags: { has: DEMO_TAG }, endCustomers: { some: {} } } },
        select: { companyId: true },
        orderBy: { createdAt: "asc" },
      });
      if (!profile) return;
      const reseller = ctx.companies.find((c) => c.id === profile.companyId);
      const endCustomer = await db.company.findFirst({ where: { managedByResellerId: profile.companyId }, select: { id: true } });
      if (!reseller || !reseller.locationId || !endCustomer) return;
      const i = item("Microsoft 365 Business Basic");
      const at = back(int(60, 120));
      const by = salespersonFor(reseller);
      const buyer = purchaser();
      const o = await punch({
        po: PO(20), company: reseller, item: i, quantity: int(50, 150), unitPrice: Math.round(i.price * 0.96), by, at,
        paymentTerms: "NET_30", ...term(at), endCustomerId: endCustomer.id,
      });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      const boughtAt = later(approvedAt, 1, 2);
      await buy(o, buyer, supplier(i), Math.round(i.cost * 0.99), boughtAt);
      await fulfil(o, later(boughtAt, 0, 2));
    });

    // S21 · A perpetual licence: owned outright, no term, never on the renewals list.
    await done(PO(21), async () => {
      const c = nextCustomer();
      const i = item("Office LTSC Standard 2024");
      const at = back(int(80, 160));
      const o = await punch({ po: PO(21), company: c, item: i, quantity: int(10, 40), unitPrice: Math.round(i.price * 0.97), by: salespersonFor(c), at, paymentTerms: "DUE_ON_RECEIPT" });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true);
      const boughtAt = later(approvedAt, 1, 2);
      await buy(o, purchaser(), supplier(i), Math.round(i.cost * 0.99), boughtAt);
      await fulfil(o, later(boughtAt, 1, 3));
    });

    // S22 · A monthly subscription, being processed; S23 · a quarterly managed service, approved.
    await done(PO(22), async () => {
      const c = nextCustomer();
      const i = item("Business Premium (Monthly)");
      const at = back(int(4, 10));
      const start = calDay(at);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()) - DAY);
      const o = await punch({ po: PO(22), company: c, item: i, quantity: int(15, 40), unitPrice: i.price, by: salespersonFor(c), at, paymentTerms: "NET_15", start, end });
      const approvedAt = later(at, 0, 1);
      await decide(o, approver(), approvedAt, true);
      await buy(o, purchaser(), supplier(i), i.cost, later(approvedAt, 0, 1));
    });
    await done(PO(23), async () => {
      const c = nextCustomer();
      const i = item("Managed SOC Monitoring");
      const at = back(int(2, 6));
      const start = calDay(daysAhead(int(3, 10)));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, start.getUTCDate()) - DAY);
      const o = await punch({ po: PO(23), company: c, item: i, quantity: 1, unitPrice: i.price, by: salespersonFor(c), at, paymentTerms: "NET_30", start, end });
      const approvedAt = later(at, 0, 2);
      await decide(o, approver(), approvedAt, true);
      await moveToStep(o.id, "Site ready", salespersonFor(c), later(approvedAt, 0, 1), "Customer's firewall admin has shared the log-forwarding access.");
    });

    // S24 · Seats added part-way through a term: their own order, co-terminating with the subscription.
    await done(PO(24), async () => {
      const parent = await db.companyProduct.findFirst({
        where: {
          company: { tags: { has: DEMO_TAG }, relationshipType: "CLIENT" },
          parentId: null,
          orderStatus: "FULFILLED",
          vendorId: { not: null },
          item: { type: "SUBSCRIPTION", brand: { name: "Microsoft" } },
          startDate: { lte: daysAgo(150) },
          endDate: { gte: daysAhead(120) },
          addons: { none: {} },
        },
        select: {
          id: true, companyId: true, locationId: true, itemId: true, vendorId: true, endCustomerId: true, paymentTerms: true,
          quantity: true, unitPrice: true, fullTermUnitPrice: true, purchasePrice: true, startDate: true, endDate: true, addedByUserId: true,
        },
        orderBy: { createdAt: "asc" },
      });
      if (!parent || !parent.startDate || !parent.endDate || parent.unitPrice === null) return;
      const at = back(int(70, 85));
      const addonStart = calDay(at);
      const annual = Number(parent.fullTermUnitPrice ?? parent.unitPrice);
      const quantity = int(4, 10);
      const quote = proRata({ fullTermUnitPrice: annual, quantity, addonStart, parentStart: parent.startDate, parentEnd: parent.endDate });
      const by = parent.addedByUserId;
      const company = ctx.companies.find((c) => c.id === parent.companyId)!;
      const o = await punch({
        po: PO(24), company, item: items.find((i) => i.id === parent.itemId)!, quantity, unitPrice: quote.unitPrice, by, at,
        businessType: "ADDON", paymentTerms: parent.paymentTerms, start: addonStart, end: parent.endDate,
        notes: `New joiners in their Pune office.\n\n${quote.workings}`,
        extra: { parentId: parent.id, fullTermUnitPrice: annual, proRataDays: quote.daysCharged, fullTermDays: quote.fullTermDays, locationId: parent.locationId, endCustomerId: parent.endCustomerId },
      });
      const approvedAt = later(at, 0, 1);
      await decide(o, approver(), approvedAt, true);
      const boughtAt = later(approvedAt, 0, 1);
      const cost = parent.purchasePrice === null ? Math.round(quote.unitPrice * 0.94) : round2(Number(parent.purchasePrice) * quote.fraction);
      await buy(o, purchaser(), parent.vendorId!, cost, boughtAt);
      await fulfil(o, later(boughtAt, 0, 1));
    });

    // S25–S27 · Renewals punched from the renewals list (`createRenewalOrder`): one waiting for approval,
    // one late renewal already with purchase, and one that had been pinned as lost before the customer came back.
    const renewable = async (window: [number, number]) =>
      db.companyProduct.findMany({
        where: {
          company: { tags: { has: DEMO_TAG }, relationshipType: "CLIENT" },
          parentId: null,
          renewedBy: null,
          renewalStage: null,
          orderStatus: { in: ["FULFILLED", "PROCESSING"] },
          vendorId: { not: null },
          item: { type: "SUBSCRIPTION" },
          endDate: { gte: daysAhead(window[0]), lte: daysAhead(window[1]) },
        },
        select: {
          id: true, orderSeq: true, companyId: true, locationId: true, itemId: true, vendorId: true, endCustomerId: true, paymentTerms: true,
          quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true, endDate: true,
          item: { select: { billingCycle: true } },
          company: { select: { ownerUserId: true } },
          addons: { where: { orderStatus: { not: "CANCELLED" } }, select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true } },
        },
        orderBy: { endDate: "asc" },
        take: 6,
      });
    const punchRenewal = async (po: string, source: Awaited<ReturnType<typeof renewable>>[number], at: Date) => {
      const group = renewalGroup([
        { id: source.id, quantity: source.quantity, unitPrice: num(source.unitPrice), fullTermUnitPrice: num(source.fullTermUnitPrice), startDate: source.startDate, isAddon: false },
        ...source.addons.map((a) => ({ id: a.id, quantity: a.quantity, unitPrice: num(a.unitPrice), fullTermUnitPrice: num(a.fullTermUnitPrice), startDate: a.startDate, isAddon: true })),
      ]);
      const draft = renewalOrderDraft({
        quantity: source.quantity,
        unitPrice: num(source.unitPrice),
        fullTermUnitPrice: num(source.fullTermUnitPrice),
        endDate: source.endDate,
        billingCycle: source.item.billingCycle,
        group,
      });
      if (!draft.term || draft.unitPrice === null) return null;
      const by = source.company.ownerUserId && salesIds.has(source.company.ownerUserId) ? source.company.ownerUserId : pick(sales).id;
      return db.companyProduct.create({
        data: {
          companyId: source.companyId,
          locationId: source.locationId,
          itemId: source.itemId,
          vendorId: source.vendorId,
          endCustomerId: source.endCustomerId,
          paymentTerms: source.paymentTerms,
          renewedFromId: source.id,
          businessType: "RENEWAL",
          quantity: draft.quantity,
          unitPrice: draft.unitPrice,
          fullTermUnitPrice: draft.unitPrice,
          startDate: new Date(`${draft.term.startDate}T00:00:00.000Z`),
          endDate: new Date(`${draft.term.endDate}T00:00:00.000Z`),
          poNumber: po,
          notes: `Renewal of ${formatOrderId(source.orderSeq)}${draft.warnings.length > 0 ? ` — ${draft.warnings.join(" ")}` : ""}`,
          orderStatus: "PENDING_APPROVAL",
          addedByUserId: by,
          createdAt: at,
          // Sent straight to purchase, as every renewal is: booked when punched (the column's default).
          bookedAt: at,
        },
        select: { id: true, orderSeq: true, addedByUserId: true },
      });
    };
    await done(PO(25), async () => {
      const [source] = await renewable([3, 30]);
      if (source) await punchRenewal(PO(25), source, back(int(1, 3)));
    });
    await done(PO(26), async () => {
      const [source] = await renewable([-40, -8]);
      if (!source) return;
      const at = back(int(4, 7));
      const o = await punchRenewal(PO(26), source, at);
      if (!o) return;
      const approvedAt = later(at, 0, 1);
      await decide(o, approver(), approvedAt, true, "Late renewal — service was suspended for six days; customer has paid.");
      const s = await state(o.id);
      await buy(o, purchaser(), s.vendorId!, round2(Number(s.unitPrice) * 0.93), later(approvedAt, 0, 1));
    });
    await done(PO(27), async () => {
      const candidates = await renewable([-25, 20]);
      const source = candidates[candidates.length - 1];
      if (!source) return;
      // Pinned as lost a month ago, by the account manager — and then the customer came back.
      const pinnedBy = source.company.ownerUserId ?? pick(sales).id;
      await db.companyProduct.update({
        where: { id: source.id },
        data: {
          renewalStage: "LOST",
          renewalStageNote: "Said they were moving to Google Workspace on price.",
          renewalStageAt: back(int(25, 35)),
          renewalStageById: pinnedBy,
        },
      });
      await punchRenewal(PO(27), source, back(int(1, 2)));
    });

    // S28 · Held until the advance came in, then sent to purchase by the salesperson — booked from that moment.
    await done(PO(28), async () => {
      const c = nextCustomer();
      const i = item("Logitech Rally Bar");
      const at = back(int(25, 45));
      const by = salespersonFor(c);
      const o = await punch({ po: PO(28), company: c, item: i, quantity: 1, unitPrice: Math.round(i.price * 0.96), by, at, paymentTerms: "ADVANCE", handoff: "HOLD" });
      const approvedAt = later(at, 1, 2);
      await decide(o, approver(), approvedAt, true, "Advance terms — sales to release once it is in.");
      const releasedAt = later(approvedAt, 4, 9);
      await release(o, by, releasedAt);
      await buy(o, purchaser(), supplier(i), Math.round(i.cost * 0.99), later(releasedAt, 0, 2));
    });

    const counts = await db.companyProduct.groupBy({
      by: ["orderStatus"],
      where: { poNumber: { startsWith: "45007" }, company: { tags: { has: DEMO_TAG } } },
      _count: { _all: true },
    });
    const summary = counts.map((c) => `${c._count._all} ${c.orderStatus.toLowerCase().replace("_", " ")}`).join(", ");
    return made === 0 ? `already there — ${summary}` : `${made} orders walked through their steps — ${summary}`;
  }

  /** Orders from the main demo moved through the steps by the people working them. */
  async function placeDemoOrdersOnSteps(): Promise<number> {
    const plan: { status: OrderStatus; route: string[]; take: number }[] = [
      { status: "APPROVED", route: ["Site ready"], take: 6 },
      { status: "PROCESSING", route: ["Material received"], take: 6 },
      { status: "PROCESSING", route: ["Material received", "Installation"], take: 6 },
      { status: "FULFILLED", route: ["Training done"], take: 8 },
    ];
    // Once is enough: a second run would only move another batch along.
    if (await db.companyProduct.count({ where: { stepId: stepNamed("Training done").id, company: { tags: { has: DEMO_TAG } }, AND: [NOT_SCENARIO] } })) return 0;
    let moved = 0;
    for (const p of plan) {
      const orders = await db.companyProduct.findMany({
        where: { orderStatus: p.status, stepId: null, stepChanges: { none: {} }, company: { tags: { has: DEMO_TAG } }, AND: [NOT_SCENARIO] },
        select: { id: true, createdAt: true, addedByUserId: true, purchasedByUserId: true },
        orderBy: { createdAt: "desc" },
        take: p.take,
      });
      for (const o of orders) {
        let at = later(o.createdAt, 2, 6);
        for (const label of p.route) {
          const by = p.status === "APPROVED" ? o.addedByUserId : p.status === "PROCESSING" ? (o.purchasedByUserId ?? pick(purchasers).id) : pick(assetKeepers).id;
          if (await moveToStep(o.id, label, by, at)) moved += 1;
          at = later(at, 2, 7);
        }
      }
    }
    return moved;
  }

  /** The people an order's installation or delivery involves, added as watchers when it was punched. */
  async function seedWatchers(): Promise<number> {
    const already = await db.companyProduct.count({ where: { watchers: { some: {} }, company: { tags: { has: DEMO_TAG } }, AND: [NOT_SCENARIO] } });
    const orders = already > 0 ? [] : await db.companyProduct.findMany({
      where: {
        company: { tags: { has: DEMO_TAG } },
        orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] },
        item: { type: { in: ["GOOD", "SERVICE"] } },
        watchers: { none: {} },
        AND: [NOT_SCENARIO],
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 14,
    });
    for (const o of orders) {
      await db.companyProduct.update({ where: { id: o.id }, data: { watchers: { connect: some(assetKeepers, int(1, 2)).map((p) => ({ id: p.id })) } } });
    }
    return db.companyProduct.count({ where: { watchers: { some: {} }, company: { tags: { has: DEMO_TAG } } } });
  }

  /**
   * The three stages a person pins by hand (`setRenewalStage` allows NEGOTIATING, ON_HOLD and LOST only),
   * and the evidence the derived ones are read from: an open renewal task names the subscription
   * (TASK_RAISED), a call is logged against it (CONTACTED). QUOTED comes from the invoices and proposals
   * already on file, RENEWED from the renewals punched above, NOT_STARTED is everything else.
   */
  async function seedRenewalStages(): Promise<string> {
    const pinned = await db.companyProduct.count({ where: { renewalStage: { in: ["NEGOTIATING", "ON_HOLD"] }, company: { tags: { has: DEMO_TAG } } } });
    let tasks = 0;
    let calls = 0;
    let pins = 0;
    const subscriptions = await db.companyProduct.findMany({
      where: {
        company: { tags: { has: DEMO_TAG } },
        parentId: null,
        renewedBy: null,
        renewalStage: null,
        orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
        item: { type: "SUBSCRIPTION" },
        endDate: { gte: daysAgo(60), lte: daysAhead(75) },
        calls: { none: {} },
      },
      select: {
        id: true, orderSeq: true, companyId: true, endDate: true,
        item: { select: { name: true } },
        company: { select: { name: true, ownerUserId: true, contacts: { where: { phone: { not: null } }, select: { id: true, phone: true }, take: 1 } } },
      },
      orderBy: { endDate: "asc" },
    });
    const owner = (s: (typeof subscriptions)[number]) => (s.company.ownerUserId && salesIds.has(s.company.ownerUserId) ? s.company.ownerUserId : pick(sales).id);
    const queue = some(subscriptions, subscriptions.length);
    if (pinned === 0) {
      const pin = async (stage: RenewalStage, note: string, count: number) => {
        for (let k = 0; k < count && queue.length > 0; k++) {
          const s = queue.shift()!;
          await db.companyProduct.update({
            where: { id: s.id },
            data: { renewalStage: stage, renewalStageNote: note, renewalStageAt: back(int(2, 20)), renewalStageById: owner(s) },
          });
          pins += 1;
        }
      };
      await pin("NEGOTIATING", "Asking for 8% off in exchange for a three-year commitment.", 2);
      await pin("ON_HOLD", "Budget freeze until their Q3 board meeting — CFO to confirm.", 2);
      await pin("LOST", "Consolidating on the group's global agreement; IT procurement moved to the parent company.", 1);
      await pin("LOST", "Went with a cheaper reseller — lost on price by about 6%.", 1);

      // An open renewal task, as `bulkCreateRenewalTasks` writes it — matched back by company and title.
      for (let k = 0; k < 3 && queue.length > 0; k++) {
        const s = queue.shift()!;
        const title = `Renew ${s.item.name} — ${s.company.name}`;
        if (await db.task.findFirst({ where: { companyId: s.companyId, title, done: false }, select: { id: true } })) continue;
        await db.task.create({
          data: {
            title,
            description: `${formatOrderId(s.orderSeq)} expires ${s.endDate ? isoDay(s.endDate) : "soon"}.`,
            dueDate: s.endDate,
            companyId: s.companyId,
            assignedToUserId: owner(s),
            createdByUserId: pick(lossApprovers).id,
            createdAt: back(int(3, 15)),
          },
        });
        tasks += 1;
      }
      // A call logged against the subscription.
      for (let k = 0; k < 3 && queue.length > 0; k++) {
        const s = queue.shift()!;
        const contact = s.company.contacts[0];
        const startedAt = back(int(1, 12));
        await db.callLog.create({
          data: {
            companyId: s.companyId,
            contactId: contact?.id ?? null,
            companyProductId: s.id,
            phoneNumber: contact?.phone ?? `+91 22${int(20000000, 69999999)}`,
            direction: "OUTBOUND",
            outcome: pick(["CONNECTED", "CONNECTED", "CALLBACK_REQUESTED"] as const),
            startedAt,
            durationSeconds: int(90, 600),
            notes: pick([
              "Renewal call — they want the same seat count, asked for the quote by Friday.",
              "Spoke to the IT head about the renewal; adding two seats possibly.",
              "Renewal reminder — finance to raise the PO next week.",
            ]),
            userId: owner(s),
            createdAt: startedAt,
          },
        });
        calls += 1;
      }
    }
    const byStage = await db.companyProduct.groupBy({ by: ["renewalStage"], where: { renewalStage: { not: null }, company: { tags: { has: DEMO_TAG } } }, _count: { _all: true } });
    return `${pins} pinned this run (${byStage.map((b) => `${b._count._all} ${String(b.renewalStage).toLowerCase().replace("_", " ")}`).join(", ")}), ${tasks} renewal tasks, ${calls} renewal calls`;
  }

  async function seedRebates(): Promise<string> {
    const brands = new Map((await db.brand.findMany({ select: { id: true, name: true } })).map((b) => [b.name, b.id]));
    const manager = pick(rebateManagers).id;
    const today = new Date();
    const fyStartYear = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    const fyTo = new Date(Date.UTC(fyStartYear + 1, 2, 31));

    // ── Programmes (Settings → Rebate programmes) ──
    const programmePlan: Prisma.RebateProgrammeUncheckedCreateInput[] = [
      {
        name: "Microsoft CSP — distributor back-end", brandId: brands.get("Microsoft") ?? null, vendorId: supplierOf("Microsoft").id,
        basis: "PURCHASE_VALUE", rate: 2.5, needsDealRegistration: false, payer: "DISTRIBUTOR", settlement: "CREDIT_NOTE",
        validFrom: new Date(Date.UTC(fyStartYear - 1, 3, 1)), validTo: fyTo, active: true, notes: "Paid quarterly as a credit note against our account.",
      },
      {
        name: "Adobe VIP — deal registration", brandId: brands.get("Adobe") ?? null, vendorId: null,
        basis: "SALE_VALUE", rate: 6, needsDealRegistration: true, payer: "OEM", settlement: "PAYOUT",
        validFrom: new Date(Date.UTC(fyStartYear - 1, 3, 1)), validTo: fyTo, active: true, notes: "Only on registered deals; Adobe pays into the bank twice a year.",
      },
      {
        name: "Autodesk Accelerate FY25-26", brandId: brands.get("Autodesk") ?? null, vendorId: supplierOf("Autodesk").id,
        basis: "PURCHASE_VALUE", rate: 4, needsDealRegistration: false, payer: "DISTRIBUTOR", settlement: "CREDIT_NOTE",
        validFrom: new Date(Date.UTC(fyStartYear - 1, 3, 1)), validTo: new Date(Date.UTC(fyStartYear, 2, 31)), active: false,
        notes: "Closed at the end of last year — kept for the orders that came from it.",
      },
      {
        name: "Dell partner back-end", brandId: brands.get("Dell") ?? null, vendorId: supplierOf("Dell").id,
        basis: "PURCHASE_VALUE", rate: 3, needsDealRegistration: false, payer: "DISTRIBUTOR", settlement: "CREDIT_NOTE",
        validFrom: new Date(Date.UTC(fyStartYear - 1, 3, 1)), validTo: null, active: true, notes: "Settled against the vendor's own bills.",
      },
      {
        name: "Sophos MDR launch incentive", brandId: brands.get("Sophos") ?? null, vendorId: null,
        basis: "SALE_VALUE", rate: 5, needsDealRegistration: false, payer: "OEM", settlement: "PAYOUT",
        validFrom: new Date(Date.UTC(fyStartYear - 1, 9, 1)), validTo: fyTo, active: true, notes: null,
      },
    ];
    let programmesAdded = 0;
    for (const p of programmePlan) {
      if (await db.rebateProgramme.findFirst({ where: { name: p.name }, select: { id: true } })) continue;
      const createdAt = back(int(200, 330));
      await db.rebateProgramme.create({ data: { ...p, updatedById: manager, createdAt } });
      programmesAdded += 1;
    }
    const programmes = await db.rebateProgramme.findMany({
      where: { name: { in: programmePlan.map((p) => p.name) } },
      select: { id: true, name: true, brandId: true, vendorId: true, needsDealRegistration: true, validFrom: true, validTo: true, active: true, basis: true, rate: true, payer: true, settlement: true },
    });
    const programme = (name: string) => programmes.find((p) => p.name === name);

    // ── Deal registrations on some of the year's licensing orders — what the Adobe programme needs ──
    const registerable = await db.companyProduct.findMany({
      where: {
        company: { tags: { has: DEMO_TAG } },
        dealRegStatus: null,
        orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] },
        item: { brand: { name: { in: ["Adobe", "Autodesk"] } } },
        AND: [NOT_SCENARIO],
      },
      select: { id: true, createdAt: true, orderStatus: true, item: { select: { brand: { select: { name: true } } } } },
      take: 12,
    });
    for (const [k, o] of registerable.entries()) {
      const status: DealRegStatus = o.orderStatus === "APPROVED" && k % 3 === 0 ? "APPLIED" : k % 5 === 4 ? "REJECTED" : "APPROVED";
      await db.companyProduct.update({
        where: { id: o.id },
        data: {
          dealRegStatus: status,
          dealRegNumber: `${o.item.brand?.name === "Adobe" ? "ADB-VIP" : "ADSK"}-${int(100000, 999999)}`,
          dealRegValidTo: status === "REJECTED" ? null : calDay(new Date(o.createdAt.getTime() + 90 * DAY)),
        },
      });
    }

    // ── Each order's expected rebates, from the programmes that applied the day it was booked ──
    const candidates = await db.companyProduct.findMany({
      where: {
        company: { tags: { has: DEMO_TAG } },
        orderStatus: { in: ["PENDING_APPROVAL", "APPROVED", "PROCESSING", "FULFILLED"] },
        rebates: { none: {} },
        item: { brandId: { in: programmes.map((p) => p.brandId).filter((b): b is string => !!b) } },
      },
      select: { id: true, vendorId: true, quoteVendorId: true, dealRegStatus: true, bookedAt: true, createdAt: true, item: { select: { brandId: true, brand: { select: { name: true } } } } },
      orderBy: { createdAt: "asc" },
    });
    const oemFor = (brand: string) => (oems.length === 0 ? null : oems[(brand.length + brand.charCodeAt(0)) % oems.length]!.id);
    const asTheyWere = programmes.map((p) => ({ ...p, active: p.active || p.validTo !== null }));
    let rebatesAdded = 0;
    // Entered once: a second run would only pick another two-thirds of what is left.
    const entered = await db.orderRebate.count({ where: { programmeId: { in: programmes.map((p) => p.id) }, companyProduct: { AND: [NOT_SCENARIO] } } });
    for (const o of entered > 0 ? [] : candidates) {
      const on = isoDay(calDay(o.bookedAt ?? o.createdAt));
      const vendorId = o.vendorId ?? o.quoteVendorId;
      // As the programmes stood when it was punched: one switched off after it ended was on while it ran.
      const matches = matchingProgrammes(asTheyWere, { brandId: o.item.brandId, vendorId, dealRegStatus: o.dealRegStatus as DealRegStatusKey | null, on });
      // Not every order a programme could cover was entered — about two in three were.
      if (matches.length === 0 || (!chance(0.65) && !(await hasPoOn(o.id)))) continue;
      for (const p of matches.slice(0, 2)) {
        const payerCompanyId = p.payer === "DISTRIBUTOR" ? (p.vendorId ?? vendorId ?? null) : chance(0.85) ? oemFor(o.item.brand?.name ?? "") : null;
        await db.orderRebate.create({
          data: {
            companyProductId: o.id,
            programmeId: p.id,
            basis: p.basis,
            rate: p.rate,
            amount: null,
            payer: p.payer,
            payerCompanyId,
            settlement: p.settlement,
            createdById: pick([...rebateManagers, ...purchasers]).id,
            createdAt: later(o.createdAt, 0, 3),
          },
        });
        rebatesAdded += 1;
      }
    }
    // A fixed amount nobody's programme covers — a distributor's year-end volume bonus — on the long-road firewall order.
    const firewall = await db.companyProduct.findFirst({ where: { poNumber: PO(11), company: { tags: { has: DEMO_TAG } } }, select: { id: true, vendorId: true, createdAt: true } });
    if (firewall && !(await db.orderRebate.findFirst({ where: { companyProductId: firewall.id, basis: "AMOUNT" }, select: { id: true } }))) {
      await db.orderRebate.create({
        data: {
          companyProductId: firewall.id, basis: "AMOUNT", amount: 12500, payer: "DISTRIBUTOR", payerCompanyId: firewall.vendorId, settlement: "CREDIT_NOTE",
          note: "Year-end volume bonus agreed with the distributor's partner manager.", createdById: manager, createdAt: later(firewall.createdAt, 1, 2),
        },
      });
      rebatesAdded += 1;
    }
    // The negative call waiting for a manager: the OEM's rebate on a registered deal is what makes it worth it.
    const negative = await db.companyProduct.findFirst({ where: { poNumber: PO(3), company: { tags: { has: DEMO_TAG } } }, select: { id: true, createdAt: true, _count: { select: { rebates: true } } } });
    const vip = programme("Adobe VIP — deal registration");
    if (negative && vip && negative._count.rebates === 0) {
      await db.orderRebate.create({
        data: {
          companyProductId: negative.id, programmeId: vip.id, basis: vip.basis, rate: vip.rate, payer: vip.payer, payerCompanyId: oemFor("Adobe"),
          settlement: vip.settlement, note: "Registered deal — VIP rebate confirmed by Adobe's partner manager.", createdById: manager, createdAt: negative.createdAt,
        },
      });
      rebatesAdded += 1;
    }
    // Written off: the closed Autodesk programme's rebates nobody claimed in time.
    const accelerate = programme("Autodesk Accelerate FY25-26");
    let writtenOff = 0;
    if (accelerate && (await db.orderRebate.count({ where: { programmeId: accelerate.id, writtenOffAt: { not: null } } })) === 0) {
      const toWriteOff = await db.orderRebate.findMany({ where: { programmeId: accelerate.id, allocations: { none: {} } }, select: { id: true, createdAt: true }, take: 2 });
      for (const r of toWriteOff) {
        await db.orderRebate.update({
          where: { id: r.id },
          data: { writtenOffAt: later(r.createdAt, 30, 90), writtenOffById: manager, writeOffReason: "Claim window closed before we filed — the distributor won't honour it." },
        });
        writtenOff += 1;
      }
    }

    // ── Vendor credits: what came back, posted to the books, set against the rebates and bills ──
    const credits = await seedVendorCredits();
    const totals = await db.orderRebate.count({ where: { companyProduct: { company: { tags: { has: DEMO_TAG } } } } });
    return `${programmesAdded} programmes added, ${rebatesAdded} rebates entered (${totals} in all), ${writtenOff} written off; ${credits}`;
  }

  /** Whether an order is one of this file's scenarios — those always get their rebate. */
  async function hasPoOn(orderId: string) {
    const o = await db.companyProduct.findUnique({ where: { id: orderId }, select: { poNumber: true } });
    return !!o?.poNumber?.startsWith("45007");
  }

  /** What is still to come on each of these rebates, worked out as the order's page does. */
  async function outstandingOn(where: Prisma.OrderRebateWhereInput) {
    const rebates = await db.orderRebate.findMany({ where: { ...where, writtenOffAt: null }, select: { id: true, companyProductId: true, createdAt: true } });
    const out: { orderRebateId: string; outstanding: number; createdAt: Date }[] = [];
    for (const r of rebates) {
      const order = await db.companyProduct.findUnique({ where: { id: r.companyProductId }, select: { ...ORDER_REBATE_SELECT, orderStatus: true } });
      if (!order || order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "PENDING_APPROVAL") continue;
      const line = rebateSummary(order).rebates.find((x) => x.id === r.id);
      if (line && line.outstanding > 0) out.push({ orderRebateId: r.id, outstanding: line.outstanding, createdAt: r.createdAt });
    }
    return out;
  }

  /** A bill's settlement, counting the vendor credits set against it — `billBalance` in src/actions/vendor-credit.ts. */
  async function billBalance(billId: string) {
    const bill = await db.tradeDocument.findUniqueOrThrow({
      where: { id: billId },
      select: { total: true, status: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } }, vendorCredits: { select: { amount: true } } },
    });
    const sum = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
    return { bill, settlement: settleInvoice(Number(bill.total), sum(bill.payments), sum(bill.creditsReceived) + sum(bill.vendorCredits)) };
  }

  async function seedVendorCredits(): Promise<string> {
    const recorder = pick(rebateManagers).id;
    const bank = await db.bankAccount.findFirst({ where: { isDefault: true, active: true }, select: { id: true } });
    let added = 0;
    let allocations = 0;
    let applications = 0;
    let cancelled = 0;

    type CreditPlan = {
      vendorId: string;
      reference: string;
      form: "CREDIT_NOTE" | "PAYOUT";
      kind: "REBATE" | "PRICE_DIFFERENCE" | "OTHER";
      date: Date;
      /** Rebates to settle in full (or `share` of each), and bills to set the credit note against. */
      rebates?: Prisma.OrderRebateWhereInput;
      share?: number;
      bills?: { amount: number }[];
      /** Before GST when nothing is allocated. */
      taxable?: number;
      gst: "IGST" | "CGST_SGST" | "NONE";
      notes?: string;
      cancelReason?: string;
    };

    const msDistributor = supplierOf("Microsoft");
    const dellVendor = supplierOf("Dell");
    const anotherVendor = hardwareVendors.find((v) => v.id !== dellVendor.id && (openBills.get(v.id) ?? 0) > 0) ?? hardwareVendors.find((v) => v.id !== dellVendor.id) ?? dellVendor;
    const adobeOem = oems.length ? oems[("Adobe".length + "Adobe".charCodeAt(0)) % oems.length]! : null;
    const sophosOem = oems.length ? oems[("Sophos".length + "Sophos".charCodeAt(0)) % oems.length]! : null;
    const fy = financialYearOf(new Date());
    const plans: CreditPlan[] = [
      {
        vendorId: msDistributor.id, reference: `CN/${fy}/0412`, form: "CREDIT_NOTE", kind: "REBATE", date: calDay(daysAgo(int(25, 40))), gst: "IGST",
        rebates: { payerCompanyId: msDistributor.id, programme: { name: "Microsoft CSP — distributor back-end" } },
        notes: "Q1 CSP back-end, as per their claim statement.",
      },
      {
        vendorId: dellVendor.id, reference: `CN-4471/${fy}`, form: "CREDIT_NOTE", kind: "REBATE", date: calDay(daysAgo(int(10, 20))), gst: "CGST_SGST",
        rebates: { payerCompanyId: dellVendor.id }, bills: [{ amount: 0 }],
        notes: "Back-end on Dell hardware — they set it against what we owe them.",
      },
      ...(adobeOem
        ? [{
            vendorId: adobeOem.id, reference: "UTRN26091804417", form: "PAYOUT" as const, kind: "REBATE" as const, date: calDay(daysAgo(int(5, 15))), gst: "NONE" as const,
            rebates: { payerCompanyId: adobeOem.id, programme: { name: "Adobe VIP — deal registration" } }, share: 0.5,
            notes: "First half-year VIP payout — Adobe pays the rest in March.",
          }]
        : []),
      ...(sophosOem
        ? [{
            vendorId: sophosOem.id, reference: `MDF-${fy}-Q2`, form: "PAYOUT" as const, kind: "OTHER" as const, date: calDay(daysAgo(int(30, 60))), gst: "NONE" as const,
            taxable: 40000, notes: "Marketing development funds for the partner breakfast we hosted.",
          }]
        : []),
      {
        vendorId: anotherVendor.id, reference: `PP/${fy}/117`, form: "CREDIT_NOTE", kind: "PRICE_DIFFERENCE", date: calDay(daysAgo(int(15, 30))), gst: "CGST_SGST",
        bills: [{ amount: 0 }], notes: "Price protection — the list price dropped a week after we bought.",
      },
      {
        vendorId: msDistributor.id, reference: `CN/${fy}/0398`, form: "CREDIT_NOTE", kind: "REBATE", date: calDay(daysAgo(int(45, 60))), gst: "IGST",
        taxable: 18500, notes: "Recorded from the email before the signed copy came.",
        cancelReason: "Entered twice — this is the draft of CN/0412, which replaced it.",
      },
    ];

    for (const plan of plans) {
      if (await db.vendorCredit.findFirst({ where: { reference: plan.reference, vendor: { tags: { has: DEMO_TAG } } }, select: { id: true } })) continue;
      const due = plan.rebates ? await outstandingOn(plan.rebates) : [];
      const alloc = due
        .filter((d) => d.createdAt <= plan.date)
        .map((d) => ({ orderRebateId: d.orderRebateId, amount: round2(d.outstanding * (plan.share ?? 1)) }))
        .filter((a) => a.amount > 0);
      const allocated = round2(alloc.reduce((t, a) => t + a.amount, 0));
      const taxable = round2(Math.max(allocated, plan.taxable ?? 0) || 7500 + int(0, 50) * 100);
      const gstTotal = plan.gst === "NONE" ? 0 : round2(taxable * 0.18);
      const cgst = plan.gst === "CGST_SGST" ? round2(gstTotal / 2) : 0;
      const sgst = plan.gst === "CGST_SGST" ? round2(gstTotal - cgst) : 0;
      const igst = plan.gst === "IGST" ? gstTotal : 0;
      const total = round2(taxable + cgst + sgst + igst);

      // A credit note may go against its issuer's open rupee bills — within each bill's balance and its own total.
      const apps: { billId: string; amount: number }[] = [];
      if (plan.bills && plan.form === "CREDIT_NOTE") {
        const open = await db.tradeDocument.findMany({
          where: { docType: "BILL", direction: "PURCHASE", companyId: plan.vendorId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, currency: "INR", issueDate: { lte: plan.date } },
          select: { id: true },
          orderBy: { issueDate: "asc" },
        });
        let left = total;
        for (const b of open) {
          if (left <= 0.005) break;
          const balance = (await billBalance(b.id)).settlement.balance;
          const amount = round2(Math.min(left, balance));
          if (amount <= 0.005) continue;
          apps.push({ billId: b.id, amount });
          left = round2(left - amount);
          if (apps.length >= plan.bills.length) break;
        }
      }

      const createdAt = new Date(plan.date.getTime() + int(10, 17) * 3_600_000);
      const credit = await db.$transaction(async (tx) => {
        const row = await tx.vendorCredit.create({
          data: {
            vendorId: plan.vendorId, form: plan.form, kind: plan.kind, reference: plan.reference, date: plan.date,
            taxableAmount: taxable, cgstAmount: cgst, sgstAmount: sgst, igstAmount: igst, total,
            bankAccountId: plan.form === "PAYOUT" ? (bank?.id ?? null) : null,
            notes: plan.notes ?? null, createdById: recorder, createdAt,
          },
          select: { id: true },
        });
        for (const a of alloc) {
          await tx.rebateAllocation.create({ data: { vendorCreditId: row.id, orderRebateId: a.orderRebateId, amount: a.amount, createdById: recorder, createdAt } });
        }
        for (const a of apps) {
          await tx.vendorCreditApplication.create({ data: { vendorCreditId: row.id, billId: a.billId, amount: a.amount, createdById: recorder, createdAt } });
        }
        await postVendorCreditToLedger(tx, row.id, recorder);
        return row;
      });
      for (const a of apps) await syncBill(a.billId);
      added += 1;
      allocations += alloc.length;
      applications += apps.length;

      if (plan.cancelReason) {
        const applied = await db.vendorCreditApplication.findMany({ where: { vendorCreditId: credit.id }, select: { billId: true } });
        await db.$transaction(async (tx) => {
          await tx.rebateAllocation.deleteMany({ where: { vendorCreditId: credit.id } });
          await tx.vendorCreditApplication.deleteMany({ where: { vendorCreditId: credit.id } });
          await reverseVendorCreditPosting(tx, credit.id, recorder);
          await tx.vendorCredit.update({ where: { id: credit.id }, data: { cancelledAt: later(createdAt, 3, 10), cancelledById: recorder, cancelReason: plan.cancelReason } });
        });
        for (const a of applied) await syncBill(a.billId);
        cancelled += 1;
      }
    }
    const all = await db.vendorCredit.count({ where: { vendor: { tags: { has: DEMO_TAG } } } });
    return `${added} vendor credits recorded and posted (${all} in all, ${cancelled} cancelled and reversed), ${allocations} set against rebates, ${applications} against bills`;
  }

  /** `syncBill`: a bill's status after what is set against it changed. */
  async function syncBill(billId: string) {
    const { bill, settlement } = await billBalance(billId);
    if (bill.status === "CANCELLED" || bill.status === "DRAFT") return;
    const next = settledStatus(settlement);
    if (next !== bill.status) await db.tradeDocument.update({ where: { id: billId }, data: { status: next } });
  }

  /** `soldInPeriod` (src/lib/reconcile/data.ts), on this client. */
  async function soldInPeriod(period: { start: Date; end: Date }): Promise<SoldOrder[]> {
    const lookBack = new Date(period.start);
    lookBack.setMonth(lookBack.getMonth() - 12);
    const orders = await db.companyProduct.findMany({
      where: {
        orderStatus: { notIn: ["REJECTED", "CANCELLED"] },
        OR: [
          { startDate: null, endDate: null },
          { startDate: { lte: period.end }, endDate: null },
          { startDate: null, endDate: { gte: period.start } },
          { startDate: { lte: period.end }, endDate: { gte: period.start } },
          { endDate: { gte: lookBack, lt: period.start } },
        ],
      },
      select: {
        id: true, quantity: true, purchasePrice: true, dealPrice: true, startDate: true, endDate: true, orderSeq: true, vendorId: true,
        item: { select: { sku: true, name: true } },
        company: { select: { id: true, name: true, website: true } },
        endCustomer: { select: { name: true, website: true } },
      },
    });
    return orders.map((o) => ({
      orderId: o.id,
      companyId: o.company.id,
      companyName: o.company.name,
      aliases: [o.company.website, o.endCustomer?.name, o.endCustomer?.website].filter((a): a is string => Boolean(a && a.trim())),
      sku: o.item.sku,
      quantity: o.quantity,
      purchasePrice: o.purchasePrice === null ? null : Number(o.purchasePrice),
      dealPrice: o.dealPrice === null ? null : Number(o.dealPrice),
      startDate: o.startDate,
      endDate: o.endDate,
      orderLabel: o.orderSeq ? `#${o.orderSeq} · ${o.item.name}` : o.item.name,
      vendorId: o.vendorId,
    }));
  }

  /** `storeStatement` in src/actions/reconcile.ts: run the comparison and write it down. */
  async function storeStatement(p: {
    vendorId: string;
    label: string;
    filename: string | null;
    period: { start: Date; end: Date };
    billing: Billing;
    complete: boolean;
    prepared: { row: StatementRow; raw: Record<string, string> | null }[];
    notes?: string;
    mapping?: ColumnMapping | null;
    uploadedById: string;
    uploadedAt: Date;
  }) {
    const sold = await soldInPeriod(p.period);
    const skus = (await db.item.findMany({ select: { sku: true } })).map((i) => i.sku);
    const result = reconcile(p.prepared.map((x) => x.row), sold, p.period, { billing: p.billing, catalogSkus: skus, vendorId: p.vendorId, reportMissing: p.complete });
    const rawByRow = new Map(p.prepared.map((x) => [x.row.rowNumber, x.raw]));
    const totalBilled = p.prepared.reduce((sum, x) => sum + x.row.lineTotal, 0);
    return db.$transaction(async (tx) => {
      const created = await tx.vendorStatement.create({
        data: {
          vendorId: p.vendorId, label: p.label, periodStart: p.period.start, periodEnd: p.period.end, billing: p.billing as StatementBilling,
          complete: p.complete, filename: p.filename, lineCount: p.prepared.length, totalBilled: totalBilled.toFixed(2),
          notes: p.notes ?? null, uploadedById: p.uploadedById, uploadedAt: p.uploadedAt,
        },
        select: { id: true },
      });
      await tx.vendorStatementLine.createMany({
        data: result.lines.map((line) => ({
          statementId: created.id,
          source: line.source,
          rowNumber: line.rowNumber,
          sku: line.sku,
          customerRef: line.customerRef,
          quantity: line.quantity,
          unitCost: line.unitCost.toFixed(2),
          lineTotal: line.lineTotal.toFixed(2),
          raw: line.rowNumber ? ((rawByRow.get(line.rowNumber) ?? null) as Prisma.InputJsonValue) : Prisma.JsonNull,
          state: line.state,
          matchedOrderId: line.matchedOrderId,
          matchedCompanyId: line.matchedCompanyId,
          variance: line.variance.toFixed(2),
          note: line.note || null,
        })),
      });
      if (p.mapping) {
        await tx.vendorStatementMapping.upsert({
          where: { vendorId: p.vendorId },
          create: { vendorId: p.vendorId, columns: p.mapping as Prisma.InputJsonValue, updatedById: p.uploadedById },
          update: { columns: p.mapping as Prisma.InputJsonValue, updatedById: p.uploadedById },
        });
      }
      return { id: created.id, summary: result.summary };
    });
  }

  async function seedStatements(): Promise<string> {
    const reconciler = pick(purchasers).id;
    const monthName = (d: Date) => d.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    const monthOf = (monthsBack: number) => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack + 1, 0));
      return { start, end };
    };
    const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
    const HEADERS = ["Part Number", "Product", "End Customer", "Qty", "Unit Price", "Extended Price", "Charge Start Date", "Charge End Date"] as const;
    const made: string[] = [];

    // ── A distributor's monthly statement, uploaded as a file — two months of it ──
    const dist = supplierOf("Microsoft");
    for (const [monthsBack, resolveSome] of [[2, true], [1, false]] as const) {
      const period = monthOf(monthsBack);
      const label = `${dist.name} — ${monthName(period.start)}`;
      if (await db.vendorStatement.findFirst({ where: { vendorId: dist.id, label }, select: { id: true } })) continue;
      const everything = await soldInPeriod(period);
      const live = (o: SoldOrder) => (!o.startDate || o.startDate <= period.end) && (!o.endDate || o.endDate >= period.start);
      const sold = everything.filter((o) => o.vendorId === dist.id && live(o));
      const rows: Record<string, string>[] = [];
      const line = (sku: string, product: string, customer: string, qty: number, unit: number) => {
        rows.push({
          "Part Number": sku, Product: product, "End Customer": customer, Qty: String(qty), "Unit Price": unit.toFixed(2),
          "Extended Price": (qty * unit).toFixed(2), "Charge Start Date": dmy(period.start), "Charge End Date": dmy(period.end),
        });
      };
      const productOf = (sku: string) => items.find((i) => i.sku === sku)?.name ?? "Microsoft subscription";
      const priced = sold.filter((o) => o.purchasePrice !== null);
      /**
       * One line a customer and SKU, as a distributor bills it: the seats of every order behind it
       * together. Where only one of our orders covers it, the line can disagree with it on purpose —
       * the first billed for more seats, the second above our cost, the third (last month) not at all.
       */
      const groups = new Map<string, SoldOrder[]>();
      for (const o of priced) groups.set(`${o.companyId}|${o.sku}`, [...(groups.get(`${o.companyId}|${o.sku}`) ?? []), o]);
      let singles = 0;
      for (const [k, group] of [...groups.values()].slice(0, 40).entries()) {
        const o = group[0]!;
        const single = everything.filter((x) => x.companyId === o.companyId && x.sku === o.sku && live(x)).length === 1;
        const nth = single ? ++singles : 0;
        if (nth === 3 && monthsBack === 1) continue; // left off the statement: sold, not billed
        const seats = group.reduce((t, x) => t + x.quantity, 0);
        const monthly = round2((o.dealPrice ?? o.purchasePrice!) / 12);
        const qty = nth === 1 ? seats + int(2, 5) : seats;
        const unit = nth === 2 ? round2(monthly * 1.08) : monthly;
        const customer = single && nth > 3 && k % 3 === 0 && o.aliases[0] ? o.aliases[0].replace(/^https?:\/\/(www\.)?/, "") : o.companyName;
        line(o.sku, productOf(o.sku), customer, qty, unit);
      }
      const msItem = items.find((i) => i.brand === "Microsoft" && i.type === "SUBSCRIPTION")!;
      line("CFQ7TTC0MM8R", "Microsoft 365 Copilot (Annual, billed monthly)", customers[3]!.name, 5, 2450);
      line(msItem.sku, msItem.name, "contoso-india.onmicrosoft.com", 12, round2(msItem.cost / 12));
      // A subscription that ended, still being charged for — and a SKU we stock that nobody here bought.
      const lapsed = everything.find(
        (o) => o.endDate && o.endDate < period.start && o.sku.startsWith(DEMO_SKU) && !everything.some((x) => x.companyId === o.companyId && x.sku === o.sku && live(x)),
      );
      if (lapsed) line(lapsed.sku, productOf(lapsed.sku), lapsed.companyName, lapsed.quantity, round2((lapsed.purchasePrice ?? 1200) / 12));
      const unsold = items.find((i) => i.brand === "Microsoft" && i.type === "SUBSCRIPTION" && !everything.some((o) => o.sku === i.sku));
      if (unsold) line(unsold.sku, unsold.name, customers[5]!.name, 2, round2(unsold.cost));
      // Two orders cover this one — an add-on beside its subscription.
      const addon = await db.companyProduct.findFirst({
        where: { poNumber: PO(24), company: { tags: { has: DEMO_TAG } } },
        select: { quantity: true, item: { select: { sku: true, name: true } }, company: { select: { name: true } }, parent: { select: { quantity: true } } },
      });
      if (addon) line(addon.item.sku, addon.item.name, addon.company.name, addon.quantity + (addon.parent?.quantity ?? 0), round2(msItem.cost / 12));

      const mapping = guessMapping([...HEADERS]);
      const mapped = applyMapping(rows, mapping);
      const stored = await storeStatement({
        vendorId: dist.id,
        label,
        filename: `${dist.name.split(" ")[0]}-CSP-${period.start.toISOString().slice(0, 7)}.csv`,
        period,
        billing: "MONTHLY",
        complete: true,
        prepared: mapped.rows.map((m) => ({ row: m.row, raw: m.raw })),
        mapping,
        uploadedById: reconciler,
        uploadedAt: duringWorkHours(new Date(period.end.getTime() + int(2, 5) * DAY)),
      });
      if (resolveSome) {
        const exceptions = await db.vendorStatementLine.findMany({ where: { statementId: stored.id, state: { not: "MATCHED" } }, select: { id: true, state: true }, take: 3 });
        const notes: Record<string, string> = {
          QUANTITY_MISMATCH: "Customer added seats directly in the portal — add-on order raised and invoiced.",
          PRICE_MISMATCH: "Distributor credited the difference on their next statement.",
          UNKNOWN_SKU: "New SKU — added to the catalogue.",
          UNKNOWN_CUSTOMER: "Tenant belongs to a customer's subsidiary — mapped to the parent account.",
          BILLED_NOT_SOLD: "Cancellation sent to the distributor; charge reversed.",
          SOLD_NOT_BILLED: "Billed on the following month's statement.",
          AMBIGUOUS: "Add-on and subscription billed together — agreed with the distributor.",
        };
        for (const e of exceptions) {
          await db.vendorStatementLine.update({
            where: { id: e.id },
            data: { resolvedAt: back(int(5, 20)), resolvedById: reconciler, resolutionNote: notes[e.state] ?? "Checked with the distributor." },
          });
        }
      }
      made.push(`${monthName(period.start)}: ${stored.summary.total} lines, ${stored.summary.exceptions} exceptions`);
    }

    // ── A typed spot check of the annual Autodesk renewals ──
    const autodeskDist = supplierOf("Autodesk");
    const annual = { start: new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), 1)), end: monthOf(1).end };
    const annualLabel = `${autodeskDist.name} — annual renewals spot check`;
    if (!(await db.vendorStatement.findFirst({ where: { vendorId: autodeskDist.id, label: annualLabel }, select: { id: true } }))) {
      const sold = (await soldInPeriod(annual)).filter((o) => o.vendorId === autodeskDist.id && o.purchasePrice !== null && (!o.endDate || o.endDate >= annual.start));
      const typed: ManualRow[] = sold.slice(0, 4).map((o, k) => ({
        sku: o.sku,
        customerRef: o.companyName,
        quantity: String(o.quantity),
        unitCost: (k === 1 ? round2(o.purchasePrice! * 1.04) : o.purchasePrice!).toFixed(2),
        lineTotal: "",
      }));
      const parsed = parseManualRows(typed);
      if (parsed.rows.length > 0) {
        const stored = await storeStatement({
          vendorId: autodeskDist.id, label: annualLabel, filename: null, period: annual, billing: "ANNUAL", complete: false,
          prepared: parsed.rows.map((row) => ({ row, raw: null })), notes: "Typed from their renewal invoices to check the uplift.",
          uploadedById: reconciler, uploadedAt: back(int(3, 10)),
        });
        made.push(`annual spot check: ${stored.summary.total} lines`);
      }
    }

    // ── A hardware vendor's one-off invoice, checked line by line ──
    const hw = supplierOf("Dell");
    const oneOff = monthOf(3);
    oneOff.end = monthOf(1).end;
    const oneOffLabel = `${hw.name} — hardware invoices, last quarter`;
    if (!(await db.vendorStatement.findFirst({ where: { vendorId: hw.id, label: oneOffLabel }, select: { id: true } }))) {
      const sold = (await soldInPeriod(oneOff)).filter((o) => o.vendorId === hw.id && o.purchasePrice !== null && o.startDate && o.startDate >= oneOff.start);
      const typed: ManualRow[] = sold.slice(0, 3).map((o) => ({ sku: o.sku, customerRef: o.companyName, quantity: String(o.quantity), unitCost: "", lineTotal: (o.purchasePrice! * o.quantity).toFixed(2) }));
      const parsed = parseManualRows(typed);
      if (parsed.rows.length > 0) {
        const stored = await storeStatement({
          vendorId: hw.id, label: oneOffLabel, filename: null, period: oneOff, billing: "ONE_OFF", complete: false,
          prepared: parsed.rows.map((row) => ({ row, raw: null })), uploadedById: reconciler, uploadedAt: back(int(2, 8)),
        });
        made.push(`one-off check: ${stored.summary.total} lines`);
      }
    }
    const states = await db.vendorStatementLine.groupBy({ by: ["state"], _count: { _all: true } });
    return `${made.length ? made.join("; ") : "already there"} — states: ${states.map((s) => `${s._count._all} ${s.state.toLowerCase()}`).join(", ")}`;
  }

  async function seedResellerStatuses(): Promise<string> {
    const profiles = await db.resellerProfile.findMany({
      where: { company: { tags: { has: DEMO_TAG } } },
      select: { id: true, status: true, companyId: true, notes: true },
      orderBy: { createdAt: "asc" },
    });
    const changed: string[] = [];
    const resellerOrder = await db.companyProduct.findFirst({ where: { poNumber: PO(20), company: { tags: { has: DEMO_TAG } } }, select: { companyId: true } });
    if (!profiles.some((p) => p.status === "SUSPENDED")) {
      const active = profiles.filter((p) => p.status === "ACTIVE" && p.companyId !== resellerOrder?.companyId);
      if (profiles.filter((p) => p.status === "ACTIVE").length > 1 && active.length > 0) {
        const p = active[active.length - 1]!;
        await db.resellerProfile.update({
          where: { id: p.id },
          data: { status: "SUSPENDED", notes: "Suspended — ₹4.2 lakh overdue past 60 days. No new orders until it is cleared.", updatedAt: back(int(5, 20)) },
        });
        changed.push("one suspended");
      }
    }
    if (!profiles.some((p) => p.status === "INACTIVE")) {
      const fresh = await db.resellerProfile.findMany({ where: { company: { tags: { has: DEMO_TAG } } }, select: { id: true, status: true } });
      const onboarding = fresh.filter((p) => p.status === "ONBOARDING");
      const target = onboarding.length > 1 ? onboarding[onboarding.length - 1] : fresh.find((p) => p.status === "ACTIVE" && fresh.filter((x) => x.status === "ACTIVE").length > 1);
      if (target) {
        await db.resellerProfile.update({
          where: { id: target.id },
          data: { status: "INACTIVE", notes: "Agreement never countersigned — they stopped responding after the first meeting.", updatedAt: back(int(30, 60)) },
        });
        changed.push("one inactive");
      }
    }
    const byStatus = await db.resellerProfile.groupBy({ by: ["status"], where: { company: { tags: { has: DEMO_TAG } } }, _count: { _all: true } });
    return `${changed.length ? changed.join(", ") : "no change"} — ${byStatus.map((b) => `${b._count._all} ${b.status.toLowerCase()}`).join(", ")}`;
  }

  /** `adjustStock`: sold, adjusted after a count, damaged, returned — the item's quantity kept in step. */
  async function seedStock(): Promise<string> {
    const keeper = pick(purchasers).id;
    let movements = 0;
    const apply = async (itemId: string, type: "SOLD" | "ADJUSTMENT" | "DAMAGED" | "RETURNED", change: number, reason: string, at: Date) => {
      const it = await db.item.findUniqueOrThrow({ where: { id: itemId }, select: { stockQuantity: true, trackInventory: true } });
      if (!it.trackInventory || it.stockQuantity + change < 0) return;
      await db.$transaction(async (tx) => {
        await tx.stockMovement.create({ data: { itemId, type, quantityChange: change, reason, createdByUserId: keeper, createdAt: at } });
        await tx.item.update({ where: { id: itemId }, data: { stockQuantity: it.stockQuantity + change } });
      });
      movements += 1;
    };
    // The new goods: their life since the opening stock.
    for (const seed of NEW_ITEMS.filter((s) => s.type === "GOOD")) {
      const it = await db.item.findUnique({ where: { sku: seed.sku }, select: { id: true, createdAt: true, _count: { select: { stockMovements: true } } } });
      if (!it || it._count.stockMovements > 1) continue;
      let at = later(it.createdAt, 10, 30);
      await apply(it.id, "SOLD", -int(1, 3), "Delivered against a customer order", at);
      at = later(at, 20, 50);
      await apply(it.id, "ADJUSTMENT", chance(0.5) ? 1 : -1, "Quarterly stock count — adjusted to what was on the shelf", at);
      at = later(at, 10, 40);
      if (chance(0.6)) await apply(it.id, "DAMAGED", -1, "Damaged in transit — carton crushed, written off with the courier's report", at);
      at = later(at, 5, 30);
      if (chance(0.5)) await apply(it.id, "RETURNED", 1, "Customer return — unopened, back to stock", at);
    }
    // A stock-take correction on goods the main demo stocks.
    const counted = await db.item.findMany({
      where: { sku: { startsWith: DEMO_SKU }, trackInventory: true, stockMovements: { none: { type: "ADJUSTMENT" } }, NOT: { sku: { in: NEW_ITEMS.map((s) => s.sku) } } },
      select: { id: true },
      orderBy: { sku: "asc" },
      take: 4,
    });
    const takenStock = await db.stockMovement.count({ where: { reason: "Annual stock take — book stock corrected to the physical count" } });
    for (const it of takenStock > 0 ? [] : counted) await apply(it.id, "ADJUSTMENT", pick([-2, -1, 1, 2]), "Annual stock take — book stock corrected to the physical count", back(int(10, 40)));
    return `${movements} movements — ${await db.stockMovement.count({ where: { type: "ADJUSTMENT" } })} adjustments in all`;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // The IT estate (src/actions/it-asset.ts and consignment.ts, step by step)
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  async function seedAssets(): Promise<string> {
    const recorder = () => pick(assetKeepers).id;
    const staff = some(everyone, everyone.length);
    const nextHolder = () => staff.shift() ?? pick(everyone);
    const hwVendor = supplierOf("Dell");
    let created = 0;

    type AssetSpec = {
      tag: string;
      kind: AssetKind;
      /** The catalogue item it is, or — for something we never sold — its own name, make and cost. */
      needle?: string;
      custom?: { name: string; make: string; cost: number };
      model?: string;
      purchasedDaysAgo: number;
      warrantyYears?: number;
      seats?: number;
      licenceKey?: string;
      notes?: string;
    };

    /** `saveAsset` for a new asset: the row, and the RECEIVED movement every history starts with. */
    async function addAsset(spec: AssetSpec) {
      if (await db.asset.findUnique({ where: { assetTag: spec.tag }, select: { id: true } })) return null;
      const it = spec.custom
        ? { id: null, name: spec.custom.name, brand: spec.custom.make, cost: spec.custom.cost }
        : item(spec.needle ?? "");
      const purchasedOn = calDay(daysAgo(spec.purchasedDaysAgo));
      const by = recorder();
      const problems = checkOwnership({ ownership: "INTERNAL", ownerCompanyId: null, fixedAssetId: null, siteCompanyId: null });
      if (problems.length) throw new Error(problems[0]!.message);
      const asset = await db.asset.create({
        data: {
          assetTag: spec.tag,
          serialNumber: spec.kind === "SOFTWARE_LICENCE" ? null : `${it.brand.slice(0, 2).toUpperCase()}${int(10_000_000, 99_999_999)}`,
          name: it.name,
          kind: spec.kind,
          status: "IN_STOCK",
          make: it.brand,
          model: spec.model ?? null,
          itemId: it.id,
          ownership: "INTERNAL",
          vendorCompanyId: spec.kind === "SOFTWARE_LICENCE" ? supplierOf(it.brand).id : spec.custom ? null : hwVendor.id,
          purchasedOn,
          purchaseCost: it.cost,
          warrantyEndsOn: spec.warrantyYears ? new Date(purchasedOn.getTime() + spec.warrantyYears * 365 * DAY) : null,
          seats: spec.seats ?? null,
          licenceKey: spec.licenceKey ?? null,
          notes: spec.notes ?? null,
          createdById: by,
          createdAt: duringWorkHours(daysAgo(spec.purchasedDaysAgo)),
        },
        select: { id: true },
      });
      await db.assetMovement.create({
        data: { assetId: asset.id, type: "RECEIVED", occurredAt: purchasedOn, note: "Added to the register", recordedById: by, createdAt: duringWorkHours(daysAgo(spec.purchasedDaysAgo)) },
      });
      created += 1;
      return { id: asset.id, purchasedOn, cost: it.cost };
    }

    /** `moveAsset`: the movement and the asset's new state, together. */
    async function move(
      assetId: string,
      type: AssetMovementType,
      daysBack: number,
      to: { userId?: string; companyId?: string; locationId?: string; contactId?: string; label?: string } = {},
      note?: string,
      acknowledge = false,
    ) {
      const a = await db.asset.findUniqueOrThrow({ where: { id: assetId }, select: { status: true, custodianUserId: true, siteCompanyId: true, locationId: true } });
      const allowed = canMove(a.status, type);
      if (!allowed.ok) throw new Error(`asset ${assetId}: ${allowed.reason}`);
      const occurredAt = calDay(daysAgo(daysBack));
      const status = statusAfter(type);
      const by = recorder();
      await db.$transaction(async (tx) => {
        await tx.assetMovement.create({
          data: {
            assetId, type, occurredAt,
            fromUserId: a.custodianUserId, fromCompanyId: a.siteCompanyId, fromLocationId: a.locationId,
            toUserId: to.userId ?? null, toCompanyId: to.companyId ?? null, toLocationId: to.locationId ?? null, toContactId: to.contactId ?? null, toLabel: to.label ?? null,
            note: note ?? null, recordedById: by, createdAt: duringWorkHours(daysAgo(daysBack)),
            ...(acknowledge && to.userId ? { acknowledgedAt: duringWorkHours(daysAgo(Math.max(0, daysBack - 1))), acknowledgedById: to.userId } : {}),
          },
        });
        await tx.asset.update({
          where: { id: assetId },
          data: {
            status,
            custodianUserId: to.userId ?? (status === "ASSIGNED" ? a.custodianUserId : null),
            holderContactId: to.contactId ?? null,
            siteCompanyId: to.companyId ?? (status === "IN_STOCK" ? null : a.siteCompanyId),
            locationId: to.locationId ?? (status === "IN_STOCK" ? null : a.locationId),
            ...(type === "SCRAPPED" ? { retiredOn: occurredAt, retiredReason: note ?? "Scrapped" } : {}),
          },
        });
      });
    }

    /** A consignment from draft (`createConsignment`) through dispatch, delivery or cancellation. */
    async function consign(
      assetIds: string[],
      reason: ConsignmentReason,
      plan: {
        draftDaysAgo: number;
        to?: SeededCompany | null;
        toAddress?: string;
        dispatchDaysAgo?: number;
        deliverDaysAgo?: number;
        installed?: boolean;
        cancel?: string;
        interstate?: boolean;
      },
    ) {
      const assets = await db.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, status: true, kind: true, purchaseCost: true, siteCompanyId: true, locationId: true, custodianUserId: true } });
      for (const a of assets) {
        if (a.kind === "SOFTWARE_LICENCE") throw new Error("a licence does not travel");
        const ok = canMove(a.status, "DISPATCHED");
        if (!ok.ok) throw new Error(ok.reason);
      }
      const by = recorder();
      const draftedAt = duringWorkHours(daysAgo(plan.draftDaysAgo));
      const prefix = `CON/${financialYearOf(draftedAt)}/`;
      const last = await db.consignment.findFirst({ where: { consignmentNumber: { startsWith: prefix } }, orderBy: { consignmentNumber: "desc" }, select: { consignmentNumber: true } });
      const number = `${prefix}${String(last ? Number(last.consignmentNumber.slice(prefix.length)) + 1 : 1).padStart(4, "0")}`;
      const declared = assets.reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0) || null;
      const head = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
      const to = plan.to ?? null;
      const consignment = await db.consignment.create({
        data: {
          consignmentNumber: number,
          reason,
          toCompanyId: to?.id ?? null,
          toLocationId: to?.locationId || null,
          toContactId: to?.contactIds[0] ?? null,
          toAddress: plan.toAddress ?? null,
          fromLabel: "Acme — Andheri East, Mumbai",
          courier: pick(["Blue Dart", "Delhivery", "DTDC", "Own vehicle"]),
          expectedOn: plan.dispatchDaysAgo !== undefined ? calDay(daysAgo(Math.max(0, plan.dispatchDaysAgo - int(1, 4)))) : null,
          interstate: plan.interstate ?? false,
          declaredValue: declared,
          branchId: head?.id ?? null,
          createdById: by,
          createdAt: draftedAt,
        },
        select: { id: true },
      });
      await db.assetMovement.createMany({
        data: assets.map((a) => ({
          assetId: a.id, type: "DISPATCHED" as const, occurredAt: draftedAt, consignmentId: consignment.id,
          fromCompanyId: a.siteCompanyId, fromLocationId: a.locationId, fromUserId: a.custodianUserId,
          note: "Added to this consignment — not yet dispatched", recordedById: by, createdAt: draftedAt,
        })),
      });
      if (plan.cancel) {
        await db.consignment.update({ where: { id: consignment.id }, data: { status: "CANCELLED", notes: plan.cancel, updatedAt: duringWorkHours(daysAgo(Math.max(0, plan.draftDaysAgo - 2))) } });
        await db.asset.updateMany({ where: { id: { in: assetIds } }, data: { status: "IN_STOCK" } });
        return;
      }
      if (plan.dispatchDaysAgo === undefined) return;
      const dispatchedOn = calDay(daysAgo(plan.dispatchDaysAgo));
      const needsEway = (declared ?? 0) > 50000;
      await db.consignment.update({
        where: { id: consignment.id },
        data: {
          status: "IN_TRANSIT",
          dispatchedOn,
          docketNumber: String(int(100_000_000, 999_999_999)),
          ewayBillNumber: needsEway ? String(int(100_000_000, 999_999_999)) + String(int(100, 999)) : null,
          ewayBillValidUntil: needsEway ? new Date(dispatchedOn.getTime() + 3 * DAY) : null,
        },
      });
      await db.assetMovement.updateMany({ where: { consignmentId: consignment.id }, data: { occurredAt: dispatchedOn, note: null } });
      await db.asset.updateMany({ where: { id: { in: assetIds } }, data: { status: "IN_TRANSIT" } });
      if (plan.deliverDaysAgo === undefined) return;
      const deliveredOn = calDay(daysAgo(plan.deliverDaysAgo));
      const receivedBy = pick(["Reception", "Stores", "IT team", "Security desk"]);
      const returning = reason === "REPAIR_RETURN";
      await db.consignment.update({ where: { id: consignment.id }, data: { status: "DELIVERED", deliveredOn, receivedBy } });
      for (const a of assets) {
        await db.assetMovement.create({
          data: {
            assetId: a.id, type: returning ? "BACK_FROM_REPAIR" : plan.installed ? "INSTALLED" : "DELIVERED", occurredAt: deliveredOn, consignmentId: consignment.id,
            toCompanyId: returning ? null : (to?.id ?? null), toLocationId: returning ? null : (to?.locationId || null), toContactId: returning ? null : (to?.contactIds[0] ?? null),
            note: `Received by ${receivedBy}`, recordedById: by, createdAt: duringWorkHours(daysAgo(plan.deliverDaysAgo)),
          },
        });
      }
      await db.asset.updateMany({
        where: { id: { in: assetIds } },
        data: returning
          ? { status: "IN_STOCK", siteCompanyId: null, locationId: null }
          : { status: "INSTALLED", siteCompanyId: to?.id ?? null, locationId: to?.locationId || null, holderContactId: to?.contactIds[0] ?? null },
      });
    }

    /** Ours, now at a client's site: the ownership edit made once it got there (`saveAsset` checks the site). */
    async function nowDeployed(assetId: string) {
      const a = await db.asset.findUniqueOrThrow({ where: { id: assetId }, select: { siteCompanyId: true } });
      const problems = checkOwnership({ ownership: "DEPLOYED" as AssetOwnership, ownerCompanyId: null, fixedAssetId: null, siteCompanyId: a.siteCompanyId });
      if (problems.length) throw new Error(problems[0]!.message);
      await db.asset.update({ where: { id: assetId }, data: { ownership: "DEPLOYED" } });
    }

    const clients = some(customers, 6);

    // A laptop issued, handed back when its holder left, wiped and back in stock.
    const a1 = await addAsset({ tag: "DMO-A001", kind: "LAPTOP", needle: "Dell Latitude 3550", purchasedDaysAgo: 330, warrantyYears: 3 });
    if (a1) {
      const holder = nextHolder();
      await move(a1.id, "ASSIGNED", 328, { userId: holder.id }, "New joiner kit", true);
      await move(a1.id, "RETURNED", 40, {}, "Returned on exit — wiped and re-imaged");
    }
    // A laptop out for repair and back with the same person.
    const a2 = await addAsset({ tag: "DMO-A002", kind: "LAPTOP", needle: "HP ProBook 450", purchasedDaysAgo: 300, warrantyYears: 3 });
    if (a2) {
      const holder = nextHolder();
      await move(a2.id, "ASSIGNED", 298, { userId: holder.id }, undefined, true);
      await move(a2.id, "SENT_FOR_REPAIR", 60, { label: "HP authorised service centre, Andheri" }, "Hinge cracked — warranty claim");
      await move(a2.id, "BACK_FROM_REPAIR", 48, {}, "Hinge and bezel replaced under warranty");
      await move(a2.id, "ASSIGNED", 47, { userId: holder.id }, "Back with its user", true);
    }
    // A laptop away being repaired right now.
    const a3 = await addAsset({ tag: "DMO-A003", kind: "LAPTOP", needle: "Lenovo ThinkPad E14", purchasedDaysAgo: 250, warrantyYears: 1 });
    if (a3) {
      await move(a3.id, "ASSIGNED", 248, { userId: nextHolder().id }, undefined, true);
      await move(a3.id, "SENT_FOR_REPAIR", 9, { label: "Lenovo service centre, Pune" }, "Battery swelling — case W-58213 with Lenovo");
    }
    // A desktop that died out of warranty: returned, then scrapped.
    const a4 = await addAsset({ tag: "DMO-A004", kind: "DESKTOP", needle: "Dell OptiPlex 7020", purchasedDaysAgo: 360, warrantyYears: 1 });
    if (a4) {
      await move(a4.id, "ASSIGNED", 355, { userId: nextHolder().id }, undefined, true);
      await move(a4.id, "RETURNED", 35, {}, "Would not power on");
      await move(a4.id, "SCRAPPED", 20, {}, "Motherboard failed out of warranty — disposed of through a certified e-waste recycler");
    }
    // A desk phone nobody can find since the office move.
    const a5 = await addAsset({ tag: "DMO-A005", kind: "PHONE", needle: "Cisco IP Phone 8841", purchasedDaysAgo: 200, warrantyYears: 1 });
    if (a5) {
      await move(a5.id, "ASSIGNED", 198, { userId: nextHolder().id }, undefined, true);
      await move(a5.id, "LOST", 15, {}, "Not found after the Andheri office floor move");
    }
    // A tablet on its way to the Pune office's front desk.
    const a6 = await addAsset({ tag: "DMO-A006", kind: "TABLET", needle: "Lenovo Tab M11", purchasedDaysAgo: 30, warrantyYears: 1 });
    if (a6) await move(a6.id, "TRANSFERRED", 3, { label: "Acme — Pune office, Baner" }, "For the visitor kiosk at the Pune front desk");
    // A monitor rented to a client: dispatched, delivered, ours at their site.
    const a7 = await addAsset({ tag: "DMO-A007", kind: "MONITOR", needle: "Dell P2425H", purchasedDaysAgo: 120, warrantyYears: 3 });
    if (a7 && clients[0]) {
      await consign([a7.id], "DEPLOYMENT", { draftDaysAgo: 100, to: clients[0], dispatchDaysAgo: 99, deliverDaysAgo: 97 });
      await nowDeployed(a7.id);
    }
    // A server installed on a client's site by our engineer, ours on a managed-service contract.
    const a8 = await addAsset({ tag: "DMO-A008", kind: "SERVER", needle: "Dell PowerEdge R450", purchasedDaysAgo: 180, warrantyYears: 3, notes: "Managed-service hardware — remains our property." });
    if (a8 && clients[1]) {
      await move(a8.id, "INSTALLED", 170, { companyId: clients[1].id, locationId: clients[1].locationId || undefined, label: "Server room, rack 2" }, "Installed and handed over to their IT admin");
      await nowDeployed(a8.id);
    }
    // Peripherals in stock.
    await addAsset({ tag: "DMO-A009", kind: "PERIPHERAL", needle: "Logitech MK540", purchasedDaysAgo: 90 });
    await addAsset({ tag: "DMO-A010", kind: "PERIPHERAL", needle: "Logitech MK540", purchasedDaysAgo: 90 });
    // A licence pool, held by whoever runs IT.
    const a11 = await addAsset({ tag: "DMO-A011", kind: "SOFTWARE_LICENCE", needle: "Office LTSC Standard 2024", purchasedDaysAgo: 140, seats: 25, licenceKey: "DEMO0-DEMO1-DEMO2-DEMO3-DEMO4", notes: "Volume licence for the accounts and HR desktops." });
    if (a11) await move(a11.id, "ASSIGNED", 139, { userId: pick(assetKeepers).id }, "Licence pool held by IT", true);
    // Something that isn't any of the kinds: the attendance terminal at reception.
    const a12 = await addAsset({ tag: "DMO-A012", kind: "OTHER", custom: { name: "Biometric attendance terminal", make: "ZKTeco", cost: 18500 }, model: "SpeedFace V5L", purchasedDaysAgo: 210, warrantyYears: 1 });
    if (a12) {
      await move(a12.id, "INSTALLED", 205, { label: "Head office — main entrance" }, "Wall-mounted, wired to the attendance network");
    }
    // A printer lent to a client, installed on delivery.
    const a13 = await addAsset({ tag: "DMO-A013", kind: "PRINTER", needle: "HP LaserJet Pro MFP", purchasedDaysAgo: 75, warrantyYears: 1 });
    if (a13 && clients[2]) {
      await consign([a13.id], "DEPLOYMENT", { draftDaysAgo: 60, to: clients[2], dispatchDaysAgo: 59, deliverDaysAgo: 58, installed: true });
      await nowDeployed(a13.id);
    }
    // Dead on arrival: going back to the vendor.
    const a14 = await addAsset({ tag: "DMO-A014", kind: "LAPTOP", needle: "Dell Latitude 3550", purchasedDaysAgo: 12, warrantyYears: 3 });
    if (a14) {
      const vendor = ctx.companies.find((c) => c.id === hwVendor.id) ?? null;
      await consign([a14.id], "RETURN_TO_VENDOR", { draftDaysAgo: 6, to: vendor, dispatchDaysAgo: 5 });
      await db.consignment.updateMany({ where: { movements: { some: { assetId: a14.id } } }, data: { notes: "Dead on arrival — replacement under the vendor's DOA policy." } });
    }
    // A deployment called off before it left.
    const a15 = await addAsset({ tag: "DMO-A015", kind: "MONITOR", needle: "Dell P2425H", purchasedDaysAgo: 50, warrantyYears: 3 });
    if (a15 && clients[3]) await consign([a15.id], "DEPLOYMENT", { draftDaysAgo: 30, to: clients[3], cancel: "Customer postponed the floor move to next quarter." });
    // Two laptops moved between our own offices.
    const a16 = await addAsset({ tag: "DMO-A016", kind: "LAPTOP", needle: "HP ProBook 450", purchasedDaysAgo: 45, warrantyYears: 3 });
    const a17 = await addAsset({ tag: "DMO-A017", kind: "LAPTOP", needle: "HP ProBook 450", purchasedDaysAgo: 45, warrantyYears: 3 });
    if (a16 && a17) {
      await consign([a16.id, a17.id], "INTERNAL_TRANSFER", { draftDaysAgo: 25, toAddress: "Acme — Pune office, Baner Road, Pune 411045", dispatchDaysAgo: 24, deliverDaysAgo: 23 });
    }
    // Lost, and found again in the store room.
    const a18 = await addAsset({ tag: "DMO-A018", kind: "LAPTOP", needle: "Lenovo ThinkPad E14", purchasedDaysAgo: 280, warrantyYears: 1 });
    if (a18) {
      await move(a18.id, "ASSIGNED", 275, { userId: nextHolder().id }, undefined, true);
      await move(a18.id, "LOST", 90, {}, "Reported missing after the Diwali office shutdown");
      await move(a18.id, "RECEIVED", 70, {}, "Found in the Mumbai store room during the stock take");
    }

    const kinds = await db.asset.groupBy({ by: ["status"], where: { assetTag: { startsWith: "DMO-A" } }, _count: { _all: true } });
    return `${created} assets added (tags DMO-A…) — ${kinds.map((k) => `${k._count._all} ${k.status.toLowerCase().replace("_", " ")}`).join(", ")}`;
  }
}

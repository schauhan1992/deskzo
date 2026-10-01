/**
 * check:order-punch — the order-punching screen (owner, 2 Oct 2026): the pickers' server search, the
 * two lookups the form makes as it is filled in, and the page as an executive and a manager get it,
 * against a real database that is not the owner's.
 *
 * The pure part needs no database: the figures the order summary shows, by the server's own rules.
 *
 * The rest builds a scratch workspace database beside the real one (as check:rebates does), drives the
 * real actions and the real page as a workspace pointed at it (`runAsTenant`), and drops it at the end,
 * pass or fail:
 *
 *   · searching: an executive finds only the customers they manage, a manager with `companies.viewAll`
 *     everybody's, and nobody a disqualified account, a vendor or a reseller's end customer; two
 *     characters at least, twenty at most, no contacts in the answer; products by name or SKU, active only;
 *   · choosing a customer: one answer with the offices (primary first), the proposals, the linked
 *     commission parties, a reseller's end customers and the credit — the credit only with the payments
 *     view, and without writing the rating back; an account out of scope answers like one that isn't there;
 *   · choosing a product: a renewal seen from an order that went ahead, never from a cancelled or rejected
 *     one; a reseller's special and tier prices; nothing learnt about an account out of scope;
 *   · punching: createOrder answers with the order's number, so the form goes straight to it;
 *   · the page: the sections, the folded parts in the markup, the summary, the backend rebate for the
 *     manager only; past 300 customers or 500 products the pickers search the server, and the
 *     executive's list is still only theirs; the people sent with the form carry no email or phone;
 *   · a plan without Receivables or Resellers: no credit and no reseller price;
 *   · and the real workspace untouched.
 *
 *   npm run check:order-punch
 *   TZ=UTC npm run check:order-punch      (from PowerShell: $env:TZ = "UTC"; npm run check:order-punch)
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { Prisma, PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { calculateOrderAmount } from "../src/lib/gst";
import { orderFigures } from "../src/lib/orders/punch-figures";
import { formatOrderId } from "../src/lib/order-id";
import { zodResolver } from "@hookform/resolvers/zod";
import { createOrderSchema } from "../src/lib/validation/order";
import { firstErrorField, type PunchErrors } from "../src/components/orders/punch/types";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZPUNCH";

/** JSON with every object's keys in order, so two answers built in a different order still compare equal. */
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
const keysOf = (o: object) => Object.keys(o).sort().join(",");
/** A fixture's name without the suite's tag, as the checks below spell them. */
const bare = (rows: { name: string }[]) => rows.map((r) => r.name.slice(TAG.length + 1));

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/orders/new",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/actions/view-mode"), viewMode],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** Awaits every async server component in a tree, so a static render can take it. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

/**
 * The first element of a component in a resolved tree. The props a server page hands a client
 * component are exactly what the browser is sent, so this is where a payload is checked for what it
 * leaves out — the static HTML only shows what the component chose to render.
 */
function findElement<P>(node: unknown, type: unknown): ReactElement<P> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement<P>(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<P>;
  return findElement<P>((node.props as { children?: unknown }).children, type);
}

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const countOf = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

function pure() {
  section("The figures the order summary shows");
  const product = { sellingPrice: 1000, taxRatePercent: 18 };
  const two = orderFigures({ quantity: 2, unitPrice: 1000 }, product);
  const server = calculateOrderAmount({ quantity: 2, unitPrice: 1000, taxRatePercent: 18 });
  ok(
    "two at ₹1,000 with 18% GST: ₹2,000, ₹360 GST, ₹2,360 — what the server works out",
    two.subtotal === 2000 && two.gstAmount === 360 && two.total === 2360 && two.total === server.total && two.taxRate === 18,
    `${two.subtotal} + ${two.gstAmount} = ${two.total}`,
  );
  const blank = orderFigures({ quantity: "", unitPrice: "" }, { sellingPrice: "1000", taxRatePercent: "18" });
  ok(
    "  a blank quantity is one and a blank price the list price, as the order schema takes them",
    blank.quantity === 1 && blank.unitPrice === 1000 && !blank.priceTyped && blank.total === 1180,
    `${blank.quantity} × ${blank.unitPrice} = ${blank.total}`,
  );
  ok("  ₹900 typed against a ₹1,000 list is 10% below", orderFigures({ unitPrice: "900" }, product).belowListPercent === 10);
  const deal = orderFigures(
    {
      quantity: 1,
      unitPrice: 1000,
      quotedPurchasePrice: 850,
      dealPrice: 800,
      expenses: [{ amount: "50" }],
      rebates: [{ basis: "PURCHASE_VALUE", value: "20" }],
    },
    product,
  );
  ok(
    "the deal price is the cost over the distributor's: front margin ₹150 after a ₹50 expense, 15%",
    deal.unitCost === 800 && deal.costSource === "DEAL" && deal.frontMargin === 150 && deal.frontMarginPercent === 15 && !deal.belowCost,
    `${deal.unitCost} ${deal.costSource} ${deal.frontMargin} ${deal.frontMarginPercent}%`,
  );
  ok(
    "  a 20% rebate on what we pay is ₹160, net margin ₹310",
    deal.rebateTotal === 160 && deal.netMargin === 310,
    `${deal.rebateTotal} / ${deal.netMargin}`,
  );
  ok("  sold at ₹700 against an ₹800 cost is below cost", orderFigures({ unitPrice: 700, dealPrice: 800 }, product).belowCost);
  const none = orderFigures({ quantity: 3, unitPrice: "" }, null);
  ok("no product yet: nothing to total, no list price", none.total === 0 && none.listPrice === null && none.unitPrice === null);
}

/**
 * Where focus goes when a punch is refused: the topmost field on the page that is wrong, in the page's
 * order — not react-hook-form's registration order, which put Quantity ahead of an empty Product.
 */
async function focusOrder() {
  section("Where focus goes when the form is refused");
  const e = (message = "x") => ({ type: "custom", message });
  const first = (errors: unknown) => firstErrorField(errors as PunchErrors);
  ok("nothing wrong: nowhere", first({}) === null);
  ok("the customer before the price, whatever order the errors come in", first({ unitPrice: e(), companyId: e() }) === "companyId");
  ok("  the product before its price", first({ unitPrice: e(), itemId: e() }) === "itemId");
  ok("  the hand-off date before anything in the folded cost section", first({ quotedPurchasePrice: e(), releaseOn: e() }) === "releaseOn");
  const expenses: unknown[] = [];
  expenses[2] = { payeeCompanyId: e(), amount: e() };
  ok("an expense row: the first wrong row, its first wrong field", first({ expenses }) === "expenses.2.amount");
  const rebates: unknown[] = [];
  rebates[1] = { note: e() };
  ok("  the rebate rows come before the expenses", first({ expenses, rebates }) === "rebates.1.note");
  ok("  an error about the whole list is passed over for the next field", first({ expenses: { message: "too many" }, notes: e() }) === "notes");

  // The shapes the real resolver produces.
  const blank = {
    companyId: "c1", locationId: "l1", itemId: "i1", quantity: 1, unitPrice: "", businessType: "NEW", endCustomerId: "",
    poNumber: "", proposalId: "", paymentTerms: "", creditOverrideReason: "", startDate: "", endDate: "", notes: "",
    watcherUserIds: [], expenses: [], handoff: "NOW", releaseOn: "", quotedPurchasePrice: "", quoteVendorId: "",
    quoteVendorName: "", quoteContact: "", quotedOn: "", quoteRemarks: "", dealRegStatus: "", dealRegNumber: "",
    dealRegValidTo: "", dealPrice: "", rebates: [],
  };
  const resolve = async (values: Record<string, unknown>) => {
    const resolver = zodResolver(createOrderSchema as never);
    const result = (await resolver(values as never, undefined, { fields: {}, shouldUseNativeValidation: false } as never)) as { errors: unknown };
    return result.errors as Record<string, unknown>;
  };
  const noProduct = await resolve({ ...blank, itemId: "", handoff: "SCHEDULE", quotedPurchasePrice: "500" });
  ok(
    "refused for no product, no hand-off date and a distributor price with no distributor: the product first",
    !!noProduct.itemId && !!noProduct.releaseOn && !!noProduct.quoteVendorName && first(noProduct) === "itemId",
    Object.keys(noProduct).join(", "),
  );
  const noDate = await resolve({ ...blank, handoff: "SCHEDULE", quotedPurchasePrice: "500" });
  ok("  with a product: the hand-off date, above the folded cost section", first(noDate) === "releaseOn", Object.keys(noDate).join(", "));
  const blankAmount = await resolve({
    ...blank,
    expenses: [{ type: "FREIGHT", amount: "10", notes: "" }, { type: "COMMISSION", amount: "", notes: "", payeeCompanyId: "" }],
  });
  ok("  a blank amount on the second expense", first(blankAmount) === "expenses.1.amount", JSON.stringify(blankAmount));
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();
  await focusOrder();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_orderpunch`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    // From here on anything reaching for the environment's workspace lands in the scratch one too, and
    // the control plane is switched off by value (a Prisma client reloads .env for a missing variable).
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its companies, offices, items, orders, proposals and people are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} order-punch checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [companies, locations, items, orders, proposals, users, taggedCompanies, taggedItems, taggedUsers] = await Promise.all([
    client.company.count(),
    client.companyLocation.count(),
    client.item.count(),
    client.companyProduct.count(),
    client.proposal.count(),
    client.user.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
    client.item.count({ where: { name: { startsWith: TAG } } }),
    client.user.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ companies, locations, items, orders, proposals, users }), tagged: taggedCompanies + taggedItems + taggedUsers };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const itemActions = require("../src/actions/item") as typeof import("../src/actions/item");
  const punch = require("../src/actions/order-punch") as typeof import("../src/actions/order-punch");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const credit = require("../src/actions/credit") as typeof import("../src/actions/credit");
  const { customerRelationshipTypeValues } = require("../src/lib/validation/company") as typeof import("../src/lib/validation/company");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { NewOrderForm } = require("../src/components/orders/new-order-form") as typeof import("../src/components/orders/new-order-form");
  const NewOrderPage = (require("../src/app/(dashboard)/orders/new/page") as { default: (p: never) => Promise<ReactElement> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  type FormProps = Parameters<typeof NewOrderForm>[0];

  const tenant = {
    id: randomUUID(),
    slug: "zzorderpunch",
    name: "zzorderpunch",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzorderpunch.localhost",
    hosts: ["zzorderpunch.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: {
      v: 1 as const,
      all: true,
      modules: [] as string[],
      seats: null,
      copilotTokens: null,
      customDomains: null,
      plans: [] as string[],
    },
    holdReason: null,
  };

  type Person = { id: string; name: string; email: string; role: string };
  const as = (u: Person) => {
    actor = u;
  };

  /** The page as somebody opens it, with what it hands the form and what the form renders. */
  const openPage = async (who: Person, query: Record<string, unknown> = {}) => {
    as(who);
    const tree = await resolveAsync(createElement(NewOrderPage as never, { searchParams: Promise.resolve(query) }));
    const html = renderToStaticMarkup(tree as ReactElement);
    const form = findElement<FormProps>(tree, NewOrderForm);
    if (!form) throw new Error("The page rendered no NewOrderForm.");
    return { html, text: textOf(html), props: form.props };
  };

  // Shared between the two workspaces below: the same scratch database seen under two plans.
  let fixture: Awaited<ReturnType<typeof buildFixture>> | null = null;

  async function buildFixture() {
    section("Fixture");
    let people = 0;
    const user = (key: string, grants: Record<string, boolean>, extra: { isSuperAdmin?: boolean; role?: string } = {}) => {
      people += 1;
      return db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          // A number to look for later: the form is sent people's names, not how to reach them.
          phone: `+91 99999 0000${people}`,
          passwordHash: "!",
          role: extra.role ?? "PROFILE",
          isSuperAdmin: extra.isSuperAdmin ?? false,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true, phone: true },
      });
    };
    const base = { "orders.view": true, "companies.viewAll": false, "payments.view": false, "credit.override": false, "rebates.view": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const exec = await user("Executive", base);
    const colleague = await user("Colleague", base);
    const manager = await user("Manager", {
      ...base,
      "companies.viewAll": true,
      "payments.view": true,
      "credit.override": true,
      "rebates.view": true,
    });

    const company = (name: string, data: Partial<Prisma.CompanyUncheckedCreateInput> = {}) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ...data },
        select: { id: true, name: true },
      });
    const customer = { relationshipType: "CLIENT", stage: "CUSTOMER", paymentTerms: "ADVANCE" } as const;
    const client = await company("Acme Client", { ...customer, ownerUserId: exec.id });
    const reseller = await company("Acme Reseller", { ...customer, relationshipType: "RESELLER", ownerUserId: exec.id });
    const endCustomer = await company("Acme End Customer", { ...customer, ownerUserId: exec.id, managedByResellerId: reseller.id });
    const lost = await company("Acme Lost", { relationshipType: "CLIENT", stage: "DISQUALIFIED", ownerUserId: exec.id });
    const supplier = await company("Acme Supplies", { relationshipType: "VENDOR", ownerUserId: exec.id });
    const others = await company("Acme Other", { ...customer, ownerUserId: colleague.id });
    const nobody = await company("Acme Nobody", { ...customer });
    const zulu = await company("Zulu Traders", { ...customer, ownerUserId: exec.id });
    const agent = await company("Agent", { relationshipType: "COMMISSION_PARTY" });

    // The branch first, so "primary first" is not simply the order they were added in.
    await db.companyLocation.create({ data: { companyId: client.id, label: "Branch", isPrimary: false } });
    const headOffice = await db.companyLocation.create({ data: { companyId: client.id, label: "Head Office", isPrimary: true } });
    const otherOffice = await db.companyLocation.create({ data: { companyId: others.id, label: "Other office", isPrimary: true } });
    await db.contact.create({ data: { companyId: client.id, name: `${TAG} Priya`, designation: "PURCHASE_MANAGER" } });
    const lead = await db.lead.create({ data: { companyId: client.id, title: `${TAG} Firewall refresh`, ownerUserId: exec.id } });
    await db.proposal.create({ data: { leadId: lead.id, status: "SENT", validUntil: new Date("2026-12-31T00:00:00.000Z") } });
    await db.commissionPartyLink.create({ data: { commissionPartyId: agent.id, companyId: client.id } });

    const adobe = await db.brand.create({ data: { name: `${TAG} Adobe` } });
    const item = (name: string, sku: string, data: Partial<Prisma.ItemUncheckedCreateInput> = {}) =>
      db.item.create({
        data: { name: `${TAG} ${name}`, sku, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: owner.id, ...data },
        select: { id: true, name: true },
      });
    const acrobat = await item("Acrobat Pro", "ADB-ACRO-01", { brandId: adobe.id });
    const office = await item("Office 365", "MS-O365-E3");
    await item("Acrobat Legacy", "ADB-ACRO-00", { active: false });

    // An onboarded reseller on a 10% tier, with a price of its own for Acrobat.
    await db.resellerProfile.create({ data: { companyId: reseller.id, status: "ACTIVE", discountPercent: 10 } });
    await db.resellerItemPrice.create({ data: { resellerId: reseller.id, itemId: acrobat.id, price: 777 } });
    ok("an executive, a colleague and a manager; the executive's client, reseller and others; products, one retired", true);

    return {
      owner, exec, colleague, manager,
      client, reseller, endCustomer, lost, supplier, others, nobody, zulu, agent,
      headOffice, otherOffice, adobe, acrobat, office,
    };
  }

  await runAsTenant(tenant, async () => {
    const f = (fixture = await buildFixture());
    const { owner, exec, colleague, manager, client, reseller, endCustomer, supplier, others, nobody, zulu, agent } = f;

    // ── Searching ──────────────────────────────────────────────────────────────────────────────
    section("Searching customers on the server");
    as(exec);
    const execAcme = await companyActions.searchCustomerOptions("acme");
    ok(
      "an executive typing “acme” finds the two customers they manage",
      bare(execAcme).join(", ") === "Acme Client, Acme Reseller",
      bare(execAcme).join(", "),
    );
    const execIds = new Set(execAcme.map((c) => c.id));
    ok("  not a colleague's, nor one nobody manages", !execIds.has(others.id) && !execIds.has(nobody.id));
    ok(
      "  nor their own disqualified account, vendor, or the reseller's end customer",
      !execIds.has(f.lost.id) && !execIds.has(supplier.id) && !execIds.has(endCustomer.id),
    );
    const trimmed = await companyActions.searchCustomerOptions("  ACME client ");
    ok("  whatever the case, with the spaces trimmed", bare(trimmed).join(", ") === "Acme Client", bare(trimmed).join(", "));
    ok(
      "  each row is what the picker shows — no contacts",
      execAcme.every((c) => keysOf(c) === "customerCategory,id,name,relationshipType"),
      execAcme.map(keysOf).join(" | "),
    );
    ok(
      "under two characters, nothing — however it is sent",
      (await companyActions.searchCustomerOptions("a")).length === 0 &&
        (await companyActions.searchCustomerOptions(" a ")).length === 0 &&
        (await companyActions.searchCustomerOptions("")).length === 0 &&
        (await companyActions.searchCustomerOptions(undefined as never)).length === 0,
    );
    as(colleague);
    ok("the colleague finds only theirs", bare(await companyActions.searchCustomerOptions("acme")).join(", ") === "Acme Other");
    as(manager);
    const managerAcme = await companyActions.searchCustomerOptions("acme");
    ok(
      "a manager who sees every account finds the colleague's and the unmanaged one too — still no vendor or end customer",
      bare(managerAcme).join(", ") === "Acme Client, Acme Nobody, Acme Other, Acme Reseller",
      bare(managerAcme).join(", "),
    );

    as(exec);
    // Typed by hand: the action answers with one of two row shapes, and only the default one has contacts.
    const full = (await companyActions.listCompanyOptions({ relationshipTypes: [...customerRelationshipTypeValues] })) as {
      id: string;
      contacts?: { name: string }[];
    }[];
    const withContacts = full.find((c) => c.id === client.id);
    const lean = await companyActions.listCompanyOptions({ relationshipTypes: [...customerRelationshipTypeValues], withContacts: false });
    ok(
      "the full option list still carries contacts for its other callers; asked lean, it carries none",
      !!withContacts?.contacts?.some((c) => c.name === `${TAG} Priya`) && lean.every((c) => !("contacts" in c)),
    );

    section("Searching products on the server");
    as(exec);
    const byName = await itemActions.searchItemOptions("ACROBAT");
    ok(
      "by name, whatever the case: “ACROBAT” finds Acrobat Pro and not the retired Legacy",
      bare(byName).join(", ") === "Acrobat Pro",
      bare(byName).join(", "),
    );
    ok("by SKU: “o365-e3” finds Office 365", bare(await itemActions.searchItemOptions("o365-e3")).join(", ") === "Office 365");
    const bySku = await itemActions.searchItemOptions("acro-0");
    ok("  “acro-0” finds only the active one of the two SKUs it matches", bare(bySku).join(", ") === "Acrobat Pro", bare(bySku).join(", "));
    const found = byName[0];
    ok(
      "  with what the picker shows and the brand, the prices as plain numbers",
      !!found &&
        keysOf(found) === "brandId,id,name,sellingPrice,sku,taxRatePercent,type,unit" &&
        found.sellingPrice === 1000 &&
        found.taxRatePercent === 18 &&
        found.brandId === f.adobe.id,
      found ? keysOf(found) : "none",
    );
    ok(
      "  under two characters, nothing",
      (await itemActions.searchItemOptions("a")).length === 0 && (await itemActions.searchItemOptions(" o ")).length === 0,
    );

    // ── The customer's context ─────────────────────────────────────────────────────────────────
    section("Choosing a customer: one lookup");
    as(exec);
    const ctx = await punch.punchCustomerContext(client.id);
    ok(
      "the offices, the primary first though it was added second",
      ctx?.locations.map((l) => `${l.label}${l.isPrimary ? " (primary)" : ""}`).join(", ") === "Head Office (primary), Branch" &&
        ctx.locations.every((l) => keysOf(l) === "id,isPrimary,label"),
      ctx?.locations.map((l) => l.label).join(", "),
    );
    const legacyProposals = await orders.listProposalOptions(client.id);
    ok(
      "the proposal on its lead — the rows the old lookup gave",
      ctx?.proposals.length === 1 && ctx.proposals[0]!.lead.title === `${TAG} Firewall refresh` && stable(ctx.proposals) === stable(legacyProposals),
    );
    ok("the commission party tied to it", stable(ctx?.linkedPartyIds) === stable([agent.id]));
    ok(
      "  no end customers for a client, and no credit for an executive without the payments view",
      ctx?.endCustomers.length === 0 && ctx.credit === null,
    );
    const resellerCtx = await punch.punchCustomerContext(reseller.id);
    ok("a reseller's end customers come with it", stable(resellerCtx?.endCustomers) === stable([{ id: endCustomer.id, name: endCustomer.name }]));
    ok(
      "a colleague's customer, an unmanaged one, a made-up id, an empty one and a non-string all answer null",
      (await punch.punchCustomerContext(others.id)) === null &&
        (await punch.punchCustomerContext(nobody.id)) === null &&
        (await punch.punchCustomerContext(randomUUID())) === null &&
        (await punch.punchCustomerContext("")) === null &&
        (await punch.punchCustomerContext(42 as never)) === null &&
        (await punch.punchCustomerContext(null as never)) === null,
    );

    as(manager);
    // The rating getCreditSnapshot writes back onto the company — which the form's lookup must not.
    const stamp = () =>
      db.company.findUniqueOrThrow({ where: { id: client.id }, select: { creditRating: true, creditScore: true, creditScoredAt: true } });
    const stampBefore = await stamp();
    const managerCtx = await punch.punchCustomerContext(client.id);
    const stampAfter = await stamp();
    const managerCredit = managerCtx?.credit ?? null;
    ok(
      "the manager, with the payments view, gets the credit — on Advance, and may override it",
      !!managerCredit && typeof managerCredit.rating === "string" && managerCredit.defaultTerms === "ADVANCE" && managerCredit.canOverride === true,
      stable(managerCredit && { rating: managerCredit.rating, limit: managerCredit.limit, outstanding: managerCredit.outstanding }),
    );
    ok("  read without writing the rating back to the customer", stable(stampBefore) === stable(stampAfter), stable(stampAfter));
    const snapshotCredit = await credit.getCreditSnapshot(client.id);
    ok("  the same snapshot getCreditSnapshot gives", !!snapshotCredit && stable(managerCredit) === stable(snapshotCredit));
    ok(
      "  (which does write it — so the check above is not one that can't fail)",
      (await stamp()).creditScoredAt !== null && stampBefore.creditScoredAt === null,
    );
    ok("  the colleague's customer is in the manager's scope", (await punch.punchCustomerContext(others.id))?.locations[0]?.id === f.otherOffice.id);
    ok("  a vendor has no credit to show", (await punch.punchCustomerContext(supplier.id))?.credit === null);

    // ── The product's context, and punching ───────────────────────────────────────────────────
    section("Choosing a product: one lookup — and punching");
    const nothing = { hasExistingOrder: false, resellerPrice: null };
    as(exec);
    const before = await punch.punchItemContext({ companyId: client.id, itemId: f.acrobat.id });
    ok("Acrobat for the client before any order: new, and no reseller price", stable(before) === stable(nothing), stable(before));

    const order = (companyId: string, locationId: string, itemId: string) =>
      orders.createOrder({ companyId, locationId, itemId, quantity: 1, unitPrice: 1000, businessType: "NEW", watcherUserIds: [], expenses: [] });
    const first = await order(client.id, f.headOffice.id, f.acrobat.id);
    const firstData = first.ok ? first.data : null;
    ok(
      "createOrder answers with the order's id and its number",
      !!firstData && keysOf(firstData) === "id,orderSeq" && typeof firstData.orderSeq === "number",
      first.ok ? stable(first.data) : first.error,
    );
    const firstRow = firstData ? await db.companyProduct.findUnique({ where: { id: firstData.id }, select: { orderSeq: true } }) : null;
    ok(
      "  its own number: ORD-000001 — where the form goes next",
      !!firstData && firstRow?.orderSeq === firstData.orderSeq && formatOrderId(firstData.orderSeq) === "ORD-000001",
      firstData && formatOrderId(firstData.orderSeq),
    );
    ok(
      "the same customer and product again: a renewal, as the old lookup says too",
      (await punch.punchItemContext({ companyId: client.id, itemId: f.acrobat.id })).hasExistingOrder &&
        (await orders.hasExistingOrderForItem(client.id, f.acrobat.id)),
    );

    const cancelled = await order(client.id, f.headOffice.id, f.office.id);
    const rejected = await order(client.id, f.headOffice.id, f.office.id);
    ok(
      "  two more punched, numbered on: ORD-000002 and ORD-000003",
      cancelled.ok && rejected.ok && cancelled.data.orderSeq === 2 && rejected.data.orderSeq === 3,
    );
    if (cancelled.ok) await db.companyProduct.update({ where: { id: cancelled.data.id }, data: { orderStatus: "CANCELLED" } });
    if (rejected.ok) await db.companyProduct.update({ where: { id: rejected.data.id }, data: { orderStatus: "REJECTED" } });
    ok(
      "an order cancelled and one rejected don't make the next one a renewal",
      !(await punch.punchItemContext({ companyId: client.id, itemId: f.office.id })).hasExistingOrder,
    );

    ok(
      "the reseller's own price for Acrobat: ₹777, and says where it came from",
      stable((await punch.punchItemContext({ companyId: reseller.id, itemId: f.acrobat.id })).resellerPrice) ===
        stable({ unitPrice: 777, note: "Special price agreed with this reseller" }),
    );
    const tier = await punch.punchItemContext({ companyId: reseller.id, itemId: f.office.id });
    ok(
      "  their 10% tier off Office 365's ₹1,000: ₹900",
      stable(tier) === stable({ hasExistingOrder: false, resellerPrice: { unitPrice: 900, note: "10% partner tier discount applied" } }),
      stable(tier),
    );

    as(manager);
    const othersOrder = await order(others.id, f.otherOffice.id, f.acrobat.id);
    ok(
      "the manager punches Acrobat for the colleague's customer, and then sees it as a renewal",
      othersOrder.ok && (await punch.punchItemContext({ companyId: others.id, itemId: f.acrobat.id })).hasExistingOrder,
    );
    as(exec);
    ok(
      "the executive asking the same about that customer learns nothing: new, no price",
      stable(await punch.punchItemContext({ companyId: others.id, itemId: f.acrobat.id })) === stable(nothing),
    );
    ok(
      "  nor from a made-up customer, nothing at all, or the wrong types",
      stable(await punch.punchItemContext({ companyId: randomUUID(), itemId: f.acrobat.id })) === stable(nothing) &&
        stable(await punch.punchItemContext(null as never)) === stable(nothing) &&
        stable(await punch.punchItemContext({ companyId: 7, itemId: ["x"] } as never)) === stable(nothing),
    );

    // ── The page ───────────────────────────────────────────────────────────────────────────────
    section("The page, as the executive gets it");
    const execPage = await openPage(exec);
    const ep = execPage.props;
    ok(
      "the header: back to Orders, “Punch order”, one line of intro",
      execPage.html.includes('href="/orders"') && execPage.text.includes("← Orders") && /<h1[^>]*>Punch order<\/h1>/.test(execPage.html),
    );
    ok(
      "the form is sent the executive's own customers only",
      bare(ep.companies).join(", ") === "Acme Client, Acme Reseller, Zulu Traders",
      bare(ep.companies).join(", "),
    );
    ok(
      "  lean: no contacts on a customer; people, payees and distributors by id and name alone",
      ep.companies.every((c) => !("contacts" in c)) &&
        ep.users.length >= 4 &&
        ep.users.every((u) => keysOf(u) === "id,name") &&
        (ep.commissionParties ?? []).every((p) => keysOf(p) === "id,name") &&
        (ep.vendors ?? []).length > 0 &&
        (ep.vendors ?? []).every((v) => keysOf(v) === "id,name"),
    );
    const sent = JSON.stringify(ep);
    ok("  nobody's email or phone number is in what the browser is sent", !sent.includes("@example.test") && !sent.includes("+91 99999"));
    const everyone = JSON.stringify(await companyActions.listAssignableUsers());
    ok(
      "  (the list the page starts from has both — leaving them out is the page's doing)",
      everyone.includes("@example.test") && everyone.includes("+91 99999"),
    );
    ok(
      "  nothing chosen, the lists whole (no server search), the plan's credit and resellers on, rebates not theirs",
      ep.initialCompanyId === undefined &&
        ep.initialContext === null &&
        ep.customerSearch === false &&
        ep.itemSearch === false &&
        ep.creditInPlan === true &&
        ep.resellersInPlan === true &&
        ep.canSeeRebates === false,
    );
    ok(
      "  so both pickers filter the list they were given",
      countOf(execPage.html, /data-search="list"/g) === 2 && !execPage.html.includes('data-search="server"'),
    );

    const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => textOf(m[1]!).trim());
    ok(
      "the sections, in order: Customer, Product and price, Terms and hand-off — then the Order summary",
      headings(execPage.html).join(" | ") === "Customer | Product and price | Terms and hand-off | Order summary",
      headings(execPage.html).join(" | "),
    );
    ok(
      "  side by side from a wide screen, the summary sticky",
      execPage.html.includes("lg:grid-cols-[minmax(0,1fr)_340px]") && /class="[^"]*lg:sticky[^"]*lg:top-20/.test(execPage.html),
    );
    const folds = (html: string) => html.match(/<details[\s>][\s\S]*?<\/details>/g) ?? [];
    const foldTitles = (html: string) =>
      folds(html).map((block) => textOf(block.match(/<summary[\s>][\s\S]*?<\/summary>/)?.[0] ?? "").trim());
    ok(
      "three folded sections, all shut: Cost and margin, Expenses and watchers, Notes",
      foldTitles(execPage.html).join(" | ") === "Cost and margin | Expenses and watchers | Notes" && !/<details[^>]*\sopen/.test(execPage.html),
      foldTitles(execPage.html).join(" | "),
    );
    const costFold = textOf(folds(execPage.html)[0] ?? "");
    const inCost = ["Distributor price", "Price per unit", "Date quoted", "Contact at the distributor", "Remarks", "Deal registration"];
    ok(
      "  shut, they are still in the markup: the distributor price and the deal registration inside Cost and margin",
      inCost.every((s) => costFold.includes(s)),
      inCost.filter((s) => !costFold.includes(s)).join(", "),
    );
    const handoff = ["Purchase hand-off", "Send to purchase now", "Hold (in-hand order)", "Schedule on a date"];
    ok(
      "the purchase hand-off and its three choices",
      handoff.every((s) => execPage.text.includes(s)),
      handoff.filter((s) => !execPage.text.includes(s)).join(", "),
    );
    const summaryParts = [
      "Order summary",
      "No product chosen yet",
      "Subtotal",
      "Total incl. GST",
      "Front margin",
      "Punch and add another",
      "Cancel",
    ];
    ok(
      "the summary: the totals, the margin and the buttons",
      summaryParts.every((s) => execPage.text.includes(s)) &&
        execPage.html.includes('data-then="another"') &&
        // The heading, the bar that stays on a phone's screen, and the summary's button.
        countOf(execPage.text, /Punch order/g) >= 3,
      summaryParts.filter((s) => !execPage.text.includes(s)).join(", "),
    );
    ok(
      "no backend rebate anywhere for the executive — nor the rebate figures",
      !execPage.text.includes("Backend rebate") && !execPage.text.includes("Expected rebate") && !execPage.text.includes("Net margin"),
    );
    ok("  and no customer's name in the picker until one is chosen", !execPage.html.includes(client.name));

    section("The page, as the manager gets it");
    const managerPage = await openPage(manager);
    ok(
      "four folded sections: the backend rebate second",
      foldTitles(managerPage.html).join(" | ") === "Cost and margin | Backend rebate | Expenses and watchers | Notes" &&
        !/<details[^>]*\sopen/.test(managerPage.html),
      foldTitles(managerPage.html).join(" | "),
    );
    ok(
      "  the expected rebate and the net margin in the summary",
      managerPage.text.includes("Expected rebate") && managerPage.text.includes("Net margin"),
    );
    ok(
      "  and the same deal registration and hand-off as everyone",
      managerPage.text.includes("Deal registration") && handoff.every((s) => managerPage.text.includes(s)),
    );
    ok(
      "the manager is sent every account's customers",
      bare(managerPage.props.companies).join(", ") === "Acme Client, Acme Nobody, Acme Other, Acme Reseller, Zulu Traders" &&
        managerPage.props.canSeeRebates === true,
      bare(managerPage.props.companies).join(", "),
    );

    section("Opened from a customer (?companyId=)");
    const execClient = await openPage(exec, { companyId: client.id });
    const ec = execClient.props;
    ok(
      "the executive's client comes chosen, with its context looked up with the page",
      ec.initialCompanyId === client.id && ec.initialContext?.locations[0]?.label === "Head Office" && ec.initialContext.credit === null,
    );
    ok(
      "  the picker names it and the primary office is selected",
      execClient.html.includes(`value="${client.name}"`) && /<option[^>]*selected=""[^>]*>Head Office/.test(execClient.html),
    );
    ok(
      "  its proposal is offered under Notes, which says so while shut",
      execClient.text.includes("Linked proposal") &&
        execClient.text.includes(`${TAG} Firewall refresh`) &&
        execClient.text.includes("1 proposal on file"),
    );
    ok("  no credit line for the executive", !execClient.text.includes("owes"));
    const managerClient = await openPage(manager, { companyId: client.id });
    ok(
      "the manager gets the same customer with its credit line under the picker",
      !!managerClient.props.initialContext?.credit && managerClient.text.includes("owes") && managerClient.text.includes(" limit"),
    );
    const unusable = [
      ["a colleague's customer", others.id],
      ["an unmanaged one", nobody.id],
      ["a vendor", supplier.id],
      ["the reseller's end customer", endCustomer.id],
      ["a repeated parameter", [client.id, client.id]],
      ["a made-up id", randomUUID()],
    ] as const;
    for (const [what, companyId] of unusable) {
      const page = await openPage(exec, { companyId });
      ok(
        `  ${what}: the form opens with nothing chosen`,
        page.props.initialCompanyId === undefined &&
          page.props.initialContext === null &&
          bare(page.props.companies).join(", ") === "Acme Client, Acme Reseller, Zulu Traders",
      );
    }

    // ── Past the caps ──────────────────────────────────────────────────────────────────────────
    section("Past 300 customers and 500 products, the pickers search the server");
    const padded = (n: number) => String(n).padStart(3, "0");
    await db.company.createMany({
      data: Array.from({ length: 301 }, (_, i) => {
        const name = `${TAG} Bulk ${padded(i + 1)}`;
        return {
          name,
          normalizedName: name.toLowerCase(),
          createdById: owner.id,
          ownerUserId: exec.id,
          relationshipType: "CLIENT",
          stage: "CUSTOMER",
        } as const;
      }),
    });
    await db.item.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        name: `${TAG} Widget ${padded(i + 1)}`,
        sku: `${TAG}-W-${padded(i + 1)}`,
        type: "SERVICE" as const,
        sellingPrice: 100,
        createdById: owner.id,
      })),
    });
    ok("301 more customers for the executive, and 501 more products", true);

    as(exec);
    const bulk = await companyActions.searchCustomerOptions("bulk");
    const first20 = Array.from({ length: 20 }, (_, i) => `Bulk ${padded(i + 1)}`).join(", ");
    ok(
      "a search answers with twenty at most, the first by name",
      bulk.length === 20 && bare(bulk).join(", ") === first20,
      `${bulk.length}: ${bare(bulk).slice(0, 3).join(", ")}…`,
    );
    as(colleague);
    ok("  the colleague finds none of them", (await companyActions.searchCustomerOptions("bulk")).length === 0);
    as(exec);
    const widgets = await itemActions.searchItemOptions("widget");
    ok(
      "  and twenty products at most",
      widgets.length === 20 && bare(widgets).join(", ") === Array.from({ length: 20 }, (_, i) => `Widget ${padded(i + 1)}`).join(", "),
      widgets.length,
    );

    const execMany = await openPage(exec);
    const sentIds = execMany.props.companies.map((c) => c.id);
    const theirs = await db.company.count({ where: { id: { in: sentIds }, ownerUserId: exec.id } });
    ok(
      "the executive's page sends 300 customers and tells the picker to search the rest",
      execMany.props.customerSearch === true && sentIds.length === 300 && execMany.html.includes('data-search="server"'),
      `${sentIds.length} sent, customerSearch ${execMany.props.customerSearch}`,
    );
    ok("  every one of them the executive's own", theirs === 300 && !sentIds.includes(others.id) && !sentIds.includes(nobody.id), theirs);
    ok(
      "  500 products, and that picker searches too",
      execMany.props.itemSearch === true && execMany.props.items.length === 500 && countOf(execMany.html, /data-search="server"/g) === 2,
      `${execMany.props.items.length} sent`,
    );
    ok("  Zulu Traders falls past the 300th", !sentIds.includes(zulu.id));
    const execZulu = await openPage(exec, { companyId: zulu.id });
    ok(
      "opened from Zulu Traders, it is sent as well, first, so the picker can name it",
      execZulu.props.companies.length === 301 &&
        execZulu.props.companies[0]?.id === zulu.id &&
        execZulu.props.initialCompanyId === zulu.id &&
        execZulu.html.includes(`value="${zulu.name}"`),
    );
    const managerMany = await openPage(manager);
    ok(
      "the manager's page searches as well, with the colleague's customer still among the first 300",
      managerMany.props.customerSearch === true &&
        managerMany.props.companies.length === 300 &&
        managerMany.props.companies.some((c) => c.id === others.id),
    );
  });

  // ── A smaller plan ───────────────────────────────────────────────────────────────────────────
  // The same scratch database as a workspace whose plan has orders and items and nothing else.
  const narrow = { ...tenant, entitlements: { ...tenant.entitlements, all: false, modules: ["orders", "items"] } };
  await runAsTenant(narrow, async () => {
    section("A plan without Receivables or Resellers");
    if (!fixture) throw new Error("The fixture was not built.");
    const { manager, client, reseller, acrobat } = fixture;
    as(manager);
    const ctx = await punch.punchCustomerContext(client.id);
    ok(
      "the manager's customer context comes without credit — the offices still there",
      !!ctx && ctx.credit === null && ctx.locations.length === 2,
    );
    ok(
      "  and the reseller's price is not looked up",
      (await punch.punchItemContext({ companyId: reseller.id, itemId: acrobat.id })).resellerPrice === null,
    );
    const page = await openPage(manager, { companyId: client.id });
    ok(
      "the page tells the form neither is in the plan, and shows no credit line",
      page.props.creditInPlan === false &&
        page.props.resellersInPlan === false &&
        page.props.initialContext?.credit === null &&
        !page.text.includes("owes"),
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { PriceRefused, addPlanPrice } from "@/lib/billing/prices";
import { controlDb } from "@/lib/platform/control-db";
import { PlanRefused, savePlan } from "@/lib/platform/plans";

/**
 * The launch prices, as a book — `npm run platform:plans -- prices` says what it would do, and
 * `-- prices --apply` does it: for each plan, the people its unit includes, and a monthly and a yearly
 * price in rupees (src/lib/billing/prices.ts). No gateway is called: a price is the plan's, shown on
 * the website at once, and each gateway's copy is made when somebody first pays through it.
 *
 * Owner, 11 Oct 2026: research the competitors, set the launch prices for India, and change them
 * later from the console. So the book is only a starting point. Running it again changes nothing that
 * already matches it; a price that differs is replaced the way the console replaces one — the old
 * stays on the subscriptions paying it. A plan staff priced differently in the console since is
 * replaced too, so run it on purpose, after reading the dry run. It never retires anything it doesn't
 * replace.
 *
 * Amounts are the price for one unit before GST, in rupees. The reasoning behind each figure, and the
 * competitors' prices it was set against, are in docs/pricing-india.md.
 */

export type PriceBookEntry = {
  planKey: string;
  /**
   * People one unit includes; undefined leaves the plan's as it is. A price per person needs none: what
   * was bought is counted (src/lib/platform/entitlements.ts), and a trial keeps the plan's "no limit".
   */
  seats?: number | null;
  /** Rupees for one unit, before GST. */
  month: number;
  year: number;
  /** Charged per person: the quantity bought is the number of people. */
  perSeat: boolean;
};

/**
 * India at launch (owner, 11 Oct 2026). Per person per month, before 18% GST; a year is ten months.
 * Each figure sits at or under the Indian price of what it replaces (docs/pricing-india.md), with no
 * minimum and no cap on invoices, orders or contacts. Deskzo One is Zoho One's yearly All-Employee
 * price without licensing every employee, and costs less than any three of its products.
 *
 * Not in the book: More people (every product is per person already, so it stays off sale) and the
 * internal plan.
 */
export const INDIA_LAUNCH_PRICES: readonly PriceBookEntry[] = [
  // Every product: Zoho One All-Employee ₹1,250 yearly / ₹2,500 monthly, Flexible ₹3,500.
  { planKey: "deskzo-one", month: 1499, year: 14990, perSeat: true },
  // Zoho CRM Standard ₹800 / ₹1,300, Freshsales Growth ₹749 / ₹899 — with calls, field visits, targets and incentives.
  { planKey: "deskzo-crm", month: 799, year: 7990, perSeat: true },
  // Zoho Books Standard ₹749 an organisation for 3 users, Professional ₹1,499 for 5 — no invoice cap, e-invoice and e-way bills in.
  { planKey: "deskzo-books", month: 349, year: 3490, perSeat: true },
  // greytHR Growth ₹85 an employee, Zoho People ₹48–144 plus Zoho Payroll ₹40–80 — payroll, attendance, hiring and visitors in one, no 50-employee floor.
  { planKey: "deskzo-people", month: 99, year: 990, perSeat: true },
  // Zoho Desk Express ₹420 / ₹540, Standard ₹800 / ₹1,300; Freshdesk Growth ₹1,499.
  { planKey: "deskzo-desk", month: 599, year: 5990, perSeat: true },
  // Zoho Inventory Standard ₹999 an organisation for 3 users — no order cap.
  { planKey: "deskzo-inventory", month: 349, year: 3490, perSeat: true },
  // Zoho Billing Premium ₹2,999 an organisation for 10 users (recurring billing starts there).
  { planKey: "deskzo-subscriptions", month: 349, year: 3490, perSeat: true },
  // Zoho Projects Premium ₹280 / ₹350.
  { planKey: "deskzo-projects", month: 299, year: 2990, perSeat: true },
  // Zoho Marketing Automation ₹855–2,880 for 1k–10k contacts — per person here, with no contact tiers.
  { planKey: "deskzo-campaigns", month: 499, year: 4990, perSeat: true },
  // Deskzo Pipeline (owner, 14 Oct 2026): below Bigin Express (₹400 billed yearly) and well below CRM.
  { planKey: "deskzo-pipeline", month: 299, year: 2990, perSeat: true },
  // Zoho Analytics ₹960 an organisation for 2 users (about ₹480 each), extra users ₹200.
  { planKey: "deskzo-analytics", month: 249, year: 2490, perSeat: true },
  // Zoho Vault Standard ₹54, Professional ₹248 (sharing); Bitwarden Teams US$4.
  { planKey: "deskzo-vault", month: 99, year: 990, perSeat: true },
  // Blinq Business and HiHello US$5 a person; Indian card makers sell a ₹999–1,699 card and a ₹199-a-year profile.
  { planKey: "deskzo-cards", month: 99, year: 990, perSeat: true },
  // Exclaimer US$0.90–1.75, CodeTwo US$1.22, Letsignit US$2 a person.
  { planKey: "deskzo-signatures", month: 59, year: 590, perSeat: true },
  // Add-ons, for the workspace rather than a person. Revenue & Close: Ind AS 115 revenue and the month-end close, with Books.
  { planKey: "addon-revenue-close", month: 2499, year: 24990, perSeat: false },
  // AI Plus: 750 Deskzo AI credits a month on top of the plan's own (owner, 17 Oct 2026). Credits are ₹1 each.
  { planKey: "addon-ai-copilot", month: 499, year: 4990, perSeat: false },
  // Automate Plus: Deskzo Automate's limits raised for the whole workspace (owner, 17 Oct 2026).
  { planKey: "addon-automate-plus", month: 999, year: 9990, perSeat: false },
];

/** What a run did, or would do, to one plan. */
export type PriceBookLine = {
  planKey: string;
  outcome: "priced" | "unchanged" | "missing" | "refused";
  changes: string[];
  note?: string;
};

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

/**
 * Applies a book (or, with `dryRun`, says what it would do). Each plan must exist already — `npm run
 * platform:plans -- products` makes them. Prices are in rupees; nothing here needs a gateway.
 */
export async function applyPriceBook(book: readonly PriceBookEntry[], opts: { actor: string; dryRun?: boolean }): Promise<PriceBookLine[]> {
  const control = controlDb();
  const lines: PriceBookLine[] = [];
  for (const entry of book) {
    const plan = await control.plan.findUnique({
      where: { key: entry.planKey },
      include: { modules: { select: { moduleKey: true } }, prices: { where: { currency: "INR", active: true } } },
    });
    if (!plan) {
      lines.push({ planKey: entry.planKey, outcome: "missing", changes: [], note: "no such plan — run `npm run platform:plans -- products` first" });
      continue;
    }
    if (plan.kind === "INTERNAL") {
      lines.push({ planKey: entry.planKey, outcome: "refused", changes: [], note: "an internal plan is never sold" });
      continue;
    }
    const changes: string[] = [];
    const seatsChange = entry.seats !== undefined && entry.seats !== plan.seats;
    if (seatsChange) changes.push(`people a unit includes ${plan.seats ?? "no limit"} → ${entry.seats ?? "no limit"}`);
    const wanted = (["MONTH", "YEAR"] as const).map((interval) => ({ interval, amount: Math.round((interval === "MONTH" ? entry.month : entry.year) * 100) }));
    const toPrice = wanted.filter((w) => {
      const now = plan.prices.find((p) => p.interval === w.interval);
      return !now || now.amount !== w.amount || now.perSeat !== entry.perSeat;
    });
    for (const w of toPrice) {
      const now = plan.prices.find((p) => p.interval === w.interval);
      const per = `${entry.perSeat ? " a person" : ""} a ${w.interval === "MONTH" ? "month" : "year"}`;
      changes.push(now ? `${rupees(now.amount)}${now.perSeat ? " a person" : ""} → ${rupees(w.amount)}${per}` : `${rupees(w.amount)}${per}`);
    }
    if (!changes.length) {
      lines.push({ planKey: entry.planKey, outcome: "unchanged", changes });
      continue;
    }
    if (opts.dryRun) {
      lines.push({ planKey: entry.planKey, outcome: "priced", changes });
      continue;
    }
    try {
      if (seatsChange) {
        // Everything else as staff left it — the plan's own words, countries, limits and modules.
        await savePlan(
          {
            key: plan.key,
            name: plan.name,
            kind: plan.kind,
            description: plan.description,
            productKey: plan.productKey,
            allModules: plan.allModules,
            modules: plan.modules.map((m) => m.moduleKey),
            countries: plan.countries,
            seats: entry.seats ?? null,
            copilotTokens: plan.copilotTokens,
            isDefault: plan.isDefault,
            active: plan.active,
            sortOrder: plan.sortOrder,
          },
          opts.actor,
        );
      }
      for (const w of toPrice) await addPlanPrice({ planKey: plan.key, currency: "INR", interval: w.interval, amount: w.amount, perSeat: entry.perSeat }, opts.actor);
      lines.push({ planKey: entry.planKey, outcome: "priced", changes });
    } catch (err) {
      if (err instanceof PriceRefused || err instanceof PlanRefused) {
        lines.push({ planKey: entry.planKey, outcome: "refused", changes, note: err.message });
        continue;
      }
      throw err;
    }
  }
  return lines;
}

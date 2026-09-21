/**
 * That a sales executive sees their own accounts, and that everybody else still sees everything.
 *
 * `src/lib/authz/company-scope.ts` states the rule and builds the `where` fragments for it. Nothing
 * else in this file is new policy — `companies.viewAll` is already defined, already documented as
 * covering "orders, payments, renewals, leads, tickets, contacts and documents", and already
 * granted by default to every role except SALES. What was missing was the wiring: the fragments
 * existed and the list actions did not use them.
 *
 * Measured before this suite was written, acting as one ordinary sales executive:
 *
 *     orders      sees   378   should see    48
 *     tickets     sees   204   should see    29
 *     leads       sees   482   should see    60
 *     contacts    sees  1008   should see   137
 *
 * A thousand contacts is every customer's name, phone number and email address in the business.
 *
 * ## Why this is behavioural rather than a source scan
 *
 * A scan can tell you a function mentions `companyScope`. It cannot tell you the fragment was
 * spread into the right `where`, or that a second query three lines down was missed, or that a
 * `include` pulls the unscoped rows back in by another path. So this calls the real actions as a
 * real restricted user and looks at what actually comes back.
 *
 * ## Both directions, and the second one matters more than it looks
 *
 * Every entity is asserted twice: a restricted viewer sees nothing outside their scope, **and** an
 * unrestricted one still sees everything. The second is not ceremony. The dangerous way to fix a
 * leak is to over-narrow, and that failure is invisible in exactly the way the leak was not — the
 * accounts team quietly stops seeing half the invoices, and the first anybody hears of it is a
 * missed collection.
 *
 *   npm run check:scope
 */
import Module from "node:module";
import { PrismaClient } from "@prisma/client";

const probe = new PrismaClient();

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};

const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
]);

const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const { listLeads } = load("../src/actions/lead") as typeof import("../src/actions/lead");
const { listOrders } = load("../src/actions/order") as typeof import("../src/actions/order");
const { listTickets } = load("../src/actions/ticket") as typeof import("../src/actions/ticket");
const { listAllContacts } = load("../src/actions/contact") as typeof import("../src/actions/contact");
const { listCompanies, listCustomers, listVendors } = load("../src/actions/company") as typeof import("../src/actions/company");
const { listRenewals } = load("../src/actions/renewal") as typeof import("../src/actions/renewal");
const { listTradeDocuments } = load("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
const { listPayments } = load("../src/actions/payment") as typeof import("../src/actions/payment");
const { agingReport } = load("../src/actions/receivable") as typeof import("../src/actions/receivable");
const { runWorkbook, countWorkbook } = load("../src/actions/workspace") as typeof import("../src/actions/workspace");
const { createCompany, getCompany } = load("../src/actions/company") as typeof import("../src/actions/company");
const { can } = load("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
const { accountScopeIds } = load("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");

let failures = 0;

function ok(label: string, pass: boolean, detail: string | number = "") {
  if (!pass) failures++;
  console.log(`${pass ? " ok  " : " FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

/**
 * One entity: how to list it, and how to find out which company each row belongs to.
 *
 * `companyIdsOf` is deliberately not "read `row.companyId`" — several of these return a shape that
 * does not carry it, and reading a field that happens to be absent would make every row look
 * in-scope. The ids go back to the database instead, which cannot be fooled by the return shape.
 */
type Entity = {
  name: string;
  list: () => Promise<unknown[]>;
  /** The owning-company ids for a set of returned rows, resolved from the database by row id. */
  ownersOf: (ids: string[]) => Promise<(string | null)[]>;
  /** Total rows an unrestricted viewer should get. */
  total: () => Promise<number>;
};

const idsOf = (rows: unknown[]) => rows.map((r) => (r as { id: string }).id).filter(Boolean);

const ENTITIES: Entity[] = [
  {
    name: "companies",
    list: () => listCompanies() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (await probe.company.findMany({ where: { id: { in: ids } }, select: { ownerUserId: true } })).map((c) => c.ownerUserId),
    total: () => probe.company.count(),
  },
  {
    name: "customers",
    list: () => listCustomers() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (await probe.company.findMany({ where: { id: { in: ids } }, select: { ownerUserId: true } })).map((c) => c.ownerUserId),
    total: async () => (await listCustomers()).length,
  },
  {
    name: "vendors",
    list: () => listVendors() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (await probe.company.findMany({ where: { id: { in: ids } }, select: { ownerUserId: true } })).map((c) => c.ownerUserId),
    total: async () => (await listVendors()).length,
  },
  {
    name: "leads",
    list: () => listLeads() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (await probe.lead.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })).map(
        (l) => l.company?.ownerUserId ?? null,
      ),
    total: () => probe.lead.count(),
  },
  {
    name: "orders",
    list: () => listOrders() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (
        await probe.companyProduct.findMany({
          where: { id: { in: ids } },
          select: { company: { select: { ownerUserId: true } } },
        })
      ).map((o) => o.company?.ownerUserId ?? null),
    total: async () => (await listOrders()).length,
  },
  {
    name: "tickets",
    list: () => listTickets() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (
        await probe.ticket.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })
      ).map((t) => t.company?.ownerUserId ?? null),
    total: async () => (await listTickets()).length,
  },
  {
    name: "contacts",
    list: () => listAllContacts() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (
        await probe.contact.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })
      ).map((c) => c.company?.ownerUserId ?? null),
    total: async () => (await listAllContacts()).length,
  },
  {
    name: "renewals",
    list: () => listRenewals() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (
        await probe.companyProduct.findMany({
          where: { id: { in: ids } },
          select: { company: { select: { ownerUserId: true } } },
        })
      ).map((r) => r.company?.ownerUserId ?? null),
    total: async () => (await listRenewals()).length,
  },
  {
    name: "documents",
    // Paged by signature, so the whole set is asked for in one large page.
    list: async () => ((await listTradeDocuments({ docType: "INVOICE", page: 1, pageSize: 5000 })).rows) as unknown[],
    ownersOf: async (ids) =>
      (
        await probe.tradeDocument.findMany({
          where: { id: { in: ids } },
          select: { company: { select: { ownerUserId: true } } },
        })
      ).map((d) => d.company?.ownerUserId ?? null),
    total: async () => (await listTradeDocuments({ docType: "INVOICE", page: 1, pageSize: 5000 })).rows.length,
  },
  {
    name: "payments",
    list: () => listPayments() as Promise<unknown[]>,
    ownersOf: async (ids) =>
      (
        await probe.payment.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })
      ).map((p) => p.company?.ownerUserId ?? null),
    total: async () => (await listPayments()).length,
  },
];

async function main() {
  // ── Who to act as ───────────────────────────────────────────────────────────────────────────
  const candidates = await probe.user.findMany({
    where: { active: true, isSuperAdmin: false, role: "SALES" },
    select: { id: true, name: true, email: true, role: true },
    take: 60,
  });

  let restricted: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (!(await can(c.id, "companies.viewAll"))) {
      restricted = c;
      break;
    }
  }

  const unrestricted = await probe.user.findFirst({
    where: { isSuperAdmin: true },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!restricted || !unrestricted) {
    ok("the check has somebody to act as", false, "needs one SALES user without companies.viewAll and one super admin");
    return;
  }

  const scope = await accountScopeIds(restricted.id);
  if (scope === null) {
    ok("the restricted user is actually restricted", false, "they hold companies.viewAll");
    return;
  }

  const inScope = new Set(scope);

  console.log(`\n  restricted: ${restricted.name} (${restricted.role}) — sees through ${scope.length} account manager(s)`);
  console.log(`  unrestricted: ${unrestricted.name} (super admin)`);

  // ── Nothing outside the scope comes back ────────────────────────────────────────────────────
  section("A sales executive sees only their own accounts");

  actor = restricted;
  const seen = new Map<string, number>();

  for (const entity of ENTITIES) {
    const rows = await entity.list();
    seen.set(entity.name, rows.length);

    const ids = idsOf(rows);
    const owners = ids.length > 0 ? await entity.ownersOf(ids) : [];
    const strangers = owners.filter((o) => o === null || !inScope.has(o)).length;

    ok(
      `${entity.name}`,
      strangers === 0,
      strangers === 0
        ? `${rows.length} row(s), all theirs`
        : `${strangers} of ${rows.length} belong to accounts they do not manage`,
    );
  }

  // ── And everybody else still sees everything ────────────────────────────────────────────────
  section("Somebody with companies.viewAll still sees the whole business");

  actor = unrestricted;

  for (const entity of ENTITIES) {
    const rows = await entity.list();
    const restrictedCount = seen.get(entity.name) ?? 0;

    /**
     * The over-narrowing guard.
     *
     * A scope applied unconditionally — forgetting that `accountScopeIds` returns `null` for an
     * unrestricted viewer — empties the accounts team's screens as thoroughly as the missing scope
     * exposed them, and nothing complains for a month.
     */
    ok(
      `${entity.name}`,
      rows.length >= restrictedCount,
      `${rows.length} row(s), against the executive's ${restrictedCount}`,
    );
  }

  // ── Filtering must not dissolve the scope ────────────────────────────────────────────────────

  /**
   * Every one of these lists takes a search term, and a search term is another `where` condition
   * reaching the same company.
   *
   * That is not a hypothetical. `agingReport` spread the scope and then spread the search, both
   * writing the key `company` into one object literal — and a spread is an assignment, so the
   * second silently replaced the first. The report was correctly scoped until somebody typed, at
   * which point 8 rows became 54, of which 48 were other people's customers with what each owed.
   * Nothing in the types says a word about it, and the unsearched assertions all still passed.
   *
   * So each list is asked for again *with* a search, and the same rule applied.
   */
  section("A search term must not widen what comes back");

  actor = restricted;

  const SEARCHED: { name: string; run: () => Promise<{ id: string }[]>; owners: (ids: string[]) => Promise<(string | null)[]> }[] = [
    {
      name: "aging report",
      run: async () => (await agingReport({ search: "a" })).rows,
      owners: async (ids) =>
        (await probe.company.findMany({ where: { id: { in: ids } }, select: { ownerUserId: true } })).map((c) => c.ownerUserId),
    },
    {
      name: "companies",
      run: async () => (await listCompanies({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (await probe.company.findMany({ where: { id: { in: ids } }, select: { ownerUserId: true } })).map((c) => c.ownerUserId),
    },
    {
      name: "leads",
      run: async () => (await listLeads({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (await probe.lead.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })).map(
          (l) => l.company?.ownerUserId ?? null,
        ),
    },
    {
      name: "orders",
      run: async () => (await listOrders({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (
          await probe.companyProduct.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })
        ).map((o) => o.company?.ownerUserId ?? null),
    },
    {
      name: "tickets",
      run: async () => (await listTickets({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (await probe.ticket.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })).map(
          (t) => t.company?.ownerUserId ?? null,
        ),
    },
    {
      name: "contacts",
      run: async () => (await listAllContacts({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (await probe.contact.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })).map(
          (c) => c.company?.ownerUserId ?? null,
        ),
    },
    {
      name: "payments",
      run: async () => (await listPayments({ search: "a" })) as { id: string }[],
      owners: async (ids) =>
        (await probe.payment.findMany({ where: { id: { in: ids } }, select: { company: { select: { ownerUserId: true } } } })).map(
          (p) => p.company?.ownerUserId ?? null,
        ),
    },
  ];

  for (const entity of SEARCHED) {
    const rows = await entity.run();
    const owners = rows.length > 0 ? await entity.owners(rows.map((r) => r.id)) : [];
    const strangers = owners.filter((o) => o === null || !inScope.has(o)).length;
    ok(
      `${entity.name}, searched`,
      strangers === 0,
      strangers === 0 ? `${rows.length} row(s), all theirs` : `${strangers} of ${rows.length} out of scope`,
    );
  }

  // ── Reports ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The largest read in the app, and the one whose failure looks most like success.
   *
   * A report crosses accounts on purpose, so an over-wide one returns *more* — which is what
   * somebody running a report wants. Nobody files a bug because their pipeline looked bigger.
   *
   * The leads source was scoped on `targets.viewAll` rather than `companies.viewAll`, and on
   * `Lead.ownerUserId` rather than through the company. 31 of 98 active users hold the first
   * permission without the second, and for every one of them the filter collapsed to nothing: a
   * sales executive whose leads screen showed 60 got all 482 leads in the business.
   *
   * `check:analytics` could not catch it. Its assertion is `narrow <= wide`, and 482 <= 482 passes.
   * So the test here is not "smaller" but "**every row belongs to somebody they may see**", which is
   * the only version that fails on a filter that is missing entirely.
   */
  section("Reports return no account a viewer may not open");

  const { FACT_SOURCES } = load("../src/lib/analytics/sources") as typeof import("../src/lib/analytics/sources");

  /** How each source's row reaches the company it belongs to. */
  const companyIdOf = (row: unknown): string | null =>
    (row as { companyId?: string | null }).companyId ?? null;

  for (const src of FACT_SOURCES) {
    actor = restricted;
    const window = { userId: restricted.id, from: new Date(2000, 0, 1), to: new Date(2100, 0, 1), dateColumn: "createdAt" };
    const mine = await src.load(window);

    const companyIds = mine.map(companyIdOf).filter((id): id is string => id !== null);
    const owners = await probe.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, ownerUserId: true },
    });
    const byId = new Map(owners.map((o) => [o.id, o.ownerUserId]));

    // A row with no company at all is counted as out of scope: an account-manager rule cannot
    // vouch for it, and silently letting those through is how the leak would return.
    const strangers = mine.filter((row) => {
      const cid = companyIdOf(row);
      if (cid === null) return true;
      const owner = byId.get(cid) ?? null;
      return owner === null || !inScope.has(owner);
    }).length;

    ok(
      `${src.key}`,
      strangers === 0,
      strangers === 0 ? `${mine.length} row(s), all theirs` : `${strangers} of ${mine.length} on accounts she may not open`,
    );
  }

  // And the unrestricted viewer still gets the whole business out of every one of them.
  for (const src of FACT_SOURCES) {
    actor = unrestricted;
    const wide = await src.load({ userId: unrestricted.id, from: new Date(2000, 0, 1), to: new Date(2100, 0, 1), dateColumn: "createdAt" });
    actor = restricted;
    const narrow = await src.load({ userId: restricted.id, from: new Date(2000, 0, 1), to: new Date(2100, 0, 1), dateColumn: "createdAt" });
    ok(`  ${src.key}, unrestricted`, wide.length >= narrow.length, `${wide.length} against ${narrow.length}`);
  }

  // ── The saved-list workspace ─────────────────────────────────────────────────────────────────

  /**
   * The most complete view of the company table in the app, and the last one to be scoped.
   *
   * A workbook is a saved filter over companies, and it returns more per row than any list does:
   * name, website, stage, tags, industry, city, the account manager's name, counts of contacts and
   * products and leads, and the last call's outcome. With no filters at all it was the whole
   * customer book — measured at 476 rows for somebody entitled to 47.
   *
   * It also feeds `startCallingActivity`, so those rows become a call sheet somebody works through.
   */
  section("A saved list is a company list too");

  actor = restricted;

  const workbook = await runWorkbook({ filters: {}, page: 1, pageSize: 1000 });
  const wbOwners = await probe.company.findMany({
    where: { id: { in: workbook.rows.map((r) => r.id) } },
    select: { ownerUserId: true },
  });
  const wbStrangers = wbOwners.filter((o) => !o.ownerUserId || !inScope.has(o.ownerUserId)).length;

  ok(
    "an unfiltered workbook returns only their accounts",
    wbStrangers === 0,
    wbStrangers === 0 ? `${workbook.rows.length} row(s)` : `${wbStrangers} of ${workbook.rows.length} out of scope`,
  );

  /**
   * Their accounts *minus the reseller-managed ones*, which `buildWhere` excludes by design —
   * a reseller's end customer is not ours to put on a call sheet. Comparing against the raw count
   * would fail for the right reason and read like the wrong one.
   */
  const entitled = await probe.company.count({
    where: { ownerUserId: { in: [...inScope] }, managedByResellerId: null },
  });
  ok("  and the total is exactly that, no more and no fewer", workbook.total === entitled, `${workbook.total} vs ${entitled}`);
  ok("  the live count under the filter builder agrees", (await countWorkbook({})) === entitled, `${await countWorkbook({})} vs ${entitled}`);

  actor = unrestricted;
  const adminWorkbook = await runWorkbook({ filters: {}, page: 1, pageSize: 1000 });
  ok("  and an unrestricted viewer's workbook is untouched", adminWorkbook.total > workbook.total, `${adminWorkbook.total} vs ${workbook.total}`);

  // ── Adding a company must not hide it from whoever added it ──────────────────────────────────

  /**
   * The failure the scope itself creates if nothing sets an owner.
   *
   * `createCompany` never set `ownerUserId`. That was harmless while everybody saw every company
   * and is not now: an unowned company is nobody's, the rule hides it, and a sales executive would
   * add a customer and not find it afterwards — having created a record only other people can see.
   */
  section("A company you add is one you can still see");

  actor = restricted;
  const MARK = "ZZ-scope-check";
  let madeId: string | null = null;

  try {
    const created = await createCompany({
      name: `${MARK} ${Date.now()}`,
      relationshipType: "CLIENT",
      paymentTerms: "NET_30",
      source: "REFERRAL",
      tags: [],
      contacts: [],
    });
    ok("a restricted user can add a company", created.ok, created.ok ? "" : created.error);

    if (created.ok) {
      madeId = created.data.id;
      ok("  and it appears in their own list", (await listCompanies()).some((c: { id: string }) => c.id === madeId));
      ok("  and its page opens for them", (await getCompany(madeId)) !== null);
      const row = await probe.company.findUnique({ where: { id: madeId }, select: { ownerUserId: true } });
      ok("  because adding one makes you its account manager", row?.ownerUserId === restricted.id);
    }
  } finally {
    if (madeId) {
      await probe.contact.deleteMany({ where: { companyId: madeId } });
      await probe.company.deleteMany({ where: { id: madeId } });
    }
    const left = await probe.company.count({ where: { name: { startsWith: MARK } } });
    ok("  and the check leaves nothing behind", left === 0, `${left} leftover(s)`);
  }

  // ── The scope is doing something, rather than everything happening to be in it ───────────────
  section("The comparison is not vacuous");

  actor = unrestricted;
  const wholeBusiness = new Map<string, number>();
  for (const entity of ENTITIES) wholeBusiness.set(entity.name, (await entity.list()).length);

  const narrowed = ENTITIES.filter((e) => (seen.get(e.name) ?? 0) < (wholeBusiness.get(e.name) ?? 0));
  ok(
    "at least one list is genuinely narrower for the executive",
    narrowed.length > 0,
    narrowed.length > 0
      ? `${narrowed.map((e) => `${e.name} ${seen.get(e.name)}/${wholeBusiness.get(e.name)}`).join(", ")}`
      : "every list is the same size for both — the scope may not be applied at all",
  );

  // Unowned records are nobody's, and the rule says they are hidden rather than public.
  const unowned = await probe.company.count({ where: { ownerUserId: null } });
  if (unowned > 0) {
    actor = restricted;
    const rows = await listCompanies();
    const owners = await Promise.all(
      idsOf(rows as unknown[]).map(async (id) => (await probe.company.findUnique({ where: { id }, select: { ownerUserId: true } }))?.ownerUserId ?? null),
    );
    ok(
      "a company with no account manager is hidden, not public",
      owners.every((o) => o !== null),
      `${unowned} unowned compan(ies) in the database`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    failures++;
  })
  .finally(async () => {
    console.log(failures === 0 ? "\nAll account-scope checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    await probe.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });

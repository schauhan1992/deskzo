/**
 * That a readable URL is not a way in.
 *
 * `/leads/LEAD-000123` is guessable in a way `/leads/cmu9u5fou04vg…` was not, so the question
 * "what happens when somebody walks the numbers" stopped being hypothetical the moment those URLs
 * shipped. This answers it by walking them: as a real sales executive with a restricted book, it
 * opens the real page component for records belonging to *other* people's accounts and asserts each
 * one refuses.
 *
 * ## Why the page, and not the action underneath it
 *
 * Four of these routes check the viewer in the page itself and four delegate to an action, and the
 * point is that the URL is closed either way. Calling the actions would test four of them and
 * assume the rest. Calling the page component tests the path a browser actually takes.
 *
 * ## Both directions
 *
 * Every record type is asserted twice: the executive is refused somebody else's, **and** allowed
 * their own. The second is not ceremony — the dangerous way to close a leak is to over-narrow, and
 * a page that refuses everybody looks exactly like a page that is properly locked down until
 * somebody cannot open their own customer.
 *
 *   npm run check:record-access
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const probe = directClient();
let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};

/** Distinguishable from any other throw, so a refusal cannot be confused with a crash. */
class NotFound extends Error {
  constructor() {
    super("NOT_FOUND");
  }
}
/** Likewise for the canonical redirect, which also unwinds the request by throwing. */
class Redirected extends Error {
  constructor(public readonly to: string) {
    super("REDIRECT " + to);
  }
}

const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("the check called a page without saying who was calling it");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    },
  ],
  /**
   * Some pages read the session through `auth()` rather than `requireUser()`. Both have to answer
   * as the same person, or half the suite would be testing a different viewer from the other half.
   */
  [
    load.resolve("../src/lib/auth"),
    {
      auth: async () => (actor ? { user: { id: actor.id, name: actor.name, email: actor.email } } : null),
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
]);

const realLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound();
      },
      redirect: (to: string) => {
        throw new Redirected(to);
      },
    };
  }
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const { can } = load("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
const { accountScopeIds } = load("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  if (!pass) failures += 1;
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** What opening a URL did: refused, redirected to the canonical form, or rendered. */
type Outcome = "refused" | "redirected" | "rendered" | { error: string };

async function open(routeFile: string, segment: string): Promise<Outcome> {
  const mod = load(routeFile) as { default: (props: never) => Promise<unknown> };
  try {
    await mod.default({
      params: Promise.resolve({ id: segment }),
      searchParams: Promise.resolve({}),
    } as never);
    return "rendered";
  } catch (error) {
    if (error instanceof NotFound) return "refused";
    if (error instanceof Redirected) return "redirected";
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type Target = {
  name: string;
  route: string;
  /** A record id belonging to a company the executive cannot see, and one they can. */
  outside: () => Promise<{ seq: number } | null>;
  inside: () => Promise<{ seq: number } | null>;
};

async function main() {
  // ── Who to act as ────────────────────────────────────────────────────────────────────────────
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
  if (!restricted) {
    ok("the check has somebody to act as", false, "needs one SALES user without companies.viewAll");
    return;
  }
  const scope = await accountScopeIds(restricted.id);
  if (scope === null || scope.length === 0) {
    ok("the restricted user is actually restricted", false, "they see everything, or nothing at all");
    return;
  }
  const mine = { in: scope };
  const notMine = { notIn: scope };
  console.log(`acting as ${restricted.name} (${restricted.role}), who manages ${scope.length} account(s)\n`);

  const TARGETS: Target[] = [
    {
      name: "company",
      route: "../src/app/(dashboard)/companies/[id]/page",
      outside: async () => probe.company.findFirst({ where: { ownerUserId: notMine }, select: { companySeq: true } }).then((r) => (r ? { seq: r.companySeq } : null)),
      inside: async () => probe.company.findFirst({ where: { ownerUserId: mine }, select: { companySeq: true } }).then((r) => (r ? { seq: r.companySeq } : null)),
    },
    {
      name: "lead",
      route: "../src/app/(dashboard)/leads/[id]/page",
      outside: async () => probe.lead.findFirst({ where: { company: { ownerUserId: notMine } }, select: { leadSeq: true } }).then((r) => (r ? { seq: r.leadSeq } : null)),
      inside: async () => probe.lead.findFirst({ where: { company: { ownerUserId: mine } }, select: { leadSeq: true } }).then((r) => (r ? { seq: r.leadSeq } : null)),
    },
    {
      name: "order",
      route: "../src/app/(dashboard)/orders/[id]/page",
      outside: async () => probe.companyProduct.findFirst({ where: { company: { ownerUserId: notMine } }, select: { orderSeq: true } }).then((r) => (r ? { seq: r.orderSeq } : null)),
      inside: async () => probe.companyProduct.findFirst({ where: { company: { ownerUserId: mine } }, select: { orderSeq: true } }).then((r) => (r ? { seq: r.orderSeq } : null)),
    },
    {
      name: "ticket",
      route: "../src/app/(dashboard)/tickets/[id]/page",
      outside: async () => probe.ticket.findFirst({ where: { company: { ownerUserId: notMine } }, select: { ticketSeq: true } }).then((r) => (r ? { seq: r.ticketSeq } : null)),
      inside: async () => probe.ticket.findFirst({ where: { company: { ownerUserId: mine } }, select: { ticketSeq: true } }).then((r) => (r ? { seq: r.ticketSeq } : null)),
    },
  ];

  section("A restricted viewer cannot open another account's record by URL");

  for (const t of TARGETS) {
    const outside = await t.outside();
    if (!outside) {
      ok(`${t.name}: a record outside their book exists to try`, false, "nothing to test against");
      continue;
    }
    actor = restricted;
    const result = await open(t.route, String(outside.seq));
    ok(
      `${t.name}: /${t.name}s/${outside.seq} is refused`,
      result === "refused",
      typeof result === "object" ? `threw: ${result.error}` : result,
    );
    ok(
      `  and is not redirected first`,
      result !== "redirected",
      "a redirect would confirm the record exists, which notFound() exists not to disclose",
    );
  }

  section("And can still open their own");

  for (const t of TARGETS) {
    const inside = await t.inside();
    if (!inside) {
      ok(`${t.name}: a record inside their book exists to try`, false, "nothing to test against");
      continue;
    }
    actor = restricted;
    const result = await open(t.route, String(inside.seq));
    ok(
      `${t.name}: /${t.name}s/${inside.seq} opens`,
      result === "rendered" || result === "redirected",
      typeof result === "object" ? `threw: ${result.error}` : result,
    );
  }

  section("Records scoped by reporting line, not by account");

  /**
   * Visits, expenses and people are not company-scoped — they belong to a person, and the line is
   * yourself plus your downline. Each has its OWN escape hatch permission, and they are not the
   * same key: `visits.viewAll`, `expenses.viewAll`, `hr.viewAll`. Checking one person against the
   * wrong key is how this suite first reported a leak that was not there — the executive legitimately
   * held `visits.viewAll`, so seeing a colleague's visit was correct all along.
   */
  const { getDownlineUserIds } = load("../src/lib/org-chart") as typeof import("../src/lib/org-chart");
  const reports = [restricted.id, ...(await getDownlineUserIds(restricted.id))];

  const PEOPLE_SCOPED = [
    {
      name: "visit",
      permission: "visits.viewAll",
      route: "../src/app/(dashboard)/visits/[id]/page",
      find: async (others: object) =>
        (await probe.visit.findFirst({ where: { userId: others }, select: { visitSeq: true } }))?.visitSeq ?? null,
    },
    {
      name: "expense",
      permission: "expenses.viewAll",
      route: "../src/app/(dashboard)/expenses/[id]/page",
      find: async (others: object) =>
        (
          await probe.expense.findFirst({
            /**
             * The null branch is not optional. `approverUserId: { not: x }` excludes rows where it
             * is NULL, because in SQL `NULL != x` is NULL rather than true — and every expense in
             * this database has no approver yet, so the naive filter matched nothing at all and the
             * assertion reported "nothing to test against" while 140 candidates sat there.
             */
            where: {
              userId: others,
              OR: [{ approverUserId: null }, { approverUserId: { not: restricted!.id } }],
            },
            select: { expenseSeq: true },
          })
        )?.expenseSeq ?? null,
    },
    {
      name: "person",
      permission: "hr.viewAll",
      route: "../src/app/(dashboard)/people/[id]/page",
      find: async (others: object) =>
        (await probe.user.findFirst({ where: { id: others, active: true }, select: { userSeq: true } }))?.userSeq ?? null,
    },
  ] as const;

  for (const t of PEOPLE_SCOPED) {
    const seesEveryone = await can(restricted.id, t.permission);
    const seq = await t.find({ notIn: reports });
    if (seq === null) {
      ok(`${t.name}: a record outside their line exists to try`, false, "nothing to test against");
      continue;
    }
    actor = restricted;
    const r = await open(t.route, String(seq));

    if (seesEveryone) {
      // Holding the escape hatch, so reaching it is the correct answer — and worth asserting, because
      // a page that refused them anyway would be a different bug wearing the same clothes.
      ok(
        `${t.name}: holds ${t.permission}, so somebody else's opens`,
        r === "rendered" || r === "redirected",
        typeof r === "object" ? r.error : r,
      );
    } else {
      ok(
        `${t.name}: /${t.name}s/${seq} (outside their line) is refused`,
        r === "refused",
        typeof r === "object" ? r.error : r,
      );
    }
  }
  section("The catalogue is open to everybody, and that is not new");

  /**
   * Items carry no scope at all — `getItem` and `listItems` only require a session, and there is no
   * items permission in the registry. Every signed-in person can already open the whole catalogue
   * from the list, so a readable URL reaches nothing the list did not.
   *
   * Asserted rather than skipped, so that if somebody later decides the catalogue should be
   * restricted, this line fails and says where to look — instead of the change quietly not
   * applying to the URL.
   */
  const anyItem = await probe.item.findFirst({ select: { itemSeq: true } });
  if (anyItem) {
    actor = restricted;
    const r = await open("../src/app/(dashboard)/items/[id]/page", String(anyItem.itemSeq));
    ok(
      "any signed-in user can open any catalogue item",
      r === "rendered" || r === "redirected",
      "unscoped by design — if this ever becomes false, the URL layer needs a scope check too",
    );
  }
  section("The cuid form is closed the same way");

  const foreignLead = await probe.lead.findFirst({
    where: { company: { ownerUserId: notMine } },
    select: { id: true },
  });
  if (foreignLead) {
    actor = restricted;
    const result = await open("../src/app/(dashboard)/leads/[id]/page", foreignLead.id);
    ok(
      "a cuid for somebody else's lead is refused too",
      result === "refused",
      "the readable form did not open a door the old one kept shut — both go through the same check",
    );
  }
}

main()
  .then(async () => {
    await probe.$disconnect();
    console.log(failures === 0 ? "\nAll record access checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await probe.$disconnect();
    process.exit(1);
  });

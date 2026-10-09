/**
 * How much support a customer takes, against what they pay.
 *
 *   · The summary alone: what counts as support and what doesn't, recorded time, missed deadlines,
 *     the month a ticket belongs to in Indian time, and the heavy / light / unbilled judgement.
 *   · Through the real actions, with four probe customers — heavy, light, supported but never
 *     billed, and quiet — including the parts each view permission withholds and the account scope.
 *   · The customer page and the Support load list.
 *
 * Everything is named ZZPROBE_SUPPORT and removed in a finally (found by probe owner as well as by
 * name — see check-scripts-run-against-a-full-database).
 *
 *   npm run check:support-load
 *   TZ=America/New_York npm run check:support-load
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { compareToPeers, monthKey, monthKeys, summariseSupport, type SupportFacts } from "../src/lib/support/load";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Support", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/tickets/load",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_SUPPORT";
const MAIL = "@zzprobe-support.invalid";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: userIds } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.expense.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { companyId: { in: companyIds } }] } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The summary, on facts written out by hand");

  const asOf = new Date("2026-09-23T12:00:00+05:30");
  const t = (priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT", created: string, resolvedAfterHours: number | null, extra: Partial<SupportFacts["tickets"][number]> = {}) => ({
    priority,
    type: "PRODUCT_SUPPORT",
    status: (resolvedAfterHours === null ? "OPEN" : "RESOLVED") as "OPEN" | "RESOLVED",
    createdAt: new Date(created),
    resolvedAt: resolvedAfterHours === null ? null : new Date(new Date(created).getTime() + resolvedAfterHours * HOUR),
    replies: 2,
    product: "Microsoft 365",
    handler: "Asha",
    ...extra,
  });
  const facts: SupportFacts = {
    tickets: [
      t("URGENT", "2026-09-10T10:00:00+05:30", 6), // 4 h deadline — missed
      t("HIGH", "2026-09-11T10:00:00+05:30", 10), // 24 h — met
      t("LOW", "2026-09-12T10:00:00+05:30", null), // 7 days, 11 days open — missed, still open
      t("MEDIUM", "2026-09-01T00:30:00+05:30", 2, { product: "Tally", handler: "Ravi" }), // 31 Aug in UTC
    ],
    calls: [
      { startedAt: new Date("2026-09-10T11:00:00+05:30"), durationSeconds: 600 },
      { startedAt: new Date("2026-09-11T11:00:00+05:30"), durationSeconds: 900 },
    ],
    visits: [
      {
        scheduledFor: new Date("2026-09-15T10:00:00+05:30"),
        checkInAt: new Date("2026-09-15T10:00:00+05:30"),
        checkOutAt: new Date("2026-09-15T12:30:00+05:30"),
        distanceKm: 42,
        expenses: 850,
      },
    ],
    billed: 200_000,
  };
  const s = summariseSupport(facts, { asOf, months: 12 });
  ok("tickets, by priority", s.tickets === 4 && s.urgent === 1 && s.high === 1);
  ok("  what is still open, and what missed its deadline", s.open === 1 && s.openPastDue === 1 && s.pastDeadline === 2, `${s.open}/${s.openPastDue}/${s.pastDeadline}`);
  ok("  median time to resolve, over the resolved ones", s.medianResolutionHours === 6, s.medianResolutionHours);
  ok("  and the back-and-forth", s.replies === 8);
  ok("recorded time is talk time plus time on site — nothing estimated", s.talkMinutes === 25 && s.onSiteHours === 2.5 && s.recordedHours === 2.9, `${s.talkMinutes}m ${s.onSiteHours}h ${s.recordedHours}h`);
  ok("  with the visit's distance and expenses", s.distanceKm === 42 && s.visitExpenses === 850);
  ok("tickets per ₹1 lakh billed", s.ticketsPerLakh === 2);
  const sept = s.byMonth.find((m) => m.month === "2026-09");
  ok("a ticket raised at 00:30 IST on 1 Sep is September's, not August's", sept?.tickets === 4 && monthKey(new Date("2026-09-01T00:30:00+05:30")) === "2026-09");
  ok("the months run oldest first and cross the year", monthKeys(new Date("2026-01-15T12:00:00+05:30"), 3).join() === "2025-11,2025-12,2026-01");
  ok("what they are about, and who handled them", s.topProducts[0]?.name === "Microsoft 365" && s.topProducts[0].count === 3 && s.topHandlers[0]?.name === "Asha");

  const peers = { peerRatios: [0.5, 1, 1, 2, 3], peerTicketCounts: [1, 2, 4, 10, 30] };
  const judge = (tickets: number, billed: number, calls = 0, visits = 0) =>
    compareToPeers({ tickets, calls, visits, billed, ticketsPerLakh: billed > 0 ? tickets / (billed / 100_000) : null }, peers);
  ok("twice the typical tickets per rupee is heavy", judge(4, 200_000).level === "HEAVY" && judge(4, 200_000).multiple === 2);
  ok("half of it or less is light", judge(1, 200_000).level === "LIGHT");
  ok("in between is normal", judge(2, 200_000).level === "NORMAL");
  const nearLight = compareToPeers({ tickets: 54, calls: 0, visits: 0, billed: 10_000_000, ticketsPerLakh: 0.54 }, peers);
  ok("  judged on the exact ratio — 0.54× shows as 0.5× but is not light", nearLight.level === "NORMAL" && nearLight.multiple === 0.5, `${nearLight.level} ${nearLight.multiple}`);
  ok("support with nothing billed is called out on its own", judge(3, 0).level === "UNBILLED");
  ok("a visit alone still counts as support", judge(0, 0, 0, 1).level === "UNBILLED");
  ok("no support at all is said plainly", judge(0, 500_000).level === "NONE");
  ok("too few customers to compare with gives no multiple", compareToPeers({ tickets: 9, calls: 0, visits: 0, billed: 1, ticketsPerLakh: 900_000 }, { peerRatios: [1, 2], peerTicketCounts: [1] }).multiple === null);
  ok("the rank counts customers with more tickets", judge(4, 200_000).rank === 3 && judge(40, 200_000).rank === 1);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const supportActions = require("../src/actions/support-load") as typeof import("../src/actions/support-load");
  const { supportWindow } = require("../src/lib/support/data") as typeof import("../src/lib/support/data");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const LoadPage = (require("../src/app/(dashboard)/tickets/load/page") as { default: (p: unknown) => Promise<ReactElement> }).default;

  const { clockFor, indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const w = supportWindow(indiaClock, 3, new Date("2026-01-15T12:00:00+05:30"));
  ok("a 3-month window starts at midnight IST on the first of the month, two months back", w.from.toISOString() === new Date("2025-11-01T00:00:00+05:30").toISOString(), w.from.toISOString());
  const ny = supportWindow(clockFor("America/New_York"), 3, new Date("2026-01-15T12:00:00Z"));
  ok("  and on a workspace's own clock elsewhere", ny.from.toISOString() === new Date("2025-11-01T00:00:00-04:00").toISOString(), ny.from.toISOString());

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          // The money views the profiler held by default until 9 Oct 2026, on the person, so these people
          // start where they always did; a check's own answer for either still wins.
          permissionGrants: { create: Object.entries({ "payments.view": true, "documents.view": true, ...grants }).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const agent = await make("agent", { "companies.viewAll": false });
    const noMoney = await make("nomoney", { "companies.viewAll": true, "payments.view": false, "calls.view": false });
    const noTickets = await make("notickets", { "companies.viewAll": true, "tickets.view": false });
    const outsider = await make("outsider", { "companies.viewAll": false });

    const now = Date.now();
    const customer = (name: string) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: agent.id, ownerUserId: agent.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
      });
    const [heavy, light, unbilled, quiet] = await Promise.all([customer("Heavy"), customer("Light"), customer("Unbilled"), customer("Quiet")]);
    const invoice = (companyId: string, total: number, n: string) =>
      db.tradeDocument.create({
        data: { docNumber: `${TAG}-${n}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId, createdById: agent.id, issueDate: new Date(now - 20 * DAY), dueDate: new Date(now + 10 * DAY), total },
      });
    const tickets = (companyId: string, n: number, opts: { priority?: "URGENT" | "MEDIUM"; type?: "DEMO" | "PRODUCT_SUPPORT" } = {}) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          db.ticket.create({
            data: {
              companyId,
              title: `${TAG} ticket ${i}`,
              createdByUserId: agent.id,
              priority: opts.priority ?? "MEDIUM",
              ticketType: opts.type ?? "PRODUCT_SUPPORT",
              status: "RESOLVED",
              createdAt: new Date(now - (10 + i) * DAY),
              resolvedAt: new Date(now - (10 + i) * DAY + 12 * HOUR),
            },
          }),
        ),
      );

    // Heavy: twelve tickets on ₹20,000 — plus the things that must not count.
    await invoice(heavy.id, 20_000, "H");
    // A big invoice from three years ago, outside the window — it must not dilute this year's support.
    await db.tradeDocument.create({
      data: { docNumber: `${TAG}-H-OLD`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: heavy.id, createdById: agent.id, issueDate: new Date(now - 1100 * DAY), total: 10_000_000 },
    });
    const heavyTickets = await tickets(heavy.id, 10);
    await tickets(heavy.id, 2, { priority: "URGENT" });
    await tickets(heavy.id, 1, { type: "DEMO" });
    await db.callLog.createMany({
      data: [
        { companyId: heavy.id, ticketId: heavyTickets[0]!.id, phoneNumber: "+919800000010", outcome: "CONNECTED", startedAt: new Date(now - 9 * DAY), durationSeconds: 600, userId: agent.id },
        { companyId: heavy.id, direction: "INBOUND", phoneNumber: "+919800000010", outcome: "CONNECTED", startedAt: new Date(now - 8 * DAY), durationSeconds: 600, userId: agent.id },
        // Our own outbound call about nothing in particular — selling, not support.
        { companyId: heavy.id, direction: "OUTBOUND", phoneNumber: "+919800000010", outcome: "CONNECTED", startedAt: new Date(now - 7 * DAY), durationSeconds: 3600, userId: agent.id },
      ],
    });
    const visit = await db.visit.create({
      data: {
        companyId: heavy.id,
        userId: agent.id,
        purpose: "SUPPORT_ESCALATION",
        status: "COMPLETED",
        scheduledFor: new Date(now - 6 * DAY),
        checkInAt: new Date(now - 6 * DAY),
        checkOutAt: new Date(now - 6 * DAY + 2 * HOUR),
        distanceKm: 30,
      },
    });
    await db.expense.create({ data: { visitId: visit.id, companyId: heavy.id, userId: agent.id, amount: 500, spentOn: new Date(now - 6 * DAY), description: `${TAG} fuel`, status: "APPROVED" } });
    await db.visit.create({ data: { companyId: heavy.id, userId: agent.id, purpose: "PRODUCT_DEMO", status: "COMPLETED", scheduledFor: new Date(now - 5 * DAY) } });

    // Light: one ticket on ₹5 crore. Unbilled: three tickets, nothing billed. Quiet: nothing at all.
    await invoice(light.id, 50_000_000, "L");
    await tickets(light.id, 1);
    await tickets(unbilled.id, 3);

    section("One customer, through the real action");

    actorId = agent.id;
    const h = await supportActions.getSupportLoad(heavy.id);
    ok("demos don't count as support tickets", h?.tickets === 12 && h.urgent === 2, h?.tickets);
    ok("  calls about a ticket or from the customer count; our outbound call doesn't", h?.calls === 2 && h.talkMinutes === 20, `${h?.calls} ${h?.talkMinutes}`);
    ok("  support visits count, with time on site, distance and expenses; the demo visit doesn't", h?.visits === 1 && h.onSiteHours === 2 && h.distanceKm === 30 && h.visitExpenses === 500);
    ok("  billed over the same months", h?.billed === 20_000 && h.ticketsPerLakh === 60, `${h?.billed} ${h?.ticketsPerLakh}`);
    ok("sixty tickets per lakh is heavy against this database's typical customer", h?.level === "HEAVY" && (h.multiple ?? 0) >= 2, `${h?.level} ${h?.multiple}× (typical ${h?.typicalTicketsPerLakh})`);
    const l = await supportActions.getSupportLoad(light.id);
    ok("one ticket on ₹5 crore is light", l?.level === "LIGHT", `${l?.level} ${l?.multiple}`);
    ok("  and ranks below the heavy one", (l?.rank ?? 0) > (h?.rank ?? Infinity));
    ok("support with nothing billed says so", (await supportActions.getSupportLoad(unbilled.id))?.level === "UNBILLED");
    ok("a quiet customer used none", (await supportActions.getSupportLoad(quiet.id))?.level === "NONE");

    section("What each view permission withholds");

    actorId = noMoney.id;
    const partial = await supportActions.getSupportLoad(heavy.id);
    ok("without the payments view: no rupees, but still the judgement", partial?.billed === null && partial.ticketsPerLakh === null && partial.multiple === null && partial.level === "HEAVY");
    ok("without the calls view: no calls, and so no combined recorded time", partial?.calls === null && partial.talkMinutes === null && partial.recordedHours === null);
    actorId = noTickets.id;
    ok("without the tickets view there is nothing to show", (await supportActions.getSupportLoad(heavy.id)) === null);
    actorId = outsider.id;
    ok("an account outside your book is not yours to see", (await supportActions.getSupportLoad(heavy.id)) === null);

    section("The list");

    actorId = agent.id;
    const byIntensity = await supportActions.listSupportLoad({ months: 12, sort: "intensity", page: 1, pageSize: 25 });
    ok(
      "most support per rupee: nothing billed first, then heavy, then light — and not the quiet one",
      byIntensity.rows.map((r) => r.name.replace(`${TAG} `, "")).join() === "Unbilled,Heavy,Light",
      byIntensity.rows.map((r) => r.name).join(", "),
    );
    const byTickets = await supportActions.listSupportLoad({ months: 12, sort: "tickets", page: 1, pageSize: 25 });
    ok("most tickets puts the heavy one first", byTickets.rows[0]?.id === heavy.id);
    actorId = outsider.id;
    ok("someone else's list doesn't include them", !(await supportActions.listSupportLoad({ months: 12, sort: "tickets", page: 1, pageSize: 25 })).rows.some((r) => r.id === heavy.id));

    section("The screens");

    actorId = agent.id;
    const page = renderToStaticMarkup((await CompanyDetail({ id: heavy.id, tab: "tickets" })) as ReactElement);
    ok("the customer page has a Support card and the panel on its Tickets tab", page.includes(">Support<") && page.includes("Support in the last 12 months") && page.includes("Heavy support"));
    ok("  explaining the judgement in numbers", page.includes("the typical customer") && page.includes("tickets per ₹1 lakh"));
    const list = renderToStaticMarkup(await LoadPage({ searchParams: Promise.resolve({ sort: "intensity" }) }));
    ok("the Support load page lists them, with nothing-billed flagged", list.includes(`${TAG} Heavy`) && list.includes("nothing billed") && list.includes("Most support per rupee"));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll support-load checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});

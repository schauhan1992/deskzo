/**
 * Whether the customer portal shows a customer their own account, and nobody else's.
 *
 * This is the largest thing in the app that answers to a stranger. It returns subscriptions,
 * invoices and tickets to whoever holds a link, and every way it can fail is silent:
 *
 *   · a query that forgets its company filter shows one customer another's invoices, and the person
 *     who finds out is the customer;
 *   · an id accepted from the form instead of re-checked lets somebody raise a request against a
 *     subscription that is not theirs;
 *   · a section switched off in settings but still fetched is a leak with the lights turned down —
 *     the data is in the response whether or not the page draws it;
 *   · a master switch that does not actually stop a valid link makes the switch a lie;
 *   · and a reseller's customer reached directly undoes what `src/lib/reseller.ts` exists for.
 *
 *   npm run check:portal
 *
 * `check:rbac` whitelists `portal-public.ts` as deliberately reachable without a session, and the
 * comment there names this file as what holds the boundary instead. So this builds two real
 * companies with real data, issues real links, and asks the real actions what each link can see.
 *
 * Everything is created under a reserved prefix and removed again, so it is safe to run against a
 * database with real data in it.
 */
import Module from "node:module";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";

/**
 * The roster is the one admin action this suite touches, and it resolves a session.
 *
 * Substituted the way check-notes documents: everything that decides *access* — the permission
 * resolver, `companyMayUsePortal` — is still the real code; only "who is asking" is supplied.
 */
const internals = Module as unknown as { _load(r: string, parent: unknown, m: boolean): unknown };
const originalLoad = internals._load;
let actor: { id: string; name: string; email: string; role: string } | null = null;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  const resolved = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
  if (request.includes("lib/session")) {
    return { ...resolved, requireUser: async () => actor, currentUser: async () => actor };
  }
  return resolved;
};
import {
  allowedActions,
  companyMayUsePortal,
  expiryFor,
  linkState,
  visibleSections,
  type PortalSettingsLike,
} from "../src/lib/portal/access";
import { portalStateFor } from "../src/lib/portal/state";
import {
  openPortal,
  portalInvoices,
  portalSubscriptions,
  portalTickets,
  raisePortalRequest,
} from "../src/actions/portal-public";

const PREFIX = "ZZPortal";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const BASE: PortalSettingsLike = {
  enabled: true,
  access: "SELECTED",
  showSubscriptions: true,
  showInvoices: true,
  showPayments: false,
  showTickets: true,
  showAssets: false,
  showContacts: false,
  allowRenewalRequest: true,
  allowSeatRequest: true,
  allowQuestion: true,
  linkValidityDays: null,
};

const CLIENT = { portalEnabled: null, relationshipType: "CLIENT", managedByResellerId: null };

async function setSettings(over: Partial<PortalSettingsLike>) {
  const data = { ...BASE, ...over };
  await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
}

async function main() {
  section("Who may have a portal — the rules, on their own");

  ok("the master switch stops everything", !companyMayUsePortal({ ...BASE, enabled: false }, { ...CLIENT, portalEnabled: true }).ok);
  ok("  even a company explicitly granted access", (() => {
    const v = companyMayUsePortal({ ...BASE, enabled: false }, { ...CLIENT, portalEnabled: true });
    return !v.ok && v.because === "off";
  })());

  ok("SELECTED refuses a company nobody has granted", !companyMayUsePortal(BASE, CLIENT).ok);
  ok("  and allows one that has been", companyMayUsePortal(BASE, { ...CLIENT, portalEnabled: true }).ok);
  ok("ALL allows a company nobody has touched", companyMayUsePortal({ ...BASE, access: "ALL" }, CLIENT).ok);
  // The reason `portalEnabled` is nullable rather than a boolean: null means "follow the default",
  // so switching to ALL actually reaches everybody instead of only untouched companies.
  ok("  but still refuses one explicitly turned off", !companyMayUsePortal({ ...BASE, access: "ALL" }, { ...CLIENT, portalEnabled: false }).ok);

  {
    // The refusal no per-company setting may override — see src/lib/reseller.ts.
    const v = companyMayUsePortal({ ...BASE, access: "ALL" }, { ...CLIENT, portalEnabled: true, managedByResellerId: "r1" });
    ok("a reseller's customer is refused even when granted", !v.ok, v.ok ? "allowed" : v.because);
    ok("  and says which rule refused it", !v.ok && v.because === "reseller-managed");
  }

  ok("a vendor gets no portal", !companyMayUsePortal({ ...BASE, access: "ALL" }, { ...CLIENT, relationshipType: "VENDOR" }).ok);
  ok("a distributor gets no portal", !companyMayUsePortal({ ...BASE, access: "ALL" }, { ...CLIENT, relationshipType: "DISTRIBUTOR" }).ok);
  ok("a reseller we sell to does", companyMayUsePortal({ ...BASE, access: "ALL" }, { ...CLIENT, relationshipType: "RESELLER" }).ok);

  section("Whether a link still works");

  const now = new Date("2026-09-21T10:00:00Z");
  ok("a live link works", linkState({ expiresAt: null, revokedAt: null }, now).ok);
  ok("a revoked one does not", !linkState({ expiresAt: null, revokedAt: now }, now).ok);
  ok("an expired one does not", !linkState({ expiresAt: new Date("2026-09-20"), revokedAt: null }, now).ok);
  ok("one expiring in an hour still does", linkState({ expiresAt: new Date("2026-09-21T11:00:00Z"), revokedAt: null }, now).ok);
  // Exactly at the moment is expired, not valid: a link that lasts one millisecond past its stated
  // life is a rule somebody has to reason about rather than read.
  ok("one expiring exactly now does not", !linkState({ expiresAt: now, revokedAt: null }, now).ok);
  ok("a missing link is the same refusal as a bad one", !linkState(null, now).ok);

  ok("no validity set means no expiry", expiryFor(BASE, now) === null);
  ok("  and zero days is treated the same, not as instant expiry", expiryFor({ ...BASE, linkValidityDays: 0 }, now) === null);
  ok("90 days lands 90 days out", expiryFor({ ...BASE, linkValidityDays: 90 }, now)?.getTime() === now.getTime() + 90 * 86400000);

  section("What a viewer can see and do");

  ok("the sections follow the settings", (() => {
    const s = visibleSections({ ...BASE, showPayments: true, showTickets: false });
    return s.has("subscriptions") && s.has("invoices") && s.has("payments") && !s.has("tickets");
  })());
  ok("everything off means nothing shown", visibleSections({
    ...BASE, showSubscriptions: false, showInvoices: false, showPayments: false,
    showTickets: false, showAssets: false, showContacts: false,
  }).size === 0);

  ok("the actions follow the settings", allowedActions(BASE).size === 3);
  // A renew button for something the page will not show is a button nobody can use correctly.
  ok("hiding subscriptions hides renew and add-seats with them", (() => {
    const a = allowedActions({ ...BASE, showSubscriptions: false });
    return !a.has("renewal") && !a.has("seats") && a.has("question");
  })());
  ok("  while a question stands on its own", allowedActions({ ...BASE, allowRenewalRequest: false, allowSeatRequest: false }).has("question"));

  section("Two real customers, two real links");

  const stamp = Date.now();

  /**
   * The portal settings row is the live one, so it is put back exactly as it was found.
   *
   * The teardown used to write a *hardcoded* "safe state" — enabled false, access SELECTED — which
   * is not a restore, it is a reset. A company running with the customer portal switched on had it
   * switched off by running the suite, along with every visibility and request toggle, and nothing
   * said so. Read before the first write, restored in the finally.
   */
  const settingsBefore = await db.portalSettings.findUnique({ where: { id: "global" } });

  const user = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  const item = await db.item.findFirst({ select: { id: true } });
  if (!user || !item) throw new Error("Seed the app first — this needs a user and a catalogue item.");

  const mine = await db.company.create({
    data: { name: `${PREFIX} Mine ${stamp}`, normalizedName: `${PREFIX.toLowerCase()} mine ${stamp}`, relationshipType: "CLIENT", portalEnabled: true, createdById: user.id },
    select: { id: true },
  });
  const theirs = await db.company.create({
    data: { name: `${PREFIX} Theirs ${stamp}`, normalizedName: `${PREFIX.toLowerCase()} theirs ${stamp}`, relationshipType: "CLIENT", portalEnabled: true, createdById: user.id },
    select: { id: true },
  });

  try {
    const location = async (companyId: string) =>
      (await db.companyLocation.create({
        data: { companyId, label: "Head office", city: "Mumbai", state: "Maharashtra", isPrimary: true },
        select: { id: true },
      })).id;

    const [mineLoc, theirsLoc] = [await location(mine.id), await location(theirs.id)];

    const order = async (companyId: string, locationId: string, quantity: number) =>
      (await db.companyProduct.create({
        data: {
          companyId, locationId, itemId: item.id, quantity,
          orderStatus: "FULFILLED", addedByUserId: user.id,
          startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
        },
        select: { id: true },
      })).id;

    const myOrder = await order(mine.id, mineLoc, 10);
    const theirOrder = await order(theirs.id, theirsLoc, 25);

    await db.ticket.create({ data: { companyId: mine.id, title: `${PREFIX} my ticket`, description: "x", createdByUserId: user.id } });
    await db.ticket.create({ data: { companyId: theirs.id, title: `${PREFIX} their ticket`, description: "x", createdByUserId: user.id } });

    const link = async (companyId: string, name: string) => {
      const token = randomBytes(24).toString("base64url");
      await db.portalLogin.create({ data: { token, companyId, personName: name, createdById: user.id } });
      return token;
    };

    const myToken = await link(mine.id, "Priya Sharma");
    const theirToken = await link(theirs.id, "Rahul Mehta");

    await setSettings({});

    // ─── The one that matters most ──────────────────────────────────────────────────────────
    {
      const mySubs = await portalSubscriptions(myToken);
      const theirSubs = await portalSubscriptions(theirToken);
      ok("a link shows its own company's subscriptions", mySubs.length === 1 && mySubs[0]!.quantity === 10, mySubs.length);
      ok("  and the other company's link shows the other company's", theirSubs.length === 1 && theirSubs[0]!.quantity === 25, theirSubs.length);
      /**
       * The leak this module exists to not have. A missing company filter would show both, and
       * nothing would throw, log or look wrong from inside.
       */
      ok("  neither sees the other's", !mySubs.some((s) => s.id === theirOrder) && !theirSubs.some((s) => s.id === myOrder));

      const myTickets = await portalTickets(myToken);
      ok("tickets are scoped the same way", myTickets.length === 1 && myTickets[0]!.title.includes("my ticket"), myTickets.map((t) => t.title).join(","));
      ok("  and carry no assignee or SLA state", !("assignee" in (myTickets[0] ?? {})) && !("slaBreached" in (myTickets[0] ?? {})));
    }

    {
      const view = await openPortal(myToken);
      ok("the frame names the right company", view?.companyName.includes("Mine") === true, view?.companyName);
      ok("  and greets by first name only", view?.personName === "Priya", view?.personName);
      ok("a garbage token is refused", (await openPortal("not-a-real-token-at-all-really")) === null);
      ok("an empty token is refused", (await openPortal("")) === null);
    }

    section("The switches actually switch things off");

    await setSettings({ showInvoices: false, showTickets: false });
    {
      // Not merely undrawn: the data must not be in the response at all.
      ok("a hidden section returns nothing, not just an unrendered page", (await portalInvoices(myToken)).length === 0);
      ok("  and hiding tickets hides tickets", (await portalTickets(myToken)).length === 0);
      ok("  while what is still on keeps working", (await portalSubscriptions(myToken)).length === 1);
      const view = await openPortal(myToken);
      ok(
        "  and the frame agrees about what exists",
        view !== null && !view.sections.includes("invoices") && view.sections.includes("subscriptions"),
      );
    }

    await setSettings({});

    section("The master switch, and per-company access");

    await setSettings({ enabled: false });
    ok("switched off, a perfectly valid link shows nothing", (await openPortal(myToken)) === null);
    ok("  and its data is unreachable too", (await portalSubscriptions(myToken)).length === 0);

    await setSettings({ enabled: true, access: "SELECTED" });
    await db.company.update({ where: { id: mine.id }, data: { portalEnabled: false } });
    ok("a company switched off refuses its own live link", (await openPortal(myToken)) === null);
    await db.company.update({ where: { id: mine.id }, data: { portalEnabled: null } });
    ok("  and left on the default, SELECTED still refuses it", (await openPortal(myToken)) === null);
    await setSettings({ enabled: true, access: "ALL" });
    ok("  until the default becomes ALL", (await openPortal(myToken)) !== null);
    await db.company.update({ where: { id: mine.id }, data: { portalEnabled: true } });
    await setSettings({});

    section("Revoking and expiry, through the real path");

    {
      const temp = await link(mine.id, "Temporary Person");
      ok("a new link works", (await openPortal(temp)) !== null);
      await db.portalLogin.update({ where: { token: temp }, data: { revokedAt: new Date() } });
      ok("  and stops the moment it is revoked", (await openPortal(temp)) === null);
      ok("  its data going with it", (await portalSubscriptions(temp)).length === 0);

      const stale = await link(mine.id, "Former Employee");
      await db.portalLogin.update({ where: { token: stale }, data: { expiresAt: new Date(Date.now() - 1000) } });
      ok("an expired link is refused", (await openPortal(stale)) === null);
    }

    section("Raising a request");

    {
      const before = await db.portalRequest.count({ where: { companyId: mine.id } });
      const good = await raisePortalRequest(myToken, { kind: "renewal", companyProductId: myOrder });
      ok("a renewal request against our own subscription is accepted", good.ok, good.ok ? "" : good.error);
      ok("  and is recorded", (await db.portalRequest.count({ where: { companyId: mine.id } })) === before + 1);

      /**
       * The one client-supplied id in the whole public module, and therefore the one place it is
       * re-checked. Taken on trust, this would let somebody paste another customer's order id into
       * the form and have us record — and then act on — a request against a subscription that is
       * not theirs.
       */
      const crossed = await raisePortalRequest(myToken, { kind: "renewal", companyProductId: theirOrder });
      ok("another company's subscription is refused", !crossed.ok, crossed.ok ? "ACCEPTED IT" : crossed.error);
      ok("  with the same sentence as a bad token, revealing nothing", !crossed.ok && crossed.error === "This link is no longer valid.");
      ok("  and nothing was written", (await db.portalRequest.count({ where: { companyProductId: theirOrder } })) === 0);

      const noId = await raisePortalRequest(myToken, { kind: "renewal" });
      ok("a renewal with no subscription is refused", !noId.ok);

      const seats = await raisePortalRequest(myToken, { kind: "seats", companyProductId: myOrder, quantity: 5 });
      ok("a seat request is accepted", seats.ok, seats.ok ? "" : seats.error);
      ok("  but a fractional one is not", !(await raisePortalRequest(myToken, { kind: "seats", companyProductId: myOrder, quantity: 2.5 })).ok);
      ok("  nor an absurd one", !(await raisePortalRequest(myToken, { kind: "seats", companyProductId: myOrder, quantity: 99999 })).ok);
      ok("  nor zero", !(await raisePortalRequest(myToken, { kind: "seats", companyProductId: myOrder, quantity: 0 })).ok);

      ok("an empty question is refused", !(await raisePortalRequest(myToken, { kind: "question", message: "   " })).ok);
      ok("  a real one is accepted", (await raisePortalRequest(myToken, { kind: "question", message: "When does our Adobe expire?" })).ok);

      // A switched-off action must be refused at the action, not merely hidden on the page.
      await setSettings({ allowSeatRequest: false });
      const refused = await raisePortalRequest(myToken, { kind: "seats", companyProductId: myOrder, quantity: 5 });
      ok("an action switched off is refused server-side, not just hidden", !refused.ok, refused.ok ? "ACCEPTED IT" : refused.error);
      await setSettings({});

      await setSettings({ enabled: false });
      ok("and with the portal off, nothing can be raised at all", !(await raisePortalRequest(myToken, { kind: "question", message: "hello" })).ok);
      await setSettings({});
    }

    section("The Portal column on the customer list");

  {
    /**
     * Three states, because "on" and "off" would hide the one worth acting on: a customer switched
     * on and never sent a link looks finished from their own page and cannot actually get in.
     */
    await setSettings({});
    const shape = (c: { id: string }) => ({
      id: c.id,
      portalEnabled: null as boolean | null,
      relationshipType: "CLIENT",
      managedByResellerId: null as string | null,
    });

    const dark = await db.company.create({
      data: {
        name: `${PREFIX} Column ${stamp}`,
        normalizedName: `${PREFIX.toLowerCase()} column ${stamp}`,
        relationshipType: "CLIENT",
        portalEnabled: true,
        createdById: (await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } }))!.id,
      },
      select: { id: true },
    });

    try {
      const state = await portalStateFor([
        { ...shape(mine), portalEnabled: true },
        { ...shape(dark), portalEnabled: true },
        { ...shape(theirs), portalEnabled: false },
      ]);

      ok("a customer with a working link reads as on", state.get(mine.id)?.kind === "on", state.get(mine.id)?.kind);
      ok("  counting only the links that work", state.get(mine.id)?.links === 1, state.get(mine.id)?.links);
      ok("one granted but never sent a link reads differently", state.get(dark.id)?.kind === "granted", state.get(dark.id)?.kind);
      ok("one switched off reads as off", state.get(theirs.id)?.kind === "off", state.get(theirs.id)?.kind);
      ok("every company asked about gets an answer", state.size === 3, state.size);

      // The master switch has to reach the column too, or the list reassures about access that is
      // not there.
      await setSettings({ enabled: false });
      const dark2 = await portalStateFor([{ ...shape(mine), portalEnabled: true }]);
      ok("with the portal off every row reads as off", dark2.get(mine.id)?.kind === "off", dark2.get(mine.id)?.kind);
      await setSettings({});

      // A reseller's customer, which no per-company setting may override.
      const managed = await portalStateFor([
        { ...shape(mine), portalEnabled: true, managedByResellerId: "some-reseller" },
      ]);
      ok("a reseller's customer reads as off however it is set", managed.get(mine.id)?.kind === "off", managed.get(mine.id)?.kind);

      ok("no companies means no queries and no rows", (await portalStateFor([])).size === 0);
    } finally {
      await db.company.delete({ where: { id: dark.id } });
    }
  }

  section("The roster — who has access, in one place");

  {
    const admin = await db.user.findFirst({
      where: { isSuperAdmin: true },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = admin;
    const { portalRoster } = await import("../src/actions/portal");

    // A third company: granted, and nobody ever sent a link. The state the roster exists to surface,
    // because the company's own page says "allowed" and looks finished.
    const dark = await db.company.create({
      data: {
        name: `${PREFIX} Dark ${stamp}`,
        normalizedName: `${PREFIX.toLowerCase()} dark ${stamp}`,
        relationshipType: "CLIENT",
        portalEnabled: true,
        createdById: admin!.id,
      },
      select: { id: true },
    });

    try {
      await setSettings({});
      const roster = await portalRoster(PREFIX);
      if (!roster.ok) throw new Error(roster.error);

      const mineRow = roster.data.rows.find((r) => r.companyName.includes("Mine"));
      ok("a company with a link is listed", mineRow !== undefined, roster.data.rows.map((r) => r.companyName).join(","));
      ok("  naming who holds it", mineRow?.people.includes("Priya Sharma") === true, mineRow?.people.join(","));
      ok("  and how they got access", mineRow?.via === "granted", mineRow?.via);
      ok("  and whether it works today", mineRow?.allowed === true);

      ok(
        "a company granted but never sent a link is called out separately",
        roster.data.grantedWithoutLinks.some((c) => c.companyId === dark.id),
        roster.data.grantedWithoutLinks.map((c) => c.companyName).join(","),
      );
      ok(
        "  and is not padded into the main list as a row of zeroes",
        !roster.data.rows.some((r) => r.companyId === dark.id),
      );

      // Searching is what makes the list usable once there are two hundred of them.
      const narrowed = await portalRoster("Theirs");
      ok("the search narrows it", narrowed.ok && narrowed.data.rows.every((r) => r.companyName.includes("Theirs")), narrowed.ok ? narrowed.data.rows.length : "");

      /**
       * Measured as a difference rather than against an absolute.
       *
       * This fixture already contains a revoked link and an expired one from the sections above, so
       * an assertion expecting exactly one would be an assertion about the order of this file rather
       * than about the code.
       */
      const rowFor = async () => {
        const r = await portalRoster(PREFIX);
        return r.ok ? r.data.rows.find((x) => x.companyName.includes("Mine")) : undefined;
      };

      const before = (await rowFor())!;
      const revokedToken = await link(mine.id, "Gone Away");
      const justIssued = (await rowFor())!;
      ok(
        "a new link raises the active count",
        justIssued.activeLinks === before.activeLinks + 1,
        before.activeLinks + " -> " + justIssued.activeLinks,
      );

      await db.portalLogin.update({ where: { token: revokedToken }, data: { revokedAt: new Date() } });
      const withRevoked = (await rowFor())!;
      ok("revoking it drops the active count back", withRevoked.activeLinks === before.activeLinks, withRevoked.activeLinks);
      ok(
        "  and moves it to the no-longer-usable count",
        withRevoked.revokedLinks === before.revokedLinks + 1,
        before.revokedLinks + " -> " + withRevoked.revokedLinks,
      );

      /**
       * The defect this section found. An expired link was being counted as active, so the page told
       * somebody a customer could still get in when they could not — the one lie a roster of who has
       * access must not tell.
       */
      const expiredToken = await link(mine.id, "Ran Out");
      await db.portalLogin.update({ where: { token: expiredToken }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const withExpired = (await rowFor())!;
      ok("an expired link is not counted as active either", withExpired.activeLinks === before.activeLinks, withExpired.activeLinks);

      // Switching the portal off must show on the roster too, or the list reassures about access
      // that does not exist.
      await setSettings({ enabled: false });
      const dark2 = await portalRoster(PREFIX);
      ok("with the portal off the roster says so", dark2.ok && !dark2.data.enabled);
      ok("  and every row reads as blocked", dark2.ok && dark2.data.rows.every((r) => !r.allowed), dark2.ok ? dark2.data.rows.filter((r) => r.allowed).length : "");
      await setSettings({});
    } finally {
      await db.portalLogin.deleteMany({ where: { companyId: dark.id } });
      await db.company.delete({ where: { id: dark.id } });
      actor = null;
    }
  }

  section("A reseller's customer, end to end");

    {
      const reseller = await db.company.create({
        data: { name: `${PREFIX} Reseller ${stamp}`, normalizedName: `${PREFIX.toLowerCase()} reseller ${stamp}`, relationshipType: "RESELLER", createdById: user.id },
        select: { id: true },
      });
      const managed = await db.company.create({
        data: {
          name: `${PREFIX} Managed ${stamp}`, normalizedName: `${PREFIX.toLowerCase()} managed ${stamp}`,
          relationshipType: "CLIENT", portalEnabled: true, managedByResellerId: reseller.id, createdById: user.id,
        },
        select: { id: true },
      });
      const token = await link(managed.id, "Someone Else");
      await setSettings({ access: "ALL" });
      ok("a reseller's customer is refused through the real path", (await openPortal(token)) === null);
      ok("  even with the portal open to everybody and the company granted", (await portalSubscriptions(token)).length === 0);
      await setSettings({});
      await db.company.deleteMany({ where: { id: { in: [managed.id, reseller.id] } } });
    }
  } finally {
    await db.portalRequest.deleteMany({ where: { companyId: { in: [mine.id, theirs.id] } } });
    await db.portalLogin.deleteMany({ where: { companyId: { in: [mine.id, theirs.id] } } });
    await db.ticket.deleteMany({ where: { companyId: { in: [mine.id, theirs.id] } } });
    await db.companyProduct.deleteMany({ where: { companyId: { in: [mine.id, theirs.id] } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: [mine.id, theirs.id] } } });
    await db.company.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
    // Restored, not reset — see `settingsBefore`.
    if (settingsBefore) {
      const { id: _id, updatedAt: _updatedAt, ...restore } = settingsBefore;
      await db.portalSettings.upsert({
        where: { id: "global" },
        create: { id: "global", ...restore },
        update: restore,
      });
    } else {
      // No row existed, so this suite's own upsert is what created one. Leaving it behind would
      // change the app from "defaults" to "explicitly off", which is a different thing.
      await db.portalSettings.deleteMany({ where: { id: "global" } });
    }
  }

  console.log(failures === 0 ? "\nAll portal checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

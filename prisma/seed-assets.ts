/**
 * Seeds an IT estate — ours, ours at clients, and clients' own — then a consignment, and checks the
 * rules held.
 *
 * The check that matters most is the last one: no client-owned asset carries a financial record.
 * Everything else here could be wrong and be annoying; that one being wrong puts somebody else's
 * property on our balance sheet.
 *
 *   npm run db:seed:assets            seed and verify
 *   npm run db:seed:assets -- --reset remove what this made first
 *   npm run db:seed:assets -- --verify-only
 */
import { PrismaClient, Prisma, type AssetKind, type AssetOwnership } from "@prisma/client";
import { awayFromSite, coverState, ewayBillRequired, statusAfter } from "../src/lib/assets/lifecycle";

const db = new PrismaClient();

const TAG_PREFIX = "WRF-IT-";
const CLIENT_TAG_PREFIX = "CL-IT-";

let seed = 20260919;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const dec = (v: number) => new Prisma.Decimal(v);
const dateOnly = (d: Date | string) => new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00.000Z`);
const TODAY = dateOnly(new Date());
const daysFrom = (n: number) => dateOnly(new Date(TODAY.getTime() + n * 86400000));

const MODELS: { kind: AssetKind; name: string; make: string; model: string; cost: number }[] = [
  { kind: "LAPTOP", name: "ThinkPad T14 Gen 3", make: "Lenovo", model: "21AH", cost: 78000 },
  { kind: "LAPTOP", name: "MacBook Air M2", make: "Apple", model: "A2681", cost: 112000 },
  { kind: "LAPTOP", name: "Latitude 5430", make: "Dell", model: "5430", cost: 71000 },
  { kind: "DESKTOP", name: "OptiPlex 3000", make: "Dell", model: "3000", cost: 46000 },
  { kind: "MONITOR", name: "24\" IPS monitor", make: "Dell", model: "P2422H", cost: 12500 },
  { kind: "PRINTER", name: "LaserJet Pro", make: "HP", model: "M404dn", cost: 28000 },
  { kind: "NETWORK", name: "48-port switch", make: "Cisco", model: "CBS350", cost: 64000 },
  { kind: "SERVER", name: "PowerEdge T350", make: "Dell", model: "T350", cost: 310000 },
  { kind: "PHONE", name: "Galaxy A54", make: "Samsung", model: "SM-A546", cost: 34000 },
];

async function reset() {
  await db.assetMovement.deleteMany({});
  await db.consignment.deleteMany({});
  await db.asset.deleteMany({
    where: { OR: [{ assetTag: { startsWith: TAG_PREFIX } }, { assetTag: { startsWith: CLIENT_TAG_PREFIX } }] },
  });
  await db.tradeDocument.deleteMany({ where: { docType: "DELIVERY_CHALLAN" } });
  console.log("Removed the previous asset seed.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const staff = await db.user.findMany({
    where: { active: true, employeeProfile: { isNot: null } },
    select: { id: true, name: true },
    take: 16,
  });
  if (staff.length === 0) {
    throw new Error("No employees found. Run `npm run db:seed:hr` first — assets need people to hold them.");
  }

  const clients = await db.company.findMany({
    where: { relationshipType: "CLIENT" },
    orderBy: { name: "asc" },
    take: 4,
    select: { id: true, name: true, locations: { select: { id: true }, take: 1 } },
  });
  if (clients.length === 0) throw new Error("No client companies found. Run the main seed first.");

  const fixedAssets = await db.fixedAsset.findMany({
    where: { disposedOn: null, asset: null },
    select: { id: true },
  });

  let tag = 1;
  const nextTag = (prefix: string) => `${prefix}${String(tag++).padStart(3, "0")}`;
  let created = 0;
  let assigned = 0;

  // ── Ours, held by staff ────────────────────────────────────────────────────
  //
  // Some acknowledged, some not — the unconfirmed ones are the state the "what I'm holding" page
  // exists to clear, and the offboarding checklist reads.
  for (const person of staff) {
    const spec = pick(MODELS.filter((m) => m.kind === "LAPTOP"));
    const purchasedOn = daysFrom(-int(120, 900));
    const asset = await db.asset.create({
      data: {
        assetTag: nextTag(TAG_PREFIX),
        serialNumber: `SN${int(1000000, 9999999)}`,
        name: spec.name,
        kind: spec.kind,
        make: spec.make,
        model: spec.model,
        ownership: "INTERNAL",
        status: "ASSIGNED",
        custodianUserId: person.id,
        purchasedOn,
        purchaseCost: dec(spec.cost),
        // A spread of cover states, so the register shows live, expiring and lapsed.
        warrantyEndsOn: daysFrom(int(-200, 500)),
        fixedAssetId: fixedAssets[created]?.id ?? null,
        createdById: admin.id,
      },
      select: { id: true },
    });
    created += 1;
    assigned += 1;

    // Always after the purchase — an assignment dated before it would leave the register saying the
    // last thing that happened was the machine arriving, while claiming somebody is holding it.
    const daysOwned = Math.round((TODAY.getTime() - purchasedOn.getTime()) / 86400000);
    const assignedOn = daysFrom(-int(1, Math.max(1, daysOwned - 1)));
    await db.assetMovement.createMany({
      data: [
        {
          assetId: asset.id,
          type: "RECEIVED",
          occurredAt: purchasedOn,
          note: "Added to the register",
          recordedById: admin.id,
        },
        {
          assetId: asset.id,
          type: "ASSIGNED",
          occurredAt: assignedOn,
          toUserId: person.id,
          recordedById: admin.id,
          // Two thirds confirmed; the rest are the ones somebody has to chase.
          ...(rnd() < 0.66 ? { acknowledgedAt: assignedOn, acknowledgedById: person.id } : {}),
        },
      ],
    });
  }

  // ── Ours, in stock ─────────────────────────────────────────────────────────
  for (let i = 0; i < 6; i += 1) {
    const spec = pick(MODELS);
    const purchasedOn = daysFrom(-int(10, 200));
    const asset = await db.asset.create({
      data: {
        assetTag: nextTag(TAG_PREFIX),
        serialNumber: `SN${int(1000000, 9999999)}`,
        name: spec.name,
        kind: spec.kind,
        make: spec.make,
        model: spec.model,
        ownership: "INTERNAL",
        status: "IN_STOCK",
        purchasedOn,
        purchaseCost: dec(spec.cost),
        warrantyEndsOn: daysFrom(int(200, 900)),
        createdById: admin.id,
      },
      select: { id: true },
    });
    created += 1;
    await db.assetMovement.create({
      data: { assetId: asset.id, type: "RECEIVED", occurredAt: purchasedOn, recordedById: admin.id },
    });
  }

  // ── Ours, deployed at a client ─────────────────────────────────────────────
  //
  // Still our balance sheet, sitting at somebody else's office — the case the ownership field
  // exists to distinguish from the one below.
  let deployed = 0;
  for (const client of clients.slice(0, 2)) {
    for (let i = 0; i < 3; i += 1) {
      const spec = pick(MODELS);
      const purchasedOn = daysFrom(-int(200, 700));
      const asset = await db.asset.create({
        data: {
          assetTag: nextTag(TAG_PREFIX),
          serialNumber: `SN${int(1000000, 9999999)}`,
          name: spec.name,
          kind: spec.kind,
          make: spec.make,
          model: spec.model,
          ownership: "DEPLOYED",
          status: "INSTALLED",
          siteCompanyId: client.id,
          locationId: client.locations[0]?.id ?? null,
          purchasedOn,
          purchaseCost: dec(spec.cost),
          warrantyEndsOn: daysFrom(int(-100, 400)),
          createdById: admin.id,
        },
        select: { id: true },
      });
      created += 1;
      deployed += 1;
      await db.assetMovement.createMany({
        data: [
          { assetId: asset.id, type: "RECEIVED", occurredAt: purchasedOn, recordedById: admin.id },
          {
            assetId: asset.id,
            type: "INSTALLED",
            occurredAt: daysFrom(-int(30, 180)),
            toCompanyId: client.id,
            recordedById: admin.id,
          },
        ],
      });
    }
  }

  // ── The clients' own, which we manage ──────────────────────────────────────
  //
  // Never a fixedAssetId. This is the estate we look after without owning any of it.
  let clientOwned = 0;
  for (const client of clients) {
    for (let i = 0; i < 7; i += 1) {
      const spec = pick(MODELS);
      const asset = await db.asset.create({
        data: {
          assetTag: nextTag(CLIENT_TAG_PREFIX),
          serialNumber: `SN${int(1000000, 9999999)}`,
          name: spec.name,
          kind: spec.kind,
          make: spec.make,
          model: spec.model,
          ownership: "CLIENT_OWNED",
          status: "INSTALLED",
          ownerCompanyId: client.id,
          siteCompanyId: client.id,
          locationId: client.locations[0]?.id ?? null,
          purchasedOn: daysFrom(-int(300, 1200)),
          // Recorded for identification and e-way bills. It is not ours to capitalise.
          purchaseCost: dec(spec.cost),
          warrantyEndsOn: daysFrom(int(-400, 200)),
          amcEndsOn: rnd() < 0.6 ? daysFrom(int(-60, 300)) : null,
          createdById: admin.id,
        },
        select: { id: true },
      });
      created += 1;
      clientOwned += 1;
      // Two movements, in order: it came under management, and it is installed at their site. One
      // RECEIVED row alone would leave the register claiming INSTALLED with nothing behind it.
      const takenOn = daysFrom(-int(200, 800));
      await db.assetMovement.createMany({
        data: [
          {
            assetId: asset.id,
            type: "RECEIVED",
            occurredAt: takenOn,
            toCompanyId: client.id,
            note: "Taken under management",
            recordedById: admin.id,
          },
          {
            assetId: asset.id,
            type: "INSTALLED",
            occurredAt: daysFrom(-int(1, 199)),
            toCompanyId: client.id,
            recordedById: admin.id,
          },
        ],
      });
    }
  }

  // ── A couple of licences ───────────────────────────────────────────────────
  for (const licence of [
    { name: "Microsoft 365 Business Premium", seats: 25 },
    { name: "Adobe Creative Cloud", seats: 4 },
  ]) {
    await db.asset.create({
      data: {
        assetTag: nextTag(TAG_PREFIX),
        name: licence.name,
        kind: "SOFTWARE_LICENCE",
        ownership: "INTERNAL",
        status: "IN_STOCK",
        seats: licence.seats,
        licenceKey: `XXXXX-${int(10000, 99999)}-${int(10000, 99999)}`,
        amcEndsOn: daysFrom(int(40, 300)),
        createdById: admin.id,
      },
    });
    created += 1;
  }

  console.log(
    `Assets: ${created} (${assigned} with staff, ${deployed} deployed at clients, ${clientOwned} client-owned)`,
  );

  // ── A consignment out for repair ───────────────────────────────────────────
  //
  // Chosen deliberately: it is worth more than ₹50,000 and nothing is being sold, which is the case
  // people get wrong — an e-way bill is still required, and it travels on a challan, not an invoice.
  const forRepair = await db.asset.findMany({
    where: { assetTag: { startsWith: TAG_PREFIX }, status: "IN_STOCK", kind: { not: "SOFTWARE_LICENCE" } },
    take: 3,
    select: { id: true, purchaseCost: true },
  });

  if (forRepair.length > 0) {
    const value = forRepair.reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0);
    const consignment = await db.consignment.create({
      data: {
        consignmentNumber: `CON/2026-27/0001`,
        reason: "REPAIR_OUT",
        status: "IN_TRANSIT",
        toCompanyId: clients[0].id,
        fromLabel: "Wroffy — Andheri",
        courier: "Blue Dart",
        docketNumber: `${int(10000000, 99999999)}`,
        dispatchedOn: daysFrom(-2),
        expectedOn: daysFrom(3),
        declaredValue: dec(value),
        interstate: false,
        ewayBillNumber: value > 50000 ? `${int(100000000000, 999999999999)}` : null,
        createdById: admin.id,
      },
      select: { id: true },
    });

    for (const asset of forRepair) {
      await db.assetMovement.create({
        data: {
          assetId: asset.id,
          type: "DISPATCHED",
          occurredAt: daysFrom(-2),
          consignmentId: consignment.id,
          toLabel: "Service centre",
          recordedById: admin.id,
        },
      });
      await db.asset.update({ where: { id: asset.id }, data: { status: "IN_TRANSIT" } });
    }
    console.log(`Consignment: 1 out for repair, ₹${value.toLocaleString("en-IN")} of goods`);
  }

  // ── A collection from a client, out to a repair vendor ─────────────────────
  //
  // The case the client estate view is built around: two machines leave the same site on the same
  // van, one of theirs and one of ours. Theirs stays on their estate because ownership doesn't
  // travel; ours drops off the site list entirely — and would vanish from their page altogether if
  // the movement didn't record where it was collected from.
  const collectFrom = clients[0];
  const repairer = await db.company.findFirst({
    where: { relationshipType: { not: "CLIENT" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const [theirMachine, ourMachine] = await Promise.all([
    db.asset.findFirst({
      where: { ownerCompanyId: collectFrom.id, status: "INSTALLED", kind: { not: "SOFTWARE_LICENCE" } },
      select: { id: true, purchaseCost: true, locationId: true },
    }),
    db.asset.findFirst({
      where: { siteCompanyId: collectFrom.id, ownership: "DEPLOYED", status: "INSTALLED" },
      select: { id: true, purchaseCost: true, locationId: true },
    }),
  ]);

  if (repairer && theirMachine && ourMachine) {
    const collected = [theirMachine, ourMachine];
    const value = collected.reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0);
    const collection = await db.consignment.create({
      data: {
        consignmentNumber: `CON/2026-27/0002`,
        reason: "REPAIR_OUT",
        status: "IN_TRANSIT",
        toCompanyId: repairer.id,
        fromLabel: collectFrom.name,
        courier: "Gati",
        docketNumber: `${int(10000000, 99999999)}`,
        dispatchedOn: daysFrom(-4),
        expectedOn: daysFrom(6),
        declaredValue: dec(value),
        interstate: false,
        ewayBillNumber: value > 50000 ? `${int(100000000000, 999999999999)}` : null,
        createdById: admin.id,
      },
      select: { id: true },
    });

    for (const asset of collected) {
      await db.assetMovement.create({
        data: {
          assetId: asset.id,
          type: "DISPATCHED",
          occurredAt: daysFrom(-4),
          consignmentId: collection.id,
          fromCompanyId: collectFrom.id,
          fromLocationId: asset.locationId,
          toCompanyId: repairer.id,
          recordedById: admin.id,
        },
      });
      // Where it is now follows the machine — which is precisely what takes ours off the client's
      // site list while it is away.
      await db.asset.update({
        where: { id: asset.id },
        data: { status: "IN_TRANSIT", siteCompanyId: repairer.id, locationId: null },
      });
    }
    console.log(`Collection: 2 machines from ${collectFrom.name} to ${repairer.name} for repair`);
  }
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };

  console.log("\n— Verifying —");

  const total = await db.asset.count();
  ok("the register was seeded", total > 0, `${total} asset(s)`);

  // The one that matters. A client's machine on our balance sheet would be claiming property we
  // don't own — and it would pass every accounting check, because nothing else knows the difference.
  const capitalisedClientAssets = await db.asset.count({
    where: { ownership: "CLIENT_OWNED", fixedAssetId: { not: null } },
  });
  ok(
    "no client-owned asset carries a financial record",
    capitalisedClientAssets === 0,
    capitalisedClientAssets === 0 ? "their property stays off our balance sheet" : `${capitalisedClientAssets} found`,
  );

  const clientAssetsWithoutOwner = await db.asset.count({
    where: { ownership: "CLIENT_OWNED", ownerCompanyId: null },
  });
  ok("every client-owned asset says whose it is", clientAssetsWithoutOwner === 0);

  const oursWithOwner = await db.asset.count({
    where: { ownership: { not: "CLIENT_OWNED" }, ownerCompanyId: { not: null } },
  });
  ok("nothing of ours is also owned by a company", oursWithOwner === 0, "one or the other, never both");

  const deployedNowhere = await db.asset.count({ where: { ownership: "DEPLOYED", siteCompanyId: null } });
  ok("every deployed asset says where it is", deployedNowhere === 0);

  // Our kit at a client is still ours — it must keep its financial record.
  const deployed = await db.asset.count({ where: { ownership: "DEPLOYED" } });
  ok("our kit is deployed at clients too", deployed > 0, `${deployed} — still our balance sheet`);

  const duplicateSerials = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT "serialNumber" FROM assets WHERE "serialNumber" IS NOT NULL
      GROUP BY "serialNumber" HAVING COUNT(*) > 1
    ) dupes`;
  ok("no serial number is on two machines", Number(duplicateSerials[0]?.count ?? 0) === 0);

  // Status has to agree with the last thing that happened, or the register lies about where things are.
  const assets = await db.asset.findMany({
    where: { status: { notIn: ["RETIRED", "LOST"] } },
    select: {
      id: true, assetTag: true, status: true,
      movements: { orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 1, select: { type: true } },
    },
  });
  const drifted = assets.filter((a) => a.movements[0] && statusAfter(a.movements[0].type) !== a.status);
  ok(
    "every status matches the last movement",
    drifted.length === 0,
    drifted.length ? drifted.slice(0, 3).map((a) => a.assetTag).join(", ") : `${assets.length} checked`,
  );

  const assignedWithoutHolder = await db.asset.count({
    where: { status: "ASSIGNED", custodianUserId: null },
  });
  ok("nothing is assigned to nobody", assignedWithoutHolder === 0);

  const heldWithoutMovement = await db.asset.count({
    where: { custodianUserId: { not: null }, movements: { none: { type: "ASSIGNED" } } },
  });
  ok("everything held by somebody was handed over", heldWithoutMovement === 0, "no asset just appears on a name");

  const unconfirmed = await db.assetMovement.count({
    where: { type: "ASSIGNED", acknowledgedAt: null, toUserId: { not: null } },
  });
  ok("some handovers are unconfirmed, as in life", unconfirmed > 0, `${unconfirmed} to chase`);

  // Cover
  const withCover = await db.asset.findMany({
    select: { warrantyEndsOn: true, amcEndsOn: true },
  });
  const states = withCover.map((a) => coverState(a));
  const covered = states.filter((s) => s.tone === "green").length;
  const expired = states.filter((s) => s.key === "EXPIRED").length;
  ok("the estate has a spread of cover", covered > 0 && expired > 0, `${covered} covered, ${expired} lapsed`);

  // Logistics
  const consignments = await db.consignment.findMany({
    select: { consignmentNumber: true, reason: true, declaredValue: true, interstate: true, ewayBillNumber: true },
  });
  ok("a consignment exists", consignments.length > 0, `${consignments.length}`);

  const missingEway = consignments.filter((c) => {
    const req = ewayBillRequired({
      declaredValue: c.declaredValue ? Number(c.declaredValue) : null,
      interstate: c.interstate,
      reason: c.reason,
    });
    return req.required && !c.ewayBillNumber;
  });
  ok(
    "anything above the threshold carries an e-way bill",
    missingEway.length === 0,
    missingEway.length ? missingEway.map((c) => c.consignmentNumber).join(", ") : "including the repair run",
  );

  const repairConsignments = consignments.filter((c) => c.reason === "REPAIR_OUT");
  ok(
    "a repair consignment needs one too",
    repairConsignments.length > 0 && repairConsignments.every((c) => !!c.ewayBillNumber),
    "the threshold is about the goods moving, not about a sale",
  );

  const challansInLedger = await db.journalEntry.count({ where: { document: { docType: "DELIVERY_CHALLAN" } } });
  ok(
    "no delivery challan reached the ledger",
    challansInLedger === 0,
    "sending a laptop for repair is not revenue",
  );

  const inTransit = await db.asset.count({ where: { status: "IN_TRANSIT" } });
  ok("assets on a dispatched consignment are in transit", inTransit > 0, `${inTransit}`);

  // ── What a client sees on their own page ───────────────────────────────────
  //
  // The three lists the estate tab is built from, queried exactly as the action queries them. The
  // point of checking them together is that they must partition: every machine we look after for
  // this client belongs to exactly one of them, or the page double-counts or loses something.
  const collection = await db.consignment.findFirst({
    where: { consignmentNumber: "CON/2026-27/0002" },
    select: {
      toCompany: { select: { name: true } },
      movements: { select: { assetId: true, fromCompanyId: true, asset: { select: { ownership: true } } } },
    },
  });

  if (!collection) {
    ok("a collection from a client site exists", false, "nothing to check the estate split against");
  } else {
    const clientId = collection.movements[0]?.fromCompanyId ?? "";

    ok(
      "every machine on the collection says where it was picked up",
      collection.movements.every((m) => m.fromCompanyId === clientId),
      "a movement with only a destination can't answer whose site it left",
    );

    const theirs = await db.asset.findMany({
      where: { ownerCompanyId: clientId, status: { not: "RETIRED" } },
      select: { id: true, assetTag: true, ownership: true },
    });
    const ours = await db.asset.findMany({
      where: { siteCompanyId: clientId, ownership: { not: "CLIENT_OWNED" }, status: { not: "RETIRED" } },
      select: { id: true, assetTag: true, ownership: true },
    });
    const movedOut = await db.asset.findMany({
      where: {
        status: { in: ["IN_TRANSIT", "UNDER_REPAIR"] },
        movements: { some: { fromCompanyId: clientId } },
      },
      select: {
        id: true,
        assetTag: true,
        movements: { orderBy: { occurredAt: "desc" }, take: 1, select: { fromCompanyId: true } },
      },
    });
    const away = awayFromSite({ candidates: movedOut, companyId: clientId, stillHere: [...theirs, ...ours] });

    ok("their estate is all theirs", theirs.every((a) => a.ownership === "CLIENT_OWNED"), `${theirs.length} machine(s)`);
    ok(
      "  and nothing of ours is filed under it",
      ours.every((a) => a.ownership !== "CLIENT_OWNED"),
      `${ours.length} of ours on their site — still our balance sheet`,
    );

    const seen = new Set<string>();
    const duplicated = [...theirs, ...ours, ...away].filter((a) => (seen.has(a.id) ? true : (seen.add(a.id), false)));
    ok("no machine is counted twice across the three lists", duplicated.length === 0, `${seen.size} distinct`);

    // The two halves of the same van run, which land in different places on the page.
    const theirsAway = collection.movements.find((m) => m.asset.ownership === "CLIENT_OWNED");
    const oursAway = collection.movements.find((m) => m.asset.ownership !== "CLIENT_OWNED");

    ok(
      "their own machine stays on their estate while it is away",
      !!theirsAway && theirs.some((a) => a.id === theirsAway.assetId),
      "ownership doesn't travel with the van",
    );
    ok(
      "ours, collected from their site, leaves the site list",
      !!oursAway && !ours.some((a) => a.id === oursAway.assetId),
      "its site is the repairer's now",
    );
    ok(
      "  but it is still on their page, under what's away",
      !!oursAway && away.some((a) => a.id === oursAway.assetId),
      `${away.length} away — otherwise nobody could answer where it went`,
    );
  }

  console.log(failures === 0 ? "\nAll asset seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});

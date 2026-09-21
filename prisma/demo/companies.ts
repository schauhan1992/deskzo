import { PrismaClient, type CompanyRelationshipType, type CompanyStage } from "@prisma/client";
import type { SeededPerson } from "./people";
import {
  CITIES,
  COMPANY_MIDS,
  COMPANY_PREFIXES,
  COMPANY_SUFFIXES,
  DEMO_TAG,
  INDUSTRIES,
  chance,
  daysAgo,
  gstin,
  int,
  log,
  normalise,
  slugOf,
  personName,
  phone,
  pick,
  rnd,
  some,
  sometimeLastYear,
} from "./shared";

/**
 * Five hundred companies, in the proportions a real book has.
 *
 * ## Not five hundred customers
 *
 * A system integrator's database is mostly people who have not bought anything. Prospects the
 * calling team sourced, leads that went quiet, a handful of resellers, the vendors it buys from.
 * Making them all customers would produce a demo where every screen is full and every filter is
 * pointless — and would hide the thing the app is actually for, which is working out which of the
 * cold ones is worth a call.
 *
 * The split below is roughly what this business would have after a year of prospecting: about a
 * fifth converted, a third still in play, the rest cold or written off.
 */

type Mix = { relationship: CompanyRelationshipType; stage: CompanyStage; weight: number };

const MIX: Mix[] = [
  { relationship: "CLIENT", stage: "CUSTOMER", weight: 95 },
  { relationship: "CLIENT", stage: "LEAD", weight: 120 },
  { relationship: "CLIENT", stage: "PROSPECT", weight: 190 },
  { relationship: "CLIENT", stage: "DISQUALIFIED", weight: 45 },
  // A supplier is not at a stage in a sales pipeline. `stage` only models the four steps a
  // prospect moves through, so everybody who is not a customer-in-waiting sits at CUSTOMER and is
  // told apart by `relationshipType` — which is what every screen actually filters on.
  { relationship: "RESELLER", stage: "CUSTOMER", weight: 14 },
  { relationship: "VENDOR", stage: "CUSTOMER", weight: 22 },
  { relationship: "DISTRIBUTOR", stage: "CUSTOMER", weight: 8 },
  { relationship: "OEM", stage: "CUSTOMER", weight: 6 },
  // Introducers: people who bring us business and take a cut of it. Few, and every one of them
  // has a payout account on file, because a commission nobody can pay is a commission that gets
  // argued about.
  { relationship: "COMMISSION_PARTY", stage: "CUSTOMER", weight: 5 },
  { relationship: "PARTNER", stage: "CUSTOMER", weight: 6 },
];

/**
 * The mix, turned into exactly `total` entries.
 *
 * Weights are proportions, not counts — the book has to come out in the right shape whether you
 * ask for fifty companies or five thousand. The obvious version expands the weights into a list
 * and walks it, and that version silently drops whatever sits at the end of the list the moment
 * the weights add up to more than `total`: adding introducers to the bottom of the mix produced
 * exactly zero of them, with no error anywhere.
 *
 * Largest remainder, so the rounding slack goes to the categories that lost the most to it, and
 * then shuffled, so the mix is spread through the run rather than arriving in blocks — and so no
 * category can be cut off the end again.
 */
function planMix(total: number): Mix[] {
  const totalWeight = MIX.reduce((t, m) => t + m.weight, 0);
  const shares = MIX.map((m) => ({ m, exact: (m.weight / totalWeight) * total }));

  const plan: Mix[] = [];
  for (const s of shares) for (let i = 0; i < Math.floor(s.exact); i++) plan.push(s.m);

  const byRemainder = [...shares].sort((x, y) => (y.exact % 1) - (x.exact % 1));
  for (let i = plan.length; i < total; i++) plan.push(byRemainder[(i - plan.length) % byRemainder.length]!.m);

  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  return plan;
}

export type SeededCompany = {
  id: string;
  name: string;
  relationship: CompanyRelationshipType;
  stage: CompanyStage;
  locationId: string;
  stateCode: string;
  ownerId: string | null;
  contactIds: string[];
  employeeCount: number;
};

function companyName(used: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${pick(COMPANY_PREFIXES)} ${pick(COMPANY_MIDS)} ${pick(COMPANY_SUFFIXES)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // The name space is large but finite; a counter guarantees termination without a duplicate.
  const fallback = `${pick(COMPANY_PREFIXES)} ${pick(COMPANY_MIDS)} ${used.size}`;
  used.add(fallback);
  return fallback;
}

export async function seedCompanies(
  db: PrismaClient,
  people: SeededPerson[],
  createdById: string,
  total = 500,
): Promise<SeededCompany[]> {
  const industries = new Map<string, string>();
  for (const name of INDUSTRIES) {
    const row = await db.industry.upsert({ where: { name }, create: { name }, update: {}, select: { id: true } });
    industries.set(name, row.id);
  }

  // Who can own an account. Calling and profiling staff source them but do not own them.
  const owners = people.filter((p) => p.dept === "Sales" || p.title === "Presales Consultant");
  const plan = planMix(total);

  const used = new Set<string>();
  const out: SeededCompany[] = [];
  let contacts = 0;
  let resellerManaged = 0;

  for (let i = 0; i < total; i++) {
    const mix = plan[i]!;
    const name = companyName(used);
    const [city, state, stateCode, pinPrefix] = pick(CITIES);
    const createdAt = sometimeLastYear();

    // A customer has an owner; a cold prospect often does not, which is what makes the "unassigned"
    // filter worth having.
    const owner =
      mix.stage === "CUSTOMER" || mix.stage === "LEAD"
        ? pick(owners)
        : chance(0.35)
          ? pick(owners)
          : null;

    const employeeCount = pick([8, 15, 24, 40, 65, 90, 140, 220, 380, 600, 1200]);
    const registered = mix.stage !== "PROSPECT" || chance(0.6);

    const company = await db.company.create({
      data: {
        name,
        normalizedName: normalise(name),
        relationshipType: mix.relationship,
        stage: mix.stage,
        industryId: industries.get(pick(INDUSTRIES))!,
        employeeCount,
        website: `https://www.${slugOf(name).split(" ")[0]}.example`,
        panNumber: registered ? `AA${pick("ABCDEFGHIJ".split(""))}CS${int(1000, 9999)}${pick("ABCDEFGH".split(""))}` : null,
        paymentTerms: pick(["DUE_ON_RECEIPT", "NET_15", "NET_30", "NET_30", "NET_45"] as const),
        source: pick(["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"] as const),
        tags: [DEMO_TAG],
        createdById,
        ownerUserId: owner?.id ?? null,
        assignedToUserId: owner?.id ?? null,
        assignedByUserId: owner ? createdById : null,
        assignedAt: owner ? createdAt : null,
        createdAt,
        vendorStatus:
          mix.relationship === "VENDOR" || mix.relationship === "DISTRIBUTOR"
            ? pick(["ACTIVE", "ACTIVE", "ONBOARDING", "INACTIVE"] as const)
            : null,
        locations: {
          create: {
            label: "Head office",
            isPrimary: true,
            isBilling: true,
            isShipping: true,
            address: `${int(1, 400)}, ${pick(["Industrial Estate", "Tech Park", "Business Centre", "Corporate Park", "Trade Centre"])}, ${pick(["Phase I", "Phase II", "Sector 18", "Block A", "MIDC"])}`,
            city,
            state,
            pincode: `${pinPrefix}${int(10, 99)}`,
            country: "India",
            gstNumber: registered ? gstin(stateCode) : null,
            // Registered businesses claim input credit; the rest are quoted the same either way.
            gstTreatment: registered ? "REGISTERED_REGULAR" : "UNREGISTERED",
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });

    // ── Contacts ────────────────────────────────────────────────────────────────────────────────
    // A prospect nobody has spoken to has one name on it; a customer has the people you actually
    // deal with — somebody who signs, somebody technical, somebody in accounts.
    const contactCount = mix.stage === "CUSTOMER" ? int(2, 5) : mix.stage === "LEAD" ? int(1, 3) : 1;
    // The designations the schema knows about — the form offers these, so the demo should too.
    const designations = some(
      ["DIRECTOR", "IT_MANAGER", "IT_HEAD", "PURCHASE_MANAGER", "CEO", "CIO", "HR"] as const,
      contactCount,
    );
    const contactIds: string[] = [];
    for (let c = 0; c < contactCount; c++) {
      const person = personName();
      const row = await db.contact.create({
        data: {
          companyId: company.id,
          name: person,
          designation: designations[c] ?? "OTHER",
          email: chance(0.85)
            ? `${person.toLowerCase().replace(" ", ".")}@${slugOf(name).split(" ")[0]}.example`
            : null,
          phone: chance(0.9) ? phone() : null,
          isPrimary: c === 0,
          createdByUserId: createdById,
          createdAt,
        },
        select: { id: true },
      });
      contactIds.push(row.id);
      contacts += 1;
    }

    out.push({
      id: company.id,
      name,
      relationship: mix.relationship,
      stage: mix.stage,
      locationId: company.locations[0]!.id,
      stateCode,
      ownerId: owner?.id ?? null,
      contactIds,
      employeeCount,
    });
  }

  // ── A few end customers belonging to resellers ────────────────────────────────────────────────
  // The reseller rule is one of the sharper edges in this app — those companies must never be
  // called or emailed directly — and it is invisible until some of them exist.
  const resellers = out.filter((c) => c.relationship === "RESELLER");
  const candidates = out.filter((c) => c.stage === "CUSTOMER" || c.stage === "LEAD");
  for (const customer of some(candidates, Math.min(28, candidates.length))) {
    await db.company.update({
      where: { id: customer.id },
      data: { managedByResellerId: pick(resellers).id },
    });
    resellerManaged += 1;
  }

    // Counted by relationship as well as stage: suppliers also sit at the CUSTOMER stage, and
  // reporting them as customers would overstate the book by a third.
  const buying = out.filter((x) => x.relationship === "CLIENT");
  const suppliers = out.filter((x) => x.relationship !== "CLIENT");
  log(
    "Companies",
    `${out.length} — ${buying.filter((x) => x.stage === "CUSTOMER").length} customers, ` +
      `${buying.filter((x) => x.stage === "LEAD").length} live leads, ` +
      `${buying.filter((x) => x.stage === "PROSPECT").length} prospects, ` +
      `${buying.filter((x) => x.stage === "DISQUALIFIED").length} written off, ` +
      `${suppliers.length} suppliers and partners`,
  );
  log("Contacts", `${contacts}`);
  log("Reseller-managed", `${resellerManaged} end customers behind ${resellers.length} resellers`);
  void daysAgo;
  return out;
}

/**
 * Bulk test data: 200 companies spanning every scenario the app models, plus the leads, orders,
 * payments, subscriptions, tickets and tasks that hang off them.
 *
 *   npm run db:seed:test           # add the data
 *   npm run db:seed:test -- --reset  # remove a previous run first, then add it again
 *
 * Everything it creates is tagged so it can be found and removed again: companies carry the
 * `seed-test` tag, items use a `TST-` SKU prefix. Nothing that already existed is modified.
 *
 * The randomness is seeded, so a re-run produces the same catalogue rather than a different one.
 */
import { PrismaClient, type CompanyStage, type ItemType, type OrderStatus, type OrderBusinessType } from "@prisma/client";

const db = new PrismaClient();

const SEED_TAG = "seed-test";
const TEST_SKU_PREFIX = "TST-";
const TODAY = new Date();

/** Deterministic PRNG so repeated runs produce the same data. */
let seed = 20260917;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const chance = (p: number) => rnd() < p;
const daysFromNow = (days: number) => new Date(TODAY.getTime() + days * 86400000);
const some = <T,>(arr: readonly T[], n: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};

const PREFIXES = [
  "Acme", "Brightwave", "Cobalt", "Dynamic", "Evergreen", "Falcon", "Granite", "Horizon", "Indus",
  "Juniper", "Kinetic", "Lumen", "Meridian", "Nimbus", "Orbit", "Pinnacle", "Quantum", "Redwood",
  "Summit", "Trident", "Umbra", "Vertex", "Westfield", "Xenon", "Yellowstone", "Zenith", "Arcadia",
  "Bluepeak", "Crestview", "Delta", "Eastgate", "Fairmont", "Goldline", "Harbour", "Ironclad",
];
const MIDS = ["Tech", "Systems", "Industries", "Logistics", "Retail", "Healthcare", "Infra", "Digital", "Foods", "Textiles", "Motors", "Pharma"];
const SUFFIXES = ["Pvt Ltd", "Solutions Pvt Ltd", "India Pvt Ltd", "Enterprises", "LLP", "Services Pvt Ltd"];

const CITIES: [string, string][] = [
  ["Mumbai", "Maharashtra"], ["Pune", "Maharashtra"], ["Bengaluru", "Karnataka"], ["Hyderabad", "Telangana"],
  ["Chennai", "Tamil Nadu"], ["Delhi", "Delhi"], ["Gurugram", "Haryana"], ["Noida", "Uttar Pradesh"],
  ["Ahmedabad", "Gujarat"], ["Surat", "Gujarat"], ["Kolkata", "West Bengal"], ["Jaipur", "Rajasthan"],
  ["Indore", "Madhya Pradesh"], ["Kochi", "Kerala"], ["Chandigarh", "Punjab"],
];
/** First four digits of each city's PIN range — the last two are randomised per location. */
const CITY_PIN_PREFIX: Record<string, string> = {
  Mumbai: "4000", Pune: "4110", Bengaluru: "5600", Hyderabad: "5000", Chennai: "6000",
  Delhi: "1100", Gurugram: "1220", Noida: "2013", Ahmedabad: "3800", Surat: "3950",
  Kolkata: "7000", Jaipur: "3020", Indore: "4520", Kochi: "6820", Chandigarh: "1600",
};

const STATE_GST_CODE: Record<string, string> = {
  Maharashtra: "27", Karnataka: "29", Telangana: "36", "Tamil Nadu": "33", Delhi: "07", Haryana: "06",
  "Uttar Pradesh": "09", Gujarat: "24", "West Bengal": "19", Rajasthan: "08", "Madhya Pradesh": "23",
  Kerala: "32", Punjab: "03",
};

const FIRST = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ayaan", "Krishna", "Ishaan",
  "Ananya", "Diya", "Aadhya", "Saanvi", "Pari", "Anika", "Navya", "Riya", "Meera", "Kavya",
  "Rahul", "Sanjay", "Priya", "Neha", "Rekha", "Vikram", "Deepak", "Sunita", "Manoj", "Asha"];
const LAST = ["Sharma", "Verma", "Patel", "Reddy", "Nair", "Iyer", "Singh", "Gupta", "Mehta", "Desai",
  "Kulkarni", "Joshi", "Rao", "Chauhan", "Banerjee", "Kapoor", "Malhotra", "Bhat", "Pillai", "Shetty"];

const DESIGNATIONS = ["IT_MANAGER", "PURCHASE_MANAGER", "IT_HEAD", "DIRECTOR", "CEO", "CIO", "HR", "OTHER"] as const;
const SOURCES = ["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"] as const;
const COMPANY_TYPES = ["PRIVATE_LIMITED", "PUBLIC_LIMITED", "PROPRIETORSHIP", "PARTNERSHIP", "LLP", "NGO", "GOVERNMENT", "OTHER"] as const;
const PAYMENT_TERMS = ["DUE_ON_RECEIPT", "ADVANCE", "NET_15", "NET_30", "NET_45", "NET_60"] as const;
const GST_TREATMENTS = ["REGISTERED_REGULAR", "REGISTERED_COMPOSITION", "UNREGISTERED", "CONSUMER", "SEZ"] as const;
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "DISQUALIFIED"] as const;
const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] as const;
const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const TICKET_TYPES = ["PRODUCT_SUPPORT", "DEMO", "INSTALLATION", "TRAINING", "OTHER"] as const;
const ORDER_STATUSES: OrderStatus[] = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "PROCESSING", "FULFILLED", "CANCELLED"];
const BUSINESS_TYPES: OrderBusinessType[] = ["NEW", "RENEWAL", "NEW_TO_US_RENEWAL"];

const BRAND_FAMILIES: Record<string, string[]> = {
  Microsoft: ["Microsoft 365", "Windows Server", "Azure", "Dynamics 365"],
  Adobe: ["Creative Cloud", "Acrobat", "Experience Cloud"],
  Dell: ["Latitude", "OptiPlex", "PowerEdge"],
  HP: ["EliteBook", "ProDesk", "LaserJet"],
  Lenovo: ["ThinkPad", "ThinkCentre"],
  Fortinet: ["FortiGate", "FortiClient"],
  Zoho: ["Zoho One", "Zoho Books"],
  Tally: ["TallyPrime"],
};

type ItemSpec = { name: string; type: ItemType; unit: string; price: number; cycle?: string };
const ITEM_TEMPLATES: Record<string, ItemSpec[]> = {
  "Microsoft 365": [
    { name: "Microsoft 365 Business Basic", type: "SUBSCRIPTION", unit: "Seat / year", price: 6500, cycle: "ANNUAL" },
    { name: "Microsoft 365 Business Premium", type: "SUBSCRIPTION", unit: "Seat / year", price: 18500, cycle: "ANNUAL" },
    { name: "Microsoft 365 E3", type: "SUBSCRIPTION", unit: "Seat / year", price: 29500, cycle: "ANNUAL" },
  ],
  "Windows Server": [
    { name: "Windows Server 2025 Standard", type: "PERPETUAL", unit: "Licence", price: 82000 },
    { name: "Windows Server CAL Pack (5)", type: "PERPETUAL", unit: "Pack", price: 21000 },
  ],
  Azure: [{ name: "Azure Reserved Instance (1yr)", type: "SUBSCRIPTION", unit: "Instance / year", price: 145000, cycle: "ANNUAL" }],
  "Dynamics 365": [{ name: "Dynamics 365 Sales Professional", type: "SUBSCRIPTION", unit: "Seat / year", price: 54000, cycle: "ANNUAL" }],
  "Creative Cloud": [
    { name: "Adobe Creative Cloud All Apps", type: "SUBSCRIPTION", unit: "Seat / year", price: 63000, cycle: "ANNUAL" },
    { name: "Adobe Photoshop Single App", type: "SUBSCRIPTION", unit: "Seat / year", price: 23000, cycle: "ANNUAL" },
  ],
  Acrobat: [{ name: "Adobe Acrobat Pro 2024", type: "PERPETUAL", unit: "Licence", price: 39000 }],
  "Experience Cloud": [{ name: "Adobe Analytics Starter", type: "SUBSCRIPTION", unit: "Org / year", price: 480000, cycle: "ANNUAL" }],
  Latitude: [
    { name: "Dell Latitude 3550 Laptop", type: "GOOD", unit: "Piece", price: 54000 },
    { name: "Dell Latitude 7450 Laptop", type: "GOOD", unit: "Piece", price: 98000 },
  ],
  OptiPlex: [{ name: "Dell OptiPlex 7020 Desktop", type: "GOOD", unit: "Piece", price: 46000 }],
  PowerEdge: [{ name: "Dell PowerEdge R760 Server", type: "GOOD", unit: "Piece", price: 425000 }],
  EliteBook: [{ name: "HP EliteBook 840 G11", type: "GOOD", unit: "Piece", price: 105000 }],
  ProDesk: [{ name: "HP ProDesk 400 G9", type: "GOOD", unit: "Piece", price: 44000 }],
  LaserJet: [{ name: "HP LaserJet Pro MFP 4103", type: "GOOD", unit: "Piece", price: 38000 }],
  ThinkPad: [{ name: "Lenovo ThinkPad E14 Gen 6", type: "GOOD", unit: "Piece", price: 72000 }],
  ThinkCentre: [{ name: "Lenovo ThinkCentre M70q", type: "GOOD", unit: "Piece", price: 51000 }],
  FortiGate: [
    { name: "FortiGate 60F Firewall", type: "GOOD", unit: "Piece", price: 68000 },
    { name: "FortiGate 60F UTM Bundle (1yr)", type: "SUBSCRIPTION", unit: "Device / year", price: 42000, cycle: "ANNUAL" },
  ],
  FortiClient: [{ name: "FortiClient EMS (25 endpoints)", type: "SUBSCRIPTION", unit: "Pack / year", price: 56000, cycle: "ANNUAL" }],
  "Zoho One": [{ name: "Zoho One All Employee", type: "SUBSCRIPTION", unit: "Seat / year", price: 32000, cycle: "ANNUAL" }],
  "Zoho Books": [{ name: "Zoho Books Premium", type: "SUBSCRIPTION", unit: "Org / year", price: 18000, cycle: "ANNUAL" }],
  TallyPrime: [{ name: "TallyPrime Silver Perpetual", type: "PERPETUAL", unit: "Licence", price: 22500 }],
};
const SERVICE_ITEMS: ItemSpec[] = [
  { name: "On-site Deployment (per day)", type: "SERVICE", unit: "Day", price: 12000 },
  { name: "Migration Service — Email", type: "SERVICE", unit: "Project", price: 85000 },
  { name: "Annual Maintenance Contract", type: "SERVICE", unit: "Year", price: 65000 },
  { name: "End-user Training Session", type: "SERVICE", unit: "Session", price: 18000 },
];

async function reset() {
  console.log("Removing previous seed-test data…");
  const companies = await db.company.findMany({ where: { tags: { has: SEED_TAG } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  // Orders/payments/tickets/tasks/leads/contacts/locations all cascade from Company.
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TEST_SKU_PREFIX } } });
  // Only drop a brand once nothing references it, so brands added by hand survive.
  for (const brandName of Object.keys(BRAND_FAMILIES)) {
    const brand = await db.brand.findUnique({ where: { name: brandName }, include: { _count: { select: { items: true } } } });
    if (brand && brand._count.items === 0) await db.brand.delete({ where: { id: brand.id } });
  }
  console.log(`  removed ${ids.length} companies and their related records`);
}

async function main() {
  if (process.argv.includes("--reset")) await reset();

  const existing = await db.company.count({ where: { tags: { has: SEED_TAG } } });
  if (existing > 0) {
    console.error(`${existing} seed-test companies already exist. Re-run with --reset to replace them.`);
    process.exit(1);
  }

  const users = await db.user.findMany({ select: { id: true, name: true, role: true } });
  if (users.length === 0) throw new Error("No users found — run `npm run db:seed` first.");
  const admin = users.find((u) => u.role === "ADMIN") ?? users[0];
  const sales = users.filter((u) => u.role === "SALES" || u.role === "ADMIN");
  const support = users.filter((u) => u.role === "SUPPORT" || u.role === "ADMIN");
  const callers = users.filter((u) => u.role === "CALLING" || u.role === "PROFILE" || u.role === "ADMIN");

  const industries = await db.industry.findMany();
  if (industries.length === 0) throw new Error("No industries found — run `npm run db:seed` first.");

  // ---- brands, families, items -------------------------------------------------------------
  console.log("Creating brands, families and items…");
  const familyIds: { brandId: string; familyId: string; familyName: string }[] = [];
  for (const [brandName, families] of Object.entries(BRAND_FAMILIES)) {
    const brand = await db.brand.upsert({
      where: { name: brandName },
      update: {},
      create: { name: brandName },
    });
    for (const familyName of families) {
      const family = await db.productFamily.upsert({
        where: { brandId_name: { brandId: brand.id, name: familyName } },
        update: {},
        create: { brandId: brand.id, name: familyName },
      });
      familyIds.push({ brandId: brand.id, familyId: family.id, familyName });
    }
  }

  let skuCounter = 1;
  const itemIds: { id: string; type: ItemType; price: number }[] = [];
  for (const { brandId, familyId, familyName } of familyIds) {
    for (const spec of ITEM_TEMPLATES[familyName] ?? []) {
      const item = await db.item.create({
        data: {
          name: spec.name,
          sku: `${TEST_SKU_PREFIX}${String(skuCounter++).padStart(4, "0")}`,
          type: spec.type,
          brandId,
          productFamilyId: familyId,
          category: spec.type === "GOOD" ? "Hardware" : spec.type === "SERVICE" ? "Professional Services" : "Software",
          unit: spec.unit,
          billingCycle: spec.cycle ? (spec.cycle as "ANNUAL") : null,
          costPrice: Math.round(spec.price * 0.82),
          sellingPrice: spec.price,
          taxRatePercent: 18,
          trackInventory: spec.type === "GOOD",
          reorderLevel: spec.type === "GOOD" ? 5 : null,
          stockQuantity: spec.type === "GOOD" ? int(0, 60) : 0,
          createdById: admin.id,
        },
      });
      itemIds.push({ id: item.id, type: spec.type, price: spec.price });
    }
  }
  for (const spec of SERVICE_ITEMS) {
    const item = await db.item.create({
      data: {
        name: spec.name,
        sku: `${TEST_SKU_PREFIX}${String(skuCounter++).padStart(4, "0")}`,
        type: spec.type,
        category: "Professional Services",
        unit: spec.unit,
        costPrice: Math.round(spec.price * 0.7),
        sellingPrice: spec.price,
        taxRatePercent: 18,
        createdById: admin.id,
      },
    });
    itemIds.push({ id: item.id, type: spec.type, price: spec.price });
  }
  console.log(`  ${itemIds.length} items`);

  // ---- companies ----------------------------------------------------------------------------
  // 120 direct clients, 25 resellers, 30 of those resellers' end customers, 15 vendors, 10 commission parties.
  const plan = [
    ...Array(120).fill("CLIENT"),
    ...Array(25).fill("RESELLER"),
    ...Array(30).fill("END_CUSTOMER"),
    ...Array(8).fill("VENDOR"),
    ...Array(3).fill("OEM"),
    ...Array(2).fill("DISTRIBUTOR"),
    ...Array(2).fill("PARTNER"),
    ...Array(10).fill("COMMISSION_PARTY"),
  ] as const;

  console.log(`Creating ${plan.length} companies…`);
  const usedNames = new Set<string>();
  function companyName() {
    for (let i = 0; i < 200; i++) {
      const name = `${pick(PREFIXES)} ${pick(MIDS)} ${pick(SUFFIXES)}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    const fallback = `${pick(PREFIXES)} ${pick(MIDS)} ${usedNames.size} ${pick(SUFFIXES)}`;
    usedNames.add(fallback);
    return fallback;
  }
  const person = () => `${pick(FIRST)} ${pick(LAST)}`;

  const clients: string[] = [];
  const resellers: string[] = [];
  const endCustomers: { id: string; resellerId: string }[] = [];
  const vendors: string[] = [];
  const commissionParties: string[] = [];

  for (const kind of plan) {
    const name = companyName();
    const [city, state] = pick(CITIES);
    const relationshipType =
      kind === "END_CUSTOMER" ? "CLIENT" : kind === "COMMISSION_PARTY" ? "COMMISSION_PARTY" : kind;
    const isCustomerSide = relationshipType === "CLIENT" || relationshipType === "RESELLER";

    // Clients spread across the pipeline; everyone else sits outside it.
    const stage: CompanyStage = isCustomerSide
      ? pick(["PROSPECT", "PROSPECT", "LEAD", "LEAD", "CUSTOMER", "CUSTOMER", "DISQUALIFIED"] as const)
      : "PROSPECT";

    const managedByResellerId =
      kind === "END_CUSTOMER" && resellers.length > 0 ? pick(resellers) : undefined;

    const contactCount = int(1, 4);
    const locationCount = chance(0.3) ? int(2, 3) : 1;

    const company = await db.company.create({
      data: {
        name,
        normalizedName: name.trim().toLowerCase().replace(/\s+/g, " "),
        relationshipType,
        stage,
        managedByResellerId,
        industryId: pick(industries).id,
        companyType: pick(COMPANY_TYPES),
        category: pick(["SMB", "Mid-market", "Enterprise", "Education", "Government"]),
        employeeCount: int(5, 4000),
        paymentTerms: pick(PAYMENT_TERMS),
        source: pick(SOURCES),
        website: `https://www.${name.split(" ")[0].toLowerCase()}.example`,
        tags: [SEED_TAG, ...(chance(0.3) ? [pick(["Hot lead", "Key account", "Renewal due", "Price sensitive"])] : [])],
        vendorStatus: isCustomerSide ? null : pick(["ONBOARDING", "ACTIVE", "ACTIVE", "INACTIVE"] as const),
        vendorCode: isCustomerSide ? null : `V-${int(1000, 9999)}`,
        panNumber: isCustomerSide ? null : `AA${pick(["A", "B", "C"])}CN${int(1000, 9999)}K`,
        bankName: isCustomerSide ? null : pick(["HDFC Bank", "ICICI Bank", "Axis Bank", "SBI"]),
        createdById: admin.id,
        ownerUserId: isCustomerSide ? pick(sales).id : admin.id,
        assignedToUserId: relationshipType === "CLIENT" && !managedByResellerId ? pick(callers).id : null,
        assignedByUserId: relationshipType === "CLIENT" && !managedByResellerId ? admin.id : null,
        assignedAt: relationshipType === "CLIENT" && !managedByResellerId ? daysFromNow(-int(1, 200)) : null,
        contacts: {
          create: Array.from({ length: contactCount }, (_, i) => {
            const contactName = person();
            return {
              name: contactName,
              designation: pick(DESIGNATIONS),
              email: `${contactName.split(" ")[0].toLowerCase()}@${name.split(" ")[0].toLowerCase()}.example`,
              phone: `9${int(100000000, 999999999)}`,
              isPrimary: i === 0,
              createdByUserId: admin.id,
            };
          }),
        },
        locations: {
          create: Array.from({ length: locationCount }, (_, i) => {
            const [lCity, lState] = i === 0 ? [city, state] : pick(CITIES);
            const treatment = pick(GST_TREATMENTS);
            return {
              label: i === 0 ? "Head Office" : pick(["Branch Office", "Warehouse", "Regional Office"]),
              address: `${int(1, 99)} ${pick(["MG Road", "Link Road", "Ring Road", "Industrial Estate"])}`,
              city: lCity,
              state: lState,
              country: "India",
              pincode: `${CITY_PIN_PREFIX[lCity] ?? "4000"}${int(10, 99)}`,
              gstNumber:
                treatment === "UNREGISTERED" || treatment === "CONSUMER"
                  ? null
                  : `${STATE_GST_CODE[lState] ?? "27"}AA${pick(["A", "B"])}CN${int(1000, 9999)}K1Z${int(1, 9)}`,
              gstTreatment: treatment,
              isPrimary: i === 0,
            };
          }),
        },
      },
      select: { id: true },
    });

    if (kind === "CLIENT") clients.push(company.id);
    else if (kind === "RESELLER") resellers.push(company.id);
    else if (kind === "END_CUSTOMER") endCustomers.push({ id: company.id, resellerId: managedByResellerId! });
    else if (kind === "COMMISSION_PARTY") commissionParties.push(company.id);
    else vendors.push(company.id);
  }
  console.log(`  ${clients.length} clients, ${resellers.length} resellers, ${endCustomers.length} end customers, ${vendors.length} vendors, ${commissionParties.length} commission parties`);

  // ---- reseller onboarding, tiers and special pricing ---------------------------------------
  console.log("Onboarding resellers…");
  const activeResellers: string[] = [];
  for (const [i, resellerId] of resellers.entries()) {
    // A quarter stay mid-onboarding so the "can't punch an order yet" path has real data.
    const status = i % 4 === 0 ? "ONBOARDING" : i % 9 === 0 ? "SUSPENDED" : i % 11 === 0 ? "INACTIVE" : "ACTIVE";
    const complete = status !== "ONBOARDING";
    const tier = pick(["SILVER", "GOLD", "PLATINUM"] as const);
    await db.resellerProfile.create({
      data: {
        companyId: resellerId,
        status,
        agreementSignedOn: complete ? daysFromNow(-int(30, 700)) : null,
        agreementReference: complete ? `WRF-PA-${int(2024, 2026)}-${int(100, 999)}` : null,
        agreementApprovedByUserId: complete ? admin.id : null,
        creditLimit: complete ? pick([200000, 500000, 1000000, 2500000]) : null,
        tier: complete ? tier : null,
        discountPercent: complete ? (tier === "PLATINUM" ? 18 : tier === "GOLD" ? 12 : 7) : null,
        activatedAt: status === "ACTIVE" ? daysFromNow(-int(10, 600)) : null,
      },
    });
    if (complete) {
      await db.company.update({
        where: { id: resellerId },
        data: { panNumber: `AA${pick(["A", "B"])}CR${int(1000, 9999)}K` },
      });
    }
    if (status === "ACTIVE") activeResellers.push(resellerId);

    for (const item of some(itemIds, int(0, 3))) {
      await db.resellerItemPrice.create({
        data: {
          resellerId,
          itemId: item.id,
          price: Math.round(item.price * (0.7 + rnd() * 0.15)),
          notes: chance(0.4) ? "Negotiated for volume" : null,
        },
      });
    }
  }

  // ---- commission party accounts and links --------------------------------------------------
  console.log("Setting up commission parties…");
  const commissionAccounts: { partyId: string; accountId: string }[] = [];
  for (const partyId of commissionParties) {
    const accountCount = int(1, 3);
    for (let i = 0; i < accountCount; i++) {
      const holder = person();
      const account = await db.commissionPartyAccount.create({
        data: {
          commissionPartyId: partyId,
          label: i === 0 ? "Primary" : pick(["Firm account", "Alternate", "Spouse account"]),
          accountHolderName: holder,
          panNumber: `AB${pick(["C", "D"])}PN${int(1000, 9999)}L`,
          bankAccountNumber: String(int(100000000, 999999999)),
          bankIfsc: `${pick(["HDFC", "ICIC", "UTIB", "SBIN"])}0${String(int(100000, 999999))}`,
          bankName: pick(["HDFC Bank", "ICICI Bank", "Axis Bank", "SBI"]),
          upiId: `${holder.split(" ")[0].toLowerCase()}@okhdfcbank`,
          isDefault: i === 0,
        },
      });
      commissionAccounts.push({ partyId, accountId: account.id });
    }
    for (const companyId of some(clients, int(1, 4))) {
      await db.commissionPartyLink.upsert({
        where: { commissionPartyId_companyId: { commissionPartyId: partyId, companyId } },
        update: {},
        create: { commissionPartyId: partyId, companyId },
      });
    }
  }

  // ---- leads --------------------------------------------------------------------------------
  console.log("Creating leads…");
  let leadCount = 0;
  for (const companyId of clients) {
    if (!chance(0.75)) continue;
    for (let i = 0; i < int(1, 3); i++) {
      const status = pick(LEAD_STATUSES);
      const owner = pick(sales);
      const lead = await db.lead.create({
        data: {
          companyId,
          title: pick([
            "Microsoft 365 rollout", "Laptop refresh — 25 units", "Firewall upgrade", "Adobe licences renewal",
            "Server consolidation", "Email migration", "Annual AMC renewal", "Zoho One evaluation",
          ]),
          description: "Captured by the calling team during qualification.",
          status,
          estimatedValue: int(50, 2500) * 1000,
          expectedCloseDate: daysFromNow(int(-60, 120)),
          ownerUserId: owner.id,
          sourcedByUserId: pick(callers).id,
          qualifiedByUserId: chance(0.6) ? pick(callers).id : null,
          createdByUserId: admin.id,
          lostReason: status === "LOST" || status === "DISQUALIFIED" ? pick(["Budget cut", "Went with incumbent", "No requirement", "Price"]) : null,
          activities: {
            create: Array.from({ length: int(1, 4) }, () => ({
              userId: pick(callers).id,
              type: pick(["CALL", "EMAIL", "NOTE", "MEETING"] as const),
              notes: pick(["Discussed requirement and timelines.", "Shared pricing over email.", "Follow-up scheduled.", "Demo completed."]),
              occurredAt: daysFromNow(-int(1, 120)),
            })),
          },
          requirements: {
            create: some(itemIds, int(0, 2)).map((it) => ({ itemId: it.id, quantity: int(1, 25) })),
          },
        },
        select: { id: true },
      });
      if (status === "PROPOSAL_SENT" || status === "NEGOTIATION" || status === "WON") {
        await db.proposal.create({
          data: {
            leadId: lead.id,
            sentByUserId: owner.id,
            status: status === "WON" ? "ACCEPTED" : "SENT",
            sentAt: daysFromNow(-int(5, 60)),
            validUntil: daysFromNow(int(5, 45)),
          },
        });
      }
      leadCount++;
    }
  }
  console.log(`  ${leadCount} leads`);

  // ---- orders, expenses, payments ------------------------------------------------------------
  console.log("Creating orders, payments and subscriptions…");
  const buyers: { companyId: string; endCustomerId?: string }[] = [
    ...clients.map((companyId) => ({ companyId })),
    ...activeResellers.flatMap((resellerId) => {
      const theirs = endCustomers.filter((e) => e.resellerId === resellerId);
      return theirs.length ? theirs.map((e) => ({ companyId: resellerId, endCustomerId: e.id })) : [{ companyId: resellerId }];
    }),
  ];

  let orderCount = 0;
  let paymentCount = 0;
  for (const buyer of buyers) {
    if (!chance(0.55)) continue;
    const locations = await db.companyLocation.findMany({ where: { companyId: buyer.companyId }, select: { id: true } });
    if (!locations.length) continue;

    for (let i = 0; i < int(1, 3); i++) {
      const item = pick(itemIds);
      const status = pick(ORDER_STATUSES);
      const quantity = int(1, 30);
      const unitPrice = Math.round(item.price * (0.85 + rnd() * 0.2));
      const isSubscription = item.type === "SUBSCRIPTION";
      const fulfilled = status === "FULFILLED";
      const purchased = fulfilled || status === "PROCESSING";
      // Spread expiry dates across expired / 30 / 60 / 90 / later so the renewals buckets fill.
      const endOffset = pick([-120, -40, -5, 12, 25, 45, 75, 110, 200, 300]);

      const order = await db.companyProduct.create({
        data: {
          companyId: buyer.companyId,
          endCustomerId: buyer.endCustomerId ?? null,
          locationId: pick(locations).id,
          itemId: item.id,
          quantity,
          unitPrice,
          businessType: pick(BUSINESS_TYPES),
          orderStatus: status,
          poNumber: `PO-${int(2025, 2026)}-${int(1000, 9999)}`,
          paymentTerms: chance(0.3) ? pick(PAYMENT_TERMS) : null,
          startDate: isSubscription ? daysFromNow(endOffset - 365) : null,
          endDate: isSubscription ? daysFromNow(endOffset) : null,
          vendorId: purchased && vendors.length ? pick(vendors) : null,
          purchasePrice: purchased ? Math.round(unitPrice * (0.72 + rnd() * 0.12)) : null,
          ourPoNumber: purchased ? `WRF-PO-${int(1000, 9999)}` : null,
          purchasedByUserId: purchased ? admin.id : null,
          fulfilledAt: fulfilled ? daysFromNow(-int(1, 200)) : null,
          accountsApprovedByUserId: status !== "PENDING_APPROVAL" ? admin.id : null,
          accountsApprovedAt: status !== "PENDING_APPROVAL" ? daysFromNow(-int(2, 210)) : null,
          accountsNotes: status === "REJECTED" ? "Payment terms not acceptable." : null,
          addedByUserId: pick(sales).id,
          createdAt: daysFromNow(-int(1, 300)),
          watchers: chance(0.25) ? { connect: some(users, int(1, 2)).map((u) => ({ id: u.id })) } : undefined,
        },
        select: { id: true },
      });
      orderCount++;

      // Commission expenses point at a real commission party and one of its accounts.
      if (chance(0.3) && commissionAccounts.length) {
        const payee = pick(commissionAccounts);
        await db.orderExpense.create({
          data: {
            companyProductId: order.id,
            type: "COMMISSION",
            amount: Math.round(unitPrice * quantity * 0.03),
            payeeCompanyId: payee.partyId,
            payeeAccountId: payee.accountId,
            notes: "Referral commission",
          },
        });
      }
      if (chance(0.2)) {
        await db.orderExpense.create({
          data: {
            companyProductId: order.id,
            type: pick(["FREIGHT", "INSTALLATION", "OTHER"] as const),
            amount: int(1, 40) * 500,
          },
        });
      }

      // Payments only against orders that actually went through: unpaid / partial / paid / overpaid.
      if (fulfilled || status === "PROCESSING") {
        const total = Math.round(unitPrice * quantity * 1.18);
        const mode = pick(["unpaid", "partial", "paid", "paid", "overpaid"] as const);
        if (mode !== "unpaid") {
          const amount =
            mode === "partial" ? Math.round(total * (0.2 + rnd() * 0.5)) : mode === "overpaid" ? total + int(1, 50) * 100 : total;
          const payment = await db.payment.create({
            data: {
              companyId: buyer.companyId,
              amount,
              paidOn: daysFromNow(-int(1, 120)),
              method: pick(["BANK_TRANSFER", "UPI", "CHEQUE", "CARD"] as const),
              reference: `TXN${int(100000, 999999)}`,
              recordedByUserId: admin.id,
            },
            select: { id: true },
          });
          await db.paymentAllocation.create({
            data: { paymentId: payment.id, companyProductId: order.id, amount: Math.min(amount, total), allocatedByUserId: admin.id },
          });
          paymentCount++;
        }
      }
    }
  }
  console.log(`  ${orderCount} orders, ${paymentCount} payments`);

  // ---- tickets and tasks ----------------------------------------------------------------------
  console.log("Creating tickets and tasks…");
  const ticketCompanies = some([...clients, ...endCustomers.map((e) => e.id)], 110);
  let ticketCount = 0;
  for (const companyId of ticketCompanies) {
    const contacts = await db.contact.findMany({ where: { companyId }, select: { id: true } });
    const orders = await db.companyProduct.findMany({ where: { OR: [{ companyId }, { endCustomerId: companyId }] }, select: { id: true } });
    for (let i = 0; i < int(1, 2); i++) {
      const status = pick(TICKET_STATUSES);
      const resolved = status === "RESOLVED" || status === "CLOSED";
      const createdAt = daysFromNow(-int(1, 90));
      await db.ticket.create({
        data: {
          companyId,
          contactId: contacts.length ? pick(contacts).id : null,
          companyProductId: orders.length && chance(0.6) ? pick(orders).id : null,
          title: pick(["Cannot sign in to Microsoft 365", "Laptop not booting", "Licence reassignment needed", "Firewall throughput drop", "Training request for new joiners", "Invoice copy required"]),
          description: "Reported by the customer over email.",
          ticketType: pick(TICKET_TYPES),
          status,
          priority: pick(TICKET_PRIORITIES),
          assignedToUserId: chance(0.8) ? pick(support).id : null,
          createdByUserId: admin.id,
          createdAt,
          // Some resolve well past their SLA so the performance metrics have spread.
          resolvedAt: resolved ? new Date(createdAt.getTime() + int(2, 200) * 3600000) : null,
          closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + int(5, 260) * 3600000) : null,
          comments: {
            create: Array.from({ length: int(0, 3) }, () => ({
              userId: pick(support).id,
              body: pick(["Looking into this now.", "Asked the customer for a screenshot.", "Escalated to the vendor.", "Fixed — please confirm."]),
            })),
          },
        },
      });
      ticketCount++;
    }
  }

  let taskCount = 0;
  for (const companyId of some(clients, 70)) {
    const done = chance(0.35);
    await db.task.create({
      data: {
        title: pick(["Send renewal quote", "Follow up on proposal", "Collect PO copy", "Schedule deployment call", "Chase overdue payment"]),
        description: chance(0.5) ? "Created during the weekly pipeline review." : null,
        dueDate: daysFromNow(int(-20, 30)),
        done,
        doneAt: done ? daysFromNow(-int(1, 20)) : null,
        assignedToUserId: pick(sales).id,
        createdByUserId: admin.id,
        companyId,
      },
    });
    taskCount++;
  }
  console.log(`  ${ticketCount} tickets, ${taskCount} tasks`);

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

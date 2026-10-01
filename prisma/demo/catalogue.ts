import { PrismaClient, type ItemType } from "@prisma/client";
import { DEMO_SKU, int, log, rnd } from "./shared";

/**
 * What this business actually sells.
 *
 * Real SKUs from the three vendors a system integrator of this shape resells, plus the hardware
 * that goes with them. The margins are roughly right for the Indian channel — thin on Microsoft
 * licensing, wider on hardware and services — because a demo where every line makes 40% teaches
 * somebody the wrong thing about their own business.
 */

type Seed = {
  name: string;
  type: ItemType;
  /** Selling price in rupees, and the cost as a fraction of it. */
  price: number;
  costRatio: number;
  hsn: string;
  gst: number;
  brand: string;
};

const CATALOGUE: Seed[] = [
  // ── Microsoft 365 ────────────────────────────────────────────────────────────────────────────
  { name: "Microsoft 365 Business Basic (Annual)", type: "SUBSCRIPTION", price: 1770, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Microsoft 365 Business Standard (Annual)", type: "SUBSCRIPTION", price: 4200, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Microsoft 365 Business Premium (Annual)", type: "SUBSCRIPTION", price: 7400, costRatio: 0.94, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Microsoft 365 E3 (Annual)", type: "SUBSCRIPTION", price: 10600, costRatio: 0.94, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Microsoft 365 E5 (Annual)", type: "SUBSCRIPTION", price: 18900, costRatio: 0.95, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Exchange Online Plan 1 (Annual)", type: "SUBSCRIPTION", price: 1680, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Microsoft Teams Phone Standard (Annual)", type: "SUBSCRIPTION", price: 6300, costRatio: 0.94, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Windows 11 Pro OEM", type: "GOOD", price: 11500, costRatio: 0.88, hsn: "85238020", gst: 18, brand: "Microsoft" },
  { name: "Microsoft Defender for Office 365 P1 (Annual)", type: "SUBSCRIPTION", price: 1660, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Microsoft" },
  { name: "Azure Consumption Commitment", type: "SUBSCRIPTION", price: 100000, costRatio: 0.97, hsn: "997331", gst: 18, brand: "Microsoft" },

  // ── Adobe ────────────────────────────────────────────────────────────────────────────────────
  { name: "Adobe Creative Cloud All Apps (Annual)", type: "SUBSCRIPTION", price: 52000, costRatio: 0.91, hsn: "997331", gst: 18, brand: "Adobe" },
  { name: "Adobe Acrobat Pro DC (Annual)", type: "SUBSCRIPTION", price: 14800, costRatio: 0.9, hsn: "997331", gst: 18, brand: "Adobe" },
  { name: "Adobe Photoshop Single App (Annual)", type: "SUBSCRIPTION", price: 21000, costRatio: 0.9, hsn: "997331", gst: 18, brand: "Adobe" },
  { name: "Adobe Substance 3D Collection (Annual)", type: "SUBSCRIPTION", price: 48000, costRatio: 0.92, hsn: "997331", gst: 18, brand: "Adobe" },

  // ── Autodesk ─────────────────────────────────────────────────────────────────────────────────
  { name: "AutoCAD (Annual)", type: "SUBSCRIPTION", price: 148000, costRatio: 0.92, hsn: "997331", gst: 18, brand: "Autodesk" },
  { name: "AutoCAD LT (Annual)", type: "SUBSCRIPTION", price: 42000, costRatio: 0.91, hsn: "997331", gst: 18, brand: "Autodesk" },
  { name: "Autodesk Revit (Annual)", type: "SUBSCRIPTION", price: 195000, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Autodesk" },
  { name: "Autodesk Inventor Professional (Annual)", type: "SUBSCRIPTION", price: 185000, costRatio: 0.93, hsn: "997331", gst: 18, brand: "Autodesk" },
  { name: "Autodesk Fusion (Annual)", type: "SUBSCRIPTION", price: 38000, costRatio: 0.9, hsn: "997331", gst: 18, brand: "Autodesk" },

  // ── Security & backup ────────────────────────────────────────────────────────────────────────
  { name: "Acronis Cyber Protect Cloud (per workload/yr)", type: "SUBSCRIPTION", price: 3600, costRatio: 0.82, hsn: "997331", gst: 18, brand: "Acronis" },
  { name: "Sophos Intercept X Advanced (per endpoint/yr)", type: "SUBSCRIPTION", price: 2900, costRatio: 0.78, hsn: "997331", gst: 18, brand: "Sophos" },
  { name: "Sophos XGS 2100 Firewall + 1yr", type: "GOOD", price: 285000, costRatio: 0.8, hsn: "85176290", gst: 18, brand: "Sophos" },
  { name: "Seqrite Endpoint Security (per seat/yr)", type: "SUBSCRIPTION", price: 1450, costRatio: 0.72, hsn: "997331", gst: 18, brand: "Seqrite" },

  // ── Hardware ─────────────────────────────────────────────────────────────────────────────────
  { name: "Dell Latitude 3550 i5/16GB/512GB", type: "GOOD", price: 78000, costRatio: 0.89, hsn: "84713010", gst: 18, brand: "Dell" },
  { name: "Dell OptiPlex 7020 SFF i5/16GB/512GB", type: "GOOD", price: 64000, costRatio: 0.88, hsn: "84714110", gst: 18, brand: "Dell" },
  { name: "HP ProBook 450 G10 i7/16GB/1TB", type: "GOOD", price: 96000, costRatio: 0.9, hsn: "84713010", gst: 18, brand: "HP" },
  { name: "Lenovo ThinkPad E14 Gen 5", type: "GOOD", price: 87000, costRatio: 0.89, hsn: "84713010", gst: 18, brand: "Lenovo" },
  { name: "Dell PowerEdge R450 Server", type: "GOOD", price: 465000, costRatio: 0.87, hsn: "84714190", gst: 18, brand: "Dell" },
  { name: "Synology DS923+ NAS (diskless)", type: "GOOD", price: 78000, costRatio: 0.85, hsn: "84717020", gst: 18, brand: "Synology" },
  { name: "Seagate IronWolf 8TB NAS HDD", type: "GOOD", price: 21500, costRatio: 0.9, hsn: "84717020", gst: 18, brand: "Seagate" },
  { name: "APC Smart-UPS 3KVA", type: "GOOD", price: 92000, costRatio: 0.86, hsn: "85044010", gst: 18, brand: "APC" },
  { name: "Ubiquiti UniFi U6-Pro Access Point", type: "GOOD", price: 18500, costRatio: 0.84, hsn: "85176290", gst: 18, brand: "Ubiquiti" },
  { name: "Cisco Catalyst 1000 24-port Switch", type: "GOOD", price: 78000, costRatio: 0.87, hsn: "85176290", gst: 18, brand: "Cisco" },
  { name: "Logitech Rally Bar Huddle", type: "GOOD", price: 185000, costRatio: 0.88, hsn: "85258900", gst: 18, brand: "Logitech" },

  // ── Services ─────────────────────────────────────────────────────────────────────────────────
  { name: "Microsoft 365 Tenant Migration (per mailbox)", type: "SERVICE", price: 850, costRatio: 0.35, hsn: "998313", gst: 18, brand: "Acme" },
  { name: "On-site Engineer Visit (per visit)", type: "SERVICE", price: 2500, costRatio: 0.45, hsn: "998313", gst: 18, brand: "Acme" },
  { name: "Annual Maintenance Contract — Comprehensive", type: "SERVICE", price: 48000, costRatio: 0.4, hsn: "998713", gst: 18, brand: "Acme" },
  { name: "Annual Maintenance Contract — Non-comprehensive", type: "SERVICE", price: 26000, costRatio: 0.38, hsn: "998713", gst: 18, brand: "Acme" },
  { name: "Firewall Installation & Configuration", type: "SERVICE", price: 35000, costRatio: 0.4, hsn: "998313", gst: 18, brand: "Acme" },
  { name: "Website Development — Corporate", type: "SERVICE", price: 185000, costRatio: 0.45, hsn: "998314", gst: 18, brand: "Acme" },
  { name: "Managed IT Support (per seat/month)", type: "SERVICE", price: 650, costRatio: 0.4, hsn: "998313", gst: 18, brand: "Acme" },
  { name: "Security Audit & VAPT", type: "SERVICE", price: 165000, costRatio: 0.42, hsn: "998313", gst: 18, brand: "Acme" },
];

export type SeededItem = {
  id: string;
  name: string;
  type: ItemType;
  price: number;
  cost: number;
  brand: string;
};

export async function seedCatalogue(db: PrismaClient, createdById: string): Promise<SeededItem[]> {
  const brands = new Map<string, string>();
  for (const name of [...new Set(CATALOGUE.map((c) => c.brand))]) {
    const row = await db.brand.upsert({ where: { name }, create: { name }, update: {}, select: { id: true } });
    brands.set(name, row.id);
  }

  const items: SeededItem[] = [];
  for (const [i, seed] of CATALOGUE.entries()) {
    const cost = Math.round(seed.price * seed.costRatio);
    const item = await db.item.create({
      data: {
        name: seed.name,
        sku: `${DEMO_SKU}${String(i + 1).padStart(3, "0")}`,
        type: seed.type,
        sellingPrice: seed.price,
        costPrice: cost,
        hsnCode: seed.hsn,
        taxRatePercent: seed.gst,
        unit: seed.type === "GOOD" ? "Nos" : "Licence",
        brandId: brands.get(seed.brand)!,
        // Only goods carry stock. A subscription with a reorder level is a nonsense somebody would
        // have to explain away in a demo.
        trackInventory: seed.type === "GOOD",
        stockQuantity: seed.type === "GOOD" ? int(0, 40) : 0,
        reorderLevel: seed.type === "GOOD" ? int(2, 8) : 0,
        billingCycle: seed.type === "SUBSCRIPTION" ? "ANNUAL" : "ONE_TIME",
        createdById,
      },
      select: { id: true },
    });
    items.push({ id: item.id, name: seed.name, type: seed.type, price: seed.price, cost, brand: seed.brand });
  }

  log("Catalogue", `${items.length} items across ${brands.size} brands`);
  void rnd;
  return items;
}

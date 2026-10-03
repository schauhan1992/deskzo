import type { PrismaClient } from "@prisma/client";
import type { Role } from "@/lib/roles";
import { DEMO_EMAIL_DOMAIN, DEMO_SKU, DEMO_TAG } from "./shared";
import type { SeededPerson } from "./people";
import type { SeededCompany } from "./companies";
import type { SeededItem } from "./catalogue";

/**
 * The demo company as the database holds it, read back rather than passed along: the people, the
 * accounts, the catalogue and the admin everything is created by. The coverage seeds (./cover) take
 * this, so each can run on its own against a database the main demo seed has already filled
 * (`npx tsx prisma/demo/run-cover.ts <area>`) as well as at the end of `npm run db:seed:demo`.
 */

export type DemoContext = {
  admin: { id: string; name: string };
  people: SeededPerson[];
  departments: Map<string, string>;
  companies: SeededCompany[];
  items: SeededItem[];
};

export async function loadDemoContext(db: PrismaClient): Promise<DemoContext> {
  const admin = await db.user.findFirst({ where: { role: "ADMIN", email: { not: { endsWith: DEMO_EMAIL_DOMAIN } } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (!admin) throw new Error("No admin account found — run `npm run db:bootstrap` first.");
  const users = await db.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, role: true, department: { select: { name: true } }, employeeProfile: { select: { designation: true } }, _count: { select: { directReports: true } } },
  });
  if (!users.length) throw new Error("No demo people — run `npm run db:seed:demo` first.");
  const departments = new Map((await db.department.findMany({ select: { id: true, name: true } })).map((d) => [d.name, d.id]));
  const companies = await db.company.findMany({
    where: { tags: { has: DEMO_TAG } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      stage: true,
      ownerUserId: true,
      employeeCount: true,
      locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1, select: { id: true, gstNumber: true } },
      contacts: { select: { id: true } },
    },
  });
  const items = await db.item.findMany({
    where: { sku: { startsWith: DEMO_SKU } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, type: true, sellingPrice: true, costPrice: true, brand: { select: { name: true } } },
  });
  return {
    admin,
    people: users.map((u) => ({ id: u.id, name: u.name, role: u.role as Role, dept: u.department?.name ?? "", title: u.employeeProfile?.designation ?? "", isManager: u._count.directReports > 0 })),
    departments,
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      relationship: c.relationshipType,
      stage: c.stage,
      locationId: c.locations[0]?.id ?? "",
      stateCode: c.locations[0]?.gstNumber?.slice(0, 2) ?? "27",
      ownerId: c.ownerUserId,
      contactIds: c.contacts.map((x) => x.id),
      employeeCount: c.employeeCount ?? 0,
    })),
    items: items.map((i) => ({ id: i.id, name: i.name, type: i.type, price: Number(i.sellingPrice), cost: Number(i.costPrice ?? 0), brand: i.brand?.name ?? "" })),
  };
}

/**
 * Customer categories — the chip beside every customer's name, and how to treat them.
 *
 *   · Without a database: a sub-category borrowing its category's icon and colour, the handling
 *     notes read category first, the tree and its order, the filter choices, and everything the
 *     editor refuses.
 *   · Through the real code: shaping the list (and who may), moving one up, deleting a
 *     sub-category (its customers move up) and a category (theirs are left uncategorised); putting a
 *     customer in one (whoever can see them — and nobody who can't); a company form sending a
 *     category that is gone; the lists filtered by a category taking in its sub-categories; the
 *     chip reaching the lead and ticket queries and every customer picker; and the customer's
 *     own page showing the chip and the note.
 *
 * Everything is named ZZCAT and removed in a finally. The starter set that ships with the migration
 * is never touched — the checks build their own categories.
 *
 *   npm run check:customer-categories
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  categoryAndChildren,
  categoryFilterOptions,
  categoryTree,
  checkCategory,
  resolveCategory,
  type FlatCategory,
} from "../src/lib/customers/categories";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzcat", email: `x${MAIL}` });
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
      usePathname: () => "/companies",
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZCAT";
const MAIL = "@zzprobe-categories.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** Renders nested async server components before handing the tree to the static renderer. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }, { ownerUserId: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  // Sub-categories go with their category.
  await db.customerCategory.deleteMany({ where: { name: { startsWith: TAG }, parentId: null } });
  await db.customerCategory.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: companyIds } }] } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("A chip, resolved");

  const top = { id: "t", name: "Strategic", icon: "star", color: "#f59e0b", guidance: "Senior people stay close." };
  const key = resolveCategory({ id: "k", name: "Key account", icon: null, color: null, guidance: "Reply within four hours.", parent: top });
  ok("a sub-category reads as its category › itself", key?.label === "Strategic › Key account" && key.parentName === "Strategic", key?.label);
  ok("  and wears its category's icon and colour when it has none of its own", key?.icon === "star" && key.color === "#f59e0b");
  ok("  the category's note first, then its own", key?.guidance.join(" | ") === "Senior people stay close. | Reply within four hours.");
  const own = resolveCategory({ id: "g", name: "Growth", icon: "rocket", color: "#10b981", guidance: "  ", parent: top });
  ok("  its own icon and colour win, and an empty note is no note", own?.icon === "rocket" && own.color === "#10b981" && own.guidance.join() === "Senior people stay close.");
  ok("a category alone is just its name", resolveCategory({ ...top, parent: null })?.label === "Strategic");
  ok("  no category, no chip", resolveCategory(null) === null && resolveCategory(undefined) === null);
  ok("an icon or colour missing everywhere falls back rather than breaking", resolveCategory({ id: "x", name: "X", icon: null, color: null, guidance: null, parent: null })?.icon === "tag");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The tree");

  const flat: FlatCategory[] = [
    { id: "b", name: "Beta", parentId: null, icon: "star", color: "#f59e0b", guidance: null, sortOrder: 1 },
    { id: "a", name: "Alpha", parentId: null, icon: "star", color: "#f59e0b", guidance: null, sortOrder: 0 },
    { id: "a2", name: "Zed", parentId: "a", icon: null, color: null, guidance: null, sortOrder: 0 },
    { id: "a1", name: "Ace", parentId: "a", icon: null, color: null, guidance: null, sortOrder: 0 },
    { id: "b1", name: "Bee", parentId: "b", icon: null, color: null, guidance: null, sortOrder: 0 },
  ];
  const tree = categoryTree(flat);
  ok("categories in their order, sub-categories under them", tree.map((t) => t.id).join() === "a,b" && tree[0]!.children.map((c) => c.id).join() === "a1,a2", tree.map((t) => `${t.id}:${t.children.map((c) => c.id)}`).join(" "));
  ok("  a tie in order goes to the alphabet", tree[0]!.children[0]!.name === "Ace");
  ok("a category takes in its sub-categories for a filter", categoryAndChildren("a", flat).sort().join() === "a,a1,a2" && categoryAndChildren("a1", flat).join() === "a1");
  const options = categoryFilterOptions(tree);
  ok("the filter offers each category, each sub-category by its full name, and none", options.map((o) => o.label).join(" | ") === "Alpha | Alpha › Ace | Alpha › Zed | Beta | Beta › Bee | No category" && options.at(-1)?.value === "none");

  // ─────────────────────────────────────────────────────────────────────────────
  section("What the editor refuses");

  const rows = flat.map(({ id, parentId, name }) => ({ id, parentId, name }));
  const good: { parentId: string | null; name: string; icon: string | null; color: string | null; guidance: string | null } = {
    parentId: null,
    name: "Gamma",
    icon: "star",
    color: "#6366F1",
    guidance: null,
  };
  const check = (over: Partial<typeof good> & { id?: string }) => checkCategory({ ...good, ...over }, { rows });
  ok("a good category passes, its colour normalised", (() => { const r = check({}); return r.ok && r.value.color === "#6366f1"; })());
  ok("  its name tidied", (() => { const r = check({ name: "  Very   big  " }); return r.ok && r.value.name === "Very big"; })());
  ok("no name", !check({ name: "   " }).ok);
  ok("a name too long for a chip", !check({ name: "x".repeat(41) }).ok);
  ok("a name with the separator in it", !check({ name: "A › B" }).ok);
  ok("the same name twice at one level — whatever the case", !check({ name: "alpha" }).ok);
  ok("  but the same name under another category is fine", check({ name: "Ace", parentId: "b", icon: null, color: null }).ok);
  ok("  and a category renamed to its own name is not a clash with itself", check({ id: "a", name: "Alpha" }).ok);
  ok("a parent that isn't there", !check({ parentId: "gone" }).ok);
  ok("a third level — nothing goes under a sub-category", !check({ parentId: "a1", icon: null, color: null }).ok);
  ok("a category under itself", !check({ id: "a", parentId: "a" }).ok);
  ok("a category with sub-categories of its own made into one", !check({ id: "a", name: "Alpha", parentId: "b" }).ok);
  ok("an icon from outside the set", !check({ icon: "skull" }).ok);
  ok("a category with no icon or no colour — its sub-categories borrow them", !check({ icon: null }).ok && !check({ color: null }).ok);
  ok("  a sub-category with neither is fine", check({ name: "New", parentId: "a", icon: null, color: null }).ok);
  ok("a colour that isn't one", !check({ color: "red" }).ok && !check({ color: "#12345" }).ok);
  ok("a handling note too long to read at a glance", !check({ guidance: "x".repeat(401) }).ok && check({ guidance: "x".repeat(400) }).ok);

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const cats = require("../src/actions/customer-category") as typeof import("../src/actions/customer-category");
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const ticketActions = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { CompanyCombobox } = require("../src/components/ui/company-combobox") as typeof import("../src/components/ui/company-combobox");
  const SettingsCategoriesPage = (require("../src/app/(dashboard)/settings/customer-categories/page") as { default: () => Promise<ReactElement> }).default;

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>, role: "SALES" | "MANAGEMENT" = "SALES") =>
      db.user.create({
        data: {
          name: `Zzcat ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role,
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const boss = await make("Boss", { "companies.manageCategories": true, "companies.viewAll": true, "tickets.view": true });
    const rep = await make("Rep", { "companies.manageCategories": false, "companies.viewAll": false, "leads.view": true });
    const other = await make("Other", { "companies.manageCategories": false, "companies.viewAll": false });
    const as = (u: { id: string }) => {
      actorId = u.id;
    };

    // ───────────────────────────────────────────────────────────────────────────
    section("Shaping the list");

    const save = (input: Partial<Parameters<typeof cats.saveCustomerCategory>[0]>) =>
      cats.saveCustomerCategory({ parentId: null, name: `${TAG} Strategic`, icon: "star", color: "#f59e0b", guidance: `${TAG} Senior people stay close.`, ...input });
    as(rep);
    ok("somebody without the permission can't add one", !(await save({})).ok);
    as(boss);
    const strategic = await save({});
    ok("the person with it can", strategic.ok, strategic.ok ? "" : strategic.error);
    if (!strategic.ok) throw new Error("cannot continue without a category");
    const keyAcc = await save({ parentId: strategic.data.id, name: `${TAG} Key`, icon: null, color: null, guidance: `${TAG} Reply within four hours.` });
    const growth = await save({ parentId: strategic.data.id, name: `${TAG} Growth`, icon: "rocket", color: null, guidance: null });
    const watch = await save({ name: `${TAG} Watch`, icon: "alert", color: "#dc2626", guidance: null });
    ok("  sub-categories under it, and another category", keyAcc.ok && growth.ok && watch.ok);
    if (!keyAcc.ok || !growth.ok || !watch.ok) throw new Error("cannot continue");
    ok("  a duplicate at the same level is refused", !(await save({ name: `${TAG} strategic` })).ok);
    ok("  and a third level", !(await save({ parentId: keyAcc.data.id, name: `${TAG} Deeper`, icon: null, color: null })).ok);
    const kids = await db.customerCategory.findMany({ where: { parentId: strategic.data.id }, orderBy: { sortOrder: "asc" }, select: { name: true, sortOrder: true } });
    ok("new ones go to the end of their list", kids.map((k) => k.name).join() === `${TAG} Key,${TAG} Growth` && kids[1]!.sortOrder > kids[0]!.sortOrder);
    await cats.moveCustomerCategory(growth.data.id, "up");
    const moved = await db.customerCategory.findMany({ where: { parentId: strategic.data.id }, orderBy: { sortOrder: "asc" }, select: { name: true } });
    ok("  and move up", moved.map((k) => k.name).join() === `${TAG} Growth,${TAG} Key`);
    as(rep);
    ok("  somebody without the permission can't reorder them", !(await cats.moveCustomerCategory(keyAcc.data.id, "up")).ok);
    as(boss);
    const renamed = await save({ id: keyAcc.data.id, parentId: strategic.data.id, name: `${TAG} Key account`, icon: null, color: null, guidance: `${TAG} Reply within four hours.` });
    ok("renaming keeps it where it is", renamed.ok && (await db.customerCategory.findUnique({ where: { id: keyAcc.data.id } }))?.name === `${TAG} Key account`);
    const listed = (await cats.listCustomerCategories()).find((t) => t.id === strategic.data.id);
    ok("everybody's list has it as a tree", listed?.children.map((c) => c.name).join() === `${TAG} Growth,${TAG} Key account`);
    const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);
    const settingsHtml = await html(SettingsCategoriesPage());
    ok("the settings page shows them, with their notes", settingsHtml.includes(`${TAG} Strategic`) && settingsHtml.includes(`${TAG} Reply within four hours.`) && settingsHtml.includes("Add a category"));
    as(rep);
    // The 404 page for somebody without the permission (owner, 8 Oct 2026).
    const settingsRefused = await html(SettingsCategoriesPage()).then(
      () => "rendered",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    ok("  and is the 404 page for somebody without the permission", settingsRefused === "notFound", settingsRefused);

    // ───────────────────────────────────────────────────────────────────────────
    section("Putting a customer in one");

    const company = (name: string, owner: { id: string }) =>
      db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ownerUserId: owner.id, relationshipType: "CLIENT", stage: "PROSPECT" } as never });
    const acme = await company("Acme", rep);
    const beta = await company("Beta", rep);
    const gamma = await company("Gamma", rep);
    const theirs = await company("Theirs", other);

    as(rep);
    ok("the account manager puts their customer in a sub-category", (await cats.setCompanyCategory(acme.id, keyAcc.data.id)).ok && (await db.company.findUnique({ where: { id: acme.id } }))?.customerCategoryId === keyAcc.data.id);
    ok("  or a category", (await cats.setCompanyCategory(beta.id, strategic.data.id)).ok);
    ok("  and it is written in the audit log", (await db.auditLog.count({ where: { entityId: acme.id, entityLabel: { contains: `${TAG} Strategic › ${TAG} Key account` } } })) === 1);
    const refused = await cats.setCompanyCategory(theirs.id, keyAcc.data.id);
    ok("but not somebody else's customer they can't see — and it reads as not there", !refused.ok && refused.error === "Company not found." && (await db.company.findUnique({ where: { id: theirs.id } }))?.customerCategoryId === null);
    ok("  nor into a category that's gone", !(await cats.setCompanyCategory(gamma.id, "no-such-category")).ok);
    await cats.setCompanyCategory(gamma.id, watch.data.id);
    ok("taking them out of every one", (await cats.setCompanyCategory(gamma.id, null)).ok && (await db.company.findUnique({ where: { id: gamma.id } }))?.customerCategoryId === null);
    await cats.setCompanyCategory(gamma.id, growth.data.id);

    // A company form sending a category that was deleted since the form was opened.
    as(boss);
    const bogus = await companyActions.createCompany({ name: `${TAG} Formco`, customerCategoryId: "deleted-meanwhile" });
    ok("a company form with a category that's gone is refused, not a crash", !bogus.ok && bogus.error.includes("category"), bogus.ok ? "" : bogus.error);
    const fromForm = await companyActions.createCompany({ name: `${TAG} Formco`, customerCategoryId: watch.data.id });
    ok("  one that's there is saved with the company", fromForm.ok && (await db.company.findUnique({ where: { id: fromForm.data.id } }))?.customerCategoryId === watch.data.id, fromForm.ok ? "" : fromForm.error);

    // ───────────────────────────────────────────────────────────────────────────
    section("Lists and pickers");

    as(rep);
    const page = (categoryId?: string) => companyActions.listCompaniesPaged({ page: 1, pageSize: 50, search: TAG, categoryId }).then((r) => r.rows.map((c) => c.name.slice(TAG.length + 1)).sort().join());
    ok("a category's filter takes in its sub-categories", (await page(strategic.data.id)) === "Acme,Beta,Gamma", await page(strategic.data.id));
    ok("  a sub-category's is just its own", (await page(keyAcc.data.id)) === "Acme");
    ok("  and 'no category' finds the rest", !(await page("none")).includes("Acme") && !(await page("none")).includes("Beta"));
    const row = (await companyActions.listCompaniesPaged({ page: 1, pageSize: 50, search: `${TAG} Acme` })).rows[0];
    ok("each row carries its category and the category above it, for the icon", row?.customerCategory?.name === `${TAG} Key account` && row.customerCategory.parent?.name === `${TAG} Strategic`);
    const options = await companyActions.listCompanyOptions();
    const acmeOption = options.find((o) => o.id === acme.id);
    ok("every customer picker is given it too", acmeOption?.customerCategory?.parent?.icon === "star");
    const picker = renderToStaticMarkup(createElement(CompanyCombobox, { companies: options, value: acme.id, onSelect: () => {} }));
    ok("  and shows it under the field once a customer is chosen", picker.includes(`${TAG} Strategic › ${TAG} Key account`) && picker.includes(`data-category="${keyAcc.data.id}"`));

    // The lead and ticket queries carry it for their pages.
    const lead = await db.lead.create({ data: { companyId: acme.id, title: `${TAG} deal`, status: "NEGOTIATION", ownerUserId: rep.id } });
    const gotLead = await leadActions.getLead(lead.id);
    ok("a lead's customer comes with their category", gotLead?.company.customerCategory?.id === keyAcc.data.id);
    const ticket = await db.ticket.create({ data: { companyId: acme.id, title: `${TAG} ticket`, createdByUserId: rep.id } });
    as(boss);
    const gotTicket = await ticketActions.getTicket(ticket.id);
    ok("  and a ticket's", gotTicket?.company.customerCategory?.id === keyAcc.data.id);
    await db.ticket.delete({ where: { id: ticket.id } });
    await db.lead.delete({ where: { id: lead.id } });

    // ───────────────────────────────────────────────────────────────────────────
    section("The customer's own page");

    as(rep);
    const acmeHtml = renderToStaticMarkup((await CompanyDetail({ id: acme.id })) as ReactElement);
    ok("the chip is beside their name", acmeHtml.includes(`${TAG} Strategic › ${TAG} Key account`) && acmeHtml.includes(`data-category="${keyAcc.data.id}"`));
    ok("  with how to treat them — the category's note, then the sub-category's", acmeHtml.includes("How to treat them") && acmeHtml.indexOf(`${TAG} Senior people stay close.`) < acmeHtml.indexOf(`${TAG} Reply within four hours.`) && acmeHtml.indexOf(`${TAG} Senior people stay close.`) > 0);
    const gammaHtml = renderToStaticMarkup((await CompanyDetail({ id: gamma.id })) as ReactElement);
    ok("a sub-category without a note shows its category's", gammaHtml.includes(`${TAG} Strategic › ${TAG} Growth`) && gammaHtml.includes(`${TAG} Senior people stay close.`));
    await cats.setCompanyCategory(gamma.id, null);
    const bareHtml = renderToStaticMarkup((await CompanyDetail({ id: gamma.id })) as ReactElement);
    ok("a customer with none is offered one, and shows no note", !bareHtml.includes("How to treat them") && bareHtml.includes("Category") && !bareHtml.includes(`data-category="`));

    // ───────────────────────────────────────────────────────────────────────────
    section("Deleting");

    as(rep);
    ok("somebody without the permission can't delete one", !(await cats.deleteCustomerCategory(keyAcc.data.id)).ok);
    as(boss);
    const subGone = await cats.deleteCustomerCategory(keyAcc.data.id);
    ok("deleting a sub-category moves its customers up to its category", subGone.ok && subGone.data.moved === 1 && (await db.company.findUnique({ where: { id: acme.id } }))?.customerCategoryId === strategic.data.id);
    await cats.setCompanyCategory(gamma.id, growth.data.id);
    const topGone = await cats.deleteCustomerCategory(strategic.data.id);
    ok(
      "deleting a category leaves its customers — and its sub-categories' — uncategorised",
      topGone.ok && topGone.data.cleared === 3 && (await db.company.count({ where: { id: { in: [acme.id, beta.id, gamma.id] }, customerCategoryId: null } })) === 3,
      topGone.ok ? topGone.data.cleared : topGone.error,
    );
    ok("  and its sub-categories go with it", (await db.customerCategory.count({ where: { id: growth.data.id } })) === 0);
    ok("  while the other category and its customers are untouched", (await db.company.findFirst({ where: { name: `${TAG} Formco` } }))?.customerCategoryId === watch.data.id);
  } finally {
    await cleanup();
    const left = (await db.customerCategory.count({ where: { name: { startsWith: TAG } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } })) + (await db.user.count({ where: { email: { endsWith: MAIL } } }));
    ok("nothing left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures ? `\n${failures} failed.` : "\nAll customer-category checks pass.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

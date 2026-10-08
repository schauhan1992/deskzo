/**
 * The view permissions — who may see a customer's contacts, leads, orders, payments, documents,
 * projects, calls, visits and tickets.
 *
 * Each one governs the customer page's tab *and* the module behind it, and is enforced on the
 * server: the page, the actions a page calls, and the actions a client could call directly. The
 * defaults give every role what it had before, so nothing changes until an admin unticks something.
 *
 * One probe user owns one probe account with one of everything on it. The suite reads it all back
 * as that user, then denies the view permissions to the same user and reads it again — so the only
 * thing that differs between the two passes is the permission. React's `cache` does not memoise
 * outside a request, which is what lets one user be asked twice.
 *
 * A second probe user, who can see contacts but not this account, checks the account scope the
 * contact actions were missing. Everything is named ZZPROBE_VIEWS and removed in a finally.
 *
 *   npm run check:view-permissions
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { PERMISSION_REGISTRY, PERMISSIONS } from "../src/lib/permissions";
import { ROLE_PRESETS } from "../src/lib/authz/presets";
import { MODULE_REGISTRY, getModuleDefinition } from "../src/lib/modules";
import { DEFAULT_BRANDING } from "../src/lib/branding";

let actorId = "";
/** The page the sidebar thinks it is on — its section is the one rendered open. */
let pathname = "/companies";
class NotFound extends Error {}
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Views", email: "rep@zzprobe-views.invalid" });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => pathname,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_VIEWS";
const MAIL = "@zzprobe-views.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const VIEWS = [
  "contacts.view",
  "leads.view",
  "orders.view",
  "payments.view",
  "documents.view",
  "projects.view",
  "calls.view",
  "visits.view",
  "tickets.view",
] as const;
const NON_ADMIN_ROLES = ["PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"];

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const contacts = await db.contact.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...companyIds, ...leads.map((l) => l.id), ...contacts.map((c) => c.id)] } },
        { userId: { in: userIds } },
      ],
    },
  });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.activity.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
  await db.contactVerification.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.visit.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.project.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The permissions, and what they are attached to");

  for (const key of VIEWS) {
    const def = PERMISSION_REGISTRY.find((p) => p.key === key);
    const roles = (def?.defaultRoles ?? []) as readonly string[];
    ok(`${key} exists and every non-admin role has it by default`, !!def && NON_ADMIN_ROLES.every((r) => roles.includes(r)), def ? roles.join(",") : "missing");
  }
  const presetsMissing = ROLE_PRESETS.filter((p) => !VIEWS.every((k) => (p.permissions as readonly string[]).includes(k))).map((p) => p.key);
  ok("every preset keeps all nine — applying one never takes a view away", presetsMissing.length === 0, presetsMissing.join(", "));

  const expected: Record<string, string> = {
    orders: "orders.view",
    renewals: "orders.view",
    payments: "payments.view",
    receivables: "payments.view",
    sales_documents: "documents.view",
    purchase_documents: "documents.view",
    projects: "projects.view",
    calls: "calls.view",
    visits: "visits.view",
    helpdesk: "tickets.view",
    contacts_library: "contacts.view",
  };
  const wrong = Object.entries(expected).filter(([mod, key]) => getModuleDefinition(mod)?.viewPermission !== key);
  ok("each module carries the view permission for its records", wrong.length === 0, wrong.map(([m]) => m).join(", "));
  const nav = MODULE_REGISTRY.flatMap((m) => m.navItems);
  ok(
    "the Leads and Contact Checks links name theirs",
    nav.find((n) => n.href === "/leads")?.permission === "leads.view" && nav.find((n) => n.href === "/verifications")?.permission === "contacts.view",
  );

  /**
   * A page somebody may not open is the 404 page (owner, 8 Oct 2026), the same as an address the app
   * doesn't have. One that says "you don't have permission" tells everybody what is behind the door,
   * so no page may say it — whatever the wording.
   */
  const refusing = /You don(?:&apos;|&rsquo;|'|’)t (?:have (?:permission|access)|hold (?:the|any) [a-z ]*permission)|You need permission|Only an admin can view|Only somebody holding the/;
  const root = path.join(__dirname, "..");
  const pagesDir = path.join(root, "src/app/(dashboard)");
  const screens = [
    ...readdirSync(pagesDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("page.tsx")).map((f) => path.join(pagesDir, f)),
    path.join(root, "src/components/settings/settings-page.tsx"),
    path.join(root, "src/components/settings/module-disabled-notice.tsx"),
  ];
  const sayingSo = screens.filter((f) => refusing.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  ok("no page tells somebody it is refusing them — it is not found instead", screens.length > 100 && sayingSo.length === 0, sayingSo.join(", "));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const moduleActions = require("../src/actions/module") as typeof import("../src/actions/module");
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const contactActions = require("../src/actions/contact") as typeof import("../src/actions/contact");
  const emailActions = require("../src/actions/email-verification") as typeof import("../src/actions/email-verification");
  const verificationActions = require("../src/actions/verification") as typeof import("../src/actions/verification");
  const projectActions = require("../src/actions/project") as typeof import("../src/actions/project");
  const orderActions = require("../src/actions/order") as typeof import("../src/actions/order");
  const paymentActions = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const documentActions = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const ticketActions = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const visitActions = require("../src/actions/visit") as typeof import("../src/actions/visit");
  const callActions = require("../src/actions/call") as typeof import("../src/actions/call");
  const receivableActions = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const dashboardActions = require("../src/actions/dashboard") as typeof import("../src/actions/dashboard");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { ModuleDisabledNotice } = require("../src/components/settings/module-disabled-notice") as typeof import("../src/components/settings/module-disabled-notice");
  const { Sidebar } = require("../src/components/layout/sidebar") as typeof import("../src/components/layout/sidebar");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");

  await cleanup();
  try {
    section("Everybody keeps what they had");

    // A role an admin has set a view on in this database (the CALLING role without orders, say) is
    // configured, not "nothing configured" — those pairs are the admin's answer, not the default's.
    const configured = new Set(
      (await db.rolePermission.findMany({ where: { role: { in: [...NON_ADMIN_ROLES] }, permission: { in: [...VIEWS] } }, select: { role: true, permission: true } })).map(
        (r) => `${r.role}:${r.permission}`,
      ),
    );
    const byRole: string[] = [];
    for (const role of NON_ADMIN_ROLES) {
      const u = await db.user.create({
        data: { name: `Zzprobe ${role}`, email: `role-${role.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60) },
      });
      for (const key of VIEWS) if (!configured.has(`${role}:${key}`) && !(await can(u.id, key))) byRole.push(`${role}:${key}`);
    }
    ok(
      `every role, with nothing configured, holds all nine${configured.size ? ` (${configured.size} set by an admin here, left out)` : ""}`,
      byRole.length === 0,
      byRole.join(", "),
    );

    section("The fixture");

    const rep = await db.user.create({
      data: {
        name: "Zzprobe Rep",
        email: `rep${MAIL}`,
        role: "PROFILE",
        passwordHash: "x".repeat(60),
        // Visibility of the account comes from managing it, not from a company-wide grant.
        permissionGrants: { create: [{ permission: "companies.viewAll", allowed: false, reason: TAG }] },
      },
    });
    const outsider = await db.user.create({
      data: {
        name: "Zzprobe Outsider",
        email: `outsider${MAIL}`,
        role: "PROFILE",
        passwordHash: "x".repeat(60),
        permissionGrants: { create: [{ permission: "companies.viewAll", allowed: false, reason: TAG }] },
      },
    });
    const company = await db.company.create({
      data: {
        name: `${TAG} Account`,
        normalizedName: `${TAG} account`.toLowerCase(),
        createdById: rep.id,
        ownerUserId: rep.id,
        relationshipType: "CLIENT",
        stage: "CUSTOMER",
      },
    });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true } });
    const item = await db.item.create({
      data: { name: `${TAG} Item`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 100, createdById: rep.id },
    });
    const contact = await db.contact.create({
      data: { companyId: company.id, name: "Zzprobe Person", email: "person@zzprobe-views.invalid", phone: "+919800000001", isPrimary: true },
    });
    const lead = await db.lead.create({
      data: { companyId: company.id, title: `${TAG} Deal`, ownerUserId: rep.id, contactId: contact.id, estimatedValue: 5000 },
    });
    await db.activity.create({ data: { leadId: lead.id, userId: rep.id, type: "NOTE", notes: "Zzprobe note" } });
    const order = await db.companyProduct.create({
      data: { companyId: company.id, locationId: location.id, itemId: item.id, addedByUserId: rep.id },
    });
    await db.payment.create({
      data: { companyId: company.id, amount: 100, paidOn: new Date(), method: "UPI", recordedByUserId: rep.id },
    });
    await db.tradeDocument.create({
      data: { docNumber: `${TAG}-INV-1`, docType: "INVOICE", direction: "SALES", companyId: company.id, createdById: rep.id },
    });
    const project = await db.project.create({
      data: { code: `${TAG}-P1`, companyId: company.id, name: `${TAG} Rollout`, createdById: rep.id, managerId: rep.id },
    });
    const ticket = await db.ticket.create({ data: { companyId: company.id, title: `${TAG} Ticket`, createdByUserId: rep.id } });
    const visit = await db.visit.create({ data: { companyId: company.id, scheduledFor: new Date(), userId: rep.id } });
    await db.callLog.create({
      data: { companyId: company.id, phoneNumber: "+919800000001", outcome: "CONNECTED", startedAt: new Date(), userId: rep.id },
    });
    const verification = await db.contactVerification.create({
      data: { companyId: company.id, contactId: contact.id, field: "PHONE", originalValue: "+919800000001", status: "CORRECTED", correctedValue: "+919800000002", verifiedByUserId: rep.id },
    });
    ok("one account with one of everything on it", true);

    /** Everything the view permissions guard, read as the current actor. */
    const readAll = async () => {
      const got = await companyActions.getCompany(company.id);
      return {
        modules: Object.fromEntries(
          await Promise.all(
            ["orders", "renewals", "payments", "receivables", "sales_documents", "projects", "calls", "visits", "helpdesk", "contacts_library"].map(
              async (k) => [k, await moduleActions.isModuleEnabled(k)] as const,
            ),
          ),
        ),
        companyContacts: got?.contacts.length ?? -1,
        companyLeads: got?.leads.length ?? -1,
        companyOrders: got?.products.length ?? -1,
        lead: (await leadActions.getLead(lead.id)) !== null,
        leadList: (await leadActions.listLeads({ search: TAG })).length,
        leadDraft: (await leadActions.leadDocumentDraft(lead.id)) !== null,
        leadExport: (await leadActions.exportLeadsCsv()).ok,
        libraryContacts: (await contactActions.listAllContacts({ search: "Zzprobe Person" })).length,
        badEmails: (await emailActions.emailVerificationSummary()).total,
        pendingChecks: (await verificationActions.pendingVerifications({ page: 1, pageSize: 500 })).rows.filter((r) => r.id === verification.id).length,
        companyChecks: (await verificationActions.companyVerifications(company.id)).length,
        project: (await projectActions.getProject(project.id)) !== null,
        projects: (await projectActions.listProjects({ companyId: company.id })).length,
        order: (await orderActions.getOrder(order.id)) !== null,
        payments: (await paymentActions.listCompanyPayments(company.id)).length,
        documents: (await documentActions.listCompanyDocuments(company.id)).length,
        tickets: (await ticketActions.listTickets({ companyId: company.id })).length,
        ticket: (await ticketActions.getTicket(ticket.id)) !== null,
        visits: (await visitActions.listCompanyVisits(company.id)).length,
        visit: (await visitActions.getVisit(visit.id)) !== null,
        calls: (await callActions.listCompanyCalls(company.id)).length,
        statement: (await receivableActions.customerStatement(company.id)) !== null,
        dashboardLeads: (await dashboardActions.getDashboardSummary()).leads !== null,
      };
    };

    /** The customer page as this actor, on one tab, as HTML. */
    const renderCompany = async (tab: string) =>
      renderToStaticMarkup((await CompanyDetail({ id: company.id, tab })) as ReactElement);
    const tabLabels = (html: string) => {
      const labels = ["Products &amp; Subscriptions", "Documents", "Payments", "Statement", "Visits", "Calls", "Leads", "Renewals", "Contacts", "Tickets", "Projects"];
      return labels.filter((l) => html.includes(`>${l}</a>`));
    };

    section("With the defaults, the account is all there");

    actorId = rep.id;
    const seen = await readAll();
    const hidden = Object.entries(seen).filter(([k, v]) => (k === "modules" ? Object.values(v as object).some((x) => !x) : v === false || v === 0 || v === -1));
    ok("every module, record, list and figure comes back", hidden.length === 0, hidden.map(([k]) => k).join(", "));
    const fullPage = await renderCompany("projects");
    const fullTabs = tabLabels(fullPage);
    ok(
      "the customer page shows every tab, including the new Projects tab",
      ["Products &amp; Subscriptions", "Documents", "Payments", "Visits", "Calls", "Leads", "Contacts", "Tickets", "Projects"].every((t) => fullTabs.includes(t)),
      fullTabs.join(" · "),
    );
    ok("  and the Projects tab lists this account's project", fullPage.includes(`${TAG} Rollout`));
    ok("  and the lead, pipeline and billing cards, and New lead", ["Open pipeline", "Last activity", "Billed", "Outstanding", "New lead"].every((t) => fullPage.includes(t)));

    section("With every view denied, none of it is");

    await db.userPermission.createMany({ data: VIEWS.map((permission) => ({ userId: rep.id, permission, allowed: false, reason: TAG })) });
    const blind = await readAll();
    const leaked = Object.entries(blind).filter(([k, v]) =>
      k === "modules" ? Object.values(v as object).some((x) => x) : k === "leadExport" ? false : v === true || (typeof v === "number" && v > 0),
    );
    ok("no module, record, list or figure comes back", leaked.length === 0, leaked.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", "));
    ok("  the lead export refuses rather than handing over an empty file", blind.leadExport === false);
    ok("  the company itself still opens — it is the parts that are withheld", blind.companyContacts === 0 && blind.companyLeads === 0 && blind.companyOrders === 0);

    const blindPage = await renderCompany("contacts");
    const blindTabs = tabLabels(blindPage);
    ok("the customer page has none of the tabs", blindTabs.length === 0, blindTabs.join(" · "));
    ok("  and none of the cards, nor New lead", !["Open pipeline", "Last activity", "Billed", "Outstanding", "New lead", "Module off"].some((t) => blindPage.includes(t)));
    ok("  and asking for a hidden tab by URL shows Details instead", !blindPage.includes("Zzprobe Person") && !blindPage.includes("person@zzprobe-views.invalid"));

    // Not a notice naming the permission any more (owner, 8 Oct 2026): the 404 page, as for an address
    // the app doesn't have, and never "switched off" — the module is on, it just isn't theirs.
    const notice = await ModuleDisabledNotice({ moduleKey: "orders" }).then(
      () => "rendered",
      (err: unknown) => (err instanceof NotFound ? "notFound" : String(err)),
    );
    ok("a module page the role can't see is not found, rather than saying it is switched off", notice === "notFound", notice);
    ok("  and says which reason it is", (await moduleActions.moduleAccess("orders")) === "no-permission");

    // A section renders its links only while open, and the section holding the current page is
    // always open — so each link is looked for with the sidebar standing on that very page.
    const offers = (link: string, permissions: string[]) => {
      pathname = link;
      return renderToStaticMarkup(
        createElement(Sidebar, {
          enabledKeys: MODULE_REGISTRY.map((m) => m.key),
          canViewPerformance: false,
          permissions,
          branding: DEFAULT_BRANDING,
        }),
      ).includes(`href="${link}"`);
    };
    const links = ["/orders", "/payments", "/projects", "/calls", "/visits", "/tickets", "/leads", "/contacts", "/verifications"];
    // Everybody holds every section until it's unticked for their role (src/lib/permissions.ts): the
    // view permissions are what's under test here.
    const SECTIONS = PERMISSIONS.filter((p) => p.everyone).map((p) => p.key);
    const missing = links.filter((l) => !offers(l, [...VIEWS, ...SECTIONS]));
    const shown = links.filter((l) => offers(l, SECTIONS));
    ok("the sidebar offers the modules to someone who has them", missing.length === 0, missing.join(", "));
    ok("  and not to someone who doesn't", shown.length === 0, shown.join(", "));

    section("Writes refuse too");

    const leadCount = await db.lead.count({ where: { companyId: company.id } });
    const created = await leadActions.createLead({ companyId: company.id, title: `${TAG} Second`, source: "OTHER" });
    ok("a lead cannot be created", !created.ok && (await db.lead.count({ where: { companyId: company.id } })) === leadCount, created.ok ? "created" : created.error);
    const logged = await leadActions.logActivity({ leadId: lead.id, type: "NOTE", notes: "should not land" });
    ok("  nor activity logged on one", !logged.ok && (await db.activity.count({ where: { leadId: lead.id } })) === 1);
    const moved = await leadActions.updateLeadStatus({ leadId: lead.id, status: "QUALIFIED" });
    ok("  nor one moved through the pipeline", !moved.ok && (await db.lead.findUnique({ where: { id: lead.id } }))!.status !== "QUALIFIED");
    const added = await companyActions.addContact(company.id, { name: "Zzprobe Extra", designation: "OTHER" });
    ok("a contact cannot be added", !added.ok && (await db.contact.count({ where: { companyId: company.id } })) === 1);
    const edited = await companyActions.updateContact({ id: contact.id, name: "Renamed", designation: "OTHER" });
    ok("  nor edited", !edited.ok && (await db.contact.findUnique({ where: { id: contact.id } }))!.name === "Zzprobe Person");
    const withContacts = await companyActions.createCompany({
      name: `${TAG} Another`,
      source: "LINKEDIN",
      relationshipType: "CLIENT",
      contacts: [{ name: "Zzprobe Smuggled", designation: "OTHER" }],
    });
    ok("  nor slipped in on a new company", !withContacts.ok && (await db.company.count({ where: { name: `${TAG} Another` } })) === 0);
    const checked = await verificationActions.applyVerification(verification.id);
    ok("  nor a reported correction applied", !checked.ok && (await db.contact.findUnique({ where: { id: contact.id } }))!.phone === "+919800000001");

    section("One view at a time");

    // Everything back, then only contacts taken away: the rest of the page must be untouched.
    await db.userPermission.deleteMany({ where: { userId: rep.id, permission: { in: [...VIEWS] } } });
    await db.userPermission.create({ data: { userId: rep.id, permission: "contacts.view", allowed: false, reason: TAG } });
    const noContacts = tabLabels(await renderCompany("details"));
    ok("without contacts, only the Contacts tab goes", !noContacts.includes("Contacts") && noContacts.includes("Leads") && noContacts.includes("Projects"), noContacts.join(" · "));
    const redacted = await leadActions.getLead(lead.id);
    ok("  and the lead still names its contact, without how to reach them", redacted?.contact?.name === "Zzprobe Person" && redacted.contact.phone === null && redacted.contact.email === null);

    await db.userPermission.deleteMany({ where: { userId: rep.id, permission: { in: [...VIEWS] } } });
    await db.userPermission.create({ data: { userId: rep.id, permission: "projects.view", allowed: false, reason: TAG } });
    const noProjects = tabLabels(await renderCompany("details"));
    ok("without projects, only the Projects tab goes", !noProjects.includes("Projects") && noProjects.includes("Contacts"), noProjects.join(" · "));

    await db.userPermission.deleteMany({ where: { userId: rep.id, permission: { in: [...VIEWS] } } });
    await db.userPermission.create({ data: { userId: rep.id, permission: "orders.view", allowed: false, reason: TAG } });
    const noOrders = tabLabels(await renderCompany("details"));
    ok("without orders, Products and Renewals go and Payments stays", !noOrders.includes("Products &amp; Subscriptions") && !noOrders.includes("Renewals") && noOrders.includes("Payments"), noOrders.join(" · "));
    await db.userPermission.deleteMany({ where: { userId: rep.id, permission: { in: [...VIEWS] } } });

    section("The account scope the contact actions were missing");

    // The outsider holds contacts.view — every role does — but does not manage this account.
    actorId = outsider.id;
    const o1 = await companyActions.updateContact({ id: contact.id, name: "Hijacked", designation: "OTHER" });
    ok("someone else's contact cannot be edited by id", !o1.ok && (await db.contact.findUnique({ where: { id: contact.id } }))!.name === "Zzprobe Person", o1.ok ? "edited" : o1.error);
    const o2 = await companyActions.deleteContact(contact.id);
    ok("  nor deleted", !o2.ok && (await db.contact.count({ where: { id: contact.id } })) === 1);
    const o3 = await contactActions.bulkUpdateContacts({ contactIds: [contact.id], action: "delete" });
    ok("  nor bulk-deleted", !o3.ok && (await db.contact.count({ where: { id: contact.id } })) === 1, o3.ok ? "deleted" : o3.error);
    const o4 = await emailActions.markEmailConfirmed(contact.id, "WRONG");
    ok("  nor its email condemned", !o4.ok && (await db.contact.findUnique({ where: { id: contact.id } }))!.emailStatus !== "INVALID");
    const o5 = await verificationActions.verifyContactDetail({
      companyId: company.id,
      contactId: contact.id,
      field: "EMAIL",
      originalValue: "person@zzprobe-views.invalid",
      status: "WRONG",
    });
    ok("  nor a verdict filed against it", !o5.ok && (await db.contactVerification.count({ where: { companyId: company.id } })) === 1);
    const o6 = await verificationActions.pendingVerifications({ page: 1, pageSize: 500 });
    ok("  and the correction queue does not show it", !o6.rows.some((r) => r.id === verification.id));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll view-permission checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});

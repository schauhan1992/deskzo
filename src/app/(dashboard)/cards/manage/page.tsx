import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { getBranding } from "@/actions/branding";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { companyName } from "@/lib/cards/server";
import { cardContacts, managedPeople, templateRows } from "@/lib/cards/views";
import { TabNav } from "@/components/ui/tab-nav";
import { CardsPeopleTable } from "@/components/cards/cards-people-table";
import { CardTemplates } from "@/components/cards/card-templates";
import { CardContactsList } from "@/components/cards/card-contacts-list";

/**
 * Digital cards, for whoever holds `cards.manage`: who has a card, issuing and switching them off,
 * the company's templates, and everybody who shared their details back.
 *
 * A refusal is a 404, as everywhere (owner, 8 Oct 2026).
 */
export default async function ManageCardsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  if (!(await hasEffectivePermission(me.id, "cards.manage"))) notFound();
  const { tab: rawTab } = await searchParams;
  const tab = rawTab === "templates" || rawTab === "contacts" ? rawTab : "people";

  const [templates, branding, company] = await Promise.all([templateRows(), getBranding(), companyName()]);
  const [people, departments, branches, roles] =
    tab === "people"
      ? await Promise.all([
          managedPeople(),
          db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
          db.branch.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
          db.role.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
        ])
      : [[], [], [], []];
  const contacts = tab === "contacts" ? await cardContacts("all", 500) : [];
  const live = people.filter((p) => p.card?.live).length;

  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Digital cards</h1>
        <p className="mt-1 text-sm text-muted">
          Nobody has a card until it&apos;s issued here. A card shows what its holder&apos;s record says and the template allows; switching one off
          points its link at the company instead.
        </p>
      </div>

      <TabNav
        tabs={[
          { key: "people", label: "People" },
          { key: "templates", label: "Templates", count: templates.length },
          { key: "contacts", label: "Contacts" },
        ]}
        activeKey={tab}
        basePath="/cards/manage"
      />

      {tab === "templates" ? (
        <CardTemplates templates={templates} logoUrl={branding.logoDataUrl ? "/api/brand/mark" : null} company={company} />
      ) : tab === "contacts" ? (
        <CardContactsList rows={contacts} showHolder empty="Nobody has shared their details from a card yet." />
      ) : (
        <CardsPeopleTable
          people={people}
          liveCount={live}
          templates={templates.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault }))}
          departments={departments}
          branches={branches}
          roles={roles}
        />
      )}
    </div>
  );
}

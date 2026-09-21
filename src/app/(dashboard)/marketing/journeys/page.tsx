import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAudiences, listJourneys, listTemplates } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { JourneyList } from "@/components/marketing/journey-list";
import { JourneyEditor } from "@/components/marketing/journey-editor";
import { TRIGGERS } from "@/lib/marketing/triggers";

export default async function JourneysPage() {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const user = await currentUser();
  const [journeys, canSend, canManage, audiences, templates] = await Promise.all([
    listJourneys(),
    user ? hasEffectivePermission(user.id, "marketing.send") : Promise.resolve(false),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
    listAudiences(),
    listTemplates(),
  ]);

  const byTeam = new Map<string, typeof TRIGGERS>();
  for (const trigger of TRIGGERS) {
    byTeam.set(trigger.team, [...(byTeam.get(trigger.team) ?? []), trigger]);
  }

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Journeys</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Something happens to a customer, and a sequence starts. A step can send them an email — or hand one of
            ours a task, which needs no mail provider at all and is often worth more.
          </p>
        </div>
        {canManage && <JourneyEditor audiences={audiences} templates={templates} />}
      </div>

      <div className="mt-5">
        <JourneyList journeys={journeys} canSend={canSend} canManage={canManage} audiences={audiences} templates={templates} />
      </div>

      <Card className="mt-6 px-4 py-4">
        <h2 className="text-sm font-medium text-text">What can start one</h2>
        <p className="mt-1 text-xs text-muted">
          Each says what it enrols and what it deliberately leaves out. The exclusions are the half people argue
          about — a renewal trigger that counted addon seats separately would start four conversations about one date.
        </p>
        <div className="mt-3 space-y-4">
          {[...byTeam.entries()].map(([team, triggers]) => (
            <div key={team}>
              <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">{team}</h3>
              <ul className="mt-1 space-y-1.5">
                {triggers.map((t) => (
                  <li key={t.key} className="text-xs">
                    <span className="font-medium text-text">{t.label}</span>
                    {t.suits === "TASK" && <span className="ml-1.5 text-[10px] text-subtle">(usually a task)</span>}
                    <span className="block text-muted">{t.enrols}</span>
                    {t.excludes && <span className="block text-subtle">Not: {t.excludes}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

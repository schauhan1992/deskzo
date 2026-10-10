import Link from "next/link";
import { notFound } from "next/navigation";
import { ScanLine } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { formatCurrency } from "@/lib/utils";
import { captureOpen, eventDatesLabel } from "@/lib/cards/events";
import { eventResults, loadEvent, teamChoices } from "@/lib/cards/events-server";
import { cardContacts, cardQr } from "@/lib/cards/views";
import { Badge, Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { CardContactsList } from "@/components/cards/card-contacts-list";
import { EventEditor } from "@/components/cards/event-editor";
import { ExportEventButton } from "@/components/cards/export-event-button";
import { BoothLinks } from "@/components/cards/booth-links";

/**
 * One card event: who the team met there against the goal, by person and by day, and what each cost;
 * the people themselves; each card's booth form; and, for whoever manages cards, its settings.
 *
 * Its team see the numbers for everybody — they share a stand — but only the people they met
 * themselves. Anybody else: a 404.
 */
export default async function CardEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const event = await loadEvent(id);
  if (!event) notFound();
  const manages = await hasEffectivePermission(me.id, "cards.manage");
  const member = event.memberIds.includes(me.id);
  if (!manages && !member) notFound();
  const tab = rawTab === "people" || (rawTab === "settings" && manages) ? rawTab : "results";

  const today = (await workspaceClock()).today();
  const open = captureOpen(event, today);
  const [results, origin, cards] = await Promise.all([
    eventResults(event),
    tenantOrigin(),
    db.digitalCard.findMany({
      where: { userId: { in: manages ? event.memberIds : [me.id] }, status: "ACTIVE" },
      select: { handle: true, user: { select: { name: true } } },
    }),
  ]);
  const goalShare = event.goal ? Math.min(100, Math.round((results.met / event.goal) * 100)) : null;
  const busiest = Math.max(1, ...results.byDay.map((d) => d.met));

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={manages ? "/cards/events" : "/cards"} className="text-sm text-muted hover:text-text">
            ← {manages ? "Card events" : "My card"}
          </Link>
          <h1 className="mt-2 flex flex-wrap items-center gap-2 text-xl font-semibold text-text">
            {event.name}
            {event.state === "live" ? <Badge tone="green">On now</Badge> : event.state === "upcoming" ? <Badge tone="blue">Coming up</Badge> : <Badge>Finished</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted">{[eventDatesLabel(event), event.venue].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && (
            <Link
              href={`/cards/events/${event.id}/capture`}
              className="inline-flex h-9 items-center gap-1.5 rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110"
            >
              <ScanLine className="h-4 w-4" />
              Add someone you met
            </Link>
          )}
          {manages && <ExportEventButton eventId={event.id} />}
        </div>
      </div>

      <TabNav
        tabs={[
          { key: "results", label: "Results" },
          { key: "people", label: "People met", count: results.met },
          ...(manages ? [{ key: "settings", label: "Settings" }] : []),
        ]}
        activeKey={tab}
        basePath={`/cards/events/${event.id}`}
      />

      {tab === "settings" ? (
        <Card className="p-5">
          <EventEditor
            initial={{
              id: event.id,
              name: event.name,
              venue: event.venue ?? "",
              startsOn: event.startsOn,
              endsOn: event.endsOn,
              goal: event.goal ? String(event.goal) : "",
              cost: event.cost !== null ? String(event.cost) : "",
              memberIds: event.memberIds,
              questions: event.questions,
            }}
            people={await teamChoices()}
            canDelete={results.met === 0}
          />
        </Card>
      ) : tab === "people" ? (
        <CardContactsList
          rows={await cardContacts(manages ? { campaignId: event.id } : { campaignId: event.id, ownerUserId: me.id }, 500)}
          showHolder={manages}
          empty={manages ? "Nobody has been met at this event yet." : "You haven't met anybody at this event yet."}
        />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="People met" value={String(results.met)} hint={event.goal ? `of ${event.goal} hoped for` : undefined} />
            <Stat label="Leads made" value={String(results.leads)} hint="in the CRM" />
            <Stat label="At the booth form" value={String(results.byVia.BOOTH)} hint={`${results.byVia.SCAN} scanned · ${results.byVia.SHARE_BACK} from cards`} />
            <Stat label="Cost per person" value={results.costPerPerson !== null ? formatCurrency(results.costPerPerson) : "—"} hint={event.cost !== null ? `${formatCurrency(event.cost)} in all` : "Add the cost in Settings"} />
          </div>
          {goalShare !== null && (
            <div className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                <div className="h-full rounded-full bg-brand" style={{ width: `${goalShare}%` }} />
              </div>
              <p className="text-xs text-muted">{goalShare}% of the goal</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <section className="rounded-xl border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-text">By person</h2>
              <ul className="divide-y divide-line">
                {results.byPerson.map((p) => (
                  <li key={p.userId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className={p.userId === me.id ? "font-medium text-text" : "text-text"}>{p.name}</span>
                    <span className="tabular-nums text-muted">
                      {p.met} met · {p.leads} {p.leads === 1 ? "lead" : "leads"}
                    </span>
                  </li>
                ))}
                {results.byPerson.length === 0 && <li className="px-4 py-4 text-sm text-muted">Nobody is on the team yet.</li>}
              </ul>
            </section>
            <section className="rounded-xl border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-text">By day</h2>
              <ul className="space-y-1.5 px-4 py-3">
                {results.byDay.map((d) => (
                  <li key={d.day} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0 text-muted">{eventDatesLabel({ startsOn: d.day, endsOn: d.day })}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((d.met / busiest) * 100)}%` }} />
                    </span>
                    <span className="w-8 text-right tabular-nums text-text">{d.met}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <BoothLinks
            links={await Promise.all(
              cards.map(async (c) => {
                const url = `${origin}/c/${c.handle}?e=${event.code}`;
                return { name: c.user.name, url, qr: await cardQr(url) };
              }),
            )}
            live={event.state === "live"}
            mine={!manages}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-text">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-subtle">{hint}</p>}
    </div>
  );
}

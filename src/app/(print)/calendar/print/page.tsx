import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { listMyDays } from "@/actions/calendar";
import { currentUser } from "@/lib/session";
import { getOrganisation } from "@/lib/organisation";
import { PrintButton } from "@/components/documents/print-button";
import { addDays, dayLabel, isDayKey, mondayOf, spanLabel } from "@/lib/calendar/days";
import { ITEM_KIND_LABELS } from "@/lib/calendar/items";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The Calendar page on paper (A4, the print shell's margins): the same week — or fortnight, from the
 * agenda — day by day, every day listed, with what is on it and where. Meetings and the rest alike, as the
 * person sees them; nobody else's.
 */
export default async function PrintCalendarPage({ searchParams }: { searchParams: Promise<{ week?: string; view?: string }> }) {
  if (!(await isModuleEnabled("calendar"))) notFound();
  const query = await searchParams;
  const [clock, me, org] = await Promise.all([workspaceClock(), currentUser(), getOrganisation()]);
  if (!me) notFound();
  const agenda = query.view === "agenda";
  const anchor = isDayKey(query.week) ? query.week : clock.today();
  const first = agenda ? anchor : mondayOf(anchor);
  const keys = Array.from({ length: agenda ? 14 : 7 }, (_, i) => addDays(first, i));
  const last = keys[keys.length - 1]!;
  const items = (await listMyDays({ from: first, to: last })).filter((e) => e.status !== "CANCELLED");
  const onDay = (key: string) =>
    items.filter((e) => (e.allDay ? e.startsAt.slice(0, 10) <= key && key < e.endsAt.slice(0, 10) : clock.dateKey(new Date(e.startsAt)) <= key && key <= clock.dateKey(new Date(new Date(e.endsAt).getTime() - 1))));

  return (
    <div className="mx-auto max-w-[210mm] bg-white p-10 text-[12px] leading-snug text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>
      <header className="mb-5 border-b border-neutral-300 pb-3">
        <h1 className="text-lg font-semibold">
          {me.name} — {spanLabel(first, last)}
        </h1>
        <p className="text-neutral-600">
          {org.tradeName || org.legalName} · times in {clock.zone.replace(/_/g, " ")} ({clock.offsetLabel()}) · printed {clock.dateTime(new Date())}
        </p>
      </header>
      {keys.map((key) => {
        const list = onDay(key);
        return (
          <section key={key} className="print-keep mb-3">
            <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">{dayLabel(key, true)}</h2>
            {list.length === 0 ? (
              <p className="text-neutral-400">Nothing on.</p>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id} className="border-t border-neutral-200 align-top">
                      <td className="w-32 py-1 pr-3 text-neutral-600">{e.allDay ? "All day" : `${clock.time(e.startsAt)} – ${clock.time(e.endsAt)}`}</td>
                      <td className="py-1 pr-3">
                        <span className="font-medium">{e.title}</span>
                        {e.location && <span className="block text-neutral-600">{e.location}</span>}
                      </td>
                      <td className="w-28 py-1 text-right text-neutral-500">{e.kind === "meeting" ? (e.record?.label ?? "Meeting") : ITEM_KIND_LABELS[e.kind]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

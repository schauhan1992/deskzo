import { isModuleEnabled } from "@/actions/module";
import { getMyCalendar, listMyEvents } from "@/actions/calendar";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CalendarBoard } from "@/components/calendar/calendar-board";
import { addDays, isDayKey, mondayOf } from "@/lib/calendar/days";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * My calendar: the person's own Outlook, Google Calendar or Zoho Calendar as the last sync found it — a
 * week at a time, or the next fortnight as a list — with the meetings scheduled from records linked back
 * to them. Days are the workspace's.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  if (!(await isModuleEnabled("calendar"))) return <ModuleDisabledNotice moduleKey="calendar" />;
  const query = await searchParams;
  const clock = await workspaceClock();
  const today = clock.today();
  const view = query.view === "agenda" ? "agenda" : "week";
  const anchor = isDayKey(query.week) ? query.week : today;
  const first = view === "week" ? mondayOf(anchor) : anchor;
  const days = view === "week" ? 7 : 14;
  const summary = await getMyCalendar();
  const events = summary.state === "ready" || summary.state === "broken" ? await listMyEvents({ from: first, to: addDays(first, days - 1) }) : [];

  return <CalendarBoard summary={summary} events={events} firstDay={first} days={days} view={view} today={today} />;
}

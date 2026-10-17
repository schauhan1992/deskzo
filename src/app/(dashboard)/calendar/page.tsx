import { isModuleEnabled } from "@/actions/module";
import { getMyCalendar, listMyDays, myCalendarFeed } from "@/actions/calendar";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CalendarBoard } from "@/components/calendar/calendar-board";
import { viewerHas } from "@/actions/permission";
import { addDays, isDayKey, mondayOf } from "@/lib/calendar/days";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * My calendar: the person's meetings — from their own Outlook, Google Calendar or Zoho Calendar as the last
 * sync found it, or Deskzo's own calendar when they have none connected — with their tasks, planned visits,
 * leave, holidays and bookings beside them, a week at a time, or the next fortnight as a list. The meetings
 * scheduled from records link back to them. Days are the workspace's.
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
  const open = summary.state !== "off" && summary.state !== "viewing-as";
  const [events, feed, canSchedule] = await Promise.all([open ? listMyDays({ from: first, to: addDays(first, days - 1) }) : [], open ? myCalendarFeed() : null, viewerHas("meetings.schedule")]);

  return <CalendarBoard summary={summary} events={events} feed={feed} firstDay={first} days={days} view={view} today={today} canSchedule={canSchedule} />;
}
